import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { api, avail, book, db, resetDb, sleep, stage } from "./helpers";

beforeEach(resetDb);

describe("seat model", () => {
  it("a booked segment only blocks journeys that touch it", async () => {
    await db.query(
      `update seat_segments set status='booked'
       where run_id=(select id from train_runs where journey_date='2026-12-25')
         and coach_code='B1' and seat_number=1 and segment_no=2`,
    );
    expect(await avail("2026-12-25", "3A", "NDLS", "PNBE")).toBe(7);
    expect(await avail("2026-12-25", "3A", "NDLS", "CNB")).toBe(8);
    expect(await avail("2026-12-25", "3A", "CNB", "PNBE")).toBe(7);
    expect(await avail("2026-12-25", "3A", "PRYJ", "PNBE")).toBe(8);
  });

  it("the database itself refuses a duplicate seat row", async () => {
    await expect(
      db.query(`insert into seat_segments (run_id, coach_code, seat_number, segment_no)
                select run_id, coach_code, seat_number, segment_no from seat_segments limit 1`),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("booking", () => {
  it("rejects a request id that is not a uuid", async () => {
    const r = await api("POST", "/bookings", { requestId: "nope" });
    expect(r.status).toBe(400);
  });

  it("holds two different seats for two passengers", async () => {
    const r = await book({ pax: 2 });
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe("seats_held");
    const seats = r.body.seats.map((s: any) => `${s.coach}-${s.seat}`);
    expect(new Set(seats).size).toBe(2);
    expect(await avail("2026-12-27", "3A")).toBe(6);
  });

  it("the same requestId twice gives the same booking and takes seats once", async () => {
    const requestId = randomUUID();
    const first = await book({ requestId });
    const second = await book({ requestId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.bookingId).toBe(first.body.bookingId);
    expect(await avail("2026-12-27", "3A")).toBe(7);
  });

  it("sold out rolls everything back", async () => {
    expect((await book({ cls: "SL", pax: 6 })).status).toBe(201);
    const r = await book({ cls: "SL", pax: 6 }); // only 2 seats left
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("SOLD_OUT");
    expect(await avail("2026-12-27", "SL")).toBe(2); // unchanged by the failed attempt
  });

  it("an unpaid hold expires and the seats come back", async () => {
    const r = await book({ pax: 2 });
    expect(await avail("2026-12-27", "3A")).toBe(6);
    await sleep(4000); // hold is 3 seconds in the test server
    expect(await stage(r.body.bookingId)).toBe("expired");
    expect(await avail("2026-12-27", "3A")).toBe(8);
  });
});

describe("many people at once", () => {
  it("100 simultaneous requests for 8 seats: exactly 8 win, nobody shares a seat", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => book({ date: "2026-12-26" })),
    );
    const tally = (code: number) =>
      results.filter((r) => r.status === code).length;
    expect(tally(201)).toBe(8);
    expect(tally(409)).toBe(92);

    const dupes = await db.query(
      `select coach_code, seat_number from booking_passengers
       group by 1, 2 having count(*) > 1`,
    );
    expect(dupes.rowCount).toBe(0);
  });
});
