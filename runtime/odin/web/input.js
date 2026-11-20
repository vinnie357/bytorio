import * as constants from "./constants.js";

export const buttons = Object.freeze(
  Object.fromEntries(
    Object.entries(constants)
      .filter(([name]) => name.startsWith("BUTTON_"))
      .map(([name, value]) => [name.slice(7).toLowerCase(), value]),
  ),
);
const maximumSources = 64;

export function buttonMask(bindings = []) {
  if (Number.isInteger(bindings) && bindings >= 0 && bindings <= constants.INPUT_BUTTON_MASK) {
    return bindings;
  }
  if (!Array.isArray(bindings) || bindings.length > Object.keys(buttons).length) {
    throw new TypeError("Buttons must be a supported mask or an array of binding names");
  }
  let mask = 0;
  for (const binding of bindings) {
    if (typeof binding !== "string" || !Object.hasOwn(buttons, binding)) {
      throw new TypeError(`Unknown input binding: ${binding}`);
    }
    mask |= buttons[binding];
  }
  return mask >>> 0;
}

export function createInputState() {
  const sources = new Map();
  let pulses = 0;
  return {
    pulse(bindings) {
      pulses |= buttonMask(bindings);
    },
    set(source, value) {
      if (typeof source !== "string" || !source || source.length > 128) {
        throw new TypeError("Input source must be a nonempty string of at most 128 characters");
      }
      if (value === null) {
        sources.delete(source);
        return;
      }
      if (!value || typeof value !== "object") {
        throw new TypeError("Input state must be an object or null to release the source");
      }
      const mask = buttonMask(value.buttons);
      let pointer = null;
      if (value.pointer !== undefined) {
        const input = value.pointer;
        if (
          !input ||
          ![input.x, input.y].every(
            (number) => Number.isFinite(number) && Math.abs(number) < 2 ** 31,
          )
        ) {
          throw new TypeError("Pointer coordinates must be finite signed 32-bit coordinates");
        }
        for (const field of ["down", "right", "hover"]) {
          if (input[field] !== undefined && typeof input[field] !== "boolean") {
            throw new TypeError(`Pointer ${field} must be boolean`);
          }
        }
        pointer = {
          x: Math.floor(input.x),
          y: Math.floor(input.y),
          down: input.down === true,
          right: input.right === true,
          hover: input.hover !== false,
        };
      }
      if (!sources.has(source) && sources.size >= maximumSources) {
        throw new RangeError("Too many active input sources");
      }
      sources.set(source, { mask, pointer });
    },
    clear() {
      sources.clear();
      pulses = 0;
    },
    sample(width, height, consume = true) {
      let mask = pulses;
      if (consume) {
        pulses = 0;
      }
      let point = null;
      for (const value of sources.values()) {
        mask |= value.mask;
        if (value.pointer && !(point?.down || point?.right)) {
          point = value.pointer;
        }
      }
      const hover =
        point?.hover && point.x >= 0 && point.y >= 0 && point.x < width && point.y < height;
      if (hover) {
        mask |= buttons.pointer_hover;
        if (point.down) {
          mask |= buttons.pointer_left;
        }
        if (point.right) {
          mask |= buttons.pointer_right;
        }
      }
      return {
        buttons: mask >>> 0,
        pointer: Boolean(hover && point.down),
        x: point?.x ?? 0,
        y: point?.y ?? 0,
      };
    },
  };
}
