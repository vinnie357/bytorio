import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameClock, parseFrameRate } from "../runtime/odin/web/frame-clock.js";

test("render rates are independent of 60 Hz simulation", () => {
  for (const fps of [1, 30, 60, 120, 144, 240, 0, -1]) {
    const clock = new FrameClock();
    let ticks = 0;
    let draws = 0;
    for (let frame = 0; frame < 720; frame++) {
      if (frame > 0) {
        clock.advance(1 / 720);
      }
      const plan = clock.take(fps);
      ticks += plan.steps;
      draws += Number(plan.render);
    }
    clock.advance(1 / 720);
    ticks += clock.take(fps).steps;
    assert.equal(ticks, 60);
    assert.equal(draws, fps > 0 ? fps : 720);
  }
});

test("native draws only on display opportunities; uncapped can draw between them", () => {
  const clock = new FrameClock();
  clock.advance(1 / 60);
  assert.deepEqual(clock.take(0, false), { steps: 1, render: false });
  assert.deepEqual(clock.take(0, true), { steps: 0, render: true });
  assert(clock.delay(0) > 0);
  assert.deepEqual(clock.take(-1, false), { steps: 0, render: true });
});

test("a slow worker preserves simulation ticks while skipping missed render opportunities", () => {
  const clock = new FrameClock();
  let ticks = 0;
  let draws = 0;
  for (let response = 0; response < 20; response++) {
    clock.advance(1 / 20);
    const plan = clock.take(30);
    ticks += plan.steps;
    draws += Number(plan.render);
  }
  assert.equal(ticks, 60);
  assert.equal(draws, 20);
  assert.deepEqual(clock.take(30), { steps: 0, render: false }, "No missed draws remain queued");
});

test("stalls drop excess tick debt and never queue missed draws", () => {
  const clock = new FrameClock();
  clock.advance(10);
  assert.deepEqual(clock.take(30), { steps: 5, render: true });
  assert.deepEqual(clock.take(30), { steps: 0, render: false });
});

test("frame rate settings reject invalid or unbounded rates", () => {
  assert.equal(parseFrameRate(), 60);
  assert.equal(parseFrameRate("native"), 0);
  assert.equal(parseFrameRate("uncapped"), -1);
  assert.equal(parseFrameRate("144"), 144);
  for (const value of ["", "0", "-1", "241", "NaN", "60.5", "Infinity", "1e2"]) {
    assert.throws(() => parseFrameRate(value), /Frame rate/);
  }
});
