import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGame } from "./check.mjs";

function child(source) {
  return { args: ["--input-type=module", "-e", source] };
}

test("check process rejects early exit, failed launch and malformed responses", async () => {
  await assert.rejects(checkGame({}, { executable: "missing-byt-check-executable" }), /ENOENT/);
  await assert.rejects(checkGame({}, child("process.exit(7)")), /exited \(7\)/);
  for (const response of ["not JSON\n", '{"type":"checked"}\n', '{"type":"unknown"}\n']) {
    await assert.rejects(
      checkGame({}, child(`process.stdout.write(${JSON.stringify(response)})`)),
      /Invalid SDK check process response/,
    );
  }
});

test("check process bounds output and preserves SDK error diagnostics", async () => {
  await assert.rejects(checkGame({ path: "x".repeat(65536) }), /request exceeds size limit/);
  await assert.rejects(
    checkGame({}, child('process.stdout.write("x".repeat(65537))')),
    /response exceeds size limit/,
  );
  await assert.rejects(
    checkGame(
      {},
      child(
        'process.stdout.write(JSON.stringify({type:"error",message:"Guest ABI rejected"}) + "\\n")',
      ),
    ),
    /Guest ABI rejected/,
  );
});

test("check process accepts fragmented progress followed by checked and reaps the process", async () => {
  await checkGame(
    {},
    child(`
    process.stdout.write('{"type":"exec');
    setTimeout(() => {
      process.stdout.write('uting"}\\n{"type":"checked"}\\n');
      setInterval(() => {}, 1000);
    }, 10);
  `),
  );
});
