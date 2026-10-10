import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  avail,
  bankFail,
  bankForge,
  bankPay,
  book,
  bookAndStartPayment,
  db,
  payStatus,
  reconcile,
  resetDb,
  sleep,
  stage,
  startPay,
} from "./helpers";

beforeEach(resetDb);
const DATE = "2026-12-27";

describe("payment outcomes", () => {
  it("1. happy path: paid means confirmed", async () => {
    const before = await avail(DATE, "3A");
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref);
    expect(await stage(id)).toBe("confirmed");
    expect(await payStatus(id)).toBe("succeeded");
    expect(await avail(DATE, "3A")).toBe(before - 1);
  });

  it("2. failed payment releases the seat", async () => {
    const before = await avail(DATE, "3A");
    const { id, ref } = await bookAndStartPayment();
    await bankFail(ref);
    expect(await stage(id)).toBe("payment_failed");
    expect(await avail(DATE, "3A")).toBe(before);
  });

  it("3. the bank calling twice changes nothing the second time", async () => {
    const before = await avail(DATE, "3A");
    const { id, ref } = await bookAndStartPayment();
    const r = await bankPay(ref, "twice");
    expect(r.body.webhookResponses).toEqual([200, 200]);
    expect(await stage(id)).toBe("confirmed");
    expect(await avail(DATE, "3A")).toBe(before - 1);
  });

  it("4. a forged call is rejected and nothing changes", async () => {
    const { id, ref } = await bookAndStartPayment();
    const r = await bankForge(ref);
    expect(r.body.webhookResponse).toBe(401);
    expect(await stage(id)).toBe("payment_pending");
  });

  it("5. a lost call is repaired by reconciliation", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref, "never");
    expect(await stage(id)).toBe("payment_pending");
    await reconcile();
    expect(await stage(id)).toBe("confirmed");
  });
});

describe("paying", () => {
  it("tapping Pay twice gives one payment", async () => {
    const b = await book();
    const first = await startPay(b.body.bookingId);
    const second = await startPay(b.body.bookingId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.paymentId).toBe(first.body.paymentId);
  });

  it("paying a confirmed booking returns the same payment, never a new one", async () => {
    const b = await book();
    const first = await startPay(b.body.bookingId);
    await bankPay(first.body.bankRef);
    const again = await startPay(b.body.bookingId);
    expect(again.body.paymentId).toBe(first.body.paymentId);
    expect(again.body.status).toBe("succeeded");
  });

  it("paying after the hold ran out is refused", async () => {
    const b = await book();
    await sleep(4000);
    const r = await startPay(b.body.bookingId);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("HOLD_EXPIRED");
    expect(await avail(DATE, "3A")).toBe(8);
  });

  it("an amount that differs from our record is rejected", async () => {
    const { ref } = await bookAndStartPayment();
    const { createHmac } = await import("node:crypto");
    const amountPaise = 1; // our record says 50000
    const signature = createHmac("sha256", "test-secret")
      .update(`${ref}|paid|${amountPaise}`)
      .digest("hex");

    const res = await fetch(`http://localhost:3101/webhooks/payment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bank-signature": signature,
      },
      body: JSON.stringify({ ref, status: "paid", amountPaise }),
    });
    expect(res.status).toBe(400);
  });
});

describe("late money (hold is 3 seconds in tests)", () => {
  it("6. seats taken by someone else: automatic refund", async () => {
    const a = await book({ cls: "SL", pax: 6 });
    const pay = await startPay(a.body.bookingId);
    await sleep(4000); // A's hold expires
    const b = await book({ cls: "SL", pax: 6 }); // B takes A's old seats
    expect(b.status).toBe(201);

    await bankPay(pay.body.bankRef); // A's money arrives late

    expect(await payStatus(a.body.bookingId)).toBe("refunded");
    expect(await stage(a.body.bookingId)).toBe("expired");
    expect(
      (await api("GET", `/fakebank/${pay.body.bankRef}`)).body.status,
    ).toBe("refunded");
    expect(await stage(b.body.bookingId)).toBe("seats_held"); // B untouched
  });

  it("7. seats still free: late payment is still confirmed", async () => {
    const { id, ref } = await bookAndStartPayment({
      date: "2026-12-26",
      cls: "SL",
    });
    await sleep(4000);
    await bankPay(ref);
    expect(await stage(id)).toBe("confirmed");
  });
});

describe("stage rules inside the database", () => {
  it("refuses to move an expired booking back to confirmed", async () => {
    const b = await book();
    await sleep(4000);
    await startPay(b.body.bookingId); // this marks the booking expired
    await expect(
      db.query("update bookings set stage='confirmed' where id = $1", [
        b.body.bookingId,
      ]),
    ).rejects.toThrow(/illegal booking stage move/);
  });
});
