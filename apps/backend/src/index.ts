import Fastify from "fastify";
import cors from "@fastify/cors";
import type { HealthResponse } from "@irctc/shared-types";
import { config } from "./config";
import { pingDatabase } from "./db";
import { pingRedis } from "./redis";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/health", async (_request, reply) => {
  const [database, redisOk] = await Promise.all([pingDatabase(), pingRedis()]);

  const body: HealthResponse = {
    version: "1.0.0",
    status: database && redisOk ? "ok" : "broken",
    details: { database, redis: redisOk },
  };

  return reply.code(body.status === "ok" ? 200 : 503).send(body);
});

await app.listen({ port: config.port, host: "0.0.0.0" });
