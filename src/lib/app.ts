// App orchestrator: hash routing, screen switching, and handing off to the Host /
// Viewer controllers. Owns the single Signaling connection per session.

import { Signaling, type ServerMessage } from './signaling.ts';
import { HostController, supportsDisplayMedia } from './host.ts';
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
  hide(el('start-error')); // pas d'erreur périmée au retour sur l'accueil
  // Même raison que dans goJoin. Conditionné : sans getDisplayMedia, wireHome a désactivé ce
  // bouton définitivement — un reset inconditionnel le rallumerait sur mobile.
  if (supportsDisplayMedia()) el<HTMLButtonElement>('btn-start').disabled = false;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); // leave the viewer's fullscreen
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}

// --- host flow ---

async function startShare(): Promise<void> {
  teardown();
  hide(el('start-error')); // une nouvelle tentative repart d'un écran propre
  // Deux chemins de réarmement : `created` ci-dessous (on quitte l'accueil sans passer par
  // goHome), et goHome pour tous les autres — échec, ou départ pendant l'attente.
  const start = el<HTMLButtonElement>('btn-start');
  start.disabled = true; // la carte se ternit (disabled:opacity-45) — c'est le retour visuel
  sig = new Signaling(signalingUrl());
  const current = sig;
  const off = current.onMessage((m: ServerMessage) => {
    if (m.type === 'created') {
      off();
      start.disabled = false; // on quitte l'accueil : réarmé pour le retour
      history.replaceState(null, '', `#${m.code}`);
      showScreen('host');
      host = new HostController(current, m, { onEnd: goHome });
    }
  });
  try {
    await current.connect();
    current.create();
  } catch {
    // On est encore sur l'accueil (showScreen('host') n'a lieu qu'à la réception de `created`),
    // donc goHome ne change pas d'écran : il libère le socket. Le message vient après, sinon
    // goHome le masquerait aussitôt. Le chemin viewer gérait déjà ce cas ; le host, non.
    goHome(); // réarme aussi #btn-start
    show(el('start-error'));
  }
}

// --- viewer flow ---

// Raisons renvoyées par le signaling (`join-error`). Toute autre valeur retombe sur le
// message générique — le serveur peut en ajouter sans casser le front.
const JOIN_ERRORS: Record<string, string> = {
  banned: 'you have been banned from this room',
  full: 'this room is full',
  'rate-limited': 'too many attempts — wait a minute',
};

function goJoin(code: string): void {
  teardown();
  // Quitter l'écran pendant une tentative (retour accueil, deep-link) ne passe par aucune des
  // trois sorties : sans ce reset le bouton resterait « Joining… » et désactivé pour de bon.
  setJoinBusy(false);
  showScreen('join');
  setText('join-code', formatCode(code));
  hide(el('join-fail'));
  el<HTMLInputElement>('pseudo-input').focus();
}

// Chaque `setJoinBusy(true)` est apparié à un `false` sur les trois sorties (joined, join-error,
// échec réseau) : sans ça le bouton reste mort et l'écran join devient un cul-de-sac.
function setJoinBusy(busy: boolean): void {
  const btn = el<HTMLButtonElement>('btn-do-join');
  btn.disabled = busy;
  btn.textContent = busy ? 'Joining…' : 'Join the stream';
}

async function doJoin(): Promise<void> {
  const code = currentCode();
  if (!isValidCode(code)) return;
  const pseudo = el<HTMLInputElement>('pseudo-input').value.trim() || 'viewer';
  // Comme les trois autres entrées (startShare, goHome, goJoin). `doJoin` était la seule à
  // écraser `sig` sans fermer la tentative précédente : deux sockets, deux ViewerController sur
  // le même DOM (le premier plus référencé, donc jamais détruit) et surtout **deux flux encodés
  // par le host** pour une seule personne, le mesh ouvrant un peer par viewer.
  // Le garde `disabled` ci-dessous ne suffit pas : Entrée est câblé sur #pseudo-input (wireJoin),
  // pas sur le bouton, donc un bouton désactivé ne ferme que le chemin souris.
  teardown();
  setJoinBusy(true);
  sig = new Signaling(signalingUrl());
  const current = sig;
  const off = current.onMessage((m: ServerMessage) => {
    if (m.type === 'joined') {
      off();
      setJoinBusy(false); // on quitte l'écran join : réarmé pour le prochain passage
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
