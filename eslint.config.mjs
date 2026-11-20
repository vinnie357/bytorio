import js from "@eslint/js";
import globals from "globals";
import html from "eslint-plugin-html";

export default [
  { ignores: ["**/build/**", ".tools/**", "**/node_modules/**"] },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.html"],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      ...js.configs.recommended.rules,
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["**/*.html"],
    plugins: { html },
    languageOptions: { sourceType: "script", globals: globals.browser },
  },
  {
    files: [
      "*.mjs",
      "tools/**/*.mjs",
      "experiments/**/*.mjs",
      "examples/**/tools/**/*.mjs",
      "examples/_shared/*.mjs",
      "site/**/*.mjs",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      "runtime/**/web/*.js",
      "sdk/examples/**/*.js",
      "examples/**/shared/*.js",
      "site/**/*.js",
      "experiments/vorbis-prototype/*.js",
    ],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: [
      "runtime/odin/web/audio-worklet.js",
      "tests/audio/web/capture-worklet.js",
      "experiments/vorbis-prototype/worklet.js",
    ],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: "readonly",
        registerProcessor: "readonly",
        sampleRate: "readonly",
      },
    },
  },
  {
    files: ["tests/audio/web/*.js", "tests/ogg/worker.js"],
    languageOptions: { globals: globals.worker },
  },
  {
    // Browser verification callbacks are serialized by Playwright.
    files: [
      "tools/verify-*.mjs",
      "experiments/**/*.mjs",
      "examples/**/tools/verify.mjs",
      "examples/**/tools/benchmark.mjs",
    ],
    languageOptions: {
      globals: { ...globals.browser, playerStatus: "readonly", playerAudio: "readonly" },
    },
  },
];
