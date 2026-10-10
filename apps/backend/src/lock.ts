import { randomUUID } from "node:crypto";
import { redis } from "./redis";
import { config } from "./config";

// delete the lock only if it is still OURS (it may have expired and been taken by someone else)
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function withLock(
  name: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (redis.status === "wait") await redis.connect().catch(() => {});
  const key = `${config.queuePrefix}:lock:${name}`;
  const token = randomUUID();

  // "set only if absent, and forget it after ttl" is one indivisible step in Redis
  const got = await redis.set(key, token, "PX", ttlMs, "NX");
  if (got !== "OK") return false; // someone else is already doing this job

  try {
    await fn();
  } finally {
    await redis.eval(RELEASE, 1, key, token).catch(() => {});
  }
  return true;
}
