import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { sdkCompatibility, sdkReleaseVersion } from "./sdk-manifest.mjs";
import { resolveSdkRelease, selectSdkRelease } from "./sdk-registry.mjs";

export const projectFilename = "bytorio.toml";
export const lockFilename = "bytorio.lock.toml";
const maxConfigBytes = 1024 * 1024;
const projectKeys = new Set([
  "schema",
  "language",
  "title",
  "entry",
  "assets",
  "cover",
  "profile",
  "display",
  "content",
  "save",
  "player",
  "custom",
]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a table`);
  }
  return value;
}

export function parseProject(source) {
  const config = parse(source, { maxDepth: 64, unsafeKeyBehaviour: "throw" });
  if (config.schema !== 1) {
    throw new Error("Unsupported bytorio.toml schema; expected schema = 1");
  }
  for (const key of Object.keys(config)) {
    if (!projectKeys.has(key)) {
      throw new Error(`Unknown project setting: ${key}`);
    }
  }
  const language = config.language ?? "luau";
  if (!["luau", "odin"].includes(language)) {
    throw new Error("Project language must be luau or odin");
  }
  for (const key of ["title", "entry", "assets", "cover", "profile"]) {
    if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key])) {
      throw new Error(`Project ${key} must be a nonempty string`);
    }
  }
  return { ...config, language };
}

export function parseLock(source) {
  const pin = parse(source, { maxDepth: 8, unsafeKeyBehaviour: "throw" });
  object(pin.sdk, "Locked SDK");
  if (
    pin.schema !== 1 ||
    Object.keys(pin).some((key) => !["schema", "sdk"].includes(key)) ||
    Object.keys(pin.sdk).some((key) => !["version", "sha256"].includes(key)) ||
    typeof pin.sdk.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin.sdk.sha256)
  ) {
    throw new Error("Invalid SDK dependency pin in bytorio.lock.toml");
  }
  sdkReleaseVersion(pin.sdk.version);
  return { version: pin.sdk.version, sha256: pin.sdk.sha256 };
}

export function serializeLock(release) {
  const source = stringify({
    schema: 1,
    sdk: { version: release.manifest.version, sha256: release.sha256 },
  });
  parseLock(source);
  return source;
}

async function readConfig(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxConfigBytes) {
    throw new Error("Project configuration must be a regular file no larger than 1 MiB");
  }
  return readFile(path, "utf8");
}

export async function assertNewProject(directory) {
  directory = resolve(directory);
  try {
    await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return directory;
    }
    throw error;
  }
  throw new Error(`Project directory already exists: ${directory}`);
}

export async function selectProjectSdk(language, version, options) {
  const requirements = {
    cliVersion: options.cliVersion,
    host: options.host,
    language,
    target: options.target ?? "web",
    profile: options.profile,
  };
  if (!version) {
    return selectSdkRelease(requirements, { allowPrerelease: true, ...options });
  }
  const release = await resolveSdkRelease(version, options);
  const reason = sdkCompatibility(release.manifest, requirements);
  if (reason) {
    throw new Error(`SDK ${version}: ${reason}`);
  }
  return release;
}

export async function createGameProject(directory, language, release) {
  const starter = release.manifest.starters[language];
  if (
    !starter ||
    starter.entry !== `src/main.${language}` ||
    !["luau", "odin"].includes(language)
  ) {
    throw new Error(`SDK ${release.manifest.version} does not provide a ${language} starter`);
  }
  const pin = serializeLock(release);
  directory = await assertNewProject(directory);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  try {
    const config = { schema: 1, title: basename(directory), language };
    await mkdir(resolve(directory, "src"));
    await writeFile(resolve(directory, starter.entry), starter.source, { flag: "wx" });
    await writeFile(resolve(directory, projectFilename), stringify(config), { flag: "wx" });
    await writeFile(resolve(directory, lockFilename), pin, { flag: "wx" });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function readGameProject(directory, { allowMissingLock = false } = {}) {
  directory = await realpath(resolve(directory));
  let config;
  try {
    config = parseProject(await readConfig(resolve(directory, projectFilename)));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No ${projectFilename} found; run byt new <directory> to create a game`, {
        cause: error,
      });
    }
    throw error;
  }
  let pin;
  try {
    pin = parseLock(await readConfig(resolve(directory, lockFilename)));
  } catch (error) {
    if (error.code === "ENOENT") {
      if (allowMissingLock) {
        return { directory, config, pin: null };
      }
      throw new Error(`Missing ${lockFilename}; use byt sdk upgrade to select an exact SDK`, {
        cause: error,
      });
    }
    throw error;
  }
  return { directory, config, pin };
}

export async function upgradeGameSdk(directory, version, options) {
  const project = await readGameProject(directory, { allowMissingLock: true });
  const release = await selectProjectSdk(project.config.language, version, {
    ...options,
    profile: project.config.profile,
    preferInstalled: options.offline,
  });
  const current = await readGameProject(project.directory, { allowMissingLock: true });
  if (JSON.stringify(current) !== JSON.stringify(project)) {
    throw new Error("Project configuration or SDK pin changed during upgrade; try again");
  }
  const temporary = resolve(project.directory, `.byt-lock-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serializeLock(release), { flag: "wx" });
    await rename(temporary, resolve(project.directory, lockFilename));
  } finally {
    await rm(temporary, { force: true });
  }
  return release;
}

export async function resolveGameProject(directory, options) {
  const project = await readGameProject(directory);
  const release = await selectProjectSdk(project.config.language, project.pin.version, {
    ...options,
    profile: project.config.profile,
    expectedSha256: project.pin.sha256,
  });
  return { ...project, release };
}
