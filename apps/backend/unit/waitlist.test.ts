import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool, seats } = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  seats: { grabOneSeat: vi.fn() },
}));
vi.mock("../src/db", () => ({ pool }));
vi.mock("../src/bookings", () => seats);

import { promoteAllWaitlists, promoteWaitlist } from "../src/waitlist";
import { fakeDb, type FakeDb } from "./fakes";

let clients: FakeDb[];
const waitingRows = (...ids: string[]) => [/^select id from bookings/, { rows: ids.map((id) => ({ id })) }] as const;
const booking = (over: object = {}) => [/for update/, { rows: [{ run_id: 7, class: "SL", first_segment: 1, last_segment: 3, ...over }], rowCount: 1 }] as const;
const passengers = (n: number) => [/from booking_passengers where booking_id = \$1 order by position/, { rows: Array.from({ length: n }, (_, i) => ({ position: i + 1 })) }] as const;
const confirmInfo = [
  [/from bookings b/, { rows: [{ train_number: "12345", date: "2026-12-27" }] }],
  [/select coach_code as coach/, { rows: [{ coach: "S1", seat: 1 }] }],
  [/^update bookings set stage/, { rowCount: 1 }],
] as const;
const client = (...rules: any[]) => { const c = fakeDb(rules); clients.push(c); return c; };

beforeEach(() => {
  pool.query.mockReset(); pool.connect.mockReset(); seats.grabOneSeat.mockReset();
  clients = [];
  pool.connect.mockImplementation(async () => clients.shift());
});

