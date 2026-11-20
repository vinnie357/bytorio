import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function checkGame(
  payload,
  {
    executable = process.execPath,
    args = [fileURLToPath(new URL("./check-child.mjs", import.meta.url))],
  } = {},
) {
  const request = JSON.stringify(payload);
  if (Buffer.byteLength(request) > 65536) {
    throw new Error("SDK check request exceeds size limit");
  }
  await new Promise((done, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let executing = false;
    let pending = "";
    let diagnostic = "";
    let failure;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      failure = error;
      clearTimeout(timer);
      child.kill("SIGKILL");
    };
    let timer = setTimeout(() => finish(new Error("SDK check timed out while loading")), 10000);
    const interrupt = () => finish(new Error("SDK check interrupted"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      diagnostic = (diagnostic + data).slice(-4096);
    });
    child.stdout.on("data", (data) => {
      if (settled) {
        return;
      }
      pending += data;
      if (pending.length > 65536) {
        finish(new Error("SDK check response exceeds size limit"));
        return;
      }
      let newline;
      while (!settled && (newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("Invalid SDK check process response"));
          return;
        }
        if (message?.type === "executing" && !executing) {
          executing = true;
          clearTimeout(timer);
          timer = setTimeout(
            () => finish(new Error("Game stopped responding during SDK check")),
            1000,
          );
        } else if (message?.type === "checked" && executing) {
          finish();
        } else if (message?.type === "error" && typeof message.message === "string") {
          finish(new Error(message.message));
        } else {
          finish(new Error("Invalid SDK check process response"));
        }
      }
    });
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      if (!settled) {
        failure = new Error(
          `SDK check process exited (${signal || code})${diagnostic ? `: ${diagnostic}` : ""}`,
        );
      }
      if (failure) {
        reject(failure);
      } else {
        done();
      }
    });
    child.stdin.end(request);
  });
}
