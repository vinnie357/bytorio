import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { packComponent } from "../sdk/component.mjs";
import { resolveComponent } from "./component-cache.mjs";

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "byt-component-cache-"));
  const server = createServer();
  try {
    const source = resolve(root, "source");
    await mkdir(resolve(source, "licenses"), { recursive: true });
    await writeFile(resolve(source, "tool"), "SDK tool bytes\n");
    await writeFile(resolve(source, "licenses/sdk.txt"), "SDK notice\n");
    const archive = resolve(root, "component.tar.gz");
    const descriptor = await packComponent({
      root: source,
      archive,
      executables: ["tool"],
      notices: ["licenses/sdk.txt"],
    });
    const bytes = await readFile(archive);
    let requests = 0;
    let mode = "normal";
    server.on("request", (request, response) => {
      requests++;
      if (mode === "missing") {
        response.writeHead(404).end();
      } else if (mode === "stall") {
        response.writeHead(200).flushHeaders();
      } else if (mode === "corrupt") {
        response.end(Buffer.alloc(bytes.length));
      } else if (mode === "oversize") {
        response.end(Buffer.concat([bytes, Buffer.from("extra")]));
      } else if (mode === "truncated") {
        response.end(bytes.subarray(0, -1));
      } else {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.write(bytes.subarray(0, 13));
        setImmediate(() => response.end(bytes.subarray(13)));
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    await run({
      root,
      descriptor,
      source,
      bytes,
      component: {
        id: "authoring",
        descriptor,
        url: `http://127.0.0.1:${server.address().port}/component.tar.gz`,
      },
      cache: resolve(root, "cache"),
      count: () => requests,
      setMode: (value) => {
        mode = value;
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
}

test("components download lazily, share by digest and reuse offline without network access", async () =>
  fixture(async ({ component, cache, count }) => {
    await assert.rejects(
      resolveComponent(component, { cache, offline: true }),
      /not cached.*online/,
    );
    assert.equal(count(), 0);
    const progress = [];
    const installed = await resolveComponent(component, {
      cache,
      onProgress: (event) => progress.push(event.phase),
    });
    assert.equal(count(), 1);
    assert.ok(progress.includes("download"));
    assert.equal(progress.at(-1), "ready");
    const cached = await resolveComponent(
      { ...component, id: "other-project", url: "file:///must-not-fetch" },
      { cache, offline: true },
    );
    assert.equal(cached.directory, installed.directory);
    assert.equal(count(), 1);
    assert.equal(await readFile(resolve(cached.directory, "tool"), "utf8"), "SDK tool bytes\n");
  }));

test("concurrent installations publish only complete verified instances", async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    await fixture(async ({ component, cache, count }) => {
      const settled = await Promise.allSettled(
        Array.from({ length: 4 }, () => resolveComponent(component, { cache })),
      );
      const failures = settled.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Concurrent SDK acquisition failed",
        );
      }
      const results = settled.map((result) => result.value);
      assert.ok(count() >= 1 && count() <= 4);
      for (const result of results) {
        assert.equal(await readFile(resolve(result.directory, "tool"), "utf8"), "SDK tool bytes\n");
      }
      const installed = await resolveComponent(component, { cache, offline: true });
      assert.ok(results.some((result) => result.directory === installed.directory));
      const entries = await readdir(resolve(cache, "sdk/components", component.descriptor.sha256));
      assert.ok(
        !entries.some((name) => name.startsWith(".install-")),
        "Acquisition left staging directories",
      );
    });
  }
});

test("corruption repairs atomically without moving a previous reader's instance", async () =>
  fixture(async ({ component, cache, count }) => {
    const first = await resolveComponent(component, { cache });
    const pointer = resolve(cache, "sdk/components", component.descriptor.sha256, "current.json");
    await writeFile(
      pointer,
      JSON.stringify({ schema: 1, sha256: component.descriptor.sha256, directory: "../../escape" }),
    );
    await assert.rejects(resolveComponent(component, { cache, offline: true }), /corrupt.*online/);
    const replacement = await resolveComponent(component, { cache });
    assert.notEqual(replacement.directory, first.directory);
    assert.equal(await readFile(resolve(first.directory, "tool"), "utf8"), "SDK tool bytes\n");
    await writeFile(resolve(replacement.directory, "tool"), "broken");
    await assert.rejects(resolveComponent(component, { cache, offline: true }), /corrupt/);
    const repaired = await resolveComponent(component, { cache });
    assert.notEqual(repaired.directory, replacement.directory);
    assert.equal(await readFile(resolve(repaired.directory, "tool"), "utf8"), "SDK tool bytes\n");
    assert.equal(count(), 3);
  }));

test("concurrent repairs reuse a complete winner and preserve previous readers", async () =>
  fixture(async ({ component, cache }) => {
    const previous = await resolveComponent(component, { cache });
    const pointer = resolve(cache, "sdk/components", component.descriptor.sha256, "current.json");
    for (let attempt = 0; attempt < 5; attempt++) {
      await writeFile(pointer, "corrupt record");
      const settled = await Promise.allSettled(
        Array.from({ length: 4 }, () => resolveComponent(component, { cache })),
      );
      for (const result of settled) {
        assert.equal(result.status, "fulfilled", result.reason?.stack);
        assert.equal(
          await readFile(resolve(result.value.directory, "tool"), "utf8"),
          "SDK tool bytes\n",
        );
      }
      assert.equal(await readFile(resolve(previous.directory, "tool"), "utf8"), "SDK tool bytes\n");
      await resolveComponent(component, { cache, offline: true });
    }
  }));

test("failed, oversized, truncated and stalled downloads never register a component", async () =>
  fixture(async ({ component, root, setMode }) => {
    for (const mode of ["missing", "corrupt", "oversize", "truncated", "stall"]) {
      setMode(mode);
      const cache = resolve(root, mode);
      await assert.rejects(resolveComponent(component, { cache, timeoutMs: 200 }));
      await assert.rejects(resolveComponent(component, { cache, offline: true }), /not cached/);
      assert.deepEqual(
        await readdir(resolve(cache, "sdk/components", component.descriptor.sha256)),
        [],
      );
      setMode("normal");
      await resolveComponent(component, { cache });
    }
  }));

test("incomplete prior acquisitions are ignored and different payload digests stay independent", async () =>
  fixture(async ({ component, root, cache, source, count }) => {
    const parent = resolve(cache, "sdk/components", component.descriptor.sha256);
    await mkdir(resolve(parent, ".install-interrupted/payload"), { recursive: true });
    await writeFile(resolve(parent, ".install-interrupted/payload/tool"), "partial");
    await assert.rejects(resolveComponent(component, { cache, offline: true }), /not cached/);
    const first = await resolveComponent(component, { cache });
    await writeFile(resolve(source, "tool"), "Different SDK bytes\n");
    const archive = resolve(root, "different.tar.gz");
    const descriptor = await packComponent({
      root: source,
      archive,
      executables: ["tool"],
      notices: ["licenses/sdk.txt"],
    });
    assert.notEqual(descriptor.sha256, component.descriptor.sha256);
    await assert.rejects(
      resolveComponent({ ...component, descriptor }, { cache, offline: true }),
      /not cached/,
    );
    assert.equal(
      (await resolveComponent(component, { cache, offline: true })).directory,
      first.directory,
    );
    assert.equal(count(), 1);
  }));
