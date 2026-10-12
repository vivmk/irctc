import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool, auth, journey } = vi.hoisted(() => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  auth: { ownedBy: vi.fn() },
  journey: { resolveJourney: vi.fn() },
}));
vi.mock("../src/db", () => ({ pool }));
vi.mock("../src/auth", () => ({
  requireUser: async (req: any) => { req.userId = "user-1"; },
  ownedBy: auth.ownedBy,
}));
vi.mock("../src/journey", async (orig) => ({ ...(await orig<typeof import("../src/journey")>()), resolveJourney: journey.resolveJourney }));

import { grabOneSeat, bookingRoutes, validate } from "../src/bookings";
import { installErrorHandlers } from "../src/errors";
import { fakeDb, type FakeDb } from "./fakes";

const UUID = "4cc7e948-3543-4b26-8bf9-12aebbef29b1";
const pax = { name: "Asha", age: 30, gender: "female" };
const good = (over: object = {}): any => ({
  requestId: UUID, trainNumber: "12345", date: "2026-12-27", from: "NDLS", to: "PNBE", class: "3A", passengers: [pax], ...over,
});

describe("validate", () => {
  it("accepts a good request", () => expect(validate(good())).toBeNull());

  const bad: [string, any][] = [
    ["no body", undefined],
    ["null body", null],
    ["a text body", "hello"],
    ["an array body", []],
    ["requestId missing", good({ requestId: undefined })],
    ["requestId not a uuid", good({ requestId: "nope" })],
    ["requestId a number", good({ requestId: 123 })],
    ["requestId is SQL", good({ requestId: "' or 1=1 --" })],
    ["trainNumber missing", good({ trainNumber: undefined })],
    ["trainNumber a list", good({ trainNumber: ["12345"] })],
    ["empty class", good({ class: "" })],
    ["class an object", good({ class: {} })],
    ["date not real", good({ date: "2026-02-31" })],
    ["date wrong format", good({ date: "27-12-2026" })],
    ["date with a time", good({ date: "2026-12-27T00:00:00Z" })],
    ["no passengers", good({ passengers: [] })],
    ["seven passengers", good({ passengers: Array(7).fill(pax) })],
    ["passengers an object", good({ passengers: {} })],
    ["passengers [null]", good({ passengers: [null] })],
    ["passengers [42]", good({ passengers: [42] })],
    ["passengers ['x']", good({ passengers: ["x"] })],
    ["name missing", good({ passengers: [{ ...pax, name: undefined }] })],
    ["name an object", good({ passengers: [{ ...pax, name: {} }] })],
    ["name only spaces", good({ passengers: [{ ...pax, name: "   " }] })],
    ["name 101 characters", good({ passengers: [{ ...pax, name: "x".repeat(101) }] })],
    ["age 1.5", good({ passengers: [{ ...pax, age: 1.5 }] })],
    ["age -1", good({ passengers: [{ ...pax, age: -1 }] })],
    ["age 121", good({ passengers: [{ ...pax, age: 121 }] })],
    ["age as text", good({ passengers: [{ ...pax, age: "30" }] })],
    ["age null", good({ passengers: [{ ...pax, age: null }] })],
    ["unknown gender", good({ passengers: [{ ...pax, gender: "x" }] })],
    ["gender in capitals", good({ passengers: [{ ...pax, gender: "MALE" }] })],
    ["waitlistIfFull as text", good({ waitlistIfFull: "yes" })],
  ];
  it.each(bad)("rejects: %s", (_n, body) => {
    expect(validate(body)).toEqual(expect.any(String));
  });

  it("accepts the edge cases", () => {
    expect(validate(good({ passengers: [{ ...pax, age: 0 }] }))).toBeNull();
    expect(validate(good({ passengers: [{ ...pax, age: 120 }] }))).toBeNull();
    expect(validate(good({ passengers: [{ ...pax, name: "x".repeat(100) }] }))).toBeNull();
    expect(validate(good({ passengers: [{ name: "राहुल 🚂", age: 5, gender: "other" }] }))).toBeNull();
    expect(validate(good({ passengers: Array(6).fill(pax) }))).toBeNull();
    expect(validate(good({ waitlistIfFull: true }))).toBeNull();
    expect(validate(good({ waitlistIfFull: false }))).toBeNull();
    expect(validate(good({ requestId: UUID.toUpperCase() }))).toBeNull();
  });

  it("says what is wrong, without echoing the caller's input back", () => {
    expect(validate(good({ requestId: "<script>" }))).toBe("requestId must be a uuid");
  });
});

