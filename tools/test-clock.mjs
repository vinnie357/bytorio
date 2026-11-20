import { setTimeout as delay } from "node:timers/promises";

export async function minimumDelay(
  milliseconds,
  { now = () => performance.now(), wait = delay } = {},
) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError("Minimum test delay must be a finite nonnegative duration");
  }
  const started = now();
  let remaining = milliseconds;
  while (remaining > 0) {
    await wait(Math.ceil(remaining));
    remaining = milliseconds - (now() - started);
  }
  return now() - started;
}
