import { describe, expect, it } from "vitest";
import { api } from "./helpers";
import { startServer, stopServer } from "./server";

describe("health check", () => {
  it("is ok when everything is reachable", async () => {
    const r = await api("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.details).toEqual({ database: true, redis: true });
  });

  it("answers 503 with redis:false when Redis can't be reached", async () => {
    const s = await startServer(3104, { REDIS_URL: "redis://localhost:6399" });
    try {
      const res = await fetch(`${s.base}/health`);
      expect(res.status).toBe(503);
      expect((await res.json()).details).toEqual({
        database: true,
        redis: false,
      });
    } finally {
      await stopServer(s.child, "SIGKILL");
    }
  });

  it("answers 503 with database:false when Postgres can't be reached", async () => {
    const s = await startServer(3105, {
      DATABASE_URL: "postgres://irctc:irctc@localhost:5999/irctc",
    });
    try {
      const res = await fetch(`${s.base}/health`);
      expect(res.status).toBe(503);
      expect((await res.json()).details).toEqual({
        database: false,
        redis: true,
      });
    } finally {
      await stopServer(s.child, "SIGKILL");
    }
  });
});
