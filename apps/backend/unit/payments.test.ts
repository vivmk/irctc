import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool, bank, wl, auth } = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  bank: { bankRefund: vi.fn(), bankStatus: vi.fn(), createBankTransaction: vi.fn() },
  wl: { promoteWaitlist: vi.fn() },
  auth: { ownedBy: vi.fn() },
}));
vi.mock("../src/db", () => ({ pool }));
vi.mock("../src/fakebank", () => bank);
vi.mock("../src/waitlist", () => wl);
vi.mock("../src/auth", () => ({ requireUser: async (req: any) => { req.userId = "user-1"; }, ownedBy: auth.ownedBy }));

import { applyBankResult, paymentRoutes, processRefunds, reconcileOnce } from "../src/payments";
import { installErrorHandlers } from "../src/errors";
import { sign } from "../src/signature";
import { fakeDb, type FakeDb } from "./fakes";

const REF = "ref-1";
const BID = "4cc7e948-3543-4b26-8bf9-12aebbef29b1";
let clients: FakeDb[];
const client = (...rules: any[]) => { const c = fakeDb(rules); clients.push(c); return c; };

beforeEach(() => {
  pool.query.mockReset(); pool.connect.mockReset();
  Object.values(bank).forEach((f) => f.mockReset().mockResolvedValue(undefined));
  wl.promoteWaitlist.mockReset().mockResolvedValue(0);
  auth.ownedBy.mockReset().mockResolvedValue(true);
  clients = [];
  pool.connect.mockImplementation(async () => clients.shift());
  pool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

const payment = (status = "initiated") => [/from payments where provider_ref = \$1 for update/, { rows: [{ id: "p-1", booking_id: "b-1", status }], rowCount: 1 }] as const;
const bookingRow = (over: object = {}) => [/from bookings where id = \$1 for update/, { rows: [{ id: "b-1", stage: "payment_pending", run_id: 7, class: "3A", waitlist_requested: false, ...over }] }] as const;
const seatCount = (expected: number, held: number) => [
  [/select \(b\.last_segment - b\.first_segment \+ 1\)/, { rows: [{ expected }] }],
  [/select 1 from seat_segments where booking_id = \$1 and status = 'held' for update/, { rowCount: held }],
] as const;
const stageMove = [/^update bookings set stage/, { rowCount: 1 }] as const;
const confirmInfo = [
  [/from bookings b\s+join train_runs/, { rows: [{ train_number: "12345", date: "2026-12-27" }] }],
  [/select coach_code as coach/, { rows: [{ coach: "B1", seat: 1 }] }],
] as const;

describe("applyBankResult: the bank says 'paid'", () => {
  it("seats still ours: payment succeeded, booking confirmed, confirmation note written, one transaction", async () => {
    const c = client(payment(), bookingRow(), ...seatCount(3, 3), stageMove, ...confirmInfo);
    expect(await applyBankResult(REF, "paid")).toBe("confirmed");
    const sqls = c.sqls();
    expect(sqls[0]).toBe("begin");
    expect(sqls.at(-1)).toBe("commit");
    expect(c.ran(/set status = 'booked'/)).toHaveLength(1);
    expect(c.ran(/set status = 'succeeded'/)[0].params).toEqual(["p-1"]);
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual(["b-1", "payment_pending", "confirmed"]);
    expect(c.ran(/set hold_expires_at = null/)).toHaveLength(1);
    expect(c.ran(/^insert into outbox/)[0].params.slice(0, 2)).toEqual(["b-1", "booking_confirmed"]);
    expect(c.release).toHaveBeenCalledOnce();
    expect(bank.bankRefund).not.toHaveBeenCalled();
  });

  it("locks the payment row first, so two simultaneous calls can't both act", async () => {
    const c = client(payment(), bookingRow(), ...seatCount(3, 3), stageMove, ...confirmInfo);
    await applyBankResult(REF, "paid");
    expect(c.log[1].sql).toMatch(/where provider_ref = \$1 for update/);
    expect(c.log[1].params).toEqual([REF]);
  });

  it("ALL held rows must still be ours: one stolen row means refund, not confirmation", async () => {
    const c = client(payment(), bookingRow(), ...seatCount(3, 2), stageMove, [/due/, {}]);
    pool.query.mockImplementation(async (sql: string) => /from payments where status = 'refund_pending'/.test(sql.replace(/\s+/g, " ")) ? { rows: [] } : { rows: [] });
    expect(await applyBankResult(REF, "paid")).toBe("refund_pending");
    expect(c.did(/set status = 'booked'/)).toBe(false);
    expect(c.ran(/set status = 'refund_pending'/)).toHaveLength(1);
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual(["b-1", "payment_pending", "expired"]);
    expect(c.did(/^update seat_segments\s+set status = 'free'/)).toBe(true); // gives back whatever it still held
    expect(c.did(/^insert into outbox/)).toBe(false);
  });

  it("booking already expired (late money): refund, and no illegal stage move is attempted", async () => {
    const c = client(payment(), bookingRow({ stage: "expired" }));
    expect(await applyBankResult(REF, "paid")).toBe("refund_pending");
    expect(c.did(/^update bookings set stage/)).toBe(false);
    expect(c.ran(/set status = 'refund_pending'/)).toHaveLength(1);
  });

  it("after a refund-worthy outcome the refunds are processed straight away", async () => {
    client(payment(), bookingRow({ stage: "expired" }));
    const refundClient = client([/set status = 'refunded'/, { rowCount: 1 }]);
    pool.query.mockImplementation(async (sql: string) =>
      /from payments\s+where status = 'refund_pending'/.test(sql.replace(/\s+/g, " ")) || /refund_pending/.test(sql)
        ? { rows: [{ id: "p-1", booking_id: "b-1", provider_ref: REF, refund_paise: 50000 }], rowCount: 1 } : { rows: [] });
    await applyBankResult(REF, "paid");
    expect(bank.bankRefund).toHaveBeenCalledWith(REF, 50000);
    expect(refundClient.ran(/^insert into outbox/)[0].params.slice(0, 2)).toEqual(["b-1", "refund_issued"]);
  });

  it("a waiting-list customer's money buys a place in line, not a seat", async () => {
    const c = client(payment(), bookingRow({ waitlist_requested: true }), stageMove);
    expect(await applyBankResult(REF, "paid")).toBe("waitlisted");
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual(["b-1", "payment_pending", "waitlisted"]);
    const upd = c.ran(/set hold_expires_at = null, waitlisted_at = now\(\)/);
    expect(upd).toHaveLength(1);
    expect(c.ran(/^insert into outbox/)[0].params.slice(0, 2)).toEqual(["b-1", "booking_waitlisted"]);
    expect(c.did(/set status = 'booked'/)).toBe(false);
    expect(wl.promoteWaitlist).toHaveBeenCalledWith(7, "3A"); // a seat may already be free
  });

  it("a waiting-list customer whose hold lapsed (booking expired) is refunded instead", async () => {
    const c = client(payment(), bookingRow({ stage: "expired", waitlist_requested: true }));
    expect(await applyBankResult(REF, "paid")).toBe("refund_pending");
    expect(wl.promoteWaitlist).not.toHaveBeenCalled();
    expect(c.did(/waitlisted_at/)).toBe(false);
  });
});

describe("applyBankResult: the bank says 'failed', or nothing to do", () => {
  it("failed: payment failed, booking payment_failed, seats released", async () => {
    const c = client(payment(), bookingRow(), stageMove);
    expect(await applyBankResult(REF, "failed")).toBe("payment_failed");
    expect(c.ran(/set status = 'failed'/)).toHaveLength(1);
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual(["b-1", "payment_pending", "payment_failed"]);
    expect(c.did(/set status = 'free'/)).toBe(true);
    expect(c.did(/^insert into outbox/)).toBe(false);
  });

  it("failed for an already expired booking: payment marked failed, stage left alone", async () => {
    const c = client(payment(), bookingRow({ stage: "expired" }));
    expect(await applyBankResult(REF, "failed")).toBe("payment_failed");
    expect(c.did(/^update bookings set stage/)).toBe(false);
  });

  it("unknown payment: rolled back, nothing happens", async () => {
    const c = client([/from payments where provider_ref/, { rows: [], rowCount: 0 }]);
    expect(await applyBankResult(REF, "paid")).toBe("unknown_payment");
    expect(c.sqls()).toContain("rollback");
    expect(c.release).toHaveBeenCalledOnce();
  });

  it.each(["succeeded", "failed", "refund_pending", "refunded"])("payment already %s: a repeat call changes nothing", async (status) => {
    const c = client(payment(status));
    expect(await applyBankResult(REF, "paid")).toBe("already_processed");
    expect(await (async () => { clients.push(c); return applyBankResult(REF, "failed"); })()).toBe("already_processed");
    expect(c.did(/^update/)).toBe(false);
    expect(c.did(/^insert/)).toBe(false);
    expect(c.sqls()).toContain("rollback");
  });

  it("a database error rolls back, releases the connection, and surfaces", async () => {
    const c = client(payment(), bookingRow(), ...seatCount(3, 3), [/set status = 'booked'/, new Error("disk full")]);
    await expect(applyBankResult(REF, "paid")).rejects.toThrow("disk full");
    expect(c.sqls()).toContain("rollback");
    expect(c.sqls()).not.toContain("commit");
    expect(c.release).toHaveBeenCalledOnce();
  });
});

describe("processRefunds", () => {
  const due = (...rows: any[]) => pool.query.mockImplementation(async () => ({ rows, rowCount: rows.length }));

  it("refunds the recorded amount, marks the payment refunded and writes the note, in one transaction", async () => {
    due({ id: "p-1", booking_id: "b-1", provider_ref: REF, refund_paise: 44000 });
    const c = client([/set status = 'refunded'/, { rowCount: 1 }]);
    await processRefunds();
    expect(bank.bankRefund).toHaveBeenCalledWith(REF, 44000);
    expect(c.ran(/set status = 'refunded'/)[0].params).toEqual(["p-1", 44000]);
    const note = c.ran(/^insert into outbox/)[0];
    expect(note.params.slice(0, 2)).toEqual(["b-1", "refund_issued"]);
    expect(JSON.parse(note.params[2])).toEqual({ bookingId: "b-1", amountPaise: 44000 });
    expect(c.sqls().at(-1)).toBe("commit");
  });

  it("a refund that was already marked done by someone else writes no second note", async () => {
    due({ id: "p-1", booking_id: "b-1", provider_ref: REF, refund_paise: 44000 });
    const c = client([/set status = 'refunded'/, { rowCount: 0 }]);
    await processRefunds();
    expect(c.did(/^insert into outbox/)).toBe(false);
  });

  it("defaults to the full payment when no partial amount was recorded", async () => {
    await processRefunds();
    expect(pool.query.mock.calls[0][0]).toMatch(/coalesce\(refund_amount_paise, amount_paise\)/);
  });

  it("handles several refunds, one after another", async () => {
    due({ id: "p-1", booking_id: "b-1", provider_ref: "r1", refund_paise: 1 }, { id: "p-2", booking_id: "b-2", provider_ref: "r2", refund_paise: 2 });
    client([/set status = 'refunded'/, { rowCount: 1 }]);
    client([/set status = 'refunded'/, { rowCount: 1 }]);
    await processRefunds();
    expect(bank.bankRefund.mock.calls).toEqual([["r1", 1], ["r2", 2]]);
  });

  it("if the bank call fails, nothing is marked refunded (it will be retried)", async () => {
    due({ id: "p-1", booking_id: "b-1", provider_ref: REF, refund_paise: 1 });
    bank.bankRefund.mockRejectedValue(new Error("bank down"));
    await expect(processRefunds()).rejects.toThrow("bank down");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("a database error while recording rolls back and releases the connection", async () => {
    due({ id: "p-1", booking_id: "b-1", provider_ref: REF, refund_paise: 1 });
    const c = client([/set status = 'refunded'/, new Error("boom")]);
    await expect(processRefunds()).rejects.toThrow("boom");
    expect(c.sqls()).toContain("rollback");
    expect(c.release).toHaveBeenCalledOnce();
  });
});

describe("reconcileOnce (the cash count)", () => {
  it("looks only at payments still 'initiated' and older than the grace period", async () => {
    await reconcileOnce(60);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'initiated'/);
    expect(sql).toMatch(/created_at < now\(\) - make_interval/);
    expect(params).toEqual([60]);
  });

  it("asks the bank about each, and repairs those the bank has settled", async () => {
    pool.query.mockImplementation(async (sql: string) =>
      /status = 'initiated'/.test(sql) ? { rows: [{ provider_ref: "r1" }, { provider_ref: "r2" }, { provider_ref: "r3" }, { provider_ref: "r4" }] } : { rows: [] });
    bank.bankStatus.mockImplementation(async (r: string) => ({ r1: "paid", r2: "failed", r3: "pending", r4: "unknown" } as any)[r]);
    client(payment(), bookingRow(), ...seatCount(3, 3), stageMove, ...confirmInfo); // r1 confirms
    client(payment(), bookingRow(), stageMove);                                    // r2 fails
    await reconcileOnce(0);
    expect(bank.bankStatus.mock.calls.map((c) => c[0])).toEqual(["r1", "r2", "r3", "r4"]);
    expect(pool.connect).toHaveBeenCalledTimes(2); // pending and unknown are left alone
  });

  it("also retries refunds that failed earlier", async () => {
    await reconcileOnce(0);
    expect(pool.query.mock.calls.some((c) => /refund_pending/.test(c[0]) && /coalesce/.test(c[0]))).toBe(true);
  });
});

describe("POST /webhooks/payment", () => {
  const app = () => { const a = Fastify(); installErrorHandlers(a); a.register(paymentRoutes); return a; };
  const hit = (body: any, sig?: string) => app().inject({ method: "POST", url: "/webhooks/payment", payload: body, headers: sig ? { "x-bank-signature": sig } : {} });
  const good = (over: object = {}) => ({ ref: REF, status: "paid", amountPaise: 50000, ...over });
  const signed = (b: any) => sign(b.ref, b.status, b.amountPaise);

  it("rejects a missing or wrong signature with 401 and touches nothing", async () => {
    for (const sig of [undefined, "abc", "f".repeat(10_000), signed(good({ amountPaise: 1 }))]) {
      const r = await hit(good(), sig);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ code: "BAD_SIGNATURE", canRetry: false });
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined], ["empty object", {}], ["a list", []],
    ["status in capitals", good({ status: "PAID" })], ["unknown status", good({ status: "refunded" })],
    ["amount as text", good({ amountPaise: "50000" })], ["fractional amount", good({ amountPaise: 1.5 })],
    ["ref an object", good({ ref: {} })], ["ref empty", good({ ref: "" })], ["ref a number", good({ ref: 7 })],
  ])("rejects malformed content even with a valid-looking signature: %s", async (_n, b: any) => {
    const r = await hit(b, "x");
    expect(r.statusCode).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("a VALIDLY signed call whose ref is not text is still refused before the database is asked", async () => {
    for (const ref of [{}, { a: 1 }, 7, ["x"], null]) {
      const b = { ref, status: "paid", amountPaise: 50000 };
      const r = await hit(b, sign(ref as any, "paid", 50000));
      expect(r.statusCode, JSON.stringify(ref)).toBe(401);
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("a correctly signed call about an unknown payment is 404", async () => {
    const b = good();
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await hit(b, signed(b))).statusCode).toBe(404);
  });

  it("a correctly signed call with the wrong amount is 400 and changes nothing", async () => {
    const b = good({ amountPaise: 1 });
    pool.query.mockResolvedValue({ rows: [{ amount_paise: 50000 }], rowCount: 1 });
    const r = await hit(b, signed(b));
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("AMOUNT_MISMATCH");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("a valid call is applied, and a repeat still answers 200 so the bank stops retrying", async () => {
    const b = good();
    pool.query.mockResolvedValue({ rows: [{ amount_paise: 50000 }], rowCount: 1 });
    client(payment("succeeded"));
    const r = await hit(b, signed(b));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ outcome: "already_processed" });
  });
});

describe("POST /bookings/:id/pay", () => {
  const app = () => { const a = Fastify(); installErrorHandlers(a); a.register(paymentRoutes); return a; };
  const pay = (id = BID) => app().inject({ method: "POST", url: `/bookings/${id}/pay` });
  const bk = (over: object = {}) => [/from bookings where id = \$1 for update/, { rows: [{ id: BID, stage: "seats_held", hold_expires_at: new Date(Date.now() + 60_000), ...over }], rowCount: 1 }] as const;
  const noPayment = [/from payments where booking_id/, { rows: [], rowCount: 0 }] as const;

  it("400 for a bad id, 404 for someone else's booking (nothing locked)", async () => {
    expect((await pay("nope")).statusCode).toBe(400);
    auth.ownedBy.mockResolvedValue(false);
    expect((await pay()).statusCode).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("404 when the booking row is gone", async () => {
    const c = client([/from bookings where id/, { rows: [], rowCount: 0 }]);
    expect((await pay()).statusCode).toBe(404);
    expect(c.sqls()).toContain("rollback");
  });

  it("starts the payment: amount = fare x passengers, the bank is told through the SAME connection, stage moves on", async () => {
    const c = client(bk(), noPayment,
      [/count\(\*\)::int as n from booking_passengers/, { rows: [{ n: 3 }] }],
      [/^insert into payments/, { rows: [{ id: "p-1", provider_ref: "ref-9", amount_paise: 150000, status: "initiated" }] }],
      stageMove);
    const r = await pay();
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ bookingId: BID, paymentId: "p-1", bankRef: "ref-9", amountPaise: 150000, status: "initiated" });
    expect(bank.createBankTransaction).toHaveBeenCalledWith(expect.any(String), 150000, c); // regression: no 2nd pool connection
    expect(c.ran(/^insert into payments/)[0].params.slice(0, 2)).toEqual([BID, 150000]);
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual([BID, "seats_held", "payment_pending"]);
    expect(c.sqls().at(-1)).toBe("commit");
    expect(c.release).toHaveBeenCalledOnce();
  });

  it("tapping Pay again returns the existing payment, creating nothing", async () => {
    const c = client(bk({ stage: "payment_pending" }),
      [/from payments where booking_id/, { rows: [{ id: "p-1", provider_ref: "ref-9", amount_paise: 50000, status: "initiated" }], rowCount: 1 }]);
    const r = await pay();
    expect(r.statusCode).toBe(200);
    expect(r.json().paymentId).toBe("p-1");
    expect(c.did(/^insert/)).toBe(false);
    expect(bank.createBankTransaction).not.toHaveBeenCalled();
  });

  it("an expired booking: 409 HOLD_EXPIRED", async () => {
    client(bk({ stage: "expired" }), noPayment);
    const r = await pay();
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("HOLD_EXPIRED");
  });

  it("a booking in another stage: 409 WRONG_STAGE", async () => {
    client(bk({ stage: "confirmed" }), noPayment);
    const r = await pay();
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("WRONG_STAGE");
  });

  it("a lapsed hold: expires the booking right now, frees the seats, commits that, and answers HOLD_EXPIRED", async () => {
    const c = client(bk({ hold_expires_at: new Date(Date.now() - 1000) }), noPayment, stageMove);
    const r = await pay();
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("HOLD_EXPIRED");
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual([BID, "seats_held", "expired"]);
    expect(c.did(/set status = 'free'/)).toBe(true);
    expect(c.sqls().at(-1)).toBe("commit");
    expect(bank.createBankTransaction).not.toHaveBeenCalled();
  });

  it("an error rolls back and releases the connection", async () => {
    const c = client(bk(), noPayment, [/count\(\*\)::int as n/, new Error("boom")]);
    expect((await pay()).statusCode).toBe(500);
    expect(c.sqls()).toContain("rollback");
    expect(c.release).toHaveBeenCalledOnce();
  });
});

describe("GET /bookings/:id/payment and the admin reconcile route", () => {
  const app = () => { const a = Fastify(); installErrorHandlers(a); a.register(paymentRoutes); return a; };

  it("returns the payment, 404 when none, 400 for a bad id, 404 for someone else's booking", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "p-1", provider_ref: "r", amount_paise: 5, status: "succeeded" }], rowCount: 1 });
    const ok = await app().inject({ method: "GET", url: `/bookings/${BID}/payment` });
    expect(ok.json()).toEqual({ bookingId: BID, paymentId: "p-1", bankRef: "r", amountPaise: 5, status: "succeeded" });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect((await app().inject({ method: "GET", url: `/bookings/${BID}/payment` })).statusCode).toBe(404);
    expect((await app().inject({ method: "GET", url: "/bookings/nope/payment" })).statusCode).toBe(400);
    auth.ownedBy.mockResolvedValue(false);
    expect((await app().inject({ method: "GET", url: `/bookings/${BID}/payment` })).statusCode).toBe(404);
  });

  it("POST /admin/reconcile runs the cash count (default: everything older than 0 seconds)", async () => {
    const r = await app().inject({ method: "POST", url: "/admin/reconcile?olderThan=5" });
    expect(r.json()).toEqual({ ok: true });
    expect(pool.query.mock.calls[0][1]).toEqual([5]);
    pool.query.mockClear();
    await app().inject({ method: "POST", url: "/admin/reconcile" });
    expect(pool.query.mock.calls[0][1]).toEqual([0]);
  });
});
