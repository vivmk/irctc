import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  withLock: vi.fn(),
  reconcileOnce: vi.fn(), sweepExpiredHolds: vi.fn(), relayOutbox: vi.fn(), requeueStuck: vi.fn(),
  promoteAllWaitlists: vi.fn(), query: vi.fn(),
}));
vi.mock("../src/lock", () => ({ withLock: m.withLock }));
vi.mock("../src/payments", () => ({ reconcileOnce: m.reconcileOnce }));
vi.mock("../src/sweeper", () => ({ sweepExpiredHolds: m.sweepExpiredHolds }));
vi.mock("../src/queue", () => ({ relayOutbox: m.relayOutbox, requeueStuck: m.requeueStuck }));
vi.mock("../src/waitlist", () => ({ promoteAllWaitlists: m.promoteAllWaitlists }));
vi.mock("../src/db", () => ({ pool: { query: m.query } }));

import { startScheduler } from "../src/scheduler";

const log: any = { error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(m).forEach((f) => f.mockReset());
  m.withLock.mockImplementation(async (_n: string, _t: number, fn: () => Promise<void>) => { await fn(); return true; });
  log.error.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe("startScheduler", () => {
  it("schedules every job at its own interval (defaults: sweep 30s, reconcile 30s, relay 2s, requeue 10s, waitlist 5s, cleanup 1h)", async () => {
    const stop = startScheduler(log);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(m.relayOutbox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.relayOutbox).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000); // t = 5s
    expect(m.promoteAllWaitlists).toHaveBeenCalledTimes(1);
    expect(m.relayOutbox).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000); // t = 10s
    expect(m.requeueStuck).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000); // t = 30s
    expect(m.sweepExpiredHolds).toHaveBeenCalledTimes(1);
    expect(m.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(m.reconcileOnce).toHaveBeenCalledWith(60);

    expect(m.query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_570_000); // t = 1h
    expect(m.query).toHaveBeenCalledWith("delete from sessions where expires_at < now()");
    stop();
  });

  it("every job runs under its own named lock, so only one app copy does the work", async () => {
    const stop = startScheduler(log);
    await vi.advanceTimersByTimeAsync(30_000);
    const names = new Set(m.withLock.mock.calls.map((c) => c[0]));
    expect(names).toEqual(new Set(["relay", "waitlist", "requeue", "sweep", "reconcile"]));
    expect(m.withLock.mock.calls.every((c) => c[1] === 25_000)).toBe(true);
    stop();
  });

  it("a runner that doesn't get the lock does NOT run the job", async () => {
    m.withLock.mockResolvedValue(false);
    const stop = startScheduler(log);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.relayOutbox).not.toHaveBeenCalled();
    expect(m.sweepExpiredHolds).not.toHaveBeenCalled();
    stop();
  });

  it("a failing job is logged with its name and does not stop the schedule", async () => {
    m.relayOutbox.mockRejectedValueOnce(new Error("redis down")).mockResolvedValue(undefined);
    const stop = startScheduler(log);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(log.error).toHaveBeenCalledWith(expect.any(Error), "scheduled job relay failed");
    expect(m.relayOutbox).toHaveBeenCalledTimes(2); // carried on after the failure
    stop();
  });

  it("failing to get the lock at all (Redis down) is also logged, not thrown", async () => {
    m.withLock.mockRejectedValue(new Error("Redis down"));
    const stop = startScheduler(log);
    await vi.advanceTimersByTimeAsync(3_000); // would reject if the error escaped
    expect(log.error).toHaveBeenCalled();
    stop();
  });

  it("the returned function stops every job", async () => {
    const stop = startScheduler(log);
    stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(m.relayOutbox).not.toHaveBeenCalled();
    expect(m.withLock).not.toHaveBeenCalled();
  });
});
