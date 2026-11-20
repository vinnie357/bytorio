import { Worker } from "node:worker_threads";

export async function runCheckProcess() {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65536) {
        throw new Error("SDK check request exceeds size limit");
      }
      chunks.push(chunk);
    }
    const { worker: entry, ...workerData } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const worker = new Worker(entry, { workerData });
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
    worker.on("message", send);
    worker.on("error", (error) => send({ type: "error", message: error.message }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: "error", message: error.message }) + "\n");
  }
}
