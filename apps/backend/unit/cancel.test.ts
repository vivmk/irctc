import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool, auth, payments, wl } = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  auth: { ownedBy: vi.fn() },
  payments: { processRefunds: vi.fn() },
  wl: { promoteWaitlist: vi.fn() },
}));
vi.mock("../src/db", () => ({ pool }));
vi.mock("../src/auth", () => ({ requireUser: async (req: any) => { req.userId = "user-1"; }, ownedBy: auth.ownedBy }));
vi.mock("../src/payments", () => payments);
vi.mock("../src/waitlist", () => wl);

import { cancelRoutes } from "../src/cancel";
import { setClock } from "../src/clock";
import { installErrorHandlers } from "../src/errors";
import { fakeDb, type FakeDb } from "./fakes";

const BID = "4cc7e948-3543-4b26-8bf9-12aebbef29b1";
const DEPARTS = Date.parse("2026-12-27T10:30:00Z");       // 16:00 IST
const hoursBefore = (h: number) => DEPARTS - h * 3_600_000;
let c: FakeDb;
const app = () => { const a = Fastify(); installErrorHandlers(a); a.register(cancelRoutes); return a; };
const cancel = (id = BID) => app().inject({ method: "POST", url: `/bookings/${id}/cancel` });

const bookingRow = (over: object = {}) => [/from bookings where id = \$1 for update/, { rows: [{ id: BID, stage: "confirmed", run_id: 7, class: "3A", first_segment: 1, ...over }], rowCount: 1 }] as const;
const departure = [/at time zone 'Asia\/Kolkata' as departs_at/, { rows: [{ departs_at: new Date(DEPARTS) }] }] as const;
const paid = (amount = 50000) => [/from payments where booking_id = \$1 and status = 'succeeded'/, { rows: [{ id: "p-1", amount_paise: amount }], rowCount: 1 }] as const;
const pax = (n: number) => [/count\(\*\)::int as n from booking_passengers/, { rows: [{ n }] }] as const;
const summaryRow = (over: object = {}) => [/from bookings b left join payments p/, { rows: [{ stage: "cancelled", status: "refunded", refund_amount_paise: 44000, ...over }] }] as const;
const stageMove = [/^update bookings set stage/, { rowCount: 1 }] as const;

const setup = (...rules: any[]) => { c = fakeDb(rules); pool.connect.mockResolvedValue(c); pool.query.mockImplementation(c.query); return c; };

beforeEach(() => {
  pool.query.mockReset(); pool.connect.mockReset();
  auth.ownedBy.mockReset().mockResolvedValue(true);
  payments.processRefunds.mockReset().mockResolvedValue(undefined);
  wl.promoteWaitlist.mockReset().mockResolvedValue(0);
  setClock(hoursBefore(100)); // by default the train is 100 hours away
});

describe("POST /bookings/:id/cancel: guards", () => {
  it("400 for a bad id, 404 for someone else's booking, before any connection is used", async () => {
    setup();
    expect((await cancel("nope")).statusCode).toBe(400);
    auth.ownedBy.mockResolvedValue(false);
    expect((await cancel()).statusCode).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("404 when the booking row is gone", async () => {
    setup([/from bookings where id/, { rows: [], rowCount: 0 }]);
    expect((await cancel()).statusCode).toBe(404);
    expect(c.sqls()).toContain("rollback");
    expect(c.release).toHaveBeenCalledOnce();
  });

  it.each(["seats_held", "payment_pending", "payment_failed", "expired"])("a %s booking can't be cancelled: 409 WRONG_STAGE", async (stage) => {
    setup(bookingRow({ stage }));
    const r = await cancel();
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "WRONG_STAGE", canRetry: false });
    expect(c.did(/^update/)).toBe(false);
  });

  it("after departure: 409 TOO_LATE and nothing changes", async () => {
    setClock(hoursBefore(-1));
    setup(bookingRow(), departure);
    const r = await cancel();
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("TOO_LATE");
    expect(c.did(/^update/)).toBe(false);
    expect(c.sqls()).toContain("rollback");
  });

  it("the departure it checks is the one at THE PASSENGER'S boarding station", async () => {
    setup(bookingRow({ run_id: 9, first_segment: 2 }), departure, paid(), pax(1), stageMove);
    await cancel();
    expect(c.ran(/as departs_at/)[0].params).toEqual([9, 2]);
  });

  it("no successful payment on a confirmed booking is an internal error, rolled back", async () => {
    setup(bookingRow(), departure, [/from payments where booking_id/, { rows: [], rowCount: 0 }]);
    expect((await cancel()).statusCode).toBe(500);
    expect(c.sqls()).toContain("rollback");
    expect(c.release).toHaveBeenCalledOnce();
  });
});

