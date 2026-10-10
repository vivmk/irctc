import { randomUUID } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:3001";
const N = Number(process.env.N ?? 1000);

async function oneAttempt(): Promise<number> {
  const res = await fetch(`${BASE}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID(),
      trainNumber: "12345",
      date: "2026-12-26",
      from: "NDLS",
      to: "PNBE",
      class: "3A",
      passengers: [{ name: "Tester", age: 30, gender: "male" }],
    }),
  });
  return res.status;
}

const started = Date.now();
const statuses = await Promise.all(Array.from({ length: N }, oneAttempt));

const tally: Record<number, number> = {};
for (const s of statuses) tally[s] = (tally[s] ?? 0) + 1;

console.log(`${N} simultaneous attempts in ${Date.now() - started} ms`);
console.log(tally);
