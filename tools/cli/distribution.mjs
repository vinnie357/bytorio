import { resolveSdk } from "./sdk-bundle.ts";
import { resolveSdkRelease } from "./sdk-registry.mjs";

// Explicit old releases retain their supported scaffolding path. Automatic
// project selection only considers full-authoring distributions.
export async function resolveDistribution(version, options) {
  try {
    const legacy = await resolveSdk(version, { ...options, offline: true });
    return { legacy };
  } catch (error) {
    if (error.code !== "SDK_LEGACY_MISSING") {
      throw error;
    }
  }
  try {
    return { release: await resolveSdkRelease(version, options) };
  } catch (error) {
    if (error.code !== "SDK_LEGACY_PROTOCOL") {
      throw error;
    }
    return { legacy: await resolveSdk(version, options) };
  }
}
