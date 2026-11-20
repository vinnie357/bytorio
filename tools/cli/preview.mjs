import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { snapshotWeb, removeGenerated } from "./output.mjs";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export async function openBrowser(url) {
  let executable;
  let args;
  if (process.platform === "darwin") {
    executable = "/usr/bin/open";
    args = [url];
  } else if (process.platform === "win32") {
    const system = process.env.SystemRoot ?? process.env.WINDIR;
    if (!system) {
      throw new Error(
        "Windows system directory is unavailable; open the printed player URL manually",
      );
    }
    executable = resolve(system, "System32/rundll32.exe");
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    throw new Error("Open the printed player URL in your browser");
  }
  await new Promise((done, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Browser launch timed out"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done();
      } else {
        reject(new Error("Browser launch failed"));
      }
    });
  });
}

export async function startPreview(project, { port = 0, open = true, reload = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be an integer from 0 to 65535");
  }
  const snapshots = new Map();
  const clients = new Map();
  let current;
  let previous;
  let closed = false;
  async function prune() {
    for (const [id, snapshot] of snapshots) {
      if (
        id !== current &&
        id !== previous &&
        ![...clients.values()].includes(id) &&
        !snapshot.readers
      ) {
        snapshots.delete(id);
        await removeGenerated(snapshot.root);
      }
    }
  }
  async function update(game) {
    if (closed) {
      throw new Error("Preview is closed");
    }
    const root = await realpath(await snapshotWeb(game.directory, resolve(game.buildRoot, "web")));
    const id = basename(root);
    snapshots.set(id, { root, entry: game.release.manifest.web.page.path, readers: 0 });
    previous = current;
    current = id;
    for (const response of clients.keys()) {
      response.write(`data: ${current}\n\n`);
    }
    await prune();
  }
  await update(project);
  const server = createServer(async (request, response) => {
    let snapshot;
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url, "http://localhost");
      if (reload && url.pathname === "/__byt/client.js") {
        response
          .writeHead(200, { "Content-Type": types[".js"], "Cache-Control": "no-store" })
          .end(
            "const id = document.currentScript.dataset.generation;\n" +
              'const changes = new EventSource("/__byt/events?id=" + encodeURIComponent(id));\n' +
              'changes.onmessage = event => { if (event.data !== id) location.replace("/" + location.search); };\n' +
              'addEventListener("pagehide", () => changes.close(), { once: true });\n',
          );
        return;
      }
      if (reload && url.pathname === "/__byt/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        clients.set(response, url.searchParams.get("id"));
        response.write(`data: ${current}\n\n`);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
        response.once("close", () => {
          clearInterval(heartbeat);
          clients.delete(response);
          void prune().catch((error) => console.error(error.message));
        });
        return;
      }
      if (url.pathname === "/") {
        const entry = snapshots.get(current).entry;
        response
          .writeHead(302, {
            Location: `${reload ? `/__byt/pages/${current}` : ""}/${entry}${url.search}`,
          })
          .end();
        return;
      }
      let pathname = url.pathname;
      let id = current;
      if (reload) {
        const match = /^\/__byt\/pages\/([^/]+)(\/.*)$/.exec(pathname);
        if (!match) {
          response.writeHead(404).end();
          return;
        }
        [, id, pathname] = match;
      }
      snapshot = snapshots.get(id);
      if (!snapshot) {
        response.writeHead(404).end();
        return;
      }
      snapshot.readers++;
      const { root } = snapshot;
      const path = resolve(root, `.${decodeURIComponent(pathname)}`);
      if (!path.startsWith(root + sep) || !(await realpath(path)).startsWith(root + sep)) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(path);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const html =
        reload && pathname === `/${snapshot.entry}`
          ? (await readFile(path, "utf8")).replace(
              /<head(?:\s[^>]*)?>/i,
              (head) => `${head}<script src="/__byt/client.js" data-generation="${id}"></script>`,
            )
          : null;
      response.writeHead(200, {
        "Content-Type": types[extname(path)] ?? "application/octet-stream",
        "Content-Length": html === null ? info.size : Buffer.byteLength(html),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
      } else if (html !== null) {
        response.end(html);
      } else {
        await pipeline(createReadStream(path), response);
      }
    } catch {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(404).end("Not found");
      }
    } finally {
      if (snapshot) {
        snapshot.readers--;
      }
    }
  });
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", done);
    });
  } catch (error) {
    await Promise.all([...snapshots.values()].map(({ root }) => removeGenerated(root)));
    throw error;
  }
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Player: ${url}`);
  if (open) {
    try {
      await openBrowser(url);
    } catch (error) {
      console.error(`${error.message}. The player is available at ${url}`);
    }
  }
  return {
    url,
    update,
    async close() {
      closed = true;
      for (const response of clients.keys()) {
        response.end();
      }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await Promise.all([...snapshots.values()].map(({ root }) => removeGenerated(root)));
    },
  };
}
