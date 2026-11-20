import { createScaffolder } from "../sdk/scaffold.mjs";
import { branding, version, notices } from "../../build/cli/assets";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hostPlatform } from "../host-platform.mjs";
import { resolveDistribution } from "./distribution.mjs";
import {
  assertNewProject,
  createGameProject,
  selectProjectSdk,
  upgradeGameSdk,
} from "./project-config.mjs";
import { authorOptions } from "./arguments.mjs";
import { authorGame } from "./author.mjs";
import { playGame } from "./play.mjs";
import { developGame } from "./dev.mjs";
import { runCheckProcess } from "../sdk/check-process.mjs";

type Language = "luau" | "odin";

const help = `${branding.name} CLI ${version}

Usage: byt new <directory> [--language luau|odin] [--sdk <version>] [--offline]
       byt sdk install <version> [--offline]
       byt sdk upgrade [directory] [--sdk <version>] [--offline]
       byt check [directory] [--offline]
       byt build [directory] [--target web|native|all] [--offline]
       byt pack [directory] [--output game.png] [--cover cover.png] [--offline]
       byt run [directory] [--target web|native] [--port 0] [--no-open] [--offline]
       byt run [directory] --target native [--offline] -- [player arguments...]
       byt dev [directory] [--port 0] [--no-open] [--offline]
       byt --help
       byt --version
       byt --licenses

New games use bytorio.toml and bytorio.lock.toml, with Luau by default.
The newest compatible installed SDK is preferred; previews are eligible.
Players and tools are downloaded only when needed.
Build defaults to web. Run opens a browser and builds once; Ctrl+C stops it.
Native player arguments after -- use build/native as their working directory.`;

function sdkOptions(offline: boolean) {
  return {
    offline,
    cliVersion: version,
    host: hostPlatform().id,
    cache: process.env.BYTORIO_CACHE_DIR,
    releaseRoot: process.env.BYTORIO_SDK_RELEASE_ROOT,
    catalogueRoot: process.env.BYTORIO_SDK_CATALOGUE_URL,
    onProgress(event: { phase: string; id?: string; total?: number }) {
      if (event.id && ["start", "repair"].includes(event.phase)) {
        const size = event.total ? ` (${(event.total / 1048576).toFixed(1)} MiB)` : "";
        console.log(`Downloading SDK ${event.id}${size}...`);
      }
    },
  };
}

async function main(args: string[]): Promise<void> {
  if (args[0] === "--sdk-check" && args.length === 1) {
    await runCheckProcess();
    return;
  }
  if (args.length === 0 || (args.length === 1 && ["--help", "help"].includes(args[0]))) {
    console.log(help);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log(version);
    return;
  }
  if (args.length === 1 && args[0] === "--licenses") {
    console.log(notices);
    return;
  }
  if (args.length === 2 && args[1] === "--help") {
    console.log(help);
    return;
  }
  if (["check", "build", "pack", "run", "dev"].includes(args[0])) {
    const command = args[0];
    const parsed = authorOptions(args.slice(1), command);
    const options = { ...sdkOptions(parsed.offline), ...parsed };
    if (command === "dev") {
      await developGame(parsed.directory, options);
    } else if (command === "run") {
      await playGame(parsed.directory, options);
    } else {
      await authorGame(command, parsed.directory, options);
    }
    return;
  }
  if (["watch", "import"].includes(args[0])) {
    throw new Error(`${args[0]} is not available in this development build.`);
  }
  if (args[0] === "sdk") {
    if (args[1] === "upgrade") {
      const rest = args.slice(2);
      const sdkIndex = rest.indexOf("--sdk");
      let sdk;
      if (sdkIndex !== -1) {
        sdk = rest[sdkIndex + 1];
        if (!sdk || sdk.startsWith("--")) throw new Error("Expected --sdk <version>");
        rest.splice(sdkIndex, 2);
      }
      const parsed = authorOptions(rest, "upgrade");
      const release = await upgradeGameSdk(parsed.directory, sdk, sdkOptions(parsed.offline));
      console.log(`Pinned SDK ${release.manifest.version}. Authored configuration is unchanged.`);
      return;
    }
    if (
      args[1] !== "install" ||
      !args[2] ||
      args.length > 4 ||
      (args.length === 4 && args[3] !== "--offline")
    ) {
      throw new Error("Expected: byt sdk install <version> [--offline]");
    }
    await resolveDistribution(args[2], sdkOptions(args[3] === "--offline"));
    console.log(`SDK ${args[2]} is cached and verified`);
    return;
  }
  if (args[0] !== "new" || !args[1] || args[1].startsWith("--")) {
    throw new Error(help);
  }
  let language: Language = "luau";
  let sdk: string | undefined;
  let offline = false;
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--offline") {
      offline = true;
    } else if (flag === "--language" && ["luau", "odin"].includes(args[index + 1])) {
      language = args[++index] as Language;
    } else if (flag === "--sdk" && args[index + 1]) {
      sdk = args[++index];
    } else {
      throw new Error(`Invalid option: ${flag}`);
    }
  }
  await assertNewProject(args[1]);
  const options = sdkOptions(offline);
  const distribution = sdk ? await resolveDistribution(sdk, options) : undefined;
  if (distribution?.legacy) {
    const legacy = distribution.legacy;
    const { createProject } = await createScaffolder({
      branding: { ...branding, ...legacy.bundle.branding },
      readAsset: async (path: string) => {
        const contents = legacy.bundle.assets[path];
        if (contents === undefined) {
          throw new Error(`Missing legacy SDK asset: ${path}`);
        }
        return contents;
      },
    });
    const project = await createProject(args[1], language);
    await writeFile(
      resolve(project, "byt.lock.json"),
      JSON.stringify(
        {
          schema: 1,
          sdk: { version: legacy.manifest.version, sha256: legacy.manifest.sha256 },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    console.log("Created a legacy scaffold. Full authoring requires a protocol-2 SDK project.");
    return;
  }
  const release = await selectProjectSdk(language, sdk, options);
  const project = await createGameProject(args[1], language, release);
  console.log(`Created ${language} game: ${project}`);
  console.log(`Pinned SDK ${release.manifest.version}. Run byt run inside the project to play.`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
