import pg from "pg";
import { config } from "./config";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 2000,
  max: 20,
});

// Without these, Postgres dropping one connection (restart, network blip) crashes the whole server.
pool.on("error", (e) => console.error("idle database connection lost:", e.message));
pool.on("connect", (client) => {
  client.on("error", () => {}); // a connection that dies while in use: the query itself reports it
});

export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
