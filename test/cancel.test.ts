import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  avail,
  book,
  bookConfirmed,
  cancel,
  db,
  FARE,
  hoursBefore,
  notifications,
  payStatus,
  resetDb,
  setClock,
  stage,
  waitFor,
} from "./helpers";

const DATE = "2026-12-27";
const FEE = 6000;
const seatRows = async (id: string) =>
  (
    await db.query(
      "select count(*)::int n from seat_segments where booking_id = $1",
      [id],
    )
  ).rows[0].n;

beforeEach(async () => {
  await resetDb();
  await setClock(hoursBefore(DATE, 100)); // by default, the train is 100 hours away
});
afterAll(async () => {
  await setClock();
});

describe("refund by time", () => {
  it("more than 48 hours before: refund minus the fee, and the seat comes back", async () => {
    const before = await avail(DATE, "3A");
    const { id, ref } = await bookConfirmed();
    expect(await avail(DATE, "3A")).toBe(before - 1);

    const r = await cancel(id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      stage: "cancelled",
      refundPaise: FARE - FEE,
      refundStatus: "refunded",
    });
    expect(await payStatus(id)).toBe("refunded");
    expect((await api("GET", `/fakebank/${ref}`)).body).toMatchObject({
      status: "refunded",
      refunded_paise: FARE - FEE,
    });
    expect(await avail(DATE, "3A")).toBe(before);
    expect(await seatRows(id)).toBe(0);
  });

  it("24 hours before: 75%", async () => {
    const { id, ref } = await bookConfirmed();
    await setClock(hoursBefore(DATE, 24));
    const r = await cancel(id);
    expect(r.body.refundPaise).toBe(37500);
    expect((await api("GET", `/fakebank/${ref}`)).body.refunded_paise).toBe(
      37500,
    );
  });

  it("6 hours before: no money back, but the seat is freed", async () => {
    const before = await avail(DATE, "3A");
    const { id, ref } = await bookConfirmed();
    await setClock(hoursBefore(DATE, 6));
    const r = await cancel(id);
    expect(r.body).toMatchObject({
      stage: "cancelled",
      refundPaise: 0,
      refundStatus: "none",
    });
    expect(await payStatus(id)).toBe("succeeded");
    expect((await api("GET", `/fakebank/${ref}`)).body.status).toBe("paid");
    expect(await avail(DATE, "3A")).toBe(before);
  });

  it("after the train has left: refused, and nothing changes", async () => {
    const { id } = await bookConfirmed();
    const held = await avail(DATE, "3A");
    await setClock(hoursBefore(DATE, -1));
    const r = await cancel(id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TOO_LATE");
    expect(await stage(id)).toBe("confirmed");
    expect(await avail(DATE, "3A")).toBe(held);
  });

  it("the clock that counts is the passenger's own boarding station", async () => {
    const early = await bookConfirmed({ to: "CNB" }); // boards at New Delhi, 16:00
    const late = await bookConfirmed({ from: "CNB" }); // boards at Kanpur, 22:00
    await setClock(hoursBefore(DATE, 11)); // 11h before Delhi, 17h before Kanpur
    expect((await cancel(early.id)).body.refundPaise).toBe(0);
    expect((await cancel(late.id)).body.refundPaise).toBe(37500);
  });
});

describe("cancelling safely", () => {
  it("cancelling twice gives the same answer and refunds once", async () => {
    const before = await avail(DATE, "3A");
    const { id } = await bookConfirmed();
    const first = await cancel(id);
    const second = await cancel(id);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await avail(DATE, "3A")).toBe(before);
    const n = await db.query(
      "select count(*)::int n from outbox where booking_id = $1 and type = 'refund_issued'",
      [id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("5 simultaneous cancels cancel once", async () => {
    const before = await avail(DATE, "3A");
    const { id } = await bookConfirmed();
    const rs = await Promise.all(Array.from({ length: 5 }, () => cancel(id)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.refundPaise)).size).toBe(1);
    expect(await avail(DATE, "3A")).toBe(before);
    const n = await db.query(
      "select type, count(*)::int n from outbox where booking_id = $1 and type in ('booking_cancelled','refund_issued') group by type",
      [id],
    );
    expect(n.rows.map((r) => r.n)).toEqual([1, 1]);
  });

  it("only confirmed or waiting bookings can be cancelled; ids are checked", async () => {
    const b = await book();
    const r = await cancel(b.body.bookingId); // still just a hold
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("WRONG_STAGE");
    expect((await cancel(randomUUID())).status).toBe(404);
    expect((await api("POST", "/bookings/nope/cancel")).status).toBe(400);
  });

  it("a cancelled booking can never be confirmed again", async () => {
    const { id } = await bookConfirmed();
    await cancel(id);
    await expect(
      db.query("update bookings set stage='confirmed' where id = $1", [id]),
    ).rejects.toThrow(/illegal booking stage move/);
  });
});

describe("messages", () => {
  it("cancelling sends a cancellation note and a refund note", async () => {
    const { id } = await bookConfirmed();
    await cancel(id);
    await waitFor(async () => {
      const n = await notifications(id);
      return (
        n.events.length === 3 && n.events.every((e) => e.status === "sent")
      );
    });
    const n = await notifications(id);
    expect(n.events.map((e) => e.type).sort()).toEqual([
      "booking_cancelled",
      "booking_confirmed",
      "refund_issued",
    ]);
    expect(
      n.delivered.some(
        (d) => d.body.includes("cancelled") && d.body.includes("440.00"),
      ),
    ).toBe(true);
    expect(
      n.delivered.some((d) => d.body.includes("Refund of Rs 440.00")),
    ).toBe(true);
  });
});
