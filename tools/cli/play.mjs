import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { once } from "node:events";
import { hostPlatform } from "../host-platform.mjs";
import { authorGame } from "./author.mjs";
import { startPreview } from "./preview.mjs";

export async function playGame(directory, options) {
  if (options.target === "all") {
    throw new Error("Run one player target at a time: web or native");
  }
  const game = await authorGame("build", directory, options);
  if (options.target === "native") {
    const host = hostPlatform();
    const base = resolve(game.buildRoot, "native");
    const child = spawn(resolve(base, host.player), options.playerArgs ?? [], {
      cwd: base,
      stdio: "inherit",
      windowsHide: true,
    });
    let stopping = false;
    const interrupt = () => {
      stopping = true;
      child.kill();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      const [code, signal] = await once(child, "exit");
      if (!stopping && (code !== 0 || signal)) {
        throw new Error(`Native player exited with ${signal ?? `code ${code}`}`);
      }
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
    return;
  }
  const preview = await startPreview(game, options);
  console.log("Press Ctrl+C to stop.");
  await new Promise((done) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await preview.close();
}
