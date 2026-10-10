import { pool } from "./db";
import { grabOneSeat } from "./bookings";
import { moveStage } from "./stages";
import { addOutbox, confirmationPayload } from "./outbox";

// Try to seat the waiting bookings of one train-run and class, earliest first.
// One that doesn't fit is skipped, and the next one in line gets its chance.
export async function promoteWaitlist(
  runId: number,
  cls: string,
): Promise<number> {
  const waiting = await pool.query(
    `select id from bookings
     where run_id = $1 and class = $2 and stage = 'waitlisted'
     order by waitlisted_at, id`,
    [runId, cls],
  );
  let promoted = 0;
  for (const w of waiting.rows) {
    if (await tryPromote(w.id)) promoted++;
  }
  return promoted;
}

// The safety net: look at every waiting line. Run on a timer.
export async function promoteAllWaitlists(): Promise<number> {
  const lines = await pool.query(
    "select distinct run_id, class from bookings where stage = 'waitlisted'",
  );
  let n = 0;
  for (const l of lines.rows) n += await promoteWaitlist(l.run_id, l.class);
  return n;
}

// All passengers get seats, or nobody does.
async function tryPromote(bookingId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // lock this booking, so a cancel and a promotion can't act on it at once.
    // If someone else has it locked we WAIT (the lock is short), rather than skip it.
    const locked = await client.query(
      `select run_id, class, first_segment, last_segment from bookings
       where id = $1 and stage = 'waitlisted' for update`,
      [bookingId],
    );
    if (locked.rowCount === 0) {
      await client.query("rollback");
      return false;
    } // already handled
    const b = locked.rows[0];

    const pax = await client.query(
      "select position from booking_passengers where booking_id = $1 order by position",
      [bookingId],
    );
    for (const p of pax.rows) {
      const seat = await grabOneSeat(client, {
        runId: b.run_id,
        cls: b.class,
        first: b.first_segment,
        last: b.last_segment,
        bookingId,
      });
      if (!seat) {
        await client.query("rollback");
        return false;
      } // doesn't fit: undo everything
      await client.query(
        "update booking_passengers set coach_code = $3, seat_number = $4 where booking_id = $1 and position = $2",
        [bookingId, p.position, seat.coach, seat.seat],
      );
    }
    // grabOneSeat marks seats "held"; a promoted booking is already paid, so make them permanent
    await client.query(
      "update seat_segments set status = 'booked', held_until = null where booking_id = $1 and status = 'held'",
      [bookingId],
    );
    await moveStage(client, bookingId, "waitlisted", "confirmed");
    await addOutbox(
      client,
      bookingId,
      "booking_confirmed",
      await confirmationPayload(client, bookingId),
    );
    await client.query("commit");
    return true;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
