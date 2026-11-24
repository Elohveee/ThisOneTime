/**
 * tab.ts: keeps one healthy ThisOneTime tab in charge.
 *
 * Purpose:  Prevent two tabs from running the same queue, and reduce the chance
 *           of Chrome suspending a long backup.
 * Lock:     Chrome releases the Web Lock automatically when the tab closes.
 * Discard:  Disabling auto-discard needs no extra extension permission.
 */

/**
 * Claims the app for this tab until it closes.
 *
 * @returns False when another ThisOneTime tab already holds the lock.
 */
export function claimTab(): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request("thisonetime-queue", { ifAvailable: true }, (lock) => {
      resolve(Boolean(lock));
      // A promise that never resolves holds the lock for the tab's lifetime.
      return lock ? new Promise<void>(() => undefined) : undefined;
    });
  });
}

/** Asks Chrome not to discard this tab to save memory during a long backup. */
export async function preventTabDiscard(): Promise<void> {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.update(tab.id, { autoDiscardable: false });
}
