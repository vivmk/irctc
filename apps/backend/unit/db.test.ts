import { beforeEach, describe, expect, it, vi } from "vitest";

const { instances, query } = vi.hoisted(() => ({ instances: [] as any[], query: vi.fn() }));
vi.mock("pg", () => {
  class Pool {
    handlers: Record<string, (...a: any[]) => void> = {};
    options: any;
    query = query;
    constructor(options: any) { this.options = options; instances.push(this); }
    on(event: string, fn: (...a: any[]) => void) { this.handlers[event] = fn; return this; }
  }
  return { default: { Pool } };
});

import { pingDatabase, pool } from "../src/db";

beforeEach(() => query.mockReset());

describe("db", () => {
  it("creates one pool with room for a rush and a short connect timeout", () => {
    expect(instances).toHaveLength(1);
    expect(instances[0].options.max).toBe(20);
    expect(instances[0].options.connectionTimeoutMillis).toBe(2000);
    expect(instances[0].options.connectionString).toMatch(/^postgres:\/\//);
  });

  it("an idle connection dying is logged, not thrown (it would crash the whole server)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => (pool as any).handlers.error(new Error("terminating connection"))).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a connection that dies while in use gets an error listener too", () => {
    const client = { on: vi.fn() };
    (pool as any).handlers.connect(client);
    expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("pingDatabase: true when 'select 1' works, false when it fails", async () => {
    query.mockResolvedValueOnce({});
    expect(await pingDatabase()).toBe(true);
    expect(query).toHaveBeenCalledWith("select 1");
    query.mockRejectedValueOnce(new Error("down"));
    expect(await pingDatabase()).toBe(false);
  });
});
