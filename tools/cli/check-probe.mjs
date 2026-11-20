import { readFile, writeFile } from "node:fs/promises";
import { checkGame } from "../sdk/check.mjs";
import { runCheckProcess } from "../sdk/check-process.mjs";
import { bundleLuau, odinEntry, odinGraphics } from "../sdk/bundle.mjs";

try {
  if (process.argv[2] === "--check-worker") {
    await runCheckProcess();
  } else if (process.argv[2] === "--bundle") {
    const request = JSON.parse(await readFile(process.argv[3], "utf8"));
    const packet = Buffer.from(request.assets, "base64");
    const source = await bundleLuau({ ...request, assets: packet });
    await writeFile(request.output, source);
    await writeFile(request.odinEntry, odinEntry({ graphicsImport: 'assets "./assets"' }));
    await writeFile(request.odinGraphics, odinGraphics({ packet, palette: request.palette }));
    console.log("Bundled SDK source");
  } else {
    const payload = JSON.parse(await readFile(process.argv[2], "utf8"));
    await checkGame(payload, { args: ["--check-worker"] });
    console.log("Checked packaged game");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
