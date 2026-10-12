import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool, bull, providers } = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  bull: { queues: [] as any[], workers: [] as any[] },
  providers: { sendEmail: vi.fn(), sendSms: vi.fn() },
}));
vi.mock("../src/db", () => ({ pool }));
vi.mock("../src/providers", () => providers);
vi.mock("bullmq", () => ({
  Queue: class { name: string; opts: any; add = vi.fn(); on = vi.fn(); close = vi.fn(); constructor(n: string, o: any) { this.name = n; this.opts = o; bull.queues.push(this); } },
  Worker: class { name: string; processor: any; opts: any; handlers: Record<string, any> = {}; constructor(n: string, p: any, o: any) { this.name = n; this.processor = p; this.opts = o; bull.workers.push(this); }
    on(e: string, fn: any) { this.handlers[e] = fn; return this; } },
}));

import { messageFor, notifyQueue, relayOutbox, requeueStuck, startWorker } from "../src/queue";
import { fakeDb, type FakeDb } from "./fakes";

let db: FakeDb;
const use = (rules: any[]) => { db = fakeDb(rules); pool.query.mockImplementation(db.query); };

beforeEach(() => {
  pool.query.mockReset();
  providers.sendEmail.mockReset().mockResolvedValue(undefined);
  providers.sendSms.mockReset().mockResolvedValue(undefined);
  (notifyQueue.add as any).mockReset();
});

describe("messageFor", () => {
  it("confirmation lists train, date and every seat", () => {
    expect(messageFor("booking_confirmed", { trainNumber: "12345", date: "2026-12-27", seats: [{ coach: "B1", seat: 1 }, { coach: "B1", seat: 2 }] }))
      .toBe("Booking confirmed: train 12345 on 2026-12-27. Seats: B1-1, B1-2.");
  });
  it("refund shows rupees with two decimals", () => {
    expect(messageFor("refund_issued", { amountPaise: 44000 })).toBe("Refund of Rs 440.00 has been issued for your booking.");
    expect(messageFor("refund_issued", { amountPaise: 37550 })).toContain("Rs 375.50");
    expect(messageFor("refund_issued", { amountPaise: 5 })).toContain("Rs 0.05");
  });
  it("waiting list note", () => {
    expect(messageFor("booking_waitlisted", {})).toContain("waiting list");
  });
  it("cancellation mentions the refund when there is one, and says none is due when there isn't", () => {
    expect(messageFor("booking_cancelled", { refundPaise: 88000 })).toBe("Booking cancelled. Your refund of Rs 880.00 is being processed.");
    expect(messageFor("booking_cancelled", { refundPaise: 0 })).toBe("Booking cancelled. No refund is due this close to departure.");
  });
  it("an unknown type still produces a sensible message", () => {
    expect(messageFor("something_new", {})).toBe("There is an update on your booking.");
  });
});

describe("the queue itself", () => {
  it("is called 'notifications' and retries with growing gaps, keeping failures for a human", () => {
    const q = bull.queues[0];
    expect(q.name).toBe("notifications");
    expect(q.opts.prefix).toBe("irctc");
    expect(q.opts.defaultJobOptions).toMatchObject({
      attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000, removeOnFail: false,
    });
  });
  it("the worker waits patiently for Redis instead of giving up", () => {
    expect(bull.queues[0].opts.connection.maxRetriesPerRequest).toBeNull();
    expect(bull.queues[0].opts.connection).toMatchObject({ host: "localhost", port: 6379 });
  });
});

