import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export function sign(ref: string, status: string, amountPaise: number): string {
  return createHmac("sha256", config.bankSecret)
    .update(`${ref}|${status}|${amountPaise}`)
    .digest("hex");
}

export function verify(
  ref: string,
  status: string,
  amountPaise: number,
  given: string,
): boolean {
  const a = Buffer.from(sign(ref, status, amountPaise));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
