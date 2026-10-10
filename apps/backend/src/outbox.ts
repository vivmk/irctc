import type { PoolClient } from "pg";

export type OutboxType =
  | "booking_confirmed"
  | "refund_issued"
  | "booking_waitlisted"
  | "booking_cancelled";

// ON CONFLICT DO NOTHING: asking twice for the same note creates it once
export async function addOutbox(
  client: PoolClient,
  bookingId: string,
  type: OutboxType,
  payload: object,
) {
  await client.query(
    `insert into outbox (booking_id, type, payload) values ($1, $2, $3)
     on conflict (booking_id, type) do nothing`,
    [bookingId, type, JSON.stringify(payload)],
  );
}

export async function confirmationPayload(
  client: PoolClient,
  bookingId: string,
) {
  const info = await client.query(
    `select t.number as train_number, to_char(r.journey_date, 'YYYY-MM-DD') as date
     from bookings b
     join train_runs r on r.id = b.run_id
     join trains t on t.id = r.train_id
     where b.id = $1`,
    [bookingId],
  );
  const seats = await client.query(
    `select coach_code as coach, seat_number as seat
     from booking_passengers where booking_id = $1 order by position`,
    [bookingId],
  );
  return {
    bookingId,
    trainNumber: info.rows[0].train_number,
    date: info.rows[0].date,
    seats: seats.rows,
  };
}