describe("promoteWaitlist", () => {
  it("asks for the waiting bookings of one run and class, earliest first", async () => {
    const q = fakeDb([waitingRows()]); pool.query.mockImplementation(q.query);
    await promoteWaitlist(7, "SL");
    expect(q.log[0].sql).toMatch(/stage = 'waitlisted'/);
    expect(q.log[0].sql).toMatch(/order by waitlisted_at, id/);
    expect(q.log[0].params).toEqual([7, "SL"]);
  });

  it("seats the first in line; a booking that doesn't fit is skipped and the next one gets its chance", async () => {
    const q = fakeDb([waitingRows("w-1", "w-2", "w-3")]); pool.query.mockImplementation(q.query);
    client(booking(), passengers(1));  // w-1: seat found? we say no
    client(booking(), passengers(1), ...confirmInfo); // w-2: fits
    client(booking(), passengers(1), ...confirmInfo); // w-3: fits
    seats.grabOneSeat
      .mockResolvedValueOnce(null)                      // w-1 doesn't fit
      .mockResolvedValueOnce({ coach: "S1", seat: 1 })  // w-2
      .mockResolvedValueOnce({ coach: "S1", seat: 2 }); // w-3
    expect(await promoteWaitlist(7, "SL")).toBe(2);
  });

  it("reports zero when nobody is waiting", async () => {
    const q = fakeDb([waitingRows()]); pool.query.mockImplementation(q.query);
    expect(await promoteWaitlist(7, "SL")).toBe(0);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe("promoting one booking", () => {
  const promote = async () => { const q = fakeDb([waitingRows("w-1")]); pool.query.mockImplementation(q.query); return promoteWaitlist(7, "SL"); };

  it("confirms it: seats assigned per passenger, made permanent, stage moved, note written, one transaction", async () => {
    const c = client(booking(), passengers(2), ...confirmInfo);
    seats.grabOneSeat.mockResolvedValueOnce({ coach: "S1", seat: 4 }).mockResolvedValueOnce({ coach: "S1", seat: 5 });
    expect(await promote()).toBe(1);

    const sqls = c.sqls();
    expect(sqls[0]).toBe("begin");
    expect(sqls.at(-1)).toBe("commit");
    expect(c.ran(/^update booking_passengers/).map((x) => x.params)).toEqual([["w-1", 1, "S1", 4], ["w-1", 2, "S1", 5]]);
    const perm = c.ran(/set status = 'booked'/)[0];
    expect(perm.sql).toMatch(/held_until = null/);
    expect(perm.sql).toMatch(/status = 'held'/);
    expect(c.ran(/^update bookings set stage/)[0].params).toEqual(["w-1", "waitlisted", "confirmed"]);
    expect(c.ran(/^insert into outbox/)[0].params.slice(0, 2)).toEqual(["w-1", "booking_confirmed"]);
    expect(c.did(/rollback/)).toBe(false);
    expect(c.release).toHaveBeenCalledOnce();
  });

  it("looks for seats on the booking's own journey and class", async () => {
    client(booking({ run_id: 9, class: "3A", first_segment: 2, last_segment: 3 }), passengers(1), ...confirmInfo);
    seats.grabOneSeat.mockResolvedValue({ coach: "B1", seat: 1 });
    await promote();
    expect(seats.grabOneSeat).toHaveBeenCalledWith(expect.anything(), { runId: 9, cls: "3A", first: 2, last: 3, bookingId: "w-1" });
  });

  it("locks the booking row first, and only if it is still waiting", async () => {
    const c = client(booking(), passengers(1), ...confirmInfo);
    seats.grabOneSeat.mockResolvedValue({ coach: "S1", seat: 1 });
    await promote();
    expect(c.log[1].sql).toMatch(/stage = 'waitlisted' for update/);
  });

  it("all-or-nothing: two passengers but only one seat, so everything is undone", async () => {
    const c = client(booking(), passengers(2));
    seats.grabOneSeat.mockResolvedValueOnce({ coach: "S1", seat: 4 }).mockResolvedValueOnce(null);
    expect(await promote()).toBe(0);
    expect(c.sqls()).toContain("rollback");
    expect(c.sqls()).not.toContain("commit");
    expect(c.did(/set status = 'booked'/)).toBe(false);
    expect(c.did(/^insert into outbox/)).toBe(false);
    expect(c.release).toHaveBeenCalledOnce();
  });

  it("a booking someone else already handled (cancelled, or promoted) is skipped without seat-hunting", async () => {
    const c = client([/for update/, { rows: [], rowCount: 0 }]);
    expect(await promote()).toBe(0);
    expect(seats.grabOneSeat).not.toHaveBeenCalled();
    expect(c.sqls()).toContain("rollback");
  });

  it("an unexpected error rolls back, releases the connection and surfaces", async () => {
    const c = client(booking(), passengers(1));
    seats.grabOneSeat.mockRejectedValue(new Error("deadlock detected"));
    await expect(promote()).rejects.toThrow("deadlock detected");
    expect(c.sqls()).toContain("rollback");
    expect(c.release).toHaveBeenCalledOnce();
  });
});

describe("promoteAllWaitlists (the safety-net job)", () => {
  it("looks at every waiting line and adds up the promotions", async () => {
    const q = fakeDb([
      [/select distinct run_id, class/, { rows: [{ run_id: 7, class: "SL" }, { run_id: 7, class: "3A" }] }],
      [/^select id from bookings/, [{ rows: [{ id: "w-1" }] }, { rows: [{ id: "w-2" }] }]],
    ]);
    pool.query.mockImplementation(q.query);
    client(booking(), passengers(1), ...confirmInfo);
    client(booking(), passengers(1));
    seats.grabOneSeat.mockResolvedValueOnce({ coach: "S1", seat: 1 }).mockResolvedValueOnce(null);
    expect(await promoteAllWaitlists()).toBe(1);
    expect(q.ran(/^select id from bookings/).map((c) => c.params)).toEqual([[7, "SL"], [7, "3A"]]);
  });

  it("zero when no one is waiting anywhere", async () => {
    const q = fakeDb([[/select distinct run_id, class/, { rows: [] }]]);
    pool.query.mockImplementation(q.query);
    expect(await promoteAllWaitlists()).toBe(0);
  });
});
