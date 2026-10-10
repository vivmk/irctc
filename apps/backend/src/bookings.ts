import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import type {
  BookingRequest,
  BookingResponse,
  BookingStage,
  ErrorShape,
} from "@irctc/shared-types";
import { pool } from "./db";
import { config } from "./config";
import { resolveJourney } from "./journey";

const err = (code: string, message: string, canRetry: boolean): ErrorShape => ({
  code,
  message,
  canRetry,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(b: Partial<BookingRequest> | undefined): string | null {
  if (!b) return "body is required";
  if (!b.requestId || !UUID.test(b.requestId))
    return `requestId must be a uuid, got "${b.requestId}" (length ${b.requestId?.length})`;
  if (!b.trainNumber || !b.date || !b.from || !b.to || !b.class)
    return "trainNumber, date, from, to, class are required";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date))
    return "date must look like 2026-12-25";
  if (
    !Array.isArray(b.passengers) ||
    b.passengers.length < 1 ||
    b.passengers.length > 6
  )
    return "between 1 and 6 passengers are required";
  for (const p of b.passengers) {
    if (!p.name || !Number.isInteger(p.age) || p.age < 0 || p.age > 120)
      return "each passenger needs a name and a valid age";
    if (!["male", "female", "other"].includes(p.gender))
      return "gender must be male, female or other";
  }
  return null;
}

async function loadBooking(
  db: Pool | PoolClient,
  id: string,
): Promise<BookingResponse | null> {
  const b = await db.query(
    "select id, stage, hold_expires_at from bookings where id = $1",
    [id],
  );
  if (b.rowCount === 0) return null;
  const p = await db.query(
    `select name, coach_code, seat_number from booking_passengers
     where booking_id = $1 order by position`,
    [id],
  );
  const row = b.rows[0];
  // a hold whose time has run out is reported as expired, even before cleanup runs
  const timedOut =
    row.stage === "seats_held" && row.hold_expires_at < new Date();
  return {
    bookingId: row.id,
    stage: (timedOut ? "expired" : row.stage) as BookingStage,
    holdExpiresAt: row.hold_expires_at?.toISOString(),
    seats: p.rows.map((r) => ({
      passenger: r.name,
      coach: r.coach_code,
      seat: r.seat_number,
    })),
  };
}

// Try to hold ONE seat for the whole journey. Returns the seat, or null if none could be taken.
async function grabOneSeat(
  client: PoolClient,
  a: {
    runId: number;
    cls: string;
    first: number;
    last: number;
    bookingId: string;
  },
): Promise<{ coach: string; seat: number } | null> {
  const needed = a.last - a.first + 1;

  // a) a quick look: seats that LOOK free for every segment (free, or hold has expired)
  const candidates = await client.query(
    `select s.coach_code, s.seat_number
     from seat_segments s
     join train_runs r on r.id = s.run_id
     join coaches c on c.train_id = r.train_id and c.coach_code = s.coach_code
     where s.run_id = $1 and c.class = $2
       and s.segment_no between $3 and $4
       and (s.status = 'free' or (s.status = 'held' and s.held_until < now()))
     group by s.coach_code, s.seat_number
     having count(*) = $5
     order by s.coach_code, s.seat_number
     limit 100`,
    [a.runId, a.cls, a.first, a.last, needed],
  );

  for (const c of candidates.rows) {
    // b) lock this seat's rows. "skip locked" = if someone else is on it, don't wait, move on.
    const locked = await client.query(
      `select segment_no from seat_segments
       where run_id = $1 and coach_code = $2 and seat_number = $3
         and segment_no between $4 and $5
         and (status = 'free' or (status = 'held' and held_until < now()))
       for update skip locked`,
      [a.runId, c.coach_code, c.seat_number, a.first, a.last],
    );
    // c) did we get ALL the segments? If not, someone beat us to part of it.
    if (locked.rowCount !== needed) continue;

    // d) it's ours: mark every segment as held
    await client.query(
      `update seat_segments
       set status = 'held', booking_id = $6,
           held_until = now() + make_interval(secs => $7::double precision)
       where run_id = $1 and coach_code = $2 and seat_number = $3
         and segment_no between $4 and $5`,
      [
        a.runId,
        c.coach_code,
        c.seat_number,
        a.first,
        a.last,
        a.bookingId,
        config.holdSeconds,
      ],
    );
    return { coach: c.coach_code, seat: c.seat_number };
  }
  return null;
}

export async function bookingRoutes(app: FastifyInstance) {
  app.post<{ Body: BookingRequest }>("/bookings", async (req, reply) => {
    const problem = validate(req.body);
    if (problem)
      return reply.code(400).send(err("BAD_REQUEST", problem, false));
    const b = req.body;

    const journey = await resolveJourney(
      pool,
      b.trainNumber,
      b.date,
      b.from,
      b.to,
    );
    if (journey === "BAD_STATIONS")
      return reply
        .code(400)
        .send(
          err(
            "BAD_REQUEST",
            "stations not on this train, or in the wrong order",
            false,
          ),
        );
    if (journey === "NO_RUN")
      return reply
        .code(404)
        .send(err("NO_RUN", "Train does not run on that date", false));

    const client = await pool.connect();
    try {
      await client.query("begin");

      // 1. create the booking. If this requestId already exists, nothing is inserted.
      const created = await client.query(
        `insert into bookings (request_id, run_id, class, first_segment, last_segment,
                               stage, hold_expires_at)
         values ($1, $2, $3, $4, $5, 'seats_held',
                 now() + make_interval(secs => $6::double precision))
         on conflict (request_id) do nothing
         returning id`,
        [
          b.requestId,
          journey.runId,
          b.class,
          journey.first,
          journey.last,
          config.holdSeconds,
        ],
      );

      // 2. seen before? hand back the earlier result, change nothing
      if (created.rowCount === 0) {
        await client.query("rollback");
        const prev = await pool.query(
          "select id from bookings where request_id = $1",
          [b.requestId],
        );
        return reply.code(200).send(await loadBooking(pool, prev.rows[0].id));
      }
      const bookingId: string = created.rows[0].id;

      // 3. one seat per passenger, all inside this same all-or-nothing step
      for (let i = 0; i < b.passengers.length; i++) {
        const seat = await grabOneSeat(client, {
          runId: journey.runId,
          cls: b.class,
          first: journey.first,
          last: journey.last,
          bookingId,
        });
        if (!seat) {
          await client.query("rollback"); // release everything we grabbed so far
          return reply
            .code(409)
            .send(err("SOLD_OUT", "Not enough seats available", false));
        }
        const p = b.passengers[i];
        await client.query(
          `insert into booking_passengers
             (booking_id, position, name, age, gender, coach_code, seat_number)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [bookingId, i + 1, p.name, p.age, p.gender, seat.coach, seat.seat],
        );
      }

      await client.query("commit");
      return reply.code(201).send(await loadBooking(pool, bookingId));
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>("/bookings/:id", async (req, reply) => {
    if (!UUID.test(req.params.id))
      return reply
        .code(400)
        .send(err("BAD_REQUEST", "id must be a uuid", false));
    const booking = await loadBooking(pool, req.params.id);
    if (!booking)
      return reply.code(404).send(err("NOT_FOUND", "Booking not found", false));
    return booking;
  });
}
