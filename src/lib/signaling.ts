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

// 'reconnecting' = unexpected drop, a retry is scheduled. 'closed' = closed
// intentionally or after the retry budget is exhausted. The app re-joins on an 'open' that
// follows a 'reconnecting'.
export type ConnectionStatus = 'open' | 'reconnecting' | 'closed';

export type MessageHandler = (msg: ServerMessage) => void;
export type StatusHandler = (status: ConnectionStatus) => void;
export type SocketFactory = (url: string) => WebSocket;
export type Scheduler = (fn: () => void, ms: number) => void;

const OPEN = 1; // WebSocket.OPEN — avoids depending on the global in tests.
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

  /** Opens the connection (manual attempt: resets the reconnection budget).
   *  Resolves on open, rejects on error/close before open. */
  connect(): Promise<void> {
    this.retries = 0;
    return this.open();
  }

  // Opens a socket. Used by connect() and by the internal reconnection attempts
  // (which do NOT reset `retries`, otherwise the cap would never be reached).
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
          this.retries = 0; // successful open → budget restored (the cap targets consecutive failures)
          this.setStatus('open');
          resolve();
        },
        { once: true },
      );
      socket.addEventListener('error', () => reject(new Error('signaling: connection failed')), { once: true });
      socket.addEventListener(
        'close',
        () => {
          // No-op reject if the promise is already resolved/rejected; only useful if the socket
          // closes before opening (without a prior `error`) so it isn't left hanging.
          reject(new Error('signaling: closed before open'));
          this.onClose(socket);
        },
        { once: true },
      );
      // Closed after reassignment: the old socket's close handler will see it is no longer current.
      previous?.close();
    });
  }

  /** Subscribes a handler to server messages. Returns the unsubscribe function. */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Subscribes a handler to the connection status (open / reconnecting / closed). */
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
  /** (host) Reclaims its room after a drop, within the grace window. */
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
    if (socket !== this.socket) return; // socket replaced by a connect(): ignore
    // No reconnection if closed intentionally, if we never managed to open
    // (the caller already has connect()'s rejection), or if the retries are exhausted.
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
        console.error('signaling: a status handler threw an exception', err);
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
      return; // non-JSON message: ignored (the server should never send one).
    }
    // Minimal anti-crash guard (the server is trusted, no schema validation):
    // we discard payloads without a string `type`, which would crash the handlers.
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      return;
    }
    const msg = parsed as ServerMessage;
    // A handler that throws must not deprive the others of the message.
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        console.error('signaling: a handler threw an exception', err);
      }
    }
  }
}
