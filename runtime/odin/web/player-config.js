import { buttonMask } from "./input.js";

const defaults = [
  { id: "up", label: "Up", symbol: "↑", bindings: ["up", "move_up"], column: 3, row: 1 },
  { id: "left", label: "Left", symbol: "←", bindings: ["left", "move_left"], column: 1, row: 2 },
  { id: "down", label: "Down", symbol: "↓", bindings: ["down", "move_down"], column: 3, row: 2 },
  {
    id: "right",
    label: "Right",
    symbol: "→",
    bindings: ["right", "move_right"],
    column: 5,
    row: 2,
  },
  { id: "action", label: "Action", symbol: "A", bindings: ["action"], column: 11, row: 2 },
];

function table(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}
function keys(value, allowed, name) {
  table(value, name);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`Unknown ${name} setting: ${key}`);
    }
  }
}
function label(value, name, maximum = 80) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError(`${name} must be a nonempty label of at most ${maximum} characters`);
  }
  return value;
}

// This data-only module is shared with SDK authoring so invalid controls fail at build time.
export function normalizePlayerConfig(value = {}) {
  keys(value, ["title", "instructions", "controls", "diagnostics"], "player");
  if (value.diagnostics !== undefined && typeof value.diagnostics !== "boolean") {
    throw new TypeError("Player diagnostics must be boolean");
  }
  if (
    value.instructions !== undefined &&
    (typeof value.instructions !== "string" || value.instructions.length > 1000)
  ) {
    throw new TypeError("Player instructions must be text of at most 1000 characters");
  }
  const controls = value.controls ?? {};
  keys(
    controls,
    ["preset", "visibility", "pointer", "keyboard", "gamepad", "overrides", "layout"],
    "controls",
  );
  const preset = controls.preset ?? "dpad";
  const visibility = controls.visibility ?? "auto";
  if (!["dpad", "pointer", "none"].includes(preset)) {
    throw new TypeError("Controls preset must be dpad, pointer or none");
  }
  if (!["auto", "always", "never"].includes(visibility)) {
    throw new TypeError("Controls visibility must be auto, always or never");
  }
  for (const name of ["pointer", "keyboard", "gamepad"]) {
    if (controls[name] !== undefined && typeof controls[name] !== "boolean") {
      throw new TypeError(`${name} controls must be boolean`);
    }
  }
  if (
    controls.layout !== undefined &&
    (!Array.isArray(controls.layout) || controls.layout.length > 32)
  ) {
    throw new TypeError("Explicit control layouts support at most 32 buttons");
  }
  const overrides = controls.overrides ?? {};
  table(overrides, "Control overrides");
  const layout = controls.layout ?? (preset === "dpad" ? defaults : []);
  const ids = new Set();
  const buttons = layout.map((item) => {
    keys(
      item,
      ["id", "label", "symbol", "bindings", "column", "row", "columns", "rows"],
      "control",
    );
    const id = item.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || ids.has(id)) {
      throw new TypeError("Control IDs must be unique short lowercase identifiers");
    }
    ids.add(id);
    const override = overrides[id] ?? {};
    keys(
      override,
      ["label", "symbol", "bindings", "column", "row", "columns", "rows"],
      "control override",
    );
    const result = { columns: 2, rows: 1, ...item, ...override };
    result.label = label(result.label, "Control label");
    result.symbol = label(result.symbol ?? result.label, "Control symbol");
    result.bindings = buttonMask(result.bindings);
    for (const [name, maximum] of [
      ["column", 12],
      ["columns", 12],
      ["row", 4],
      ["rows", 4],
    ]) {
      if (!Number.isInteger(result[name]) || result[name] < 1 || result[name] > maximum) {
        throw new TypeError(`Invalid control ${name}`);
      }
    }
    if (result.column + result.columns > 13 || result.row + result.rows > 5) {
      throw new TypeError("Control extends beyond the 12-column, 4-row layout");
    }
    return Object.freeze(result);
  });
  if (Object.keys(overrides).some((id) => !ids.has(id))) {
    throw new TypeError("Override refers to an unknown control ID");
  }
  return Object.freeze({
    title: value.title === undefined ? "Game" : label(value.title, "Player title", 256),
    instructions: value.instructions ?? "",
    diagnostics: value.diagnostics === true,
    controls: Object.freeze({
      preset,
      visibility,
      pointer: controls.pointer !== false,
      keyboard: controls.keyboard !== false,
      gamepad: controls.gamepad !== false,
      layout: Object.freeze(buttons),
    }),
  });
}