describe("POST /bookings/:id/cancel: confirmed booking", () => {
  const run = async (hours: number, amount = 50000, n = 1) => {
    setClock(hoursBefore(hours));
    setup(bookingRow(), departure, paid(amount), pax(n), stageMove, summaryRow());
    return cancel();
  };

  it("more than 48h: refund minus the fee, seats freed, stage moved, note written, all in one transaction", async () => {
    const r = await run(100);
    expect(r.statusCode).toBe(200);
    const pend = c.ran(/set status = 'refund_pending'/)[0];
    expect(pend.params).toEqual(["p-1", 44000]);
    expect(c.ran(/set status = 'free', booking_id = null/)[0].params).toEqual([BID]);
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual([BID, "confirmed", "cancelled"]);
    const note = c.ran(/^insert into outbox/)[0];
    expect(note.params.slice(0, 2)).toEqual([BID, "booking_cancelled"]);
    expect(JSON.parse(note.params[2])).toEqual({ bookingId: BID, refundPaise: 44000 });
    const sqls = c.sqls();
    expect(sqls[0]).toBe("begin");
    expect(sqls.indexOf("commit")).toBeGreaterThan(sqls.findIndex((s) => /insert into outbox/.test(s)));
  });

  it("the fee is per passenger", async () => {
    await run(100, 100000, 2);
    expect(c.ran(/set status = 'refund_pending'/)[0].params[1]).toBe(88000);
  });

  it("24h before: 75%", async () => {
    await run(24);
    expect(c.ran(/set status = 'refund_pending'/)[0].params[1]).toBe(37500);
  });

  it("6h before: no refund is recorded as pending, but the seat IS freed", async () => {
    await run(6);
    expect(c.did(/set status = 'refund_pending'/)).toBe(false);
    expect(c.ran(/set refund_amount_paise = 0/)).toHaveLength(1);
    expect(c.did(/set status = 'free'/)).toBe(true);
    expect(JSON.parse(c.ran(/^insert into outbox/)[0].params[2]).refundPaise).toBe(0);
  });

  it("after commit: processes refunds and offers the freed seat to the waiting list for that run and class", async () => {
    await run(100);
    expect(payments.processRefunds).toHaveBeenCalledOnce();
    expect(wl.promoteWaitlist).toHaveBeenCalledWith(7, "3A");
  });

  it("answers with the final state: stage, amount and whether the refund has gone through", async () => {
    const r = await run(100);
    expect(r.json()).toEqual({ bookingId: BID, stage: "cancelled", refundPaise: 44000, refundStatus: "refunded" });
  });

  it("refundStatus: 'none' for zero, 'refund_pending' while the bank hasn't confirmed", async () => {
    setup(bookingRow(), departure, paid(), pax(1), stageMove, summaryRow({ status: "succeeded", refund_amount_paise: 0 }));
    expect((await cancel()).json().refundStatus).toBe("none");
    setup(bookingRow(), departure, paid(), pax(1), stageMove, summaryRow({ status: "refund_pending" }));
    expect((await cancel()).json().refundStatus).toBe("refund_pending");
  });

  it("a failure in refunds or promotion after the commit does NOT undo the cancellation", async () => {
    payments.processRefunds.mockRejectedValue(new Error("bank down"));
    wl.promoteWaitlist.mockRejectedValue(new Error("deadlock"));
    const r = await run(100);
    expect(r.statusCode).toBe(200);
    expect(r.json().stage).toBe("cancelled");
  });

  it("a database error mid-way rolls everything back and releases the connection", async () => {
    setup(bookingRow(), departure, paid(), pax(1), [/^update seat_segments/, new Error("boom")]);
    expect((await cancel()).statusCode).toBe(500);
    expect(c.sqls()).toContain("rollback");
    expect(c.sqls()).not.toContain("commit");
    expect(c.release).toHaveBeenCalledOnce();
    expect(wl.promoteWaitlist).not.toHaveBeenCalled();
  });
});

describe("POST /bookings/:id/cancel: waiting-list booking", () => {
  it("full refund even close to departure, no seats to free, no promotion triggered", async () => {
    setClock(hoursBefore(2));
    setup(bookingRow({ stage: "waitlisted" }), departure, paid(), pax(1), stageMove, summaryRow({ refund_amount_paise: 50000 }));
    const r = await cancel();
    expect(r.statusCode).toBe(200);
    expect(c.ran(/set status = 'refund_pending'/)[0].params[1]).toBe(50000);
    expect(c.did(/set status = 'free'/)).toBe(false);
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual([BID, "waitlisted", "cancelled"]);
    expect(wl.promoteWaitlist).not.toHaveBeenCalled();
  });
});

describe("POST /bookings/:id/cancel: repeats", () => {
  it("cancelling again answers 200 with the same facts and creates nothing new", async () => {
    setup(bookingRow({ stage: "cancelled" }), summaryRow());
    const r = await cancel();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ stage: "cancelled", refundPaise: 44000, refundStatus: "refunded" });
    expect(c.did(/^update/)).toBe(false);
    expect(c.did(/^insert/)).toBe(false);
    expect(wl.promoteWaitlist).not.toHaveBeenCalled();
  });

  it("settles any unfinished refund first, so every caller sees the same final state", async () => {
    setup(bookingRow({ stage: "cancelled" }), summaryRow());
    await cancel();
    expect(payments.processRefunds).toHaveBeenCalledOnce();
  });

  it("gives its connection back BEFORE asking for more (no pool deadlock under load)", async () => {
    setup(bookingRow({ stage: "cancelled" }), summaryRow());
    let releasedWhenRefundsStarted = false;
    payments.processRefunds.mockImplementation(async () => { releasedWhenRefundsStarted = c.release.mock.calls.length === 1; });
    await cancel();
    expect(releasedWhenRefundsStarted).toBe(true);
    expect(c.release).toHaveBeenCalledOnce(); // and not released twice
  });
});
