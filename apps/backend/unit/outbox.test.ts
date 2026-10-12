import { describe, expect, it } from "vitest";
import { addOutbox, confirmationPayload } from "../src/outbox";
import { fakeDb } from "./fakes";

describe("addOutbox", () => {
  it("writes the note, once per booking and type (a repeat does nothing)", async () => {
    const db: any = fakeDb();
    await addOutbox(db, "b-1", "booking_confirmed", { a: 1 });
    const { sql, params } = db.log[0];
    expect(sql).toMatch(/insert into outbox \(booking_id, type, payload\)/);
    expect(sql).toMatch(/on conflict \(booking_id, type\) do nothing/);
    expect(params).toEqual(["b-1", "booking_confirmed", '{"a":1}']);
  });

  it("stores the payload as JSON text", async () => {
    const db: any = fakeDb();
    await addOutbox(db, "b-1", "refund_issued", { bookingId: "b-1", amountPaise: 44000 });
    expect(JSON.parse(db.log[0].params[2])).toEqual({ bookingId: "b-1", amountPaise: 44000 });
  });
});

describe("confirmationPayload", () => {
  it("combines train, date and every passenger's seat in order", async () => {
    const db: any = fakeDb([
      [/from bookings b/, { rows: [{ train_number: "12345", date: "2026-12-27" }] }],
      [/from booking_passengers/, { rows: [{ coach: "B1", seat: 1 }, { coach: "B1", seat: 2 }] }],
    ]);
    expect(await confirmationPayload(db, "b-1")).toEqual({
      bookingId: "b-1",
      trainNumber: "12345",
      date: "2026-12-27",
      seats: [{ coach: "B1", seat: 1 }, { coach: "B1", seat: 2 }],
    });
    expect(db.ran(/booking_passengers/)[0].sql).toMatch(/order by position/);
  });

  it("throws if the booking doesn't exist (a note must never be written for nothing)", async () => {
    const db: any = fakeDb([[/from bookings b/, { rows: [] }]]);
    await expect(confirmationPayload(db, "nope")).rejects.toThrow();
  });
});
