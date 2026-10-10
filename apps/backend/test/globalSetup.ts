import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { ADMIN_DB_URL, BASE, TEST_DB_URL, TEST_PORT } from "./constants";

const backendDir = path.resolve(import.meta.dirname, "..");
let server: ChildProcess | undefined;

const env = {
  ...process.env,
  DATABASE_URL: TEST_DB_URL,
  PORT: String(TEST_PORT),
  HOLD_SECONDS: "3", // holds expire in 3 seconds, so late-payment tests are quick
  RECONCILE_AFTER_SECONDS: "3600", // the background job stays out of the way; tests trigger it by hand
  WAITLIST_EVERY_SECONDS: "3600",
  ENABLE_FAKE_BANK: "true",
  BANK_SECRET: "test-secret",
  QUEUE_PREFIX: "irctc-test", // own queue, separate from dev
  SWEEP_EVERY_SECONDS: "3600", // tests run the sweeper by hand
  RELAY_EVERY_SECONDS: "1",
  NOTIFY_ATTEMPTS: "8",
  NOTIFY_BACKOFF_MS: "100", // fast retries
};

function runScript(file: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", file], {
    cwd: backendDir,
    env,
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`${file} failed`);
}

export async function setup() {
  // 1. make sure the test database exists
  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  const exists = await admin.query(
    "select 1 from pg_database where datname = 'irctc_test'",
  );
  if (exists.rowCount === 0) await admin.query("create database irctc_test");
  await admin.end();

  // 2. build the tables and add the seed data
  runScript("src/migrate.ts");
  runScript("src/seed.ts");

  // 3. start the backend
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: backendDir,
    env,
    stdio: "inherit",
  });

  // 4. wait until it answers
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/health`); // any answer, even 503, means the server is up
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("test server did not start");
}

export async function teardown() {
  server?.kill("SIGTERM");
}
