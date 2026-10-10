import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  avail,
  book,
  bookAndStartPayment,
  db,
  dbStage,
  FARE,
  resetDb,
  signedWebhook,
  sleep,
  stage,
  startPay,
  sweep,
} from "./helpers";

beforeEach(resetDb);
const DATE = "2026-12-27";
// push every hold far into the future so slow machines can't expire it mid-test
const extendHolds = () =>
  db.query(
    "update seat_segments set held_until = now() + interval '1 hour' where status = 'held'",
  );

describe("one seat, several journeys", () => {
  it("the same 8 seats are sold to NDLS-CNB and again to CNB-PNBE", async () => {
    for (let i = 0; i < 8; i++)
      expect((await book({ to: "CNB" })).status).toBe(201);
    await extendHolds();
    expect(await avail(DATE, "3A", "NDLS", "PNBE")).toBe(0);
    expect(await avail(DATE, "3A", "CNB", "PNBE")).toBe(8); // second half still untouched

    for (let i = 0; i < 8; i++)
      expect((await book({ from: "CNB" })).status).toBe(201);
    await extendHolds();
    expect(await avail(DATE, "3A", "CNB", "PNBE")).toBe(0);
    expect(await avail(DATE, "3A", "NDLS", "CNB")).toBe(0);

    // every seat was used twice: once per half of the route
    const shared = await db.query(
      "select 1 from booking_passengers group by coach_code, seat_number having count(*) = 2",
    );
    expect(shared.rowCount).toBe(8);
  });
});

describe("the same thing happening many times at once", () => {
  it("10 identical booking requests create one booking", async () => {
    const requestId = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => book({ requestId, pax: 2 })),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(rs.map((r) => r.body.bookingId)).size).toBe(1);
    expect(await avail(DATE, "3A")).toBe(6);
  });

  it("5 simultaneous Pay taps create one payment and one bank transaction", async () => {
    const b = await book();
    const id = b.body.bookingId;
    const rs = await Promise.all(Array.from({ length: 5 }, () => startPay(id)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(4);
    expect(new Set(rs.map((r) => r.body.paymentId)).size).toBe(1);
    expect(
      (
        await db.query(
          "select count(*)::int n from payments where booking_id = $1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await db.query("select count(*)::int n from fake_bank_transactions"))
        .rows[0].n,
    ).toBe(1);
  });

  it("10 simultaneous 'paid' calls confirm once and write one note", async () => {
    const { id, ref } = await bookAndStartPayment();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => signedWebhook(ref, "paid", FARE)),
    );
    const outcomes = rs.map((r) => r.body.outcome);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(outcomes.filter((o) => o === "confirmed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_processed")).toHaveLength(9);
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

  it("the sweeper and Pay at the same moment never leave a half-state", async () => {
    const b = await book({ pax: 2 });
    const id = b.body.bookingId;
    await sleep(4000); // hold has run out
    const [pay] = await Promise.all([startPay(id), sweep()]);
    expect(pay.status).toBe(409);
    expect(pay.body.code).toBe("HOLD_EXPIRED");
    expect(await dbStage(id)).toBe("expired");
    expect(
      (
        await db.query(
          "select count(*)::int n from payments where booking_id = $1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.query(
          "select count(*)::int n from seat_segments where booking_id = $1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await avail(DATE, "3A")).toBe(8);
  });
});

describe("contention", () => {
  it("20 two-passenger bookings fighting over 8 seats never double-book", async () => {
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => book({ date: "2026-12-26", pax: 2 })),
    );
    await extendHolds();
    const won = rs.filter((r) => r.status === 201).length;

    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(won).toBeGreaterThanOrEqual(1);
    expect(won).toBeLessThanOrEqual(4); // 8 seats, 2 each
    const dupes = await db.query(
      "select 1 from booking_passengers group by coach_code, seat_number having count(*) > 1",
    );
    expect(dupes.rowCount).toBe(0);
    // the books balance: seats held = winners x passengers x 3 segments
    const held = await db.query(
      "select count(*)::int n from seat_segments where booking_id is not null",
    );
    expect(held.rows[0].n).toBe(won * 2 * 3);
    expect(await avail("2026-12-26", "3A")).toBe(8 - won * 2);
  });
});
