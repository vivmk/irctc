import type { Pool, PoolClient } from "pg";

export type Journey = { runId: number; first: number; last: number };

export async function resolveJourney(
  db: Pool | PoolClient,
  trainNumber: string,
  date: string,
  from: string,
  to: string,
): Promise<Journey | "BAD_STATIONS" | "NO_RUN"> {
  const stops = await db.query(
    `select ts.stop_order, s.code
     from train_stops ts
     join trains t on t.id = ts.train_id
     join stations s on s.id = ts.station_id
     where t.number = $1 and s.code in ($2, $3)`,
    [trainNumber, from, to],
  );
  const fromOrder = stops.rows.find((r) => r.code === from)?.stop_order;
  const toOrder = stops.rows.find((r) => r.code === to)?.stop_order;
  if (!fromOrder || !toOrder || fromOrder >= toOrder) return "BAD_STATIONS";

  const run = await db.query(
    `select r.id from train_runs r
     join trains t on t.id = r.train_id
     where t.number = $1 and r.journey_date = $2`,
    [trainNumber, date],
  );
  if (run.rowCount === 0) return "NO_RUN";

  return { runId: run.rows[0].id, first: fromOrder, last: toOrder - 1 };
}
