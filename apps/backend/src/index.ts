import Fastify from "fastify";
import cors from "@fastify/cors";
import type { HealthResponse } from "@irctc/shared-types";
import { config } from "./config";
import { pingDatabase } from "./db";
import { pingRedis } from "./redis";
import { availabilityRoutes } from "./availability";
import { bookingRoutes } from "./bookings";
import { paymentRoutes } from "./payments";
import { fakeBankRoutes } from "./fakebank";
import { adminRoutes } from "./admin";
import { startScheduler } from "./scheduler";
import { startWorker, notifyQueue } from "./queue";
import { pool } from "./db";
import { redis } from "./redis";
import { cancelRoutes } from "./cancel";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(availabilityRoutes);
await app.register(bookingRoutes);
await app.register(paymentRoutes);
await app.register(cancelRoutes);

if (config.enableFakeBank) {
  await app.register(fakeBankRoutes);
  await app.register(adminRoutes);
}

app.get("/health", async (_request, reply) => {
  const [database, redisOk] = await Promise.all([pingDatabase(), pingRedis()]);

  const body: HealthResponse = {
    status: database && redisOk ? "ok" : "broken",
    details: { database, redis: redisOk },
  };

  return reply.code(body.status === "ok" ? 200 : 503).send(body);
});

await app.listen({ port: config.port, host: "0.0.0.0" });

const worker = startWorker();
const stopScheduler = startScheduler(app.log);

// "finish what you're doing, then leave"
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    setTimeout(() => process.exit(1), 10_000).unref(); // safety net if something hangs
    stopScheduler();
    await worker.close();
    await notifyQueue.close();
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  });
}
