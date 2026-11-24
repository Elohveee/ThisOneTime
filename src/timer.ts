/**
 * timer.ts: a cancellable delay backed by timer-worker.ts.
 *
 * Purpose: Give the app a `wait` function that keeps working in a hidden tab.
 * Usage:   const wait = createWorkerWait();
 *          await wait(700, abortSignal);
 * Abort:   An aborted signal rejects immediately. The worker's later message is
 *          harmlessly ignored.
 */
import type { WaitFunction } from "./types.js";

/** Creates a wait function connected to one dedicated worker. */
export function createWorkerWait(): WaitFunction {
  const worker = new Worker(chrome.runtime.getURL("timer-worker.js"), { type: "module" });
  const waiting = new Map<number, () => void>();
  let nextId = 0;

  worker.onmessage = ({ data }: MessageEvent<number>) => {
    waiting.get(data)?.();
    waiting.delete(data);
  };

  return (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const id = nextId;
      nextId += 1;
      const onAbort = (): void => {
        waiting.delete(id);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.set(id, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      worker.postMessage({ id, ms });
    });
}
