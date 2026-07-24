// App orchestrator: hash routing, screen switching, and handing off to the Host /
// Viewer controllers. Owns the single Signaling connection per session.

import { Signaling, type ServerMessage } from './signaling.ts';
import { HostController, supportsDisplayMedia } from './host.ts';
import { ViewerController } from './viewer.ts';
import { normalizeCode, isValidCode, formatCode } from './code.ts';
import { el, show, hide, setText } from './dom.ts';

type Screen = 'home' | 'join' | 'host' | 'viewer';
const SCREENS: Screen[] = ['home', 'join', 'host', 'viewer'];
// Per-screen tab title, so several open tabs (a host and a viewer) are distinguishable.
const TITLES: Record<Screen, string> = {
  home: 'stream share',
  join: 'Join a share — stream share',
  host: 'Sharing — stream share',
  viewer: 'Watching — stream share',
};
const TOKEN_KEY = 'ss-token';

let sig: Signaling | null = null;
let host: HostController | null = null;
let viewer: ViewerController | null = null;

// Persistent client id, sent on join so a host's ban survives an IP change (cf. rooms-and-codes.md).
function getToken(): string {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

function signalingUrl(): string {
  const { protocol, hostname, host: httpHost } = location;
  // Dev: the signaling runs standalone on :8080. Prod: same-origin behind Traefik at /ws.
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'ws://localhost:8080/ws';
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${httpHost}/ws`;
}

function showScreen(name: Screen): void {
  for (const s of SCREENS) el(`screen-${s}`).hidden = s !== name;
  document.title = TITLES[name];
  // Hiding the section that held focus drops it to <body>, so a keyboard user restarts from the
  // top of the document on every screen change. Move focus onto the new section (tabindex=-1).
  // Callers that want a specific target (goJoin → pseudo-input) focus it after, and win.
  el(`screen-${name}`).focus({ preventScroll: true });
}

function currentCode(): string {
  return normalizeCode(location.hash.replace(/^#/, ''));
}

function teardown(): void {
  sig?.leave(); // notify the server first so peers are told (peer-left) before we close our side
  host?.destroy();
  viewer?.destroy();
  host = null;
  viewer = null;
  sig?.close();
  sig = null;
}

function goHome(): void {
  teardown();
  hide(el('start-error')); // no stale error when returning to the home screen
  // Same reason as in goJoin. Conditional: without getDisplayMedia, wireHome disabled this
  // button for good — an unconditional reset would turn it back on on mobile.
  if (supportsDisplayMedia()) el<HTMLButtonElement>('btn-start').disabled = false;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); // leave the viewer's fullscreen
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}

// --- host flow ---

async function startShare(): Promise<void> {
  teardown();
  hide(el('start-error')); // a new attempt starts from a clean screen
  // Two re-arm paths: `created` below (we leave the home screen without going through
  // goHome), and goHome for all the others — failure, or leaving during the wait.
  const start = el<HTMLButtonElement>('btn-start');
  start.disabled = true; // the card dims (disabled:opacity-45) — that's the visual feedback
  sig = new Signaling(signalingUrl());
  const current = sig;
  const off = current.onMessage((m: ServerMessage) => {
    // A newer startShare/doJoin (or a teardown) already replaced `sig`: this connection is stale,
    // so stop listening and never install a controller over the newer attempt. teardown() closes
    // the old socket, so this mostly catches a `created` already in flight when the swap happened.
    if (sig !== current) return void off();
    if (m.type === 'created') {
      off();
      start.disabled = false; // we leave the home screen: re-armed for the return
      history.replaceState(null, '', `#${m.code}`);
      showScreen('host');
      host = new HostController(current, m, { onEnd: goHome });
    }
  });
  try {
    await current.connect();
    current.create();
  } catch {
    // We are still on the home screen (showScreen('host') only happens when `created` is received),
    // so goHome doesn't change screen: it releases the socket. The message comes after, otherwise
    // goHome would hide it right away. The viewer path already handled this case; the host didn't.
    goHome(); // also re-arms #btn-start
    show(el('start-error'));
  }
}

// --- viewer flow ---

// Reasons returned by the signaling (`join-error`). Any other value falls back to the
// generic message — the server can add more without breaking the front end.
const JOIN_ERRORS: Record<string, string> = {
  banned: 'you have been banned from this room',
  full: 'this room is full',
  'rate-limited': 'too many attempts — wait a minute',
};

