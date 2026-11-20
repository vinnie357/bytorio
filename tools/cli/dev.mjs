import { watch } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { authorGame } from "./author.mjs";
import { startPreview } from "./preview.mjs";

export function watchesProjectFile(filename) {
  if (!filename) {
    return true;
  }
  const parts = String(filename).replaceAll("\\", "/").split("/");
  return (
    !["build", ".bytorio", ".git", ".luaurc", ".gitignore"].includes(parts[0]) &&
    !parts.at(-1).startsWith(".byt-lock-")
  );
}

export async function developGame(directory, options) {
  directory = await realpath(resolve(directory));
  let dirty = true;
  let stopped = false;
  let preview;
  let wake;
  let timer;
  let watchError;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const stop = () => {
    stopped = true;
    notify();
  };
  const watcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (!watchesProjectFile(filename)) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      dirty = true;
      notify();
    }, 150);
  });
  watcher.on("error", (error) => {
    watchError = error;
    stop();
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Watching game sources. Press Ctrl+C to stop.");
  try {
    while (!stopped) {
      if (!dirty) {
        await new Promise((done) => {
          wake = done;
        });
      }
      if (stopped) {
        break;
      }
      dirty = false;
      try {
        const game = await authorGame("build", directory, { ...options, target: "web" });
        if (stopped) {
          break;
        }
        if (preview) {
          await preview.update(game);
          console.log("Rebuilt game; browser reloaded.");
        } else {
          preview = await startPreview(game, { ...options, reload: true });
        }
      } catch (error) {
        console.error(`Build failed: ${error.message}\nWaiting for another edit.`);
      }
    }
    if (watchError) {
      throw watchError;
    }
  } finally {
    clearTimeout(timer);
    watcher.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await preview?.close();
  }
}
