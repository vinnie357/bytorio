export function authorOptions(args, action) {
  const options = { directory: ".", offline: false, target: "web", port: 0, open: true };
  const seen = new Set();
  const values = new Set([
    ...(action === "build" || action === "run" ? ["--target"] : []),
    ...(action === "run" || action === "dev" ? ["--port"] : []),
    ...(action === "pack" ? ["--output", "--cover"] : []),
  ]);
  let directory = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--") {
      if (action !== "run" || options.target !== "native") {
        throw new Error("Player arguments after -- require run --target native");
      }
      options.playerArgs = args.slice(index + 1);
      break;
    }
    if (!flag.startsWith("--")) {
      if (directory) {
        throw new Error("Expected only one project directory");
      }
      directory = true;
      options.directory = flag;
      continue;
    }
    if (seen.has(flag)) {
      throw new Error(`Duplicate option: ${flag}`);
    }
    seen.add(flag);
    if (flag === "--offline") {
      options.offline = true;
    } else if (flag === "--no-open" && ["run", "dev"].includes(action)) {
      options.open = false;
    } else if (values.has(flag) && args[index + 1] && !args[index + 1].startsWith("--")) {
      const value = args[++index];
      options[flag.slice(2)] = flag === "--port" ? Number(value) : value;
    } else {
      throw new Error(`Invalid ${action} option: ${flag}`);
    }
  }
  if (!["web", "native", "all"].includes(options.target)) {
    throw new Error("Target must be web, native or all");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("Port must be an integer from 0 to 65535");
  }
  return options;
}