function goJoin(code: string): void {
  teardown();
  // Leaving the screen during an attempt (return home, deep-link) goes through none of the
  // three exits: without this reset the button would stay "Joining…" and disabled for good.
  setJoinBusy(false);
  showScreen('join');
  setText('join-code', formatCode(code));
  hide(el('join-fail'));
  el<HTMLInputElement>('pseudo-input').focus();
}

// Each `setJoinBusy(true)` is paired with a `false` on the three exits (joined, join-error,
// network failure): without it the button stays dead and the join screen becomes a dead end.
function setJoinBusy(busy: boolean): void {
  const btn = el<HTMLButtonElement>('btn-do-join');
  btn.disabled = busy;
  btn.textContent = busy ? 'Joining…' : 'Join the stream';
}

async function doJoin(): Promise<void> {
  const code = currentCode();
  if (!isValidCode(code)) return;
  const pseudo = el<HTMLInputElement>('pseudo-input').value.trim() || 'viewer';
  // Like the three other entry points (startShare, goHome, goJoin). `doJoin` was the only one to
  // overwrite `sig` without closing the previous attempt: two sockets, two ViewerControllers on
  // the same DOM (the first no longer referenced, so never destroyed) and above all **two streams
  // encoded by the host** for a single person, the mesh opening one peer per viewer.
  // The `disabled` guard below is not enough: Enter is wired on #pseudo-input (wireJoin),
  // not on the button, so a disabled button only closes the mouse path.
  teardown();
  setJoinBusy(true);
  sig = new Signaling(signalingUrl());
  const current = sig;
  const off = current.onMessage((m: ServerMessage) => {
    // Superseded by a newer attempt/teardown: stop listening. Without this, a stale `join-error`
    // would null a newer `sig`, and a stale `joined` would install a second ViewerController.
    if (sig !== current) return void off();
    if (m.type === 'joined') {
      off();
      setJoinBusy(false); // we leave the join screen: re-armed for the next visit
      showScreen('viewer');
      viewer = new ViewerController(current, m, { code, pseudo, token: getToken() }, { onLeave: goHome });
    } else if (m.type === 'join-error') {
      off();
      current.close();
      sig = null;
      setJoinBusy(false);
      const fail = el('join-fail');
      fail.textContent = JOIN_ERRORS[m.reason] ?? 'room not found or closed';
      show(fail);
    }
  });
  try {
    await current.connect();
    current.join(code, pseudo, getToken());
  } catch {
    setJoinBusy(false);
    const fail = el('join-fail');
    fail.textContent = 'could not reach the server';
    show(fail);
  }
}

// --- wiring ---

// Brand logo → home, from any screen. preventDefault keeps it an SPA nav
// (goHome runs sig.leave() first) instead of the anchor's full reload.
function wireBrand(): void {
  for (const id of ['brand-home', 'brand-host']) {
    el(id).addEventListener('click', (e) => {
      e.preventDefault();
      goHome();
    });
  }
}

function wireHome(): void {
  // Hosting needs getDisplayMedia, which no mobile browser implements. Say so instead of offering
  // a button that would silently do nothing. Joining stays wired — that's the whole mobile flow.
  const start = el<HTMLButtonElement>('btn-start');
  if (supportsDisplayMedia()) start.addEventListener('click', () => void startShare());
  else {
    start.disabled = true;
    show(el('start-unsupported'));
  }
  const input = el<HTMLInputElement>('join-input');
  const submit = (): void => {
    const code = normalizeCode(input.value);
    if (isValidCode(code)) location.hash = code; // triggers route() → goJoin
    else show(el('join-error'));
  };
  el('btn-join').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  // Clear the error on `input`, not `keydown`: a mouse paste or dictation leaves no keystroke, so a
  // now-valid code would keep the red error showing under it.
  input.addEventListener('input', () => hide(el('join-error')));
}

function wireJoin(): void {
  el('btn-do-join').addEventListener('click', () => void doJoin());
  el('pseudo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doJoin();
  });
  el('btn-back-home').addEventListener('click', (e) => {
    e.preventDefault();
    goHome();
  });
}

// A share link (#CODE) skips the landing and goes straight to the nickname screen.
function route(): void {
  const code = currentCode();
  if (host || viewer) return; // already in a live session — ignore our own hash writes
  if (isValidCode(code)) goJoin(code);
  else showScreen('home');
}

export function startApp(): void {
  wireBrand();
  wireHome();
  wireJoin();
  route();
  window.addEventListener('hashchange', route);
}
