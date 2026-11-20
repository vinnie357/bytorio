import { readFile } from "node:fs/promises";
import { resolveSdkRelease } from "./sdk-registry.mjs";
import { loadReleasedAuthoring } from "./released-sdk.mjs";
import { checkGame } from "../sdk/check.mjs";
import { runCheckProcess } from "../sdk/check-process.mjs";

try {
  if (process.argv[2] === "--sdk-check") {
    await runCheckProcess();
  } else {
    const request = JSON.parse(await readFile(process.argv[2], "utf8"));
    const release = await resolveSdkRelease(request.version, request.options);
    const authoring = await loadReleasedAuthoring(release, {
      ...request.options,
      check: (payload) => checkGame(payload, { args: ["--sdk-check"] }),
    });
    if (request.action === "check") {
      await authoring.checkProject(request.project, request.config);
    } else if (request.action === "pack") {
      await authoring.packProject(request.project, request.config);
    } else {
      await authoring.buildProject(request.project, request.config, {
        targets: request.targets ?? ["web"],
      });
    }
    console.log("Standalone SDK authoring passed");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
