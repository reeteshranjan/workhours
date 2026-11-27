// One tab plays sounds, shows notifications and runs away detection: the leader (DESIGN §7.1).
// It is chosen with a Web Lock that is held until the tab closes, and then another tab takes over.

const LOCK_NAME = 'workhours-alerts';

let leading = false;

/** Calls `onLeader` once, when this tab holds the lock. It may be right away, or much later. */
export function becomeLeaderWhenPossible(onLeader: () => void): void {
  const become = (): void => {
    leading = true;
    try {
      onLeader();
    } catch (err) {
      console.error('Starting as the alert leader failed', err);
    }
  };
  if (!navigator.locks) {
    // No Web Locks (not Chrome): assume this is the only tab.
    become();
    return;
  }
  void navigator.locks.request(LOCK_NAME, () => {
    become();
    // Never settles, so the lock is released only when the tab goes away.
    return new Promise<never>(() => {});
  });
}

export const leader = {
  get isLeader(): boolean {
    return leading;
  },
};
