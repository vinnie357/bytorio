export function manifestFixture(version = "0.2.0-preview.1") {
  const reference = (path) => ({ component: "core", path });
  return {
    schema: 2,
    version,
    cliProtocol: 2,
    cliVersionRange: ">=0.1.0-0 <1.0.0",
    profiles: [
      {
        id: 2,
        name: "resource-av-1",
        sdk: "0.2.0",
        sdkWord: 512,
        abi: 2,
        protocol: 4,
        features: 7,
      },
    ],
    limits: { moduleBytes: 8388608, guestMemoryBytes: 8388608, luauSourceBytes: 8388608 },
    defaults: {
      profile: "resource-av-1",
      display: [640, 360],
      assets: reference("sdk/templates/assets.json"),
    },
    starters: {
      luau: { entry: "src/main.luau", source: "return {}\n" },
      odin: { entry: "src/main.odin", source: "package main\n" },
    },
    components: {
      core: {
        asset: "sdk-core.tar.gz",
        format: "tar.gz",
        bytes: 128,
        expandedBytes: 512,
        files: 2,
        sha256: "0".repeat(64),
        inventorySha256: "1".repeat(64),
      },
    },
    authoring: reference("authoring.mjs"),
    contract: reference("sdk/contract.json"),
    check: {
      runtime: reference("runtime.wasm"),
      luauExecutor: reference("luau-executor.wasm"),
      workers: { luau: reference("check-worker.mjs"), odin: reference("check-worker.mjs") },
    },
    web: {
      runtime: reference("web/runtime.js"),
      player: reference("web/player.js"),
      page: reference("web/player.html"),
    },
    languages: {
      luau: {
        libraries: reference("sdk/luau"),
        hosts: {
          "windows-x64": { analyzer: reference("luau-analyze.exe") },
          "macos-arm64": { analyzer: reference("luau-analyze") },
          "macos-x64": { analyzer: reference("luau-analyze") },
        },
      },
      odin: {
        libraries: reference("sdk/odin"),
        hosts: {
          "windows-x64": {
            compiler: reference("odin.exe"),
            linker: reference("bin/wasm-ld.exe"),
          },
          "macos-arm64": { compiler: reference("odin"), linker: reference("bin/wasm-ld") },
        },
      },
    },
    native: {
      "windows-x64": reference("native/player.exe"),
      "macos-arm64": reference("native/player"),
    },
  };
}
