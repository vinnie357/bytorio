import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cliReleasePlatform, verifyReleaseArchive, verifyReleaseAsset } from "./release-config.mjs";
import { run } from "./toolchain.mjs";

export async function createCliArchive(release, manifest, executable, directory) {
  const host = cliReleasePlatform(manifest.platform);
  verifyReleaseAsset(release, manifest, await readFile(executable), host.id);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(resolve(directory, "archive-staging-"));
  if (dirname(staging) !== resolve(directory)) {
    throw new Error("Archive staging escaped the output directory");
  }
  const archive = resolve(directory, host.cliArchive);
  try {
    const staged = resolve(staging, host.executable);
    await copyFile(executable, staged);
    await chmod(staged, 0o755);
    run(
      "tar",
      [
        "--format=ustar",
        "--uid",
        "0",
        "--gid",
        "0",
        "--uname",
        "root",
        "--gname",
        "root",
        "-czf",
        archive,
        "-C",
        staging,
        host.executable,
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const bytes = await readFile(archive);
    const result = {
      ...manifest,
      archive: {
        asset: host.cliArchive,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    await verifyCliArchive(release, result, archive);
    return result;
  } finally {
    // mkdtemp created this child of the caller's output directory.
    await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyCliArchive(release, manifest, path) {
  const host = cliReleasePlatform(manifest.platform);
  verifyReleaseArchive(release, manifest, await readFile(path), host.id);
  const entries = run("tar", ["-tzf", path]).trim().split(/\r?\n/);
  if (entries.length !== 1 || entries[0] !== host.executable) {
    throw new Error("CLI archive must contain only the executable at its root");
  }
  // Stream the member to stdout instead of extracting archive paths to disk.
  const payload = run("tar", ["-xOzf", path, host.executable], {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  verifyReleaseAsset(release, manifest, payload, host.id);
}