describe("relayOutbox (notebook -> token line)", () => {
  it("adds one token per pending note, using the note's id as the job id, then marks it queued", async () => {
    use([[/select id from outbox where status = 'pending'/, { rows: [{ id: "n-1" }, { id: "n-2" }] }]]);
    expect(await relayOutbox()).toBe(2);
    expect(notifyQueue.add).toHaveBeenCalledTimes(2);
    expect(notifyQueue.add).toHaveBeenCalledWith("send", { outboxId: "n-1" }, { jobId: "n-1" });
    const upd = db.ran(/update outbox set status = 'queued'/);
    expect(upd).toHaveLength(2);
    expect(upd[0].sql).toMatch(/queued_at = now\(\)/);
    expect(upd[0].sql).toMatch(/status = 'pending'/); // only if still pending
    expect(upd.map((c) => c.params[0])).toEqual(["n-1", "n-2"]);
  });

  it("oldest first, bounded", async () => {
    use([[/select id from outbox/, { rows: [] }]]);
    await relayOutbox();
    expect(db.log[0].sql).toMatch(/order by created_at limit 100/);
  });

  it("does nothing when nothing is pending", async () => {
    use([[/select id from outbox/, { rows: [] }]]);
    expect(await relayOutbox()).toBe(0);
    expect(notifyQueue.add).not.toHaveBeenCalled();
  });

  it("if the queue refuses a token, the note is NOT marked queued (so it is retried)", async () => {
    use([[/select id from outbox/, { rows: [{ id: "n-1" }] }]]);
    (notifyQueue.add as any).mockRejectedValueOnce(new Error("redis down"));
    await expect(relayOutbox()).rejects.toThrow("redis down");
    expect(db.did(/update outbox set status = 'queued'/)).toBe(false);
  });
});

describe("requeueStuck", () => {
  it("puts back notes marked queued for too long, and reports how many", async () => {
    use([[/update outbox set status = 'pending'/, { rowCount: 3 }]]);
    expect(await requeueStuck()).toBe(3);
    expect(db.log[0].sql).toMatch(/where status = 'queued'/);
    expect(db.log[0].sql).toMatch(/coalesce\(queued_at, created_at\)/);
    expect(db.log[0].params).toEqual([120]);
  });
});

