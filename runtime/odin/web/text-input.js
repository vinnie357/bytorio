import {
  TEXT_INPUT_ACTIVE,
  TEXT_INPUT_CHANGED,
  TEXT_INPUT_SUBMITTED,
  TEXT_INPUT_CANCELLED,
} from "./constants.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function validText(value, maximum) {
  if (value.length > maximum || !value.isWellFormed()) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return encoder.encode(value).length <= maximum;
}

function selectionPrefix(value, offset) {
  if (
    offset > 0 &&
    offset < value.length &&
    value.charCodeAt(offset - 1) >= 0xd800 &&
    value.charCodeAt(offset - 1) <= 0xdbff &&
    value.charCodeAt(offset) >= 0xdc00 &&
    value.charCodeAt(offset) <= 0xdfff
  ) {
    offset--;
  }
  return value.slice(0, offset);
}

// One real text input owns browser editing, selection and IME. The cartridge
// still draws its field; this transparent surface supplies native input only.
export function createTextInputOverlay({ canvas, logicalSize, send, onEditing = () => {} }) {
  const document = canvas.ownerDocument;
  let field = null;
  let input = null;
  let destroyed = false;
  const editing = () => !!input && input.getRootNode().activeElement === input;
  function reposition() {
    if (!field || !input) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const [width, height] = logicalSize();
    if (!(width > 0 && height > 0)) {
      return;
    }
    const left = bounds.left + (Math.max(0, field.x) * bounds.width) / width;
    const top = bounds.top + (Math.max(0, field.y) * bounds.height) / height;
    const right = bounds.left + (Math.min(width, field.x + field.width) * bounds.width) / width;
    const bottom = bounds.top + (Math.min(height, field.y + field.height) * bounds.height) / height;
    Object.assign(input.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(0, right - left)}px`,
      height: `${Math.max(0, bottom - top)}px`,
    });
  }
  const observer = new ResizeObserver(reposition);
  observer.observe(canvas);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  window.visualViewport?.addEventListener("resize", reposition);
  window.visualViewport?.addEventListener("scroll", reposition);
  function close() {
    const wasEditing = editing();
    field = null;
    input?.remove();
    input = null;
    if (wasEditing) {
      onEditing(false);
    }
  }
  function configure(state) {
    if (destroyed) {
      return;
    }
    const wasEditing = editing();
    close();
    if (!state || !(state.flags & TEXT_INPUT_ACTIVE)) {
      return;
    }
    const token = { ...state, sequence: 0, composing: false, last: null, terminal: false };
    field = token;
    const element = document.createElement("input");
    input = element;
    element.type = "text";
    element.autocomplete = "off";
    element.autocapitalize = "off";
    element.spellcheck = false;
    element.inputMode = "text";
    element.enterKeyHint = "done";
    element.setAttribute("aria-label", "Game text input");
    element.dataset.bytorioText = "";
    Object.assign(element.style, {
      position: "fixed",
      zIndex: "100",
      boxSizing: "border-box",
      margin: "0",
      padding: "0",
      border: "0",
      borderRadius: "0",
      outline: "none",
      background: "transparent",
      color: "transparent",
      caretColor: "transparent",
      fontSize: "16px",
      minWidth: "0",
      touchAction: "manipulation",
    });
    element.value = token.value;
    const encoded = encoder.encode(token.value);
    element.setSelectionRange(
      decoder.decode(encoded.subarray(0, token.start)).length,
      decoder.decode(encoded.subarray(0, token.end)).length,
    );
    token.acceptedStart = element.selectionStart;
    token.acceptedEnd = element.selectionEnd;
    const current = () => field === token && input === element && !token.terminal;
    function publish(flags) {
      if (!current() || token.composing) {
        return;
      }
      const raw = element.value;
      if (!validText(raw, token.maxBytes)) {
        element.value = token.value;
        element.setSelectionRange(token.acceptedStart, token.acceptedEnd);
        return;
      }
      const value = raw;
      const start = selectionPrefix(raw, element.selectionStart ?? raw.length).length;
      const end = selectionPrefix(raw, element.selectionEnd ?? raw.length).length;
      token.value = value;
      token.acceptedStart = start;
      token.acceptedEnd = end;
      const byteStart = encoder.encode(value.slice(0, start)).length;
      const byteEnd = encoder.encode(value.slice(0, end)).length;
      const fingerprint = JSON.stringify([value, byteStart, byteEnd]);
      if (flags === TEXT_INPUT_CHANGED && token.last === fingerprint) {
        return;
      }
      token.last = fingerprint;
      token.sequence += 1;
      send({
        id: token.id,
        revision: token.revision,
        sequence: token.sequence,
        value,
        start: byteStart,
        end: byteEnd,
        flags,
      });
      if (flags === TEXT_INPUT_SUBMITTED || flags === TEXT_INPUT_CANCELLED) {
        token.terminal = true;
        element.blur();
        canvas.focus({ preventScroll: true });
      }
    }
    element.addEventListener("pointerdown", (event) => {
      if (!current()) {
        return;
      }
      // Keep focus in the trusted event stack so phone browsers may open their
      // native keyboard. Never depend on a later worker response for focus.
      element.focus({ preventScroll: true });
      event.stopPropagation();
    });
    element.addEventListener("focus", () => {
      if (current()) {
        onEditing(true);
      }
    });
    element.addEventListener("blur", () => onEditing(false));
    element.addEventListener("compositionstart", () => {
      if (current()) {
        token.composing = true;
      }
    });
    element.addEventListener("compositionend", () => {
      if (!current()) {
        return;
      }
      token.composing = false;
      publish(TEXT_INPUT_CHANGED);
    });
    element.addEventListener("input", (event) => {
      if (!event.isComposing) {
        publish(TEXT_INPUT_CHANGED);
      }
    });
    element.addEventListener("select", () => publish(TEXT_INPUT_CHANGED));
    element.addEventListener("keydown", (event) => {
      if (!current()) {
        return;
      }
      event.stopPropagation();
      if (event.isComposing || token.composing || event.keyCode === 229) {
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        publish(event.key === "Enter" ? TEXT_INPUT_SUBMITTED : TEXT_INPUT_CANCELLED);
      }
    });
    element.addEventListener("keyup", (event) => event.stopPropagation());
    (canvas.parentElement || document.body).append(element);
    reposition();
    // Retain a keyboard already opened by a trusted focus when the guest
    // intentionally replaces the field. Initial mobile focus remains a tap.
    if (wasEditing || window.matchMedia("(pointer: fine)").matches) {
      element.focus({ preventScroll: true });
    }
  }
  return {
    configure,
    editing,
    reposition,
    close,
    destroy() {
      close();
      destroyed = true;
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    },
  };
}