describe("grabOneSeat", () => {
  const args = { runId: 7, cls: "3A", first: 1, last: 3, bookingId: "b-1" };
  const candidates = (...seats: [string, number][]) => [/select s\.coach_code, s\.seat_number/, { rows: seats.map(([c, n]) => ({ coach_code: c, seat_number: n })) }] as const;

  it("returns null when no seat looks free for the whole journey", async () => {
    const db: any = fakeDb([candidates()]);
    expect(await grabOneSeat(db, args)).toBeNull();
    expect(db.did(/for update/)).toBe(false);
  });

  it("looks for seats free on EVERY segment, treating expired holds as free", async () => {
    const db: any = fakeDb([candidates()]);
    await grabOneSeat(db, args);
    const q = db.log[0];
    expect(q.sql).toMatch(/having count\(\*\) = \$5/);
    expect(q.sql).toMatch(/status = 'free' or \(s\.status = 'held' and s\.held_until < now\(\)\)/);
    expect(q.params).toEqual([7, "3A", 1, 3, 3]); // needed = last - first + 1
  });

  it("locks the seat's rows without waiting, then holds all of them", async () => {
    const db: any = fakeDb([candidates(["B1", 4]), [/for update skip locked/, { rowCount: 3 }]]);
    expect(await grabOneSeat(db, args)).toEqual({ coach: "B1", seat: 4 });
    expect(db.ran(/for update skip locked/)).toHaveLength(1);
    const upd = db.ran(/^update seat_segments/)[0];
    expect(upd.sql).toMatch(/set status = 'held', booking_id = \$6/);
    expect(upd.params.slice(0, 6)).toEqual([7, "B1", 4, 1, 3, "b-1"]);
    expect(upd.params[6]).toBe(300); // default hold seconds
  });

  it("skips a seat when someone else is holding any of its segments, and tries the next", async () => {
    const db: any = fakeDb([
      candidates(["B1", 1], ["B1", 2]),
      [/for update skip locked/, [{ rowCount: 2 }, { rowCount: 3 }]], // first seat: only 2 of 3 rows lockable
    ]);
    expect(await grabOneSeat(db, args)).toEqual({ coach: "B1", seat: 2 });
    expect(db.ran(/^update seat_segments/)).toHaveLength(1);
    expect(db.ran(/^update seat_segments/)[0].params[2]).toBe(2);
  });

  it("returns null when every candidate is contended", async () => {
    const db: any = fakeDb([candidates(["B1", 1], ["B1", 2]), [/for update skip locked/, { rowCount: 0 }]]);
    expect(await grabOneSeat(db, args)).toBeNull();
    expect(db.did(/^update seat_segments/)).toBe(false);
  });

  it("a one-segment journey needs one locked row", async () => {
    const db: any = fakeDb([candidates(["S1", 8]), [/for update skip locked/, { rowCount: 1 }]]);
    expect(await grabOneSeat(db, { ...args, first: 2, last: 2 })).toEqual({ coach: "S1", seat: 8 });
  });
});

