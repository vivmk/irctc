import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOOKING_STAGES, type BookingStage } from "@irctc/shared-types";
import { moveStage } from "../src/stages";
import { fakeDb } from "./fakes";

const asClient = (db: ReturnType<typeof fakeDb>) => db as any;

async function allowed(from: BookingStage, to: BookingStage) {
  const db = fakeDb([[/^update bookings/, { rowCount: 1 }]]);
  try {
    await moveStage(asClient(db), "b-1", from, to);
    return true;
  } catch (e) {
    if ((e as Error).message.startsWith("illegal move")) return false;
    throw e;
  }
}

describe("moveStage", () => {
  it("makes the move with a guard on the current stage", async () => {
    const db = fakeDb([[/^update bookings/, { rowCount: 1 }]]);
    await moveStage(asClient(db), "b-1", "seats_held", "payment_pending");
    expect(db.sqls()).toEqual(["update bookings set stage = $3 where id = $1 and stage = $2"]);
    expect(db.log[0].params).toEqual(["b-1", "seats_held", "payment_pending"]);
  });

  it("refuses an illegal move WITHOUT touching the database", async () => {
    const db = fakeDb();
    await expect(moveStage(asClient(db), "b-1", "confirmed", "seats_held")).rejects.toThrow(
      "illegal move confirmed -> seats_held",
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it("fails loudly if the booking is no longer in the stage we thought (someone else moved it)", async () => {
    const db = fakeDb([[/^update bookings/, { rowCount: 0 }]]);
    await expect(moveStage(asClient(db), "b-1", "seats_held", "expired")).rejects.toThrow(
      "booking b-1 was not in stage seats_held",
    );
  });

  it("the legal moves are exactly the ones in the rulebook", async () => {
    const expected = new Set([
      "started>seats_held",
      "seats_held>payment_pending", "seats_held>expired",
      "payment_pending>confirmed", "payment_pending>waitlisted",
      "payment_pending>payment_failed", "payment_pending>expired",
      "confirmed>cancelled",
      "waitlisted>confirmed", "waitlisted>cancelled",
    ]);
    const got = new Set<string>();
    for (const from of BOOKING_STAGES) for (const to of BOOKING_STAGES) if (await allowed(from, to)) got.add(`${from}>${to}`);
    expect(got).toEqual(expected);
  });

  it("terminal stages lead nowhere", async () => {
    for (const from of ["payment_failed", "expired", "cancelled"] as const)
      for (const to of BOOKING_STAGES) expect(await allowed(from, to)).toBe(false);
  });

  it("agrees with the database trigger in the migration (the two lists must never drift apart)", async () => {
    const sql = readFileSync(path.join(import.meta.dirname, "..", "migrations", "004_payments.sql"), "utf8");
    const block = sql.slice(sql.indexOf("(old.stage, new.stage) in ("));
    const pairs = [...block.slice(0, block.indexOf(") then")).matchAll(/\('(\w+)','(\w+)'\)/g)].map(
      (m) => `${m[1]}>${m[2]}`,
    );
    expect(pairs.length).toBeGreaterThan(5);
    const code = new Set<string>();
    for (const from of BOOKING_STAGES) for (const to of BOOKING_STAGES) if (await allowed(from, to)) code.add(`${from}>${to}`);
    expect(code).toEqual(new Set(pairs));
  });
});
