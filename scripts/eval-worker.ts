// Child process of npm run eval -- --concurrency N: runs one group of cases (one chain, or one case) in order, each on
// the data dir the parent gave it, and sends each outcome back over IPC as it finishes. TRADEFLOW_DATA_DIR is
// process-wide, so each group gets its own process. Started only by scripts/eval.ts; it reads nothing from the
// command line. Runs under tsx as CommonJS: no top-level await.
import { runCaseHere, type RunJob } from "./eval-cases";

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("scripts/eval-worker.ts runs only as a child of scripts/eval.ts."));
      return;
    }
    process.send(message, undefined, {}, (error) => (error ? reject(error) : resolve()));
  });
}

async function work(jobs: RunJob[]): Promise<void> {
  for (const job of jobs) {
    const outcome = await runCaseHere(job);
    await send({ id: job.id, ...outcome });
  }
}

process.once("message", (message: { jobs: RunJob[] }) => {
  work(message.jobs).then(
    () => process.disconnect(),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      process.disconnect();
    },
  );
});
