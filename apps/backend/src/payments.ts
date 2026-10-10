import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type {
  ErrorShape,
  PaymentStartResponse,
  PaymentStatus,
} from "@irctc/shared-types";
import { pool } from "./db";
import { config } from "./config";
import { moveStage } from "./stages";
import { releaseSeats } from "./seats";
import { verify } from "./signature";
import { bankRefund, bankStatus, createBankTransaction } from "./fakebank";
import { addOutbox, confirmationPayload } from "./outbox";

const err = (code: string, message: string, canRetry: boolean): ErrorShape => ({
  code,
  message,
  canRetry,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toResponse = (bookingId: string, r: any): PaymentStartResponse => ({
  bookingId,
  paymentId: r.id,
  bankRef: r.provider_ref,
  amountPaise: r.amount_paise,
  status: r.status as PaymentStatus,
});

// Turn this booking's held seats into booked seats, IF they are still all ours.
async function confirmSeats(
  client: PoolClient,
  bookingId: string,
): Promise<boolean> {
  const info = await client.query(
    `select (b.last_segment - b.first_segment + 1)
            * (select count(*) from booking_passengers where booking_id = b.id) as expected
     from bookings b where b.id = $1`,
    [bookingId],
  );
  const expected = Number(info.rows[0].expected);

  // lock the rows that still carry our booking id (even if the hold timed out,
  // they are ours as long as nobody else grabbed them)
  const mine = await client.query(
    "select 1 from seat_segments where booking_id = $1 and status = 'held' for update",
    [bookingId],
  );
  if (mine.rowCount !== expected) return false; // someone took some of them

  await client.query(
    `update seat_segments set status = 'booked', held_until = null
     where booking_id = $1 and status = 'held'`,
    [bookingId],
  );
  return true;
}

// The ONE place that reacts to "the bank says paid/failed".
// Used by the webhook AND by the reconciliation job. Safe to call many times.
export async function applyBankResult(
  ref: string,
  result: "paid" | "failed",
): Promise<string> {
  const client = await pool.connect();
  let outcome: string;
  try {
    await client.query("begin");

    const p = await client.query(
      "select id, booking_id, status from payments where provider_ref = $1 for update",
      [ref],
    );
    if (p.rowCount === 0) {
      await client.query("rollback");
      return "unknown_payment";
    }
    const pay = p.rows[0];

    // already handled (webhook came twice, or reconciler got here first): do nothing
    if (pay.status !== "initiated") {
      await client.query("rollback");
      return "already_processed";
    }

    const bk = await client.query(
      "select id, stage from bookings where id = $1 for update",
      [pay.booking_id],
    );
    const booking = bk.rows[0];

    if (result === "failed") {
      await client.query(
        "update payments set status = 'failed', updated_at = now() where id = $1",
        [pay.id],
      );
      if (booking.stage === "payment_pending") {
        await moveStage(
          client,
          booking.id,
          "payment_pending",
          "payment_failed",
        );
        await releaseSeats(client, booking.id);
      }
      outcome = "payment_failed";
    } else {
      const seatsOk =
        booking.stage === "payment_pending" &&
        (await confirmSeats(client, booking.id));
      if (seatsOk) {
        await client.query(
          "update payments set status = 'succeeded', updated_at = now() where id = $1",
          [pay.id],
        );
        await moveStage(client, booking.id, "payment_pending", "confirmed");
        await client.query(
          "update bookings set hold_expires_at = null where id = $1",
          [booking.id],
        );
        await addOutbox(
          client,
          booking.id,
          "booking_confirmed",
          await confirmationPayload(client, booking.id),
        );
        outcome = "confirmed";
      } else {
        // money arrived but the seats are gone: mark for refund
        await client.query(
          "update payments set status = 'refund_pending', updated_at = now() where id = $1",
          [pay.id],
        );
        if (booking.stage === "payment_pending") {
          await moveStage(client, booking.id, "payment_pending", "expired");
        }
        await releaseSeats(client, booking.id); // give back any seats we still held
        outcome = "refund_pending";
      }
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // talking to the bank happens AFTER our database step is safely saved
  if (outcome === "refund_pending") await processRefunds().catch(() => {});
  return outcome;
}

// Ask the bank to return money for every payment waiting for a refund.
export async function processRefunds() {
  const due = await pool.query(
    "select id, booking_id, provider_ref, amount_paise from payments where status = 'refund_pending'",
  );
  for (const row of due.rows) {
    await bankRefund(row.provider_ref);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const done = await client.query(
        "update payments set status = 'refunded', updated_at = now() where id = $1 and status = 'refund_pending'",
        [row.id],
      );
      if (done.rowCount === 1) {
        await addOutbox(client, row.booking_id, "refund_issued", {
          bookingId: row.booking_id,
          amountPaise: row.amount_paise,
        });
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

// The end-of-day cash count: find payments we never heard back about.
export async function reconcileOnce(olderThanSeconds: number) {
  const stuck = await pool.query(
    `select provider_ref from payments
     where status = 'initiated'
       and created_at < now() - make_interval(secs => $1::double precision)`,
    [olderThanSeconds],
  );
  for (const row of stuck.rows) {
    const s = await bankStatus(row.provider_ref);
    if (s === "paid" || s === "failed")
      await applyBankResult(row.provider_ref, s);
  }
  await processRefunds(); // also retry refunds that failed earlier
}

export async function paymentRoutes(app: FastifyInstance) {
  // 1. start paying for a held booking
  app.post<{ Params: { id: string } }>(
    "/bookings/:id/pay",
    async (req, reply) => {
      const id = req.params.id;
      if (!UUID.test(id))
        return reply
          .code(400)
          .send(err("BAD_REQUEST", "id must be a uuid", false));

      const client = await pool.connect();
      try {
        await client.query("begin");
        const bk = await client.query(
          "select id, stage, hold_expires_at from bookings where id = $1 for update",
          [id],
        );
        if (bk.rowCount === 0) {
          await client.query("rollback");
          return reply
            .code(404)
            .send(err("NOT_FOUND", "Booking not found", false));
        }
        const b = bk.rows[0];

        // tapped "Pay" twice? return the payment we already created
        const existing = await client.query(
          "select id, provider_ref, amount_paise, status from payments where booking_id = $1",
          [id],
        );
        if (existing.rowCount! > 0) {
          await client.query("rollback");
          return reply.code(200).send(toResponse(id, existing.rows[0]));
        }

        if (b.stage === "expired") {
          await client.query("rollback");
          return reply
            .code(409)
            .send(
              err(
                "HOLD_EXPIRED",
                "Your seat hold ran out. Please search again.",
                false,
              ),
            );
        }

        if (b.stage !== "seats_held") {
          await client.query("rollback");
          return reply
            .code(409)
            .send(err("WRONG_STAGE", `booking is ${b.stage}`, false));
        }

        if (b.hold_expires_at < new Date()) {
          await moveStage(client, id, "seats_held", "expired");
          await releaseSeats(client, id);
          await client.query("commit");
          return reply
            .code(409)
            .send(
              err(
                "HOLD_EXPIRED",
                "Your seat hold ran out. Please search again.",
                false,
              ),
            );
        }

        const count = await client.query(
          "select count(*)::int as n from booking_passengers where booking_id = $1",
          [id],
        );
        const amount = count.rows[0].n * config.farePaise;
        const ref = randomUUID();

        await createBankTransaction(ref, amount); // tell the bank to expect this payment
        const pay = await client.query(
          `insert into payments (booking_id, amount_paise, status, provider_ref)
         values ($1, $2, 'initiated', $3)
         returning id, provider_ref, amount_paise, status`,
          [id, amount, ref],
        );
        await moveStage(client, id, "seats_held", "payment_pending");
        await client.query("commit");
        return reply.code(201).send(toResponse(id, pay.rows[0]));
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  );

  // 2. what is the payment status of this booking?
  app.get<{ Params: { id: string } }>(
    "/bookings/:id/payment",
    async (req, reply) => {
      if (!UUID.test(req.params.id))
        return reply
          .code(400)
          .send(err("BAD_REQUEST", "id must be a uuid", false));
      const r = await pool.query(
        "select id, provider_ref, amount_paise, status from payments where booking_id = $1",
        [req.params.id],
      );
      if (r.rowCount === 0)
        return reply
          .code(404)
          .send(err("NOT_FOUND", "No payment for this booking", false));
      return toResponse(req.params.id, r.rows[0]);
    },
  );

  // 3. the bank calls us here
  app.post<{ Body: { ref?: string; status?: string; amountPaise?: number } }>(
    "/webhooks/payment",
    async (req, reply) => {
      const { ref, status, amountPaise } = req.body ?? {};
      const sig = req.headers["x-bank-signature"];

      if (
        !ref ||
        (status !== "paid" && status !== "failed") ||
        typeof amountPaise !== "number" ||
        !Number.isInteger(amountPaise) ||
        typeof sig !== "string" ||
        !verify(ref, status, amountPaise, sig)
      ) {
        return reply
          .code(401)
          .send(err("BAD_SIGNATURE", "Rejected: not a valid bank call", false));
      }

      const pay = await pool.query(
        "select amount_paise from payments where provider_ref = $1",
        [ref],
      );
      if (pay.rowCount === 0)
        return reply.code(404).send(err("NOT_FOUND", "unknown payment", false));
      if (pay.rows[0].amount_paise !== amountPaise) {
        return reply
          .code(400)
          .send(
            err("AMOUNT_MISMATCH", "amount does not match our record", false),
          );
      }

      // even for repeats we answer 200, so the bank stops retrying
      return { outcome: await applyBankResult(ref, status) };
    },
  );

  // 4. test-only: run the cash count right now (no login yet, so gated by the same flag)
  if (config.enableFakeBank) {
    app.post<{ Querystring: { olderThan?: string } }>(
      "/admin/reconcile",
      async (req) => {
        await reconcileOnce(Number(req.query.olderThan ?? 0));
        return { ok: true };
      },
    );
  }
}
