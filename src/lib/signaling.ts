// WebSocket client for the signaling protocol (cf. docs/signaling-server.md).
// Transport-agnostic: inject a socket factory (and a scheduler) in tests.

export type RoomViewer = { peerId: string; pseudo: string };

export type ServerMessage =
  | { type: 'hello'; peerId: string }
  | { type: 'created'; code: string; display: string; hostToken: string; iceServers: RTCIceServer[] }
  | { type: 'joined'; hostId: string; iceServers: RTCIceServer[] }
  | { type: 'join-error'; reason: string }
  | { type: 'peer-joined'; peerId: string; pseudo: string }
  | { type: 'reclaimed'; viewers: RoomViewer[]; iceServers: RTCIceServer[] }
  | { type: 'reclaim-error'; reason: string }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'peer-left'; peerId: string; reason?: string }
  | { type: 'kicked'; banned: boolean }
  | { type: 'error'; reason: string };

// 'reconnecting' = coupure inattendue, une tentative est planifiée. 'closed' = fermé
// volontairement ou après épuisement des tentatives. L'app re-join sur un 'open' qui suit
// un 'reconnecting'.
export type ConnectionStatus = 'open' | 'reconnecting' | 'closed';

export type MessageHandler = (msg: ServerMessage) => void;
export type StatusHandler = (status: ConnectionStatus) => void;
export type SocketFactory = (url: string) => WebSocket;
export type Scheduler = (fn: () => void, ms: number) => void;

const OPEN = 1; // WebSocket.OPEN — évite de dépendre du global dans les tests.
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

export class Signaling {
  private socket: WebSocket | null = null;
  private readonly handlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly url: string;
  private readonly makeSocket: SocketFactory;
  private readonly schedule: Scheduler;
  private intentionalClose = false;
  private hasOpened = false;
  private retries = 0;

  constructor(
    url: string,
    makeSocket: SocketFactory = (u) => new WebSocket(u),
    schedule: Scheduler = (fn, ms) => {
      setTimeout(fn, ms);
    },
  ) {
    this.url = url;
    this.makeSocket = makeSocket;
    this.schedule = schedule;
  }

  /** Ouvre la connexion (tentative manuelle : réinitialise le budget de reconnexion).
   *  Résout à l'ouverture, rejette sur erreur/fermeture avant ouverture. */
  connect(): Promise<void> {
    this.retries = 0;
    return this.open();
  }

  // Ouvre un socket. Utilisé par connect() et par les tentatives de reconnexion internes
  // (qui NE réinitialisent PAS `retries`, sinon le plafond ne serait jamais atteint).
  private open(): Promise<void> {
    const previous = this.socket;
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      const socket = this.makeSocket(this.url);
      this.socket = socket;
      socket.addEventListener('message', (ev: MessageEvent) => this.dispatch(ev.data));
      socket.addEventListener(
        'open',
        () => {
          this.hasOpened = true;
          this.retries = 0; // ouverture réussie → budget rendu (le cap vise les échecs consécutifs)
          this.setStatus('open');
          resolve();
        },
        { once: true },
      );
      socket.addEventListener('error', () => reject(new Error('signaling: connexion échouée')), { once: true });
      socket.addEventListener(
        'close',
        () => {
          // Rejet no-op si la promesse est déjà résolue/rejetée ; utile seulement si le socket
          // se ferme avant de s'ouvrir (sans `error` préalable) pour ne pas la laisser pendre.
          reject(new Error('signaling: fermé avant ouverture'));
          this.onClose(socket);
        },
        { once: true },
      );
      // Fermé après réassignation : le handler close de l'ancien socket verra qu'il n'est plus courant.
      previous?.close();
    });
  }

  /** Abonne un handler aux messages serveur. Retourne la fonction de désabonnement. */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Abonne un handler au statut de connexion (open / reconnecting / closed). */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  create(): void {
    this.send({ type: 'create' });
  }
  join(code: string, pseudo: string, token: string): void {
    this.send({ type: 'join', code, pseudo, token });
  }
  /** (host) Reprend son salon après une coupure, dans la fenêtre de grâce. */
  reclaim(code: string, hostToken: string): void {
    this.send({ type: 'reclaim', code, hostToken });
  }
  signal(to: string, data: unknown): void {
    this.send({ type: 'signal', to, data });
  }
  kick(peerId: string): void {
    this.send({ type: 'kick', peerId });
  }
  ban(peerId: string): void {
    this.send({ type: 'ban', peerId });
  }
  leave(): void {
    this.send({ type: 'leave' });
  }
  close(): void {
    this.intentionalClose = true;
    this.socket?.close();
  }

  private onClose(socket: WebSocket): void {
    if (socket !== this.socket) return; // socket remplacé par un connect() : on ignore
    // Pas de reconnexion si fermeture volontaire, si on n'a jamais réussi à ouvrir
    // (l'appelant a déjà le rejet de connect()), ou si les tentatives sont épuisées.
    if (this.intentionalClose || !this.hasOpened || this.retries >= MAX_RETRIES) {
      this.setStatus('closed');
      return;
    }
    this.retries += 1;
    this.setStatus('reconnecting');
    this.schedule(() => void this.open().catch(() => {}), RETRY_DELAY_MS);
  }

  private setStatus(status: ConnectionStatus): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (err) {
        console.error('signaling: un handler de statut a levé une exception', err);
      }
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // message non-JSON : ignoré (le serveur ne devrait jamais en envoyer).
    }
    // Garde anti-crash minimale (le serveur est de confiance, pas de validation de schéma) :
    // on écarte les payloads sans `type` string, qui feraient planter les handlers.
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      return;
    }
    const msg = parsed as ServerMessage;
    // Un handler qui jette ne doit pas priver les autres du message.
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        console.error('signaling: un handler a levé une exception', err);
      }
    }
  }
}
