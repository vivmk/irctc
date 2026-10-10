export const config = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://irctc:irctc@localhost:5432/irctc",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  holdSeconds: Number(process.env.HOLD_SECONDS ?? 300),
  selfUrl:
    process.env.SELF_URL ??
    `http://localhost:${Number(process.env.PORT ?? 3001)}`,
  bankSecret: process.env.BANK_SECRET ?? "dev-only-secret",
  farePaise: Number(process.env.FARE_PAISE ?? 50000), // Rs 500 per passenger
  reconcileAfterSeconds: Number(process.env.RECONCILE_AFTER_SECONDS ?? 60),
  enableFakeBank: process.env.ENABLE_FAKE_BANK !== "false",
  queuePrefix: process.env.QUEUE_PREFIX ?? "irctc",
  sweepEverySeconds: Number(process.env.SWEEP_EVERY_SECONDS ?? 30),
  relayEverySeconds: Number(process.env.RELAY_EVERY_SECONDS ?? 2),
  notifyAttempts: Number(process.env.NOTIFY_ATTEMPTS ?? 5),
  notifyBackoffMs: Number(process.env.NOTIFY_BACKOFF_MS ?? 2000),
  reconcileEverySeconds: Number(process.env.RECONCILE_EVERY_SECONDS ?? 30),
};
