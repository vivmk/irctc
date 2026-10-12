import { beforeEach, describe, expect, it, vi } from "vitest";

const { client } = vi.hoisted(() => {
  const client: any = { status: "wait", handlers: {} as Record<string, any>, connect: vi.fn(), ping: vi.fn() };
  client.on = vi.fn((e: string, fn: any) => { client.handlers[e] = fn; return client; });
  return { client };
});
vi.mock("ioredis", () => ({
  Redis: class {
    constructor(public url: string, public options: any) { Object.assign(client, { url, options }); return client as any; }
  },
}));
import { pingRedis } from "../src/redis";

beforeEach(() => {
  client.status = "wait";
  client.connect.mockReset().mockResolvedValue(undefined);
  client.ping.mockReset().mockResolvedValue("PONG");
});

describe("redis", () => {
  it("is created lazily, gives up fast, and swallows connection errors", () => {
    expect((client as any).options).toMatchObject({ lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
    expect(() => client.handlers.error(new Error("ECONNREFUSED"))).not.toThrow();
  });

  it("pingRedis: true on PONG, connecting first if needed", async () => {
    expect(await pingRedis()).toBe(true);
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("doesn't reconnect when already connected", async () => {
    client.status = "ready";
    expect(await pingRedis()).toBe(true);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("false when the connection or the ping fails, or the answer is wrong", async () => {
    client.connect.mockRejectedValueOnce(new Error("refused"));
    expect(await pingRedis()).toBe(false);
    client.status = "ready";
    client.ping.mockRejectedValueOnce(new Error("timeout"));
    expect(await pingRedis()).toBe(false);
    client.ping.mockResolvedValueOnce("NOPE");
    expect(await pingRedis()).toBe(false);
  });
});
