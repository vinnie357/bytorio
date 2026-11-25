import assert from "node:assert/strict";
import { checkExecutor, loadSource } from "../../runtime/odin/web/policy.js";
import { gameSource } from "./luau-source.mjs";

export async function sourceProof(executorBytes, imports, contract, minimumBytes) {
  const source = Buffer.from(gameSource(minimumBytes));
  assert.ok(
    source.length >= minimumBytes && source.length <= 524288,
    `${source.length} source bytes`,
  );
  const game = (await WebAssembly.instantiate(executorBytes, imports)).instance.exports;
  game._initialize?.();
  assert.ok(
    game.game_source_capacity() >= 524288,
    `executor source capacity ${game.game_source_capacity()} must be at least 524288`,
  );
  loadSource(game, source);
  const started = performance.now();
  assert.doesNotThrow(
    () => game.game_init(),
    `game_init must compile ${source.length} source bytes within ${contract.limits.guestMemoryBytes} guest memory bytes`,
  );
  const duration = performance.now() - started;
  checkExecutor(game);
  const heapPeak = game.game_heap_peak();
  const memoryBytes = game.memory.buffer.byteLength;
  assert.ok(heapPeak > 0 && heapPeak <= contract.limits.luauHeapBytes, `${heapPeak} heap bytes`);
  assert.ok(memoryBytes <= contract.limits.guestMemoryBytes, `${memoryBytes} guest memory bytes`);
  return `Luau source proof: ${source.length} source bytes, ${heapPeak} heap peak bytes, ${memoryBytes} guest memory bytes, game_init ${duration.toFixed(2)} ms`;
}
