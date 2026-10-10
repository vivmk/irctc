import type { FastifyInstance } from "fastify";
import { pool } from "./db";
import { config } from "./config";
import { sign } from "./signature";

// ---- what OUR code is allowed to ask the bank ----
export async function createBankTransaction(ref: string, amountPaise: number) {
  await pool.query(
    "insert into fake_bank_transactions (ref, amount_paise) values ($1, $2)",
    [ref, amountPaise],
  );
}

export async function bankStatus(ref: string): Promise<string> {
  const r = await pool.query(
    "select status from fake_bank_transactions where ref = $1",
    [ref],
  );
  return r.rowCount === 0 ? "unknown" : r.rows[0].status;
}

export async function bankRefund(ref: string) {
  // safe to call twice: only a 'paid' transaction can become 'refunded'
  await pool.query(
    "update fake_bank_transactions set status = 'refunded' where ref = $1 and status = 'paid'",
    [ref],
  );
}

// ---- the "bank's page", which you press by hand in Postman ----
async function sendWebhook(
  ref: string,
  status: string,
  amountPaise: number,
  signature?: string,
) {
  const res = await fetch(`${config.selfUrl}/webhooks/payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bank-signature": signature ?? sign(ref, status, amountPaise),
    },
    body: JSON.stringify({ ref, status, amountPaise }),
  });
  return res.status;
}

async function settle(ref: string, result: "paid" | "failed", mode: string) {
  const r = await pool.query(
    "select amount_paise, status from fake_bank_transactions where ref = $1",
    [ref],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  if (row.status !== "pending")
    return { bankStatus: row.status, note: "already settled" };

  await pool.query(
    "update fake_bank_transactions set status = $2 where ref = $1",
    [ref, result],
  );

  const times = mode === "never" ? 0 : mode === "twice" ? 2 : 1;
  const webhookResponses: number[] = [];
  for (let i = 0; i < times; i++) {
    webhookResponses.push(await sendWebhook(ref, result, row.amount_paise));
  }
  return { bankStatus: result, webhookResponses };
}

export async function fakeBankRoutes(app: FastifyInstance) {
  type P = { Params: { ref: string }; Querystring: { webhook?: string } };

  // ?webhook=once (default) | twice | never
  app.post<P>("/fakebank/:ref/pay", async (req, reply) => {
    const out = await settle(
      req.params.ref,
      "paid",
      req.query.webhook ?? "once",
    );
    return (
      out ??
      reply
        .code(404)
        .send({ code: "NOT_FOUND", message: "unknown ref", canRetry: false })
    );
  });

  app.post<P>("/fakebank/:ref/fail", async (req, reply) => {
    const out = await settle(
      req.params.ref,
      "failed",
      req.query.webhook ?? "once",
    );
    return (
      out ??
      reply
        .code(404)
        .send({ code: "NOT_FOUND", message: "unknown ref", canRetry: false })
    );
  });

  // a forged call: right shape, wrong signature
  app.post<P>("/fakebank/:ref/forge", async (req) => {
    const status = await sendWebhook(
      req.params.ref,
      "paid",
      50000,
      "not-a-real-signature",
    );
    return { webhookResponse: status };
  });

  app.get<P>("/fakebank/:ref", async (req, reply) => {
    const r = await pool.query(
      "select ref, status, amount_paise from fake_bank_transactions where ref = $1",
      [req.params.ref],
    );
    return (
      r.rows[0] ??
      reply
        .code(404)
        .send({ code: "NOT_FOUND", message: "unknown ref", canRetry: false })
    );
  });
}
