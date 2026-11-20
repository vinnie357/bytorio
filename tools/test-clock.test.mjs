import assert from "node:assert/strict";
import { test } from "node:test";
import { minimumDelay } from "./test-clock.mjs";

test("minimum fixture delay survives an early timer wakeup", async () => {
  let time = 100;
  const waits = [];
  const elapsed = await minimumDelay(350, {
    now: () => time,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      time += milliseconds - 0.25;
    },
  });
  assert.ok(elapsed >= 350, `Response was released early at ${elapsed} ms`);
  assert.deepEqual(waits, [350, 1]);
});

test("zero fixture delay does not schedule a timer and invalid durations fail", async () => {
  assert.equal(
    await minimumDelay(0, { now: () => 123, wait: () => assert.fail("Unexpected timer") }),
    0,
  );
  await assert.rejects(minimumDelay(-1), RangeError);
  await assert.rejects(minimumDelay(NaN), RangeError);
});
