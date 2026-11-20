export const nativeHostNote = "Windows x64 or macOS Apple Silicon";
export const cliPlatforms = ["windows-x64", "macos-arm64", "macos-x64"];

export function hostPlatform(platform = process.platform, arch = process.arch) {
  const windows = platform === "win32";
  const os = windows ? "windows" : platform === "darwin" ? "macos" : platform;
  const id = `${os}-${arch}`;
  const archiveArch = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  return {
    id,
    windows,
    supported: id === "windows-x64" || id === "macos-arm64",
    cliSupported: cliPlatforms.includes(id),
    executable: windows ? "byt.exe" : "byt",
    cliAsset: windows ? "byt.exe" : `byt-${id}`,
    cliArchive: `byt-${os}-${archiveArch}.tar.gz`,
    cliManifest: windows ? "release.json" : `release-${id}.json`,
    player: windows ? "player.exe" : "player",
    sdlLibrary: windows ? "SDL3.dll" : "libSDL3.0.dylib",
  };
}

export function requireNativeHost(platform = process.platform, arch = process.arch) {
  const host = hostPlatform(platform, arch);
  if (!host.supported) {
    throw new Error(`Unsupported host ${host.id}; use ${nativeHostNote}`);
  }
  return host;
}

export function requireCliHost(platform = process.platform, arch = process.arch) {
  const host = hostPlatform(platform, arch);
  if (!host.cliSupported) {
    throw new Error(`Unsupported CLI host ${host.id}; use Windows x64 or macOS arm64/x64`);
  }
  return host;
}
