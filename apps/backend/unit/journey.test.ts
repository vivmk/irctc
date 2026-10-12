import { describe, expect, it } from "vitest";
import { isRealDate, resolveJourney } from "../src/journey";
import { fakeDb } from "./fakes";

describe("isRealDate", () => {
  it.each(["2026-12-27", "2026-01-01", "2024-02-29", "2026-12-31", "0001-01-01"])("accepts %s", (d) => {
    expect(isRealDate(d)).toBe(true);
  });

  it.each([
    "2026-02-31", "2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-12-32", "2026-12-00",
    "27-12-2026", "2026-1-1", "2026/12/27", "2026-12-27T00:00:00Z", " 2026-12-27", "2026-12-27 ", "", "tomorrow",
    "２０２６-12-27",
  ])("rejects %j", (d) => {
    expect(isRealDate(d)).toBe(false);
  });

  it("knows leap years", () => {
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("2100-02-29")).toBe(false);
    expect(isRealDate("2000-02-29")).toBe(true);
  });
});

const stops = (rows: { stop_order: number; code: string }[]): readonly [RegExp, any] => [/from train_stops/, { rows }];
const ROUTE = [
  { stop_order: 1, code: "NDLS" },
  { stop_order: 2, code: "CNB" },
  { stop_order: 3, code: "PRYJ" },
  { stop_order: 4, code: "PNBE" },
];
const pick = (...codes: string[]) => ROUTE.filter((r) => codes.includes(r.code));

describe("resolveJourney", () => {
  const run = (db: any, from: string, to: string) => resolveJourney(db, "12345", "2026-12-27", from, to);

  it("turns stations into the segments the journey uses", async () => {
    const cases: [string, string, number, number][] = [
      ["NDLS", "PNBE", 1, 3],
      ["NDLS", "CNB", 1, 1],
      ["CNB", "PNBE", 2, 3],
      ["CNB", "PRYJ", 2, 2],
      ["PRYJ", "PNBE", 3, 3],
    ];
    for (const [from, to, first, last] of cases) {
      const db: any = fakeDb([stops(pick(from, to) as any), [/from train_runs/, { rows: [{ id: 7 }] }]]);
      expect(await run(db, from, to)).toEqual({ runId: 7, first, last });
    }
  });

  it("passes train, date and stations to the queries as parameters (never glued into the SQL)", async () => {
    const db: any = fakeDb([stops(pick("NDLS", "PNBE")), [/from train_runs/, { rows: [{ id: 1 }] }]]);
    await resolveJourney(db, "12345'; drop table x;--", "2026-12-27", "NDLS", "PNBE");
    expect(db.log[0].params).toEqual(["12345'; drop table x;--", "NDLS", "PNBE"]);
    expect(db.log[0].sql).not.toContain("drop table");
    expect(db.log[1].params).toEqual(["12345'; drop table x;--", "2026-12-27"]);
  });

  it("BAD_STATIONS when the stations are in the wrong order", async () => {
    const db: any = fakeDb([stops(pick("NDLS", "PNBE"))]);
    expect(await run(db, "PNBE", "NDLS")).toBe("BAD_STATIONS");
    expect(db.did(/from train_runs/)).toBe(false); // gave up before asking about the run
  });

  it("BAD_STATIONS when both are the same station", async () => {
    const db: any = fakeDb([stops(pick("NDLS"))]);
    expect(await run(db, "NDLS", "NDLS")).toBe("BAD_STATIONS");
  });

  it("BAD_STATIONS when a station isn't on this train", async () => {
    const db: any = fakeDb([stops(pick("NDLS"))]);
    expect(await run(db, "NDLS", "ZZZZ")).toBe("BAD_STATIONS");
    const none: any = fakeDb([stops([])]);
    expect(await run(none, "AAAA", "BBBB")).toBe("BAD_STATIONS");
  });

  it("NO_RUN when the train doesn't run on that date", async () => {
    const db: any = fakeDb([stops(pick("NDLS", "PNBE")), [/from train_runs/, { rows: [], rowCount: 0 }]]);
    expect(await run(db, "NDLS", "PNBE")).toBe("NO_RUN");
  });
});
