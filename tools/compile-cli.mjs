import { run, tool } from "./toolchain.mjs";

export function compileCli(entries, executable) {
  run(tool("bun"), [
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    ...entries,
    "--outfile",
    executable,
  ]);
  if (process.platform === "darwin") {
    run("codesign", ["--force", "--sign", "-", executable]);
    run("codesign", ["--verify", "--strict", executable]);
  }
}
