import type { PoolClient } from "pg";

// Give back a booking's held seats. Rows another booking has since taken are untouched.
export async function releaseSeats(client: PoolClient, bookingId: string) {
  await client.query(
    `update seat_segments
     set status = 'free', booking_id = null, held_until = null
     where booking_id = $1 and status = 'held'`,
    [bookingId],
  );
}
