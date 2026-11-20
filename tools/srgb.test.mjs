import assert from "node:assert/strict";
import { test } from "node:test";
import { srgbLinearSample } from "./srgb.mjs";

test("sRGB tables retain full precision and increasing half-byte thresholds", () => {
  const decode = Array.from({ length: 256 }, (_, i) => srgbLinearSample(i, 255));
  assert.equal(decode[0], 0);
  assert.equal(decode[255], 1);
  assert.equal(srgbLinearSample(1, 25), 0.04 / 12.92);
  for (let i = 0; i < 255; i++) {
    const threshold = srgbLinearSample(i * 2 + 1, 510);
    assert.ok(decode[i] < threshold && threshold < decode[i + 1]);
  }
  // An independent floating-point evaluation checks accuracy; it is unsuitable
  // for generating exact source text because fractional powers vary across hosts.
  for (const denominator of [255, 510]) {
    for (let numerator = 0; numerator <= denominator; numerator++) {
      const value = numerator / denominator;
      const expected = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      assert.ok(Math.abs(srgbLinearSample(numerator, denominator) - expected) < 2e-15);
    }
  }
});

test("sRGB rational samples reject invalid bounds and non-integer inputs", () => {
  for (const [n, d] of [
    [-1, 255],
    [256, 255],
    [0, 0],
    [0, -1],
    [0.5, 255],
    [1, Infinity],
  ]) {
    assert.throws(() => srgbLinearSample(n, d), RangeError);
  }
});
