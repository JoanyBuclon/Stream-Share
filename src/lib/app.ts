// App orchestrator: hash routing, screen switching, and handing off to the Host /
// Viewer controllers. Owns the single Signaling connection per session.

import { Signaling, type ServerMessage } from './signaling.ts';
import { HostController } from './host.ts';
import { ViewerController } from './viewer.ts';
import { normalizeCode, isValidCode, formatCode } from './code.ts';
import { el, show, hide, setText } from './dom.ts';

type Screen = 'home' | 'join' | 'host' | 'viewer';
const SCREENS: Screen[] = ['home', 'join', 'host', 'viewer'];
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
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}

// --- host flow ---

async function startShare(): Promise<void> {
  teardown();
  sig = new Signaling(signalingUrl());
  const current = sig;
  const off = current.onMessage((m: ServerMessage) => {
    if (m.type === 'created') {
      off();
      history.replaceState(null, '', `#${m.code}`);
      showScreen('host');
      host = new HostController(current, m, { onEnd: goHome });
    }
  });
  try {
    await current.connect();
    current.create();
  } catch {
    goHome();
  }
}

// --- viewer flow ---

function goJoin(code: string): void {
  teardown();
  showScreen('join');
  setText('join-code', formatCode(code));
  hide(el('join-fail'));
  el<HTMLInputElement>('pseudo-input').focus();
}

async function doJoin(): Promise<void> {
  const code = currentCode();
  if (!isValidCode(code)) return;
  const pseudo = el<HTMLInputElement>('pseudo-input').value.trim() || 'viewer';
  sig = new Signaling(signalingUrl());
  const current = sig;
  const off = current.onMessage((m: ServerMessage) => {
    if (m.type === 'joined') {
      off();
      showScreen('viewer');
      viewer = new ViewerController(current, m, { code, pseudo, token: getToken() }, { onLeave: goHome });
    } else if (m.type === 'join-error') {
      off();
      current.close();
      sig = null;
      const fail = el('join-fail');
      fail.textContent = m.reason === 'banned' ? 'you have been banned from this room' : 'room not found or closed';
      show(fail);
    }
  });
  try {
    await current.connect();
    current.join(code, pseudo, getToken());
  } catch {
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
  el('btn-start').addEventListener('click', () => void startShare());
  const input = el<HTMLInputElement>('join-input');
  const submit = (): void => {
    const code = normalizeCode(input.value);
    if (isValidCode(code)) location.hash = code; // triggers route() → goJoin
    else show(el('join-error'));
  };
  el('btn-join').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    else hide(el('join-error'));
  });
}

function wireJoin(): void {
  el('btn-do-join').addEventListener('click', () => void doJoin());
  el('pseudo-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void doJoin();
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
