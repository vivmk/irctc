import { Queue, Worker } from "bullmq";
import { pool } from "./db";
import { config } from "./config";
import { sendEmail, sendSms } from "./providers";

const RECIPIENT = "demo-recipient"; // real phone/email arrive with user accounts

function connectionOptions() {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as null, // the queue waits patiently instead of giving up
  };
}

export const notifyQueue = new Queue("notifications", {
  connection: connectionOptions(),
  prefix: config.queuePrefix,
  defaultJobOptions: {
    attempts: config.notifyAttempts,
    backoff: { type: "exponential", delay: config.notifyBackoffMs },
    removeOnComplete: 1000, // keep recent finished tokens so a duplicate can be recognised
    removeOnFail: false, // keep failed ones for a human to inspect
  },
});
notifyQueue.on("error", () => {});

function messageFor(type: string, p: any): string {
  const rupees = (paise: number) => (paise / 100).toFixed(2);
  if (type === "booking_confirmed") {
    const seats = p.seats.map((s: any) => `${s.coach}-${s.seat}`).join(", ");
    return `Booking confirmed: train ${p.trainNumber} on ${p.date}. Seats: ${seats}.`;
  }
  if (type === "refund_issued")
    return `Refund of Rs ${rupees(p.amountPaise)} has been issued for your booking.`;
  if (type === "booking_waitlisted")
    return "Payment received. You are on the waiting list, and we will confirm you if a seat opens up.";
  if (type === "booking_cancelled")
    return p.refundPaise > 0
      ? `Booking cancelled. Your refund of Rs ${rupees(p.refundPaise)} is being processed.`
      : "Booking cancelled. No refund is due this close to departure.";
  return "There is an update on your booking.";
}

async function deliver(outboxId: string, attempt: number) {
  const o = await pool.query(
    "select type, payload, status from outbox where id = $1",
    [outboxId],
  );
  if (o.rowCount === 0 || o.rows[0].status === "sent") return; // nothing to do
  const body = messageFor(o.rows[0].type, o.rows[0].payload);

  const channels = [
    { name: "email", send: sendEmail },
    { name: "sms", send: sendSms },
  ];
  for (const ch of channels) {
    // already sent on an earlier attempt? don't send it again
    const done = await pool.query(
      "select 1 from notification_log where outbox_id = $1 and channel = $2",
      [outboxId, ch.name],
    );
    if (done.rowCount) continue;

    await ch.send(RECIPIENT, body); // throws if the provider is down
    await pool.query(
      `insert into notification_log (outbox_id, channel, recipient, body)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [outboxId, ch.name, RECIPIENT, body],
    );
  }
  await pool.query(
    "update outbox set status = 'sent', sent_at = now(), attempts = $2, last_error = null where id = $1",
    [outboxId, attempt],
  );
}

export function startWorker() {
  const worker = new Worker(
    "notifications",
    async (job) => {
      const attempt = job.attemptsMade + 1;
      try {
        await deliver(job.data.outboxId, attempt);
      } catch (e) {
        await pool
          .query(
            "update outbox set attempts = $2, last_error = $3 where id = $1",
            [job.data.outboxId, attempt, (e as Error).message],
          )
          .catch(() => {});
        throw e; // tells the queue to retry later
      }
    },
    {
      connection: connectionOptions(),
      prefix: config.queuePrefix,
      concurrency: 5,
    },
  );

  // out of retries: park it as "dead" so a person (and an alarm, later) notices
  worker.on("failed", async (job, e) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await pool
        .query(
          "update outbox set status = 'dead', last_error = $2 where id = $1",
          [job.data.outboxId, e.message],
        )
        .catch(() => {});
    }
  });
  worker.on("error", () => {});
  return worker;
}

// The runner: notebook -> token line
export async function relayOutbox(): Promise<number> {
  const pending = await pool.query(
    "select id from outbox where status = 'pending' order by created_at limit 100",
  );
  for (const row of pending.rows) {
    // jobId = the note's id, so adding it twice creates one token
    await notifyQueue.add("send", { outboxId: row.id }, { jobId: row.id });
    await pool.query(
      "update outbox set status = 'queued' where id = $1 and status = 'pending'",
      [row.id],
    );
  }
  return pending.rowCount ?? 0;
}
