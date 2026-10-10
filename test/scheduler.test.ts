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
} from "./helpers";
import { startServer, stopServer, type Copy } from "./server";

let copy: Copy;

beforeAll(async () => {
  copy = await startServer(3102, {
    SWEEP_EVERY_SECONDS: "1",
    RECONCILE_EVERY_SECONDS: "1",
    RECONCILE_AFTER_SECONDS: "1",
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
