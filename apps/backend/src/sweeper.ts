import { pool } from "./db";
import { moveStage } from "./stages";
import { releaseSeats } from "./seats";

// Free up seats of bookings that were never paid for.
// Bookings in payment_pending are left alone: the bank may still confirm them.
export async function sweepExpiredHolds(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const due = await client.query(
      `select id from bookings
       where stage = 'seats_held' and hold_expires_at < now()
       order by hold_expires_at
       limit 200
       for update skip locked`,
    );
    for (const row of due.rows) {
      await moveStage(client, row.id, "seats_held", "expired");
      await releaseSeats(client, row.id);
    }
    await client.query("commit");
    return due.rowCount ?? 0;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
