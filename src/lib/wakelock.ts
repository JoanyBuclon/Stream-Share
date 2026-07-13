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
