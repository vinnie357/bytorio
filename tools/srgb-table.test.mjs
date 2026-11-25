import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Linter } from "eslint";

const decimalPlaces = 120n;
const decimalScale = 10n ** decimalPlaces;
const significantDigits = 17n;
const moduleUrl = new URL("./srgb-table.mjs", import.meta.url);
const generatorUrl = new URL("./generate-constants.mjs", import.meta.url);

function integerFifthRoot(value) {
  let low = 0n;
  let high = 1n;
  while (high ** 5n <= value) {
    high *= 2n;
  }
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

// All value arithmetic is BigInt; Number conversions below only size string operations.
function canonicalDecimal(scaled) {
  if (scaled === 0n) {
    return "0.0000000000000000";
  }
  const digits = BigInt(scaled.toString().length);
  let exponent = digits - 1n - decimalPlaces;
  const discardedScale = 10n ** (digits - significantDigits);
  let rounded = (scaled + discardedScale / 2n) / discardedScale;
  if (rounded === 10n ** significantDigits) {
    rounded /= 10n;
    exponent++;
  }
  const significand = rounded.toString();
  assert.equal(significand.length, 17);
  assert.ok(exponent <= 0n, "sRGB linear values are at most one");
  return exponent === 0n
    ? `${significand[0]}.${significand.slice(1)}`
    : `0.${"0".repeat(Number(-exponent - 1n))}${significand}`;
}

function exactSrgb(numerator, denominator) {
  let scaled;
  if (numerator * 20000n <= 809n * denominator) {
    scaled = (numerator * 25n * decimalScale) / (323n * denominator);
  } else {
    const p = 200n * numerator + 11n * denominator;
    const q = 211n * denominator;
    const radicand = (p ** 12n * 10n ** (5n * decimalPlaces)) / q ** 12n;
    scaled = integerFifthRoot(radicand);
  }
  return canonicalDecimal(scaled);
}

function assertCanonical(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^(?:0\.[0-9]+|1\.0{16})$/);
  if (value === "0.0000000000000000") {
    return;
  }
  const digits = value.replace(".", "").replace(/^0+/, "");
  assert.equal(digits.length, 17, `${value} must preserve 17 significant digits`);
}

test("BigInt reference fifth root floors exact powers and their neighbors", () => {
  assert.equal(integerFifthRoot(0n), 0n);
  assert.equal(integerFifthRoot(1n), 1n);
  for (const root of [2n, 3n, 123456789n]) {
    const power = root ** 5n;
    assert.equal(integerFifthRoot(power - 1n), root - 1n);
    assert.equal(integerFifthRoot(power), root);
    assert.equal(integerFifthRoot(power + 1n), root);
  }
});

test("BigInt reference rounds half up to 17 significant digits without exponent notation", () => {
  const half = 123456789012345645n * 10n ** (decimalPlaces - 18n);
  assert.equal(canonicalDecimal(half - 1n), "0.12345678901234564");
  assert.equal(canonicalDecimal(half), "0.12345678901234565");
  assert.equal(canonicalDecimal(half + 1n), "0.12345678901234565");
  const carry = 999999999999999995n * 10n ** (decimalPlaces - 18n);
  assert.equal(canonicalDecimal(carry), "1.0000000000000000");
});

test("BigInt reference matches exact rational anchors in both sRGB branches", () => {
  assert.equal(exactSrgb(0n, 255n), "0.0000000000000000");
  assert.equal(exactSrgb(323n, 25000n), "0.0010000000000000000");
  assert.equal(exactSrgb(809n, 20000n), "0.0031308049535603715");
  // Here (v + 0.055) / 1.055 = (4/5)^5, so the result is exactly (4/5)^12.
  assert.equal(exactSrgb(2907024n, 10000000n), "0.068719476736000000");
  assert.equal(exactSrgb(255n, 255n), "1.0000000000000000");
});

for (const [name, count, numerator, denominator] of [
  ["srgbDecodeTable", 256n, (index) => index, 255n],
  ["srgbThresholdTable", 255n, (index) => 2n * index + 1n, 510n],
]) {
  test(`${name} equals every exact BigInt reference entry in canonical decimal format`, async () => {
    const expected = [];
    for (let index = 0n; index < count; index++) {
      expected.push(exactSrgb(numerator(index), denominator));
    }
    expected.forEach(assertCanonical);
    const module = await import(moduleUrl.href);
    assert.equal(typeof module[name], "function", `${name} must be exported`);
    const actual = module[name]();
    assert.ok(Array.isArray(actual), `${name} must return an array`);
    assert.equal(actual.length, Number(count));
    actual.forEach(assertCanonical);
    actual.forEach((value, index) => assert.equal(value, expected[index], `${name}[${index}]`));
  });
}

