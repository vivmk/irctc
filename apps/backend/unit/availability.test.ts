import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock("../src/db", () => ({ pool }));

import { availabilityRoutes } from "../src/availability";
import { installErrorHandlers } from "../src/errors";
import { fakeDb, type FakeDb } from "./fakes";

let db: FakeDb;
const stops = [{ stop_order: 1, code: "NDLS" }, { stop_order: 2, code: "CNB" }, { stop_order: 3, code: "PRYJ" }, { stop_order: 4, code: "PNBE" }];
const use = (over: { stops?: any[]; run?: any[]; seats?: any[] } = {}) => {
  db = fakeDb([
    [/from train_stops/, { rows: over.stops ?? stops }],
    [/from train_runs/, { rows: over.run ?? [{ id: 7 }] }],
    [/from seat_segments/, { rows: over.seats ?? [] }],
  ]);
  pool.query.mockImplementation(db.query);
};
const get = (qs: string) => { const a = Fastify(); installErrorHandlers(a); a.register(availabilityRoutes); return a.inject({ method: "GET", url: `/availability?${qs}` }); };
const ok = "trainNumber=12345&date=2026-12-27&from=NDLS&to=PNBE&class=3A";

beforeEach(() => {
  pool.query.mockReset();
});

describe("GET /availability", () => {
  it("returns the segments and the seats free for the whole journey", async () => {
    use({ seats: [{ coach_code: "B1", seat_number: 1 }, { coach_code: "B1", seat_number: 2 }] });
    const r = await get(ok);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      trainNumber: "12345", date: "2026-12-27", from: "NDLS", to: "PNBE", class: "3A",
      segments: { first: 1, last: 3 }, availableCount: 2,
      seats: [{ coach: "B1", seat: 1 }, { coach: "B1", seat: 2 }],
    });
  });

  it("asks the database for seats with ALL needed segments free (expired holds count as free)", async () => {
    use();
    await get(ok);
    const q = db.ran(/from seat_segments/)[0];
    expect(q.params).toEqual([7, "3A", 1, 3, 3]);
    expect(q.sql).toMatch(/having count\(\*\) = \$5/);
    expect(q.sql).toMatch(/held_until < now\(\)/);
  });

  it("a one-hop journey needs just one segment", async () => {
    use({ stops: [stops[1], stops[2]] });
    const r = await get("trainNumber=12345&date=2026-12-27&from=CNB&to=PRYJ&class=SL");
    expect(r.json().segments).toEqual({ first: 2, last: 2 });
    expect(db.ran(/from seat_segments/)[0].params).toEqual([7, "SL", 2, 2, 1]);
  });

  it("zero seats is a normal answer, not an error", async () => {
    use();
    const r = await get(ok);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ availableCount: 0, seats: [] });
  });

  it.each(["trainNumber", "date", "from", "to", "class"])("400 when %s is missing", async (name) => {
    use();
    const qs = ok.split("&").filter((p) => !p.startsWith(name + "=")).join("&");
    const r = await get(qs);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("BAD_REQUEST");
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each(["27-12-2026", "2026-02-31", "2026-13-01", "tomorrow", "2026-12-27T00:00:00Z"])("400 for date %s", async (d) => {
    use();
    expect((await get(ok.replace("2026-12-27", encodeURIComponent(d)))).statusCode).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("400 when a parameter is given twice", async () => {
    use();
    expect((await get(ok + "&date=2026-12-26")).statusCode).toBe(400);
    expect((await get(ok + "&class=SL")).statusCode).toBe(400);
  });

  it("400 for stations in the wrong order, the same, or not on the train", async () => {
    use({ stops: [stops[0], stops[3]] });
    expect((await get(ok.replace("from=NDLS&to=PNBE", "from=PNBE&to=NDLS"))).statusCode).toBe(400);
    use({ stops: [stops[0]] });
    expect((await get(ok.replace("to=PNBE", "to=NDLS"))).statusCode).toBe(400);
    use({ stops: [stops[0]] });
    expect((await get(ok.replace("to=PNBE", "to=ZZZZ"))).statusCode).toBe(400);
  });

  it("404 NO_RUN when the train doesn't run that day", async () => {
    use({ run: [] });
    const r = await get(ok);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ code: "NO_RUN", message: "Train does not run on that date", canRetry: false });
  });

  it("injection attempts travel as parameters and cause no error", async () => {
    use();
    const r = await get(ok.replace("class=3A", "class=" + encodeURIComponent("3A' or 1=1--")));
    expect(r.statusCode).toBe(200);
    expect(db.ran(/from seat_segments/)[0].params[1]).toBe("3A' or 1=1--");
    expect(db.ran(/from seat_segments/)[0].sql).not.toContain("1=1");
  });
});
