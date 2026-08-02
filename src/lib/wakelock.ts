// Keeps the device awake during a session (host sharing / viewer watching). The browser drops
// the lock whenever the tab is hidden, so we re-acquire on visibilitychange. Best-effort and
// no UI: unsupported / denied browsers throw in the factory, which the acquire() catch swallows.
//
// The lock factory is injected (defaulting to the real API) so the acquire/release races are
// unit-testable without a browser.

export type LockFactory = () => Promise<WakeLockSentinel>;

export class WakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private active = false; // "should hold" — drives re-acquisition on visibility
  private acquiring = false; // an acquire() is in flight (guards concurrent requests)
  private readonly requestLock: LockFactory;

  constructor(requestLock: LockFactory = () => navigator.wakeLock.request('screen')) {
    this.requestLock = requestLock;
  }

  private readonly onVisible = (): void => {
    if (this.active && document.visibilityState === 'visible') void this.acquire();
  };

  /** Start holding the lock (and keep re-taking it while the session is active). */
  async request(): Promise<void> {
    if (this.active) return;
    this.active = true;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
    await this.acquire();
  }

  private async acquire(): Promise<void> {
    if (this.sentinel || this.acquiring) return;
    this.acquiring = true;
    try {
      const sentinel = await this.requestLock();
      if (!this.active) {
        void sentinel.release().catch(() => {}); // released while acquiring → don't hold it
        return;
      }
      this.sentinel = sentinel;
      // Browser auto-releases when hidden; forget only THIS sentinel so onVisible re-acquires.
      sentinel.addEventListener('release', () => (this.sentinel === sentinel ? (this.sentinel = null) : undefined), { once: true });
    } catch {
      // unsupported / denied / not visible — best-effort, nothing to do
    } finally {
      this.acquiring = false;
    }
  }

  release(): void {
    this.active = false; // makes any in-flight acquire() drop its sentinel on resolve
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    void this.sentinel?.release().catch(() => {});
    this.sentinel = null;
  }
}

/**
 * The wake lock to use for a session — the desktop shell's, when there is one.
 *
 * The shell holds a process-level `powerSaveBlocker`, which is not tied to a document and therefore
 * survives the window being hidden — unlike the sentinel above, which the browser releases the
 * instant it is. That is the whole feature; the measurement behind it is in docs/desktop.md
 * § Confort système.
 *
 * A sibling rather than a second mode inside `WakeLock`: everything that class exists for (the
 * sentinel, the acquiring guard, the visibilitychange re-acquire) is dead weight on this path, and
 * keeping it out means the class — and its existing tests — stay exactly as they were.
 */
export function createWakeLock(): Pick<WakeLock, 'request' | 'release'> {
  const native = typeof window === 'undefined' ? undefined : window.native;
  if (!native) return new WakeLock();
  // Swallowing, to match WakeLock: its release() cannot throw, and both callers run it near the TOP
  // of destroy() — so an IPC that threw here would skip closing the peers and tearing down the
  // audio, trading "the screen sleeps" for "WASAPI clients and peers stay alive".
  // ponytail: no `active` bookkeeping — the shell collapses repeated toggles on its own id.
  const toggle = (on: boolean): void => {
    try {
      native.setWakeLock(on);
    } catch {
      // The display sleeping is a degradation, never a reason to break a session.
    }
  };
  return { request: async () => toggle(true), release: () => toggle(false) };
}
