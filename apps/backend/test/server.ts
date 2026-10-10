import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { TEST_DB_URL } from "./constants";

const backendDir = path.resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Copy = { child: ChildProcess; base: string };

export async function startServer(
  port: number,
  extraEnv: Record<string, string> = {},
): Promise<Copy> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: backendDir,
    stdio: "ignore",
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      PORT: String(port),
      HOLD_SECONDS: "3",
      RECONCILE_AFTER_SECONDS: "3600",
      WAITLIST_EVERY_SECONDS: "3600",
      ENABLE_FAKE_BANK: "true",
      BANK_SECRET: "test-secret",
      QUEUE_PREFIX: "irctc-test", // same queue and locks as the main test server = "two copies"
      SWEEP_EVERY_SECONDS: "3600",
      RELAY_EVERY_SECONDS: "1",
      NOTIFY_ATTEMPTS: "8",
      NOTIFY_BACKOFF_MS: "100",
      ...extraEnv,
    },
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${base}/health`); // any answer, even 503, means it is up
      return { child, base };
    } catch {
      await sleep(500);
    }
  }
  child.kill("SIGKILL");
  throw new Error(`server on port ${port} did not start`);
}

// resolves with the exit code (null if it was killed by a signal)
export function stopServer(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
    child.kill(signal);
  });
}
