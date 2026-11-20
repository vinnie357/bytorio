// Evaluate the sRGB transfer function on rational samples without host libm.
// Above the linear segment, ((v + 0.055) / 1.055)^2.4 is exactly
// ((200*n + 11*d) / (211*d))^(12/5), where v = n/d.
// Thirty decimal places leave ample precision before conversion to binary64.
const scale = 10n ** 30n;

function fifthRoot(value) {
  let low = 0n;
  let high = scale + 1n;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (middle ** 5n <= value) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

export function srgbLinearSample(numerator, denominator) {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0 ||
    numerator < 0 ||
    numerator > denominator
  ) {
    throw new RangeError("sRGB sample must be a rational number between zero and one");
  }
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const fixed =
    n * 20000n <= d * 809n
      ? (n * scale * 100n) / (d * 1292n)
      : fifthRoot(((200n * n + 11n * d) ** 12n * scale ** 5n) / (211n * d) ** 12n);
  const decimal = `${fixed / scale}.${String(fixed % scale).padStart(30, "0")}`;
  return Number(decimal);
}
