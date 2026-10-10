import Fastify from "fastify";
import cors from "@fastify/cors";
import type { HealthResponse } from "@irctc/shared-types";
import { config } from "./config";
import { pingDatabase } from "./db";
import { pingRedis } from "./redis";
import { availabilityRoutes } from "./availability";
import { bookingRoutes } from "./bookings";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(availabilityRoutes);
await app.register(bookingRoutes);

app.get("/health", async (_request, reply) => {
  const [database, redisOk] = await Promise.all([pingDatabase(), pingRedis()]);

  const body: HealthResponse = {
    status: database && redisOk ? "ok" : "broken",
    details: { database, redis: redisOk },
  };

  return reply.code(body.status === "ok" ? 200 : 503).send(body);
});

await app.listen({ port: config.port, host: "0.0.0.0" });
