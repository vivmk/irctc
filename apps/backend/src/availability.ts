import type { FastifyInstance } from "fastify";
import type { AvailabilityResponse, ErrorShape } from "@irctc/shared-types";
import { pool } from "./db";

type Query = {
  trainNumber?: string;
  date?: string;
  from?: string;
  to?: string;
  class?: string;
};

const bad = (message: string): ErrorShape => ({
  code: "BAD_REQUEST",
  message,
  canRetry: false,
});

export async function availabilityRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Query }>("/availability", async (req, reply) => {
    const { trainNumber, date, from, to, class: cls } = req.query;

    if (!trainNumber || !date || !from || !to || !cls) {
      return reply
        .code(400)
        .send(bad("trainNumber, date, from, to, class are required"));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send(bad("date must look like 2026-12-25"));
    }

    // 1. station codes -> stop positions on this train
    const stops = await pool.query(
      `select ts.stop_order, s.code
       from train_stops ts
       join trains t on t.id = ts.train_id
       join stations s on s.id = ts.station_id
       where t.number = $1 and s.code in ($2, $3)`,
      [trainNumber, from, to],
    );
    const fromOrder = stops.rows.find((r) => r.code === from)?.stop_order;
    const toOrder = stops.rows.find((r) => r.code === to)?.stop_order;

    if (!fromOrder || !toOrder || fromOrder >= toOrder) {
      return reply
        .code(400)
        .send(bad("stations not on this train, or in the wrong order"));
    }

    // 2. stop positions -> segments the journey uses
    const first = fromOrder;
    const last = toOrder - 1;
    const needed = last - first + 1;

    // 3. which run (train on that date)?
    const run = await pool.query(
      `select r.id from train_runs r
       join trains t on t.id = r.train_id
       where t.number = $1 and r.journey_date = $2`,
      [trainNumber, date],
    );
    if (run.rowCount === 0) {
      const err: ErrorShape = {
        code: "NO_RUN",
        message: "Train does not run on that date",
        canRetry: false,
      };
      return reply.code(404).send(err);
    }

    // 4. seats where EVERY needed segment is free
    const seats = await pool.query(
      `select s.coach_code, s.seat_number
       from seat_segments s
       join train_runs r on r.id = s.run_id
       join coaches c on c.train_id = r.train_id and c.coach_code = s.coach_code
       where s.run_id = $1
         and c.class = $2
         and s.segment_no between $3 and $4
         and s.status = 'free'
       group by s.coach_code, s.seat_number
       having count(*) = $5
       order by s.coach_code, s.seat_number`,
      [run.rows[0].id, cls, first, last, needed],
    );

    const body: AvailabilityResponse = {
      trainNumber,
      date,
      from,
      to,
      class: cls,
      segments: { first, last },
      availableCount: seats.rowCount ?? 0,
      seats: seats.rows.map((r) => ({
        coach: r.coach_code,
        seat: r.seat_number,
      })),
    };
    return body;
  });
}
