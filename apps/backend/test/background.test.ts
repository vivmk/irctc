import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  avail,
  bankPay,
  book,
  bookAndStartPayment,
  db,
  dbStage,
  notifications,
  resetDb,
  sleep,
  stage,
  startPay,
  sweep,
  waitFor,
} from "./helpers";
import { withLock } from "../src/lock";
import { redis } from "../src/redis";

beforeEach(async () => {
  await resetDb();
  await api("POST", "/admin/sms?down=false");
});
afterAll(async () => {
  await redis.quit().catch(() => {});
});

describe("sweeper (hold timeout is 3 seconds in tests)", () => {
  it("expires unpaid bookings in the database and frees their seats", async () => {
    const b = await book({ pax: 2 });
    const id = b.body.bookingId;
    await sleep(4000);
    expect(await dbStage(id)).toBe("seats_held"); // stored truth is still old
    await sweep();
    expect(await dbStage(id)).toBe("expired"); // now fixed
    const left = await db.query(
      "select count(*)::int as n from seat_segments where booking_id = $1",
      [id],
    );
    expect(left.rows[0].n).toBe(0);
    expect(await avail("2026-12-27", "3A")).toBe(8);
  });

  it("leaves bookings that are waiting on the bank alone", async () => {
    const { id } = await bookAndStartPayment();
    await sleep(4000);
    await sweep();
    expect(await dbStage(id)).toBe("payment_pending");
  });

  it("paying after the sweeper ran says the hold ran out", async () => {
    const b = await book();
    await sleep(4000);
    await sweep();
    const r = await startPay(b.body.bookingId);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("HOLD_EXPIRED");
  });
});

describe("notifications", () => {
  it("a confirmed booking gets one note, delivered by email and sms", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref);
    await waitFor(
      async () => (await notifications(id)).events[0]?.status === "sent",
    );
    const n = await notifications(id);
    expect(n.events).toHaveLength(1);
    expect(n.events[0].type).toBe("booking_confirmed");
    expect(n.delivered.map((d) => d.channel).sort()).toEqual(["email", "sms"]);
    expect(n.delivered[0].body).toContain("Booking confirmed");
  });

  it("the bank calling twice still produces one note", async () => {
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref, "twice");
    await waitFor(
      async () => (await notifications(id)).events[0]?.status === "sent",
    );
    const n = await notifications(id);
    expect(n.events).toHaveLength(1);
    expect(n.delivered).toHaveLength(2);
  });

  it("when sms is down it retries, and delivers once sms is back", async () => {
    await api("POST", "/admin/sms?down=true");
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref);

    await waitFor(async () => (await notifications(id)).delivered.length === 1); // email got out
    await sleep(800);
    let n = await notifications(id);
    expect(n.events[0].status).not.toBe("sent");
    expect(n.events[0].lastError).toMatch(/SMS provider/);

    await api("POST", "/admin/sms?down=false");
    await waitFor(
      async () => (await notifications(id)).events[0].status === "sent",
      20_000,
    );
    n = await notifications(id);
    expect(n.delivered.map((d) => d.channel).sort()).toEqual(["email", "sms"]);
    expect(n.events[0].attempts).toBeGreaterThan(1);
  });

  it("sms down for good: the booking still confirms instantly, and the note ends up dead", async () => {
    await api("POST", "/admin/sms?down=true");
    const { id, ref } = await bookAndStartPayment();
    await bankPay(ref);
    expect(await stage(id)).toBe("confirmed"); // notification trouble never slows the booking

    await waitFor(
      async () => (await notifications(id)).events[0]?.attempts >= 3,
      15_000,
    );
    await waitFor(
      async () => (await notifications(id)).events[0]?.status === "dead",
      40_000,
    );

    const n = await notifications(id);
    expect(n.events[0].attempts).toBe(8);
    expect(n.events[0].lastError).toMatch(/SMS provider/);
    expect(n.delivered.map((d) => d.channel)).toEqual(["email"]);
  }, 60_000);

  it("an automatic refund sends a refund message", async () => {
    const a = await book({ cls: "SL", pax: 6 });
    const pay = await startPay(a.body.bookingId);
    await sleep(4000);
    await book({ cls: "SL", pax: 6 }); // takes A's old seats
    await bankPay(pay.body.bankRef); // A's money arrives late
    await waitFor(async () => {
      const n = await notifications(a.body.bookingId);
      return n.events.some(
        (e) => e.type === "refund_issued" && e.status === "sent",
      );
    });
    const n = await notifications(a.body.bookingId);
    expect(n.delivered.some((d) => d.body.includes("Refund"))).toBe(true);
  });
});

describe("lock", () => {
  it("only one of two simultaneous runners gets it", async () => {
    const name = `t-${randomUUID()}`;
    let runs = 0;
    const job = async () => {
      runs++;
      await sleep(300);
    };
    const results = await Promise.all([
      withLock(name, 5000, job),
      withLock(name, 5000, job),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(runs).toBe(1);
    expect(await withLock(name, 5000, job)).toBe(true); // free again after release
  });
});
