/**
 * timer-worker.ts: a tiny background timer.
 *
 * Purpose:  Keep request pacing accurate while the tab is hidden.
 * Why:      Chrome can slow chained page timers in hidden tabs to about once
 *           per minute. Timers in a dedicated worker are not throttled that way.
 * Protocol: Receives `{ id, ms }`, then posts `id` back after `ms`.
 */
interface TimerRequest {
  id: number;
  ms: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<TimerRequest>) => void) | null;
  postMessage(id: number): void;
};

scope.onmessage = ({ data }) => {
  setTimeout(() => scope.postMessage(data.id), data.ms);
};
