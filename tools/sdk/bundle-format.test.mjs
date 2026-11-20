import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { odinEntry } from "./bundle.mjs";
import { formatSource } from "../code-tools.mjs";

test("generated Odin entries already match the pinned formatter", () => {
  for (const display of ["High", "Low"]) {
    for (const graphicsImport of ['"assets"', 'assets "./bytorio_assets"']) {
      const source = odinEntry({ display, graphicsImport });
      assert.equal(source, formatSource(source, "cartridge.odin"));
    }
  }
});

test("regenerating tracked example entries leaves their bytes unchanged", async () => {
  for (const [example, display] of [
    ["racing", "Low"],
    ["rpg", "High"],
  ]) {
    assert.equal(
      odinEntry({ display }),
      (await readFile(`examples/${example}/odin/cartridge.odin`, "utf8")).replaceAll("\r\n", "\n"),
    );
  }
});
