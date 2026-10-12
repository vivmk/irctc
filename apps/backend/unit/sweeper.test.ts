import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool } = vi.hoisted(() => ({ pool: { connect: vi.fn() } }));
vi.mock("../src/db", () => ({ pool }));

import { sweepExpiredHolds } from "../src/sweeper";
import { fakeDb } from "./fakes";

const use = (rules: any[]) => { const db = fakeDb(rules); pool.connect.mockResolvedValue(db); return db; };

beforeEach(() => {
  pool.connect.mockReset();
});

describe("sweepExpiredHolds", () => {
  it("expires each lapsed unpaid booking and frees its seats, all in one transaction", async () => {
    const db = use([
      [/^select id from bookings/, { rows: [{ id: "b-1" }, { id: "b-2" }] }],
      [/^update bookings set stage/, { rowCount: 1 }],
    ]);
    expect(await sweepExpiredHolds()).toBe(2);
    const sqls = db.sqls();
    expect(sqls[0]).toBe("begin");
    expect(sqls.at(-1)).toBe("commit");
    expect(db.ran(/^update bookings set stage/).map((c) => c.params)).toEqual([
      ["b-1", "seats_held", "expired"],
      ["b-2", "seats_held", "expired"],
    ]);
    expect(db.ran(/^update seat_segments/).map((c) => c.params[0])).toEqual(["b-1", "b-2"]);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("only touches unpaid (seats_held) bookings: payment_pending ones may still be confirmed by the bank", async () => {
    const db = use([[/^select id from bookings/, { rows: [] }]]);
    await sweepExpiredHolds();
    const q = db.ran(/^select id from bookings/)[0].sql;
    expect(q).toMatch(/stage = 'seats_held'/);
    expect(q).toMatch(/hold_expires_at < now\(\)/);
    expect(q).not.toMatch(/payment_pending/);
  });

  it("skips bookings someone is working on right now, and works in bounded batches", async () => {
    const db = use([[/^select id from bookings/, { rows: [] }]]);
    await sweepExpiredHolds();
    expect(db.log[1].sql).toMatch(/for update skip locked/);
    expect(db.log[1].sql).toMatch(/limit 200/);
  });

  it("nothing to do: still commits cleanly and returns 0", async () => {
    const db = use([[/^select id from bookings/, { rows: [] }]]);
    expect(await sweepExpiredHolds()).toBe(0);
    expect(db.sqls()).toEqual([expect.stringMatching(/^begin$/), expect.stringMatching(/^select id/), "commit"]);
  });

  it("if one booking has changed stage meanwhile, everything rolls back and the error surfaces", async () => {
    const db = use([
      [/^select id from bookings/, { rows: [{ id: "b-1" }, { id: "b-2" }] }],
      [/^update bookings set stage/, [{ rowCount: 1 }, { rowCount: 0 }]],
    ]);
    await expect(sweepExpiredHolds()).rejects.toThrow(/was not in stage seats_held/);
    expect(db.sqls()).toContain("rollback");
    expect(db.sqls()).not.toContain("commit");
    expect(db.release).toHaveBeenCalledOnce();
  });
});