function parse(source) {
  let program;
  const messages = new Linter().verify(source, [
    {
      plugins: {
        capture: {
          rules: {
            program: {
              create() {
                return {
                  Program(node) {
                    program = node;
                  },
                };
              },
            },
          },
        },
      },
      rules: { "capture/program": "error" },
    },
  ]);
  assert.deepEqual(messages, [], "static-check input must be valid JavaScript");
  assert.ok(program);
  return program;
}

function walk(node, visit) {
  if (!node || typeof node.type !== "string") {
    return;
  }
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (["parent", "tokens", "comments"].includes(key)) {
      continue;
    }
    if (Array.isArray(child)) {
      child.forEach((item) => walk(item, visit));
    } else if (child && typeof child === "object") {
      walk(child, visit);
    }
  }
}

function memberName(node) {
  return node.computed ? node.property.value : node.property.name;
}

function forbiddenOperations(roots) {
  const violations = [];
  for (const root of roots) {
    walk(root, (node) => {
      if (node.operator === "**" || node.operator === "**=") {
        violations.push(`line ${node.loc.start.line}: exponentiation operator`);
      }
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
        const member = memberName(node.callee);
        if (node.callee.object.name === "Math" && member === "pow") {
          violations.push(`line ${node.loc.start.line}: Math.pow`);
        }
        if (member === "toPrecision") {
          violations.push(`line ${node.loc.start.line}: toPrecision`);
        }
      }
    });
  }
  return violations;
}

function generatorSrgbPath(program) {
  const statement = program.body.find(
    (node) =>
      node.type === "ExpressionStatement" &&
      node.expression.type === "AssignmentExpression" &&
      node.expression.left.type === "MemberExpression" &&
      node.expression.left.object.name === "files" &&
      memberName(node.expression.left) === "runtime/odin/resources/srgb_table.odin",
  );
  assert.ok(statement, "generator must emit srgb_table.odin");
  const bindings = new Map();
  for (const node of program.body) {
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier" && declaration.init) {
          bindings.set(declaration.id.name, declaration.init);
        }
      }
    } else if (node.type === "FunctionDeclaration") {
      bindings.set(node.id.name, node);
    }
  }
  const roots = [statement.expression.right];
  const visited = new Set();
  for (let index = 0; index < roots.length; index++) {
    walk(roots[index], (node) => {
      if (node.type === "Identifier" && bindings.has(node.name) && !visited.has(node.name)) {
        visited.add(node.name);
        roots.push(bindings.get(node.name));
      }
    });
  }
  return roots;
}

test("generator sRGB path uses no exponentiation, Math.pow or toPrecision", async () => {
  const program = parse(await readFile(generatorUrl, "utf8"));
  const violations = forbiddenOperations(generatorSrgbPath(program));
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("sRGB table module uses no exponentiation, Math.pow or toPrecision", async () => {
  const program = parse(await readFile(moduleUrl, "utf8"));
  const violations = forbiddenOperations([program]);
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("generator imports and uses both tables from srgb-table.mjs", async () => {
  const program = parse(await readFile(generatorUrl, "utf8"));
  const declaration = program.body.find(
    (node) => node.type === "ImportDeclaration" && node.source.value === "./srgb-table.mjs",
  );
  assert.ok(declaration, 'generator must import from "./srgb-table.mjs"');
  const roots = generatorSrgbPath(program);
  for (const name of ["srgbDecodeTable", "srgbThresholdTable"]) {
    const specifier = declaration.specifiers.find(
      (item) => item.type === "ImportSpecifier" && item.imported.name === name,
    );
    assert.ok(specifier, `generator must import ${name}`);
    let used = false;
    for (const root of roots) {
      walk(root, (node) => {
        if (node.type === "CallExpression" && node.callee.name === specifier.local.name) {
          used = true;
        }
      });
    }
    assert.ok(used, `generator must use ${name} for srgb_table.odin`);
  }
});
