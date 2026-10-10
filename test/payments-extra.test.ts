import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE } from "./constants";
import {
  api,
  avail,
  bankPay,
  book,
  bookAndStartPayment,
  db,
  FARE,
  notifications,
  payStatus,
  reconcile,
  resetDb,
  signedWebhook,
  sleep,
  stage,
  sweep,
  waitFor,
} from "./helpers";

beforeEach(resetDb);
const DATE = "2026-12-27";

describe("webhook gatekeeping", () => {
  it("a call with no signature is rejected", async () => {
    const res = await fetch(`${BASE}/webhooks/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "x", status: "paid", amountPaise: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("a validly signed call about an unknown payment is 404", async () => {
    expect((await signedWebhook(randomUUID(), "paid", FARE)).status).toBe(404);
  });

  it("a status we don't recognise is rejected", async () => {
    const { ref } = await bookAndStartPayment();
    expect((await signedWebhook(ref, "refunded", FARE)).status).toBe(401);
  });

  it("a late 'failed' after 'paid' changes nothing", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref);
    const r = await signedWebhook(ref, "failed", FARE);
    expect(r.body.outcome).toBe("already_processed");
    expect(await stage(id)).toBe("confirmed");
  });

  it("a late 'paid' after 'failed' doesn't resurrect the booking", async () => {
    const before = await avail(DATE, "3A");
    const { id, ref } = await bookAndStartPayment();
    await signedWebhook(ref, "failed", FARE);
    const r = await signedWebhook(ref, "paid", FARE);
    expect(r.body.outcome).toBe("already_processed");
    expect(await stage(id)).toBe("payment_failed");
    expect(await avail(DATE, "3A")).toBe(before);
  });
});

describe("reconciliation", () => {
  it("leaves a payment alone while the customer is still on the bank page", async () => {
    const { id } = await bookAndStartPayment();
    await reconcile();
    expect(await stage(id)).toBe("payment_pending");
    expect(await payStatus(id)).toBe("initiated");
  });

  it("repairs a lost 'failed' call and frees the seat", async () => {
    const before = await avail(DATE, "3A");
    const { id, ref } = await bookAndStartPayment();
    await api("POST", `/fakebank/${ref}/fail?webhook=never`);
    await reconcile();
    expect(await stage(id)).toBe("payment_failed");
    expect(await avail(DATE, "3A")).toBe(before);
  });

  it("running it twice is harmless and writes one note", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref, "never");
    await reconcile();
    await reconcile();
    expect(await stage(id)).toBe("confirmed");
    expect(
      (
        await db.query(
          "select count(*)::int n from outbox where booking_id = $1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("finishes a refund that was left half-done, and notifies once", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref, "never"); // bank has the money
    await db.query(
      "update payments set status = 'refund_pending' where provider_ref = $1",
      [ref],
    );
    await reconcile();
    await reconcile();
    expect(await payStatus(id)).toBe("refunded");
    expect((await api("GET", `/fakebank/${ref}`)).body.status).toBe("refunded");
    await waitFor(
      async () => (await notifications(id)).events[0]?.status === "sent",
    );
    const n = await notifications(id);
    expect(n.events.filter((e) => e.type === "refund_issued")).toHaveLength(1);
  });
});

describe("confirmed bookings are permanent", () => {
  it("never expire, keep their seats, and have no hold deadline", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref);
    const before = await avail(DATE, "3A");
    await sleep(4000);
    await sweep();
    expect(await stage(id)).toBe("confirmed");
    expect(await avail(DATE, "3A")).toBe(before);
    const booked = await db.query(
      "select count(*)::int n from seat_segments where booking_id = $1 and status = 'booked'",
      [id],
    );
    expect(booked.rows[0].n).toBe(3); // 1 passenger x 3 segments
    expect(
      (await api("GET", `/bookings/${id}`)).body.holdExpiresAt,
    ).toBeUndefined();
  });
});

describe("rules enforced by the database itself", () => {
  it("confirmed -> cancelled is allowed", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref);
    await expect(
      db.query("update bookings set stage='cancelled' where id = $1", [id]),
    ).resolves.toBeTruthy();
  });

  it("payment_failed -> confirmed is refused", async () => {
    const { id, ref } = await bookAndStartPayment();
    await api("POST", `/fakebank/${ref}/fail`);
    await expect(
      db.query("update bookings set stage='confirmed' where id = $1", [id]),
    ).rejects.toThrow(/illegal booking stage move/);
  });

  it("seats_held -> confirmed (skipping payment) is refused", async () => {
    const b = await book();
    await expect(
      db.query("update bookings set stage='confirmed' where id = $1", [
        b.body.bookingId,
      ]),
    ).rejects.toThrow(/illegal booking stage move/);
  });

  it("an invented stage is refused", async () => {
    const b = await book();
    await expect(
      db.query("update bookings set stage='banana' where id = $1", [
        b.body.bookingId,
      ]),
    ).rejects.toThrow();
  });

  const anySeat =
    "(run_id, coach_code, seat_number, segment_no) = (select run_id, coach_code, seat_number, segment_no from seat_segments limit 1)";

  it("a seat can't have an invented status", async () => {
    await expect(
      db.query(`update seat_segments set status='banana' where ${anySeat}`),
    ).rejects.toThrow(/check constraint/);
  });

  it("a held seat must carry an expiry time", async () => {
    await expect(
      db.query(
        `update seat_segments set status='held', held_until=null where ${anySeat}`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