describe("worker: delivering a note", () => {
  const job = (outboxId = "n-1", attemptsMade = 0, attempts = 5) => ({ data: { outboxId }, attemptsMade, opts: { attempts } });
  const run = (j: any) => startWorkerProcessor()(j);
  const startWorkerProcessor = () => { startWorker(); return bull.workers.at(-1).processor as (j: any) => Promise<void>; };

  const outbox = (over: object = {}) => [/select type, payload, status from outbox/, { rows: [{ type: "booking_confirmed", payload: { trainNumber: "12345", date: "2026-12-27", seats: [{ coach: "B1", seat: 1 }] }, status: "queued", ...over }] }] as const;
  const contact = (c: object | null = { email: "asha@example.com", phone: "9876543210" }) => [/select u\.email, u\.phone from outbox/, { rows: c ? [c] : [] }] as const;
  const logged = (...already: boolean[]) => [/select 1 from notification_log/, already.map((a) => ({ rowCount: a ? 1 : 0 }))] as const;

  it("sends an email to the account's email and an sms to its mobile, and records each", async () => {
    use([outbox(), contact(), logged(false)]);
    await run(job());
    expect(providers.sendEmail).toHaveBeenCalledWith("asha@example.com", expect.stringContaining("Booking confirmed"));
    expect(providers.sendSms).toHaveBeenCalledWith("9876543210", expect.stringContaining("Booking confirmed"));
    const logs = db.ran(/^insert into notification_log/);
    expect(logs).toHaveLength(2);
    // regression: the SQL must name its columns, and record the REAL recipient, not a placeholder
    expect(logs[0].sql).toBe("insert into notification_log (outbox_id, channel, recipient, body) values ($1, $2, $3, $4) on conflict do nothing");
    expect(logs[0].params.slice(0, 3)).toEqual(["n-1", "email", "asha@example.com"]);
    expect(logs[1].params.slice(0, 3)).toEqual(["n-1", "sms", "9876543210"]);
    expect(logs[0].params[3]).toContain("Booking confirmed");
  });

  it("then marks the note sent with the attempt number and clears any earlier error", async () => {
    use([outbox(), contact(), logged(false)]);
    await run(job("n-1", 2));
    const sent = db.ran(/set status = 'sent'/)[0];
    expect(sent.sql).toMatch(/last_error = null/);
    expect(sent.params).toEqual(["n-1", 3]);
  });

  it("older bookings with no owner fall back to the placeholder recipient", async () => {
    use([outbox(), contact(null), logged(false)]);
    await run(job());
    expect(providers.sendEmail).toHaveBeenCalledWith("demo-recipient", expect.any(String));
    expect(providers.sendSms).toHaveBeenCalledWith("demo-recipient", expect.any(String));
  });

  it("a note already sent is left alone", async () => {
    use([outbox({ status: "sent" })]);
    await run(job());
    expect(providers.sendEmail).not.toHaveBeenCalled();
    expect(providers.sendSms).not.toHaveBeenCalled();
    expect(db.did(/^update outbox/)).toBe(false);
  });

  it("a note that no longer exists is skipped quietly", async () => {
    use([[/select type, payload, status from outbox/, { rows: [], rowCount: 0 }]]);
    await expect(run(job())).resolves.toBeUndefined();
    expect(providers.sendEmail).not.toHaveBeenCalled();
  });

  it("when sms fails: the email is recorded, the attempt and error are saved, and the job is retried", async () => {
    providers.sendSms.mockRejectedValue(new Error("SMS provider unavailable"));
    use([outbox(), contact(), logged(false)]);
    await expect(run(job("n-1", 0))).rejects.toThrow("SMS provider unavailable");
    expect(db.ran(/^insert into notification_log/)).toHaveLength(1);
    expect(db.ran(/^insert into notification_log/)[0].params[1]).toBe("email");
    expect(db.did(/set status = 'sent'/)).toBe(false);
    const fail = db.ran(/set attempts = \$2, last_error = \$3/)[0];
    expect(fail.params).toEqual(["n-1", 1, "SMS provider unavailable"]);
  });

  it("on the retry, an email that already went out is NOT sent again", async () => {
    use([outbox(), contact(), logged(true, false)]); // email logged earlier, sms not
    await run(job("n-1", 1));
    expect(providers.sendEmail).not.toHaveBeenCalled();
    expect(providers.sendSms).toHaveBeenCalledOnce();
    expect(db.ran(/set status = 'sent'/)[0].params).toEqual(["n-1", 2]);
  });

  it("if even recording the error fails, the original error still reaches the queue", async () => {
    providers.sendEmail.mockRejectedValue(new Error("email down"));
    use([outbox(), contact(), logged(false), [/set attempts = \$2/, new Error("db down too")]]);
    await expect(run(job())).rejects.toThrow("email down");
  });

  it("runs five at a time, in the configured queue", () => {
    startWorker();
    const w = bull.workers.at(-1);
    expect(w.name).toBe("notifications");
    expect(w.opts).toMatchObject({ concurrency: 5, prefix: "irctc" });
  });
});

describe("worker: giving up", () => {
  const failed = (jobOver: object) => { startWorker(); return bull.workers.at(-1).handlers.failed as (j: any, e: Error) => Promise<void>; };

  it("after the last attempt the note is parked as dead, with the reason", async () => {
    use([]);
    await failed({})({ data: { outboxId: "n-1" }, attemptsMade: 5, opts: { attempts: 5 } }, new Error("SMS provider unavailable"));
    const dead = db.ran(/set status = 'dead'/)[0];
    expect(dead.params).toEqual(["n-1", "SMS provider unavailable"]);
  });

  it("before the last attempt nothing is marked dead", async () => {
    use([]);
    await failed({})({ data: { outboxId: "n-1" }, attemptsMade: 4, opts: { attempts: 5 } }, new Error("x"));
    expect(db.did(/set status = 'dead'/)).toBe(false);
  });

  it("a failure with no job attached is ignored", async () => {
    use([]);
    await expect(failed({})(undefined, new Error("x"))).resolves.toBeUndefined();
  });

  it("worker connection errors are swallowed (they would crash the process)", () => {
    startWorker();
    expect(() => bull.workers.at(-1).handlers.error(new Error("ECONNREFUSED"))).not.toThrow();
  });
});
