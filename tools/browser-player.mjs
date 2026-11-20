// Bind the public host controller once so polling reads synchronous snapshots.
export async function bindPlayer(page) {
  await page.evaluate(async () => {
    globalThis.hostedPlayer = (await import("./bootstrap.js")).player;
  });
}
