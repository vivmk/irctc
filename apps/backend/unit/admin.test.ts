import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pool, sweeper, wl } = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  sweeper: { sweepExpiredHolds: vi.fn() },
  wl: { promoteAllWaitlists: vi.fn() },
}));
vi.mock("../src/db", () => ({ pool }));
vi.mock("../src/sweeper", () => sweeper);
vi.mock("../src/waitlist", () => wl);

import { adminRoutes } from "../src/admin";
import { clockIsOverridden, clockNow, setClock } from "../src/clock";
import { sendSms, setSmsDown } from "../src/providers";
import { fakeDb } from "./fakes";

const app = () => { const a = Fastify(); a.register(adminRoutes); return a; };
const call = (method: "GET" | "POST", url: string) => app().inject({ method, url });

beforeEach(() => { sweeper.sweepExpiredHolds.mockReset().mockResolvedValue(2); wl.promoteAllWaitlists.mockReset().mockResolvedValue(1); pool.query.mockReset(); });
afterEach(() => { setClock(null); setSmsDown(false); });

describe("admin routes (test and dev helpers)", () => {
  it("/admin/sweep runs the sweeper and reports how many holds it released", async () => {
    expect((await call("POST", "/admin/sweep")).json()).toEqual({ released: 2 });
  });

  it("/admin/promote runs the waiting-list job", async () => {
    expect((await call("POST", "/admin/promote")).json()).toEqual({ promoted: 1 });
  });

  it("/admin/sms flips the fake SMS provider", async () => {
    expect((await call("POST", "/admin/sms?down=true")).json()).toEqual({ smsDown: true });
    await expect(sendSms("x", "y")).rejects.toThrow();
    expect((await call("POST", "/admin/sms?down=false")).json()).toEqual({ smsDown: false });
    await expect(sendSms("x", "y")).resolves.toBeUndefined();
    await call("POST", "/admin/sms?down=banana");
    await expect(sendSms("x", "y")).resolves.toBeUndefined(); // anything but "true" means up
  });

  it("/admin/clock sets, shows and clears the pretend time", async () => {
    const set = await call("POST", "/admin/clock?now=2026-12-27T08:30:00Z");
    expect(set.json()).toEqual({ now: "2026-12-27T08:30:00.000Z" });
    expect(clockNow()).toBe(Date.parse("2026-12-27T08:30:00Z"));
    expect((await call("GET", "/admin/clock")).json()).toEqual({ overridden: true, now: "2026-12-27T08:30:00.000Z" });
    expect((await call("POST", "/admin/clock")).json()).toEqual({ clock: "real" });
    expect(clockIsOverridden()).toBe(false);
    expect((await call("GET", "/admin/clock")).json().overridden).toBe(false);
  });

  it("a nonsense time is 400 and leaves the clock alone", async () => {
    const r = await call("POST", "/admin/clock?now=not-a-date");
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("BAD_REQUEST");
    expect(clockIsOverridden()).toBe(false);
  });

  it("/admin/notifications/:id lists the notes and what was delivered", async () => {
    const db = fakeDb([
      [/from outbox/, { rows: [{ type: "booking_confirmed", status: "sent", attempts: 2, last_error: null }] }],
      [/from notification_log/, { rows: [{ channel: "email", body: "hi" }, { channel: "sms", body: "hi" }] }],
    ]);
    pool.query.mockImplementation(db.query);
    expect((await call("GET", "/admin/notifications/b-1")).json()).toEqual({
      events: [{ type: "booking_confirmed", status: "sent", attempts: 2, lastError: null }],
      delivered: [{ channel: "email", body: "hi" }, { channel: "sms", body: "hi" }],
    });
    expect(db.log.every((c) => c.params[0] === "b-1")).toBe(true);
  });
});
