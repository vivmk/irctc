import { describe, expect, it } from "vitest";
import { releaseSeats } from "../src/seats";
import { fakeDb } from "./fakes";

describe("releaseSeats", () => {
  it("frees only the booking's HELD seats, clearing owner and hold time", async () => {
    const db: any = fakeDb();
    await releaseSeats(db, "b-1");
    expect(db.log).toHaveLength(1);
    const { sql, params } = db.log[0];
    expect(params).toEqual(["b-1"]);
    expect(sql).toMatch(/set status = 'free', booking_id = null, held_until = null/);
    // confirmed (booked) seats and other people's seats must be untouched
    expect(sql).toMatch(/where booking_id = \$1 and status = 'held'/);
  });
});
