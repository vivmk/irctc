import type { PoolClient } from "pg";
import type { BookingStage } from "@irctc/shared-types";

const ALLOWED: Record<BookingStage, BookingStage[]> = {
  started: ["seats_held"],
  seats_held: ["payment_pending", "expired"],
  payment_pending: ["confirmed", "waitlisted", "payment_failed", "expired"],
  confirmed: ["cancelled"],
  waitlisted: ["confirmed", "cancelled"],
  payment_failed: [],
  expired: [],
  cancelled: [],
};

export async function moveStage(
  client: PoolClient,
  bookingId: string,
  from: BookingStage,
  to: BookingStage,
) {
  if (!ALLOWED[from].includes(to))
    throw new Error(`illegal move ${from} -> ${to}`);
  const r = await client.query(
    "update bookings set stage = $3 where id = $1 and stage = $2",
    [bookingId, from, to],
  );
  if (r.rowCount !== 1)
    throw new Error(`booking ${bookingId} was not in stage ${from}`);
}