describe("POST /bookings", () => {
  let db: FakeDb;
  const useDb = (d: FakeDb) => { db = d; pool.query.mockImplementation(d.query); pool.connect.mockResolvedValue(d); };
  const app = () => { const a = Fastify(); installErrorHandlers(a); a.register(bookingRoutes); return a; };
  const post = (body: any) => app().inject({ method: "POST", url: "/bookings", payload: body });

  const seatRules = (seats: [string, number][], lockCounts: number[] = [3]) => [
    [/select s\.coach_code, s\.seat_number/, { rows: seats.map(([c, n]) => ({ coach_code: c, seat_number: n })) }],
    [/for update skip locked/, lockCounts.map((n) => ({ rowCount: n }))],
  ] as const;
  const afterwards = [
    [/select id, stage, hold_expires_at, waitlist_requested/, { rows: [{ id: "b-1", stage: "seats_held", hold_expires_at: new Date("2026-12-27T10:05:00Z"), waitlist_requested: false }] }],
    [/select name, coach_code, seat_number from booking_passengers/, { rows: [{ name: "Asha", coach_code: "B1", seat_number: 1 }] }],
  ] as const;

  beforeEach(() => {
    pool.query.mockReset(); pool.connect.mockReset(); auth.ownedBy.mockReset(); journey.resolveJourney.mockReset();
    journey.resolveJourney.mockResolvedValue({ runId: 7, first: 1, last: 3 });
  });

  it("rejects an invalid body with 400 before touching the database", async () => {
    useDb(fakeDb());
    const r = await post(good({ passengers: [] }));
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "BAD_REQUEST", canRetry: false });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(journey.resolveJourney).not.toHaveBeenCalled();
  });

  it("400 for stations not on the train, 404 when it doesn't run that day", async () => {
    useDb(fakeDb());
    journey.resolveJourney.mockResolvedValueOnce("BAD_STATIONS");
    expect((await post(good())).statusCode).toBe(400);
    journey.resolveJourney.mockResolvedValueOnce("NO_RUN");
    const r = await post(good());
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("NO_RUN");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("happy path: one transaction creates the booking, holds a seat per passenger and commits", async () => {
    useDb(fakeDb([
      [/^insert into bookings/, { rows: [{ id: "b-1" }] }],
      ...seatRules([["B1", 1], ["B1", 2]]),
      ...afterwards,
    ]));
    const r = await post(good({ passengers: [pax, { ...pax, name: "Ravi" }] }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ bookingId: "b-1", stage: "seats_held", waitlistRequested: false });
    const sqls = db.sqls();
    expect(sqls[0]).toBe("begin");
    expect(sqls.at(sqls.findIndex((s) => s === "commit"))).toBe("commit");
    expect(db.ran(/^insert into booking_passengers/)).toHaveLength(2);
    expect(db.ran(/^insert into booking_passengers/).map((c) => c.params[1])).toEqual([1, 2]); // positions
    expect(db.did(/rollback/)).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("stores the booking against the logged-in user, with the journey's segments and the hold time", async () => {
    useDb(fakeDb([[/^insert into bookings/, { rows: [{ id: "b-1" }] }], ...seatRules([["B1", 1]]), ...afterwards]));
    await post(good());
    const ins = db.ran(/^insert into bookings/)[0];
    expect(ins.params).toEqual([UUID, "user-1", 7, "3A", 1, 3, 300]);
    expect(ins.sql).toMatch(/on conflict \(request_id\) do nothing/);
  });

  it("a repeated requestId from the same user returns the earlier booking and changes nothing", async () => {
    useDb(fakeDb([
      [/^insert into bookings/, { rows: [], rowCount: 0 }],
      [/select id, user_id from bookings where request_id/, { rows: [{ id: "b-1", user_id: "user-1" }] }],
      ...afterwards,
    ]));
    const r = await post(good());
    expect(r.statusCode).toBe(200);
    expect(r.json().bookingId).toBe("b-1");
    expect(db.did(/for update skip locked/)).toBe(false);
    expect(db.did(/^commit/)).toBe(false);
    expect(db.sqls()).toContain("rollback");
  });

  it("someone else's requestId is refused and reveals nothing about that booking", async () => {
    useDb(fakeDb([
      [/^insert into bookings/, { rows: [], rowCount: 0 }],
      [/select id, user_id from bookings where request_id/, { rows: [{ id: "b-OTHER", user_id: "user-2" }] }],
    ]));
    const r = await post(good());
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("REQUEST_ID_TAKEN");
    expect(r.body).not.toContain("b-OTHER");
  });

  it("sold out: rolls back everything and says so", async () => {
    useDb(fakeDb([[/^insert into bookings/, { rows: [{ id: "b-1" }] }], ...seatRules([])]));
    const r = await post(good());
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "SOLD_OUT", canRetry: false });
    expect(db.sqls()).toContain("rollback");
    expect(db.did(/^commit/)).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("two passengers but only one seat: all-or-nothing, rolled back", async () => {
    useDb(fakeDb([
      [/^insert into bookings/, { rows: [{ id: "b-1" }] }],
      [/select s\.coach_code, s\.seat_number/, [{ rows: [{ coach_code: "B1", seat_number: 1 }] }, { rows: [] }]],
      [/for update skip locked/, { rowCount: 3 }],
    ]));
    const r = await post(good({ passengers: [pax, pax] }));
    expect(r.statusCode).toBe(409);
    expect(db.sqls()).toContain("rollback");
    expect(db.did(/^commit/)).toBe(false);
  });

  it("sold out WITH waitlistIfFull: gives back any held seats, records passengers without seats, marks the booking", async () => {
    useDb(fakeDb([
      [/^insert into bookings/, { rows: [{ id: "b-1" }] }],
      ...seatRules([]),
      [/select id, stage, hold_expires_at, waitlist_requested/, { rows: [{ id: "b-1", stage: "seats_held", hold_expires_at: new Date(Date.now() + 1e5), waitlist_requested: true }] }],
    ]));
    const r = await post(good({ waitlistIfFull: true, passengers: [pax, pax] }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ waitlistRequested: true, seats: [] });
    const sqls = db.sqls();
    expect(sqls).toContain("savepoint seats");
    expect(sqls).toContain("rollback to savepoint seats");
    expect(sqls.indexOf("rollback to savepoint seats")).toBeLessThan(sqls.indexOf("commit"));
    const inserts = db.ran(/^insert into booking_passengers/);
    expect(inserts).toHaveLength(2);
    expect(inserts.every((c) => !/coach_code/.test(c.sql))).toBe(true); // no seat columns
    expect(db.did(/set waitlist_requested = true/)).toBe(true);
  });

  it("an unexpected database error rolls back, releases the connection and answers 500", async () => {
    useDb(fakeDb([[/^insert into bookings/, new Error("connection reset")]]));
    const r = await post(good());
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("connection reset");
    expect(db.sqls()).toContain("rollback");
    expect(db.release).toHaveBeenCalledOnce();
  });
});

describe("GET /bookings/:id", () => {
  let db: FakeDb;
  const get = (id: string) => { const a = Fastify(); installErrorHandlers(a); a.register(bookingRoutes); return a.inject({ method: "GET", url: `/bookings/${id}` }); };
  const row = (over: object = {}) => ({ id: UUID, stage: "seats_held", hold_expires_at: new Date(Date.now() + 60_000), waitlist_requested: false, ...over });

  beforeEach(() => { pool.query.mockReset(); auth.ownedBy.mockReset(); auth.ownedBy.mockResolvedValue(true); });
  const useRows = (booking: any, extra: any[] = []) => {
    db = fakeDb([
      [/select id, stage, hold_expires_at, waitlist_requested/, { rows: booking ? [booking] : [] }],
      [/from booking_passengers/, { rows: [{ name: "Asha", coach_code: "B1", seat_number: 3 }] }],
      ...extra,
    ]);
    pool.query.mockImplementation(db.query);
  };

  it("400 for an id that isn't a uuid; nothing is looked up", async () => {
    useRows(row());
    expect((await get("not-a-uuid")).statusCode).toBe(400);
    expect(auth.ownedBy).not.toHaveBeenCalled();
  });

  it("404 for someone else's booking, exactly like a missing one", async () => {
    useRows(row());
    auth.ownedBy.mockResolvedValue(false);
    const r = await get(UUID);
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("NOT_FOUND");
    expect(auth.ownedBy).toHaveBeenCalledWith(UUID, "user-1");
  });

  it("shows the booking with its seats and hold deadline", async () => {
    useRows(row());
    const r = await get(UUID);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      bookingId: UUID, stage: "seats_held", waitlistRequested: false,
      seats: [{ passenger: "Asha", coach: "B1", seat: 3 }],
    });
    expect(r.json().holdExpiresAt).toEqual(expect.any(String));
  });

  it("reports a lapsed hold as expired even before the sweeper has run", async () => {
    useRows(row({ hold_expires_at: new Date(Date.now() - 1000) }));
    expect((await get(UUID)).json().stage).toBe("expired");
  });

  it("only a seats_held booking is reported as expired by time; a confirmed one stays confirmed", async () => {
    useRows(row({ stage: "confirmed", hold_expires_at: null }));
    const r = (await get(UUID)).json();
    expect(r.stage).toBe("confirmed");
    expect(r.holdExpiresAt).toBeUndefined();
  });

  it("a waiting booking shows its place in the line", async () => {
    useRows(row({ stage: "waitlisted", hold_expires_at: null }), [[/select count\(\*\)::int as n/, { rows: [{ n: 3 }] }]]);
    expect((await get(UUID)).json().waitlistPosition).toBe(3);
  });

  it("a booking that vanished between the ownership check and the load is 404", async () => {
    useRows(null);
    expect((await get(UUID)).statusCode).toBe(404);
  });
});
