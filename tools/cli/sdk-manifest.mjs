import semver from "semver";
import { componentDescriptor, componentPath } from "../sdk/component.mjs";

export const sdkDistributionProtocol = 2;
export const maxManifestBytes = 256 * 1024;
const hostPattern = /^(windows|macos|linux)-(x64|arm64)$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const languages = ["luau", "odin"];

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(`Invalid SDK manifest: ${message}`);
  }
}

function object(value, name) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object`,
  );
  return value;
}

function fields(value, required, optional, name) {
  object(value, name);
  requireValue(
    required.every((key) => Object.hasOwn(value, key)),
    `${name} is missing required fields`,
  );
  requireValue(
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    `${name} contains unknown fields`,
  );
}

export function sdkReleaseVersion(value) {
  requireValue(
    typeof value === "string" &&
      value.length <= 128 &&
      semver.valid(value) === value &&
      !value.includes("+"),
    "release identity must be an exact canonical SemVer version without build metadata",
  );
  return value;
}

export function orderedSdkVersions(versions, { allowPrerelease }) {
  requireValue(typeof allowPrerelease === "boolean", "prerelease eligibility must be explicit");
  return [...new Set(versions)]
    .filter((version) => {
      try {
        sdkReleaseVersion(version);
        return allowPrerelease || semver.prerelease(version) === null;
      } catch {
        return false;
      }
    })
    .sort(semver.rcompare);
}

function reference(value, components, name) {
  fields(value, ["component", "path"], [], name);
  requireValue(
    typeof value.component === "string" &&
      idPattern.test(value.component) &&
      Object.hasOwn(components, value.component),
    `${name} references a missing component`,
  );
  componentPath(value.path);
}

export function parseSdkManifest(bytes, expectedVersion) {
  requireValue(
    bytes.byteLength > 0 && bytes.byteLength <= maxManifestBytes,
    "metadata exceeds byte limit",
  );
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  fields(
    value,
    [
      "schema",
      "version",
      "cliProtocol",
      "cliVersionRange",
      "profiles",
      "limits",
      "defaults",
      "starters",
      "components",
      "authoring",
      "contract",
      "check",
      "web",
      "languages",
      "native",
    ],
    [],
    "release",
  );
  requireValue(
    value.schema === 2 && value.cliProtocol === sdkDistributionProtocol,
    "unsupported distribution protocol; a newer byt may be required",
  );
  sdkReleaseVersion(value.version);
  requireValue(
    expectedVersion === undefined || value.version === expectedVersion,
    "release identity mismatch",
  );
  requireValue(
    typeof value.cliVersionRange === "string" &&
      value.cliVersionRange.length <= 256 &&
      semver.validRange(value.cliVersionRange) !== null,
    "invalid CLI version range",
  );

  const components = object(value.components, "components");
  requireValue(
    Object.keys(components).length > 0 && Object.keys(components).length <= 128,
    "invalid component count",
  );
  for (const [id, component] of Object.entries(components)) {
    requireValue(idPattern.test(id), "invalid component identifier");
    fields(
      component,
      ["asset", "format", "bytes", "expandedBytes", "files", "sha256", "inventorySha256"],
      [],
      `component ${id}`,
    );
    requireValue(
      typeof component.asset === "string" &&
        component.asset.length <= 160 &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.tar\.gz$/.test(component.asset),
      `invalid component asset ${id}`,
    );
    componentDescriptor(component);
  }
  reference(value.authoring, components, "authoring");
  reference(value.contract, components, "contract");
  fields(value.defaults, ["profile", "display", "assets"], [], "defaults");
  reference(value.defaults.assets, components, "default assets");
  requireValue(
    Array.isArray(value.defaults.display) &&
      value.defaults.display.length === 2 &&
      value.defaults.display.every(
        (size) => Number.isSafeInteger(size) && size > 0 && size <= 16384,
      ),
    "invalid default display",
  );

  requireValue(
    Array.isArray(value.profiles) && value.profiles.length > 0 && value.profiles.length <= 255,
    "invalid profiles",
  );
  const ids = new Set();
  const names = new Set();
  for (const profile of value.profiles) {
    fields(profile, ["id", "name", "sdk", "sdkWord", "abi", "protocol", "features"], [], "profile");
    sdkReleaseVersion(profile.sdk);
    requireValue(
      Number.isInteger(profile.id) &&
        profile.id > 0 &&
        profile.id <= 255 &&
        typeof profile.name === "string" &&
        idPattern.test(profile.name) &&
        !ids.has(profile.id) &&
        !names.has(profile.name),
      "invalid or duplicate profile identity",
    );
    for (const key of ["sdkWord", "abi", "protocol", "features"]) {
      requireValue(
        Number.isSafeInteger(profile[key]) && profile[key] >= 0 && profile[key] <= 0xffffffff,
        `invalid profile ${key}`,
      );
    }
    ids.add(profile.id);
    names.add(profile.name);
  }
  requireValue(names.has(value.defaults.profile), "default profile is unavailable");
  object(value.limits, "limits");
  requireValue(
    Object.keys(value.limits).length <= 128 &&
      Object.values(value.limits).every(Number.isSafeInteger),
    "invalid console limits",
  );
  for (const name of ["moduleBytes", "guestMemoryBytes", "luauSourceBytes"]) {
    requireValue(value.limits[name] > 0, `missing console limit ${name}`);
  }

  object(value.languages, "languages");
  object(value.starters, "starters");
  const supported = Object.keys(value.languages);
  requireValue(
    supported.length > 0 &&
      supported.every((language) => languages.includes(language)) &&
      Object.keys(value.starters).length === supported.length,
    "invalid language/starter inventory",
  );
  fields(value.check, ["runtime", "workers"], ["luauExecutor"], "check");
  reference(value.check.runtime, components, "check runtime");
  object(value.check.workers, "check workers");
  requireValue(
    Object.keys(value.check.workers).length === supported.length,
    "invalid check worker inventory",
  );
  if (supported.includes("luau")) {
    reference(value.check.luauExecutor, components, "Luau executor");
  }
  for (const language of supported) {
    const starter = value.starters[language];
    fields(starter, ["entry", "source"], [], `${language} starter`);
    requireValue(
      starter.entry === `src/main.${language}` &&
        typeof starter.source === "string" &&
        Buffer.byteLength(starter.source) > 0 &&
        Buffer.byteLength(starter.source) <= 32768,
      `invalid ${language} starter`,
    );
    const config = value.languages[language];
    fields(config, ["libraries", "hosts"], [], language);
    reference(config.libraries, components, `${language} libraries`);
    reference(value.check.workers[language], components, `${language} check worker`);
    object(config.hosts, `${language} hosts`);
    requireValue(Object.keys(config.hosts).length > 0, `no ${language} authoring hosts`);
    for (const [host, tools] of Object.entries(config.hosts)) {
      requireValue(hostPattern.test(host), "invalid authoring host");
      object(tools, `${language} host tools`);
      requireValue(
        Object.hasOwn(tools, language === "luau" ? "analyzer" : "compiler"),
        `missing ${language} host tool`,
      );
      requireValue(
        language !== "odin" || Object.hasOwn(tools, "linker"),
        "missing Odin Wasm linker",
      );
      for (const [name, tool] of Object.entries(tools)) {
        requireValue(idPattern.test(name), "invalid tool identifier");
        reference(tool, components, `${language} ${host} ${name}`);
      }
    }
  }
  fields(value.web, ["runtime", "player", "page"], [], "web");
  for (const [name, entry] of Object.entries(value.web)) {
    reference(entry, components, `web ${name}`);
  }
  object(value.native, "native players");
  for (const [host, player] of Object.entries(value.native)) {
    requireValue(hostPattern.test(host), "invalid native host");
    reference(player, components, `${host} native player`);
  }
  return value;
}

export function sdkCompatibility(manifest, { cliVersion, host, language, target, profile }) {
  if (manifest.cliProtocol !== sdkDistributionProtocol) {
    return "unsupported distribution protocol";
  }
  if (!semver.satisfies(cliVersion, manifest.cliVersionRange, { includePrerelease: true })) {
    return `SDK requires byt ${manifest.cliVersionRange}`;
  }
  if (!manifest.languages[language]?.hosts[host]) {
    return `SDK does not support ${language} authoring on ${host}`;
  }
  if (profile !== undefined && !manifest.profiles.some((item) => item.name === profile)) {
    return `SDK does not include cartridge profile ${profile}`;
  }
  if (target !== "web" && target !== "native") {
    return "unsupported player target";
  }
  if (target === "native" && !manifest.native[host]) {
    return `SDK does not include a native player for ${host}`;
  }
  return null;
}
