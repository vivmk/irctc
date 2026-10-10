import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  avail,
  bankPay,
  book,
  bookAndStartPayment,
  db,
  dbStage,
  notifications,
  resetDb,
  stage,
  waitFor,
  bookConfirmed,
  bookWaitlisted,
} from "./helpers";
import { startServer, stopServer, type Copy } from "./server";

let copy: Copy;

beforeAll(async () => {
  copy = await startServer(3102, {
    SWEEP_EVERY_SECONDS: "1",
    RECONCILE_EVERY_SECONDS: "1",
    RECONCILE_AFTER_SECONDS: "1",
    WAITLIST_EVERY_SECONDS: "1",
  });
});
afterAll(async () => {
  await stopServer(copy.child);
});
beforeEach(resetDb);

describe("jobs that run by themselves", () => {
  it("the sweeper expires an unpaid booking without anyone calling it", async () => {
    const b = await book({ pax: 2 });
    const id = b.body.bookingId;
    expect(await dbStage(id)).toBe("seats_held");
    await waitFor(async () => (await dbStage(id)) === "expired", 15_000);
    expect(await avail("2026-12-27", "3A")).toBe(8);
  });

  it("the reconciler repairs a lost bank call without anyone calling it", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref, "never");
    await waitFor(async () => (await stage(id)) === "confirmed", 15_000);
  });
});

describe("two app copies running together", () => {
  it("5 confirmations produce exactly 5 notes and 10 messages", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id, ref } = await bookAndStartPayment({ cls: "SL" });
      await bankPay(ref);
      ids.push(id);
    }
    await waitFor(async () => {
      const all = await Promise.all(ids.map(notifications));
      return all.every((n) => n.events[0]?.status === "sent");
    }, 20_000);

    for (const id of ids) {
      const n = await notifications(id);
      expect(n.events).toHaveLength(1);
      expect(n.delivered).toHaveLength(2);
    }
    expect(
      (await db.query("select count(*)::int n from notification_log")).rows[0]
        .n,
    ).toBe(10);
  });
});

describe("shutdown", () => {
  it("exits cleanly with code 0 when asked to stop", async () => {
    const extra = await startServer(3103);
    expect(await stopServer(extra.child)).toBe(0);
  });
});

describe("waiting list job", () => {
  it("promotes someone when a seat frees up with no cancellation at all", async () => {
    await bookConfirmed({ cls: "SL", pax: 6 });
    await bookConfirmed({ cls: "SL" });
    const unpaid = await book({ cls: "SL" }); // takes the last seat, never pays
    const uid = unpaid.body.bookingId;
    // keep that hold alive while the waiting booking is set up
    await db.query(
      "update seat_segments set held_until = now() + interval '1 hour' where booking_id = $1",
      [uid],
    );
    await db.query(
      "update bookings set hold_expires_at = now() + interval '1 hour' where id = $1",
      [uid],
    );

    const w = await bookWaitlisted({ cls: "SL" });
    expect(await stage(w.id)).toBe("waitlisted");

    // now let the unpaid hold run out; the background jobs should do the rest
    await db.query(
      "update seat_segments set held_until = now() - interval '1 second' where booking_id = $1",
      [uid],
    );
    await db.query(
      "update bookings set hold_expires_at = now() - interval '1 second' where id = $1",
      [uid],
    );

    await waitFor(async () => (await stage(w.id)) === "confirmed", 15_000);
  });
});
