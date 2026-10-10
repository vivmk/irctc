import type { FastifyInstance } from "fastify";
import type {
  BookingStage,
  CancelResponse,
  ErrorShape,
} from "@irctc/shared-types";
import { pool } from "./db";
import { config } from "./config";
import { clockNow } from "./clock";
import { moveStage } from "./stages";
import { addOutbox } from "./outbox";
import { refundFor } from "./refund";
import { processRefunds } from "./payments";
import { promoteWaitlist } from "./waitlist";

const err = (code: string, message: string, canRetry: boolean): ErrorShape => ({
  code,
  message,
  canRetry,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function summary(id: string): Promise<CancelResponse> {
  const r = await pool.query(
    `select b.stage, p.status, p.refund_amount_paise
     from bookings b left join payments p on p.booking_id = b.id where b.id = $1`,
    [id],
  );
  const row = r.rows[0];
  const refundPaise: number = row.refund_amount_paise ?? 0;
  return {
    bookingId: id,
    stage: row.stage,
    refundPaise,
    refundStatus:
      refundPaise === 0
        ? "none"
        : row.status === "refunded"
          ? "refunded"
          : "refund_pending",
  };
}

export async function cancelRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/bookings/:id/cancel",
    async (req, reply) => {
      const id = req.params.id;
      if (!UUID.test(id))
        return reply
          .code(400)
          .send(err("BAD_REQUEST", "id must be a uuid", false));

      let freed: { runId: number; cls: string } | null = null;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const bk = await client.query(
          "select id, stage, run_id, class, first_segment from bookings where id = $1 for update",
          [id],
        );
        if (bk.rowCount === 0) {
          await client.query("rollback");
          return reply
            .code(404)
            .send(err("NOT_FOUND", "Booking not found", false));
        }
        const b = bk.rows[0];

        // cancelling twice gives the same answer and does nothing the second time
        if (b.stage === "cancelled") {
          await client.query("rollback");
          return reply.code(200).send(await summary(id));
        }
        if (b.stage !== "confirmed" && b.stage !== "waitlisted") {
          await client.query("rollback");
          return reply
            .code(409)
            .send(err("WRONG_STAGE", `booking is ${b.stage}`, false));
        }

        // when does the train leave from THIS passenger's boarding station?
        const dep = await client.query(
          `select ((r.journey_date + ts.day_offset) + ts.departure_time) at time zone 'Asia/Kolkata' as departs_at
         from train_runs r
         join train_stops ts on ts.train_id = r.train_id and ts.stop_order = $2
         where r.id = $1`,
          [b.run_id, b.first_segment],
        );
        const hoursBefore =
          (dep.rows[0].departs_at.getTime() - clockNow()) / 3_600_000;
        if (hoursBefore <= 0) {
          await client.query("rollback");
          return reply
            .code(409)
            .send(err("TOO_LATE", "The train has already departed", false));
        }

        const pay = await client.query(
          "select id, amount_paise from payments where booking_id = $1 and status = 'succeeded' for update",
          [id],
        );
        if (pay.rowCount === 0)
          throw new Error(`booking ${id} has no successful payment`);
        const pax = await client.query(
          "select count(*)::int as n from booking_passengers where booking_id = $1",
          [id],
        );

        const refund = refundFor(
          {
            amountPaise: pay.rows[0].amount_paise,
            passengers: pax.rows[0].n,
            hoursBefore,
            waitlisted: b.stage === "waitlisted",
          },
          config.cancelFeePaise,
        );

        if (b.stage === "confirmed") {
          await client.query(
            `update seat_segments set status = 'free', booking_id = null, held_until = null
           where booking_id = $1`,
            [id],
          );
          freed = { runId: b.run_id, cls: b.class };
        }
        await moveStage(client, id, b.stage as BookingStage, "cancelled");

        if (refund > 0) {
          await client.query(
            "update payments set status = 'refund_pending', refund_amount_paise = $2, updated_at = now() where id = $1",
            [pay.rows[0].id, refund],
          );
        } else {
          await client.query(
            "update payments set refund_amount_paise = 0 where id = $1",
            [pay.rows[0].id],
          );
        }
        await addOutbox(client, id, "booking_cancelled", {
          bookingId: id,
          refundPaise: refund,
        });
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      // after the commit. Both are safe to repeat, and the scheduled jobs back them up.
      await processRefunds().catch(() => {});
      if (freed) await promoteWaitlist(freed.runId, freed.cls).catch(() => {});
      return reply.code(200).send(await summary(id));
    },
  );
}
