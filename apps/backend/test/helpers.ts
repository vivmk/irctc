import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { BASE, TEST_DB_URL } from "./constants";

export const FARE = 50000; // paise per passenger, matches the server default

export const dbStage = async (id: string) =>
  (await db.query("select stage from bookings where id = $1", [id])).rows[0]
    .stage as string;

// a correctly signed call "from the bank", with any status and amount we choose
export async function signedWebhook(
  ref: string,
  status: string,
  amountPaise: number,
) {
  const signature = createHmac("sha256", "test-secret")
    .update(`${ref}|${status}|${amountPaise}`)
    .digest("hex");
  const res = await fetch(`${BASE}/webhooks/payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bank-signature": signature,
    },
    body: JSON.stringify({ ref, status, amountPaise }),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as any,
  };
}

export const db = new pg.Pool({ connectionString: TEST_DB_URL, max: 3 });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wipe everything a test could have changed: all seats free, no bookings, no payments.
export async function resetDb() {
  await db.query(
    "update seat_segments set status='free', booking_id=null, held_until=null",
  );
  await db.query("delete from notification_log");
  await db.query("delete from outbox");
  await db.query("delete from payments");
  await db.query("delete from booking_passengers");
  await db.query("delete from bookings");
  await db.query("delete from fake_bank_transactions");
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error("timed out waiting for condition");
}

export const sweep = () => api("POST", "/admin/sweep");

export const notifications = async (bookingId: string) =>
  (await api("GET", `/admin/notifications/${bookingId}`)).body as {
    events: {
      type: string;
      status: string;
      attempts: number;
      lastError: string | null;
    }[];
    delivered: { channel: string; body: string }[];
  };

export async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

type BookOpts = {
  date?: string;
  cls?: string;
  pax?: number;
  requestId?: string;
  from?: string;
  to?: string;
};

export const book = (o: BookOpts = {}) =>
  api("POST", "/bookings", {
    requestId: o.requestId ?? randomUUID(),
    trainNumber: "12345",
    date: o.date ?? "2026-12-27",
    from: o.from ?? "NDLS",
    to: o.to ?? "PNBE",
    class: o.cls ?? "3A",
    passengers: Array.from({ length: o.pax ?? 1 }, (_, i) => ({
      name: `P${i + 1}`,
      age: 30,
      gender: "male",
    })),
  });

export async function avail(
  date: string,
  cls: string,
  from = "NDLS",
  to = "PNBE",
) {
  const r = await api(
    "GET",
    `/availability?trainNumber=12345&date=${date}&from=${from}&to=${to}&class=${cls}`,
  );
  return r.body.availableCount as number;
}

export const startPay = (id: string) => api("POST", `/bookings/${id}/pay`);
export const bankPay = (ref: string, mode = "once") =>
  api("POST", `/fakebank/${ref}/pay?webhook=${mode}`);
export const bankFail = (ref: string) => api("POST", `/fakebank/${ref}/fail`);
export const bankForge = (ref: string) => api("POST", `/fakebank/${ref}/forge`);
export const reconcile = () => api("POST", "/admin/reconcile?olderThan=0");
export const stage = async (id: string) =>
  (await api("GET", `/bookings/${id}`)).body.stage as string;
export const payStatus = async (id: string) =>
  (await api("GET", `/bookings/${id}/payment`)).body.status as string;

// book 1 passenger and start payment; returns what the next steps need
export async function bookAndStartPayment(o: BookOpts = {}) {
  const b = await book(o);
  const p = await startPay(b.body.bookingId);
  return { id: b.body.bookingId as string, ref: p.body.bankRef as string };
}
