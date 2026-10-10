import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { api, avail, book, FARE, resetDb, startPay } from "./helpers";

beforeEach(resetDb);

const q = (o: Record<string, string>) =>
  "/availability?" + new URLSearchParams(o).toString();
const ok = {
  trainNumber: "12345",
  date: "2026-12-27",
  from: "NDLS",
  to: "PNBE",
  class: "3A",
};
const pax = { name: "A", age: 30, gender: "male" };
const body = (over: object = {}) => ({
  requestId: randomUUID(),
  trainNumber: "12345",
  date: "2026-12-27",
  from: "NDLS",
  to: "PNBE",
  class: "3A",
  passengers: [pax],
  ...over,
});

describe("availability endpoint", () => {
  it("returns segments and seats for a full journey", async () => {
    const r = await api("GET", q(ok));
    expect(r.status).toBe(200);
    expect(r.body.segments).toEqual({ first: 1, last: 3 });
    expect(r.body.availableCount).toBe(8);
    expect(r.body.seats).toHaveLength(8);
  });

  it("a one-hop journey uses just one segment", async () => {
    const r = await api("GET", q({ ...ok, from: "CNB", to: "PRYJ" }));
    expect(r.body.segments).toEqual({ first: 2, last: 2 });
  });

  it("classes are counted separately", async () => {
    await book({ pax: 1 });
    expect(await avail("2026-12-27", "3A")).toBe(7);
    expect(await avail("2026-12-27", "SL")).toBe(8);
  });

  it("a class the train doesn't have shows zero", async () => {
    const r = await api("GET", q({ ...ok, class: "1A" }));
    expect(r.status).toBe(200);
    expect(r.body.availableCount).toBe(0);
  });

  it("rejects a missing parameter", async () => {
    const { to, ...rest } = ok;
    expect((await api("GET", q(rest))).status).toBe(400);
  });

  it("rejects a badly formatted date", async () => {
    expect((await api("GET", q({ ...ok, date: "27-12-2026" }))).status).toBe(
      400,
    );
  });

  it("rejects stations in the wrong order", async () => {
    expect(
      (await api("GET", q({ ...ok, from: "PNBE", to: "NDLS" }))).status,
    ).toBe(400);
  });

  it("rejects a station that is not on this train", async () => {
    expect((await api("GET", q({ ...ok, to: "XXXX" }))).status).toBe(400);
  });

  it("a date with no run is 404 NO_RUN", async () => {
    const r = await api("GET", q({ ...ok, date: "2026-12-30" }));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NO_RUN");
  });
});

describe("booking validation", () => {
  const bad: [string, object][] = [
    ["no passengers", { passengers: [] }],
    ["seven passengers", { passengers: Array.from({ length: 7 }, () => pax) }],
    ["unknown gender", { passengers: [{ ...pax, gender: "x" }] }],
    ["negative age", { passengers: [{ ...pax, age: -1 }] }],
    ["age as text", { passengers: [{ ...pax, age: "30" }] }],
    ["empty name", { passengers: [{ ...pax, name: "" }] }],
    ["bad date format", { date: "27-12-2026" }],
    ["missing class", { class: undefined }],
  ];

  it.each(bad)("rejects: %s", async (_name, over) => {
    const r = await api("POST", "/bookings", body(over));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("BAD_REQUEST");
    expect(r.body.canRetry).toBe(false);
    expect(await avail("2026-12-27", "3A")).toBe(8); // a rejected request takes no seats
  });

  it("rejects a request with no body at all", async () => {
    expect((await api("POST", "/bookings")).status).toBe(400);
  });

  it("a date with no run is 404 NO_RUN", async () => {
    const r = await api("POST", "/bookings", body({ date: "2026-12-30" }));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NO_RUN");
  });

  it("stations in the wrong order are rejected", async () => {
    expect(
      (await api("POST", "/bookings", body({ from: "PNBE", to: "NDLS" })))
        .status,
    ).toBe(400);
  });
});

describe("reading a booking", () => {
  it("non-uuid id is 400, unknown id is 404", async () => {
    expect((await api("GET", "/bookings/not-a-uuid")).status).toBe(400);
    expect((await api("GET", `/bookings/${randomUUID()}`)).status).toBe(404);
  });

  it("shows held seats and when the hold ends", async () => {
    const b = await book({ pax: 2 });
    const r = await api("GET", `/bookings/${b.body.bookingId}`);
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe("seats_held");
    expect(r.body.seats).toHaveLength(2);
    expect(new Date(r.body.holdExpiresAt).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  });
});

describe("payment endpoints", () => {
  it("rejects a non-uuid id and an unknown booking", async () => {
    expect((await api("POST", "/bookings/nope/pay")).status).toBe(400);
    expect((await api("POST", `/bookings/${randomUUID()}/pay`)).status).toBe(
      404,
    );
  });

  it("a booking with no payment has none to show", async () => {
    const b = await book();
    expect(
      (await api("GET", `/bookings/${b.body.bookingId}/payment`)).status,
    ).toBe(404);
    expect((await api("GET", "/bookings/nope/payment")).status).toBe(400);
  });

  it("the amount is the fare times the number of passengers", async () => {
    const b = await book({ pax: 3 });
    const p = await startPay(b.body.bookingId);
    expect(p.body.amountPaise).toBe(3 * FARE);
  });

  it("the fake bank doesn't know a random reference", async () => {
    expect((await api("GET", `/fakebank/${randomUUID()}`)).status).toBe(404);
    expect((await api("POST", `/fakebank/${randomUUID()}/pay`)).status).toBe(
      404,
    );
  });
});
