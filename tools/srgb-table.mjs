const fractionalDigits = 40n;
const decimalScale = integerPower(10n, fractionalDigits);
const rootScale = integerPower(decimalScale, 5n);
const significantDigits = 17n;

function integerPower(value, exponent) {
  let result = 1n;
  for (let index = 0n; index < exponent; index++) {
    result *= value;
  }
  return result;
}

function fifthRoot(value) {
  let root = decimalScale;
  while (true) {
    const next = (4n * root + value / integerPower(root, 4n)) / 5n;
    if (next >= root) {
      return root;
    }
    root = next;
  }
}

function decimalString(scaled) {
  if (scaled === 0n) {
    return "0.0000000000000000";
  }
  const digits = BigInt(scaled.toString().length);
  let exponent = digits - fractionalDigits - 1n;
  const roundingUnit = integerPower(10n, digits - significantDigits);
  let significand = (scaled + roundingUnit / 2n) / roundingUnit;
  if (significand === integerPower(10n, significantDigits)) {
    significand /= 10n;
    exponent++;
  }
  const text = significand.toString();
  return exponent === 0n
    ? `${text[0]}.${text.slice(1)}`
    : `0.${"0".repeat(Number(-exponent - 1n))}${text}`;
}

function decode(numerator, denominator) {
  let scaled;
  if (numerator * 100000n <= 4045n * denominator) {
    scaled = (numerator * 25n * decimalScale) / (denominator * 323n);
  } else {
    const p = numerator * 1000n + denominator * 55n;
    const q = denominator * 1055n;
    scaled = fifthRoot((integerPower(p, 12n) * rootScale) / integerPower(q, 12n));
  }
  // Forty fractional digits preserve every 17-digit rounding boundary for these 8-bit inputs.
  return decimalString(scaled);
}

export function srgbDecodeTable() {
  return Array.from({ length: 256 }, (_, index) => decode(BigInt(index), 255n));
}

export function srgbThresholdTable() {
  return Array.from({ length: 255 }, (_, index) => decode(2n * BigInt(index) + 1n, 510n));
}
