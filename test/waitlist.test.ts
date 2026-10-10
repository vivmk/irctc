import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  avail,
  book,
  bookConfirmed,
  bookWaitlisted,
  cancel,
  db,
  dbStage,
  FARE,
  hoursBefore,
  notifications,
  payStatus,
  resetDb,
  setClock,
  sleep,
  stage,
  startPay,
  bankPay,
  sweep,
  waitFor,
} from "./helpers";

const DATE = "2026-12-27";

beforeEach(async () => {
  await resetDb();
  await setClock(hoursBefore(DATE, 100));
});
afterAll(async () => {
  await setClock();
});

// sell all 8 Sleeper seats: 6 + 1 + 1 passengers
async function fillSL() {
  const big = await bookConfirmed({ cls: "SL", pax: 6 });
  const a = await bookConfirmed({ cls: "SL" });
  const b = await bookConfirmed({ cls: "SL" });
  return { big, a, b };
}
const info = async (id: string) => (await api("GET", `/bookings/${id}`)).body;
const position = async (id: string) =>
  (await info(id)).waitlistPosition as number | undefined;
const seatOf = async (id: string) => {
  const s = (await info(id)).seats[0];
  return `${s.coach}-${s.seat}`;
};

describe("joining the waiting list", () => {
  it("is ignored when seats are available", async () => {
    const r = await book({ cls: "SL", waitlist: true });
    expect(r.status).toBe(201);
    expect(r.body.seats).toHaveLength(1);
    expect(r.body.waitlistRequested).toBe(false);
  });

  it("when sold out: refused normally, but a seatless booking if you ask for the list", async () => {
    await fillSL();
    expect(await avail(DATE, "SL")).toBe(0);
    const no = await book({ cls: "SL" });
    expect(no.status).toBe(409);
    expect(no.body.code).toBe("SOLD_OUT");

    const w = await book({ cls: "SL", waitlist: true });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({
      stage: "seats_held",
      waitlistRequested: true,
      seats: [],
    });
    expect(await avail(DATE, "SL")).toBe(0); // it took nothing
  });

  it("after paying, the booking is waitlisted, with a note", async () => {
    await fillSL();
    const { id } = await bookWaitlisted({ cls: "SL" });
    expect(await stage(id)).toBe("waitlisted");
    expect(await payStatus(id)).toBe("succeeded");
    expect(await position(id)).toBe(1);
    await waitFor(
      async () => (await notifications(id)).events[0]?.status === "sent",
    );
    const n = await notifications(id);
    expect(n.events[0].type).toBe("booking_waitlisted");
    expect(n.delivered[0].body).toContain("waiting list");
  });

  it("places in line follow the order of payment", async () => {
    await fillSL();
    const w1 = await bookWaitlisted({ cls: "SL" });
    const w2 = await bookWaitlisted({ cls: "SL" });
    expect(await position(w1.id)).toBe(1);
    expect(await position(w2.id)).toBe(2);
  });

  it("money that arrives late still gets a place in line", async () => {
    await fillSL();
    const w = await book({ cls: "SL", waitlist: true });
    const p = await startPay(w.body.bookingId);
    await sleep(4000); // the 3-second hold is over, but the bank hasn't answered yet
    await bankPay(p.body.bankRef);
    expect(await stage(w.body.bookingId)).toBe("waitlisted");
  });

  it("an unpaid waiting-list booking just expires", async () => {
    await fillSL();
    const w = await book({ cls: "SL", waitlist: true });
    await sleep(4000);
    await sweep();
    expect(await dbStage(w.body.bookingId)).toBe("expired");
  });
});

describe("promotion", () => {
  it("a cancellation hands the freed seat to the person waiting", async () => {
    const { a } = await fillSL();
    const w = await bookWaitlisted({ cls: "SL" });
    const freedSeat = await seatOf(a.id);

    await cancel(a.id);

    expect(await stage(w.id)).toBe("confirmed");
    expect(await seatOf(w.id)).toBe(freedSeat);
    expect(await avail(DATE, "SL")).toBe(0); // the seat went straight to them
    await waitFor(async () =>
      (await notifications(w.id)).events.some(
        (e) => e.type === "booking_confirmed" && e.status === "sent",
      ),
    );
  });

  it("the earliest in line wins, and the next one moves up", async () => {
    const { a } = await fillSL();
    const w1 = await bookWaitlisted({ cls: "SL" });
    const w2 = await bookWaitlisted({ cls: "SL" });
    await cancel(a.id);
    expect(await stage(w1.id)).toBe("confirmed");
    expect(await stage(w2.id)).toBe("waitlisted");
    expect(await position(w2.id)).toBe(1);
  });

  it("someone whose journey doesn't fit is skipped, even if earlier in line", async () => {
    await bookConfirmed({ cls: "SL", pax: 6 });
    await bookConfirmed({ cls: "SL" }); // 7 seats sold for the whole route
    const first = await bookConfirmed({ cls: "SL", to: "CNB" }); // last seat, first leg
    const second = await bookConfirmed({ cls: "SL", from: "CNB" }); // same seat, second leg
    expect(await seatOf(first.id)).toBe(await seatOf(second.id));

    const wFull = await bookWaitlisted({ cls: "SL" }); // Delhi to Patna, earlier in line
    const wShort = await bookWaitlisted({ cls: "SL", to: "CNB" }); // Delhi to Kanpur

    await cancel(first.id); // frees only Delhi to Kanpur on that seat
    expect(await stage(wFull.id)).toBe("waitlisted"); // needs the whole route: doesn't fit
    expect(await stage(wShort.id)).toBe("confirmed"); // fits, so it gets the seat
  });

  it("a booking for two people waits until both seats exist", async () => {
    const { a, b } = await fillSL();
    const w = await bookWaitlisted({ cls: "SL", pax: 2 });

    await cancel(a.id);
    expect(await stage(w.id)).toBe("waitlisted"); // one seat isn't enough for two people
    expect(await avail(DATE, "SL")).toBe(1); // and nothing was half-taken

    await cancel(b.id);
    expect(await stage(w.id)).toBe("confirmed");
    const seats = (await info(w.id)).seats.map(
      (s: any) => `${s.coach}-${s.seat}`,
    );
    expect(new Set(seats).size).toBe(2);
  });

  it("two cancellations at the same moment seat two waiting bookings, no clashes", async () => {
    const { a, b } = await fillSL();
    const w1 = await bookWaitlisted({ cls: "SL" });
    const w2 = await bookWaitlisted({ cls: "SL" });

    await Promise.all([cancel(a.id), cancel(b.id)]);

    expect(await stage(w1.id)).toBe("confirmed");
    expect(await stage(w2.id)).toBe("confirmed");
    expect(await seatOf(w1.id)).not.toBe(await seatOf(w2.id));
    const booked = await db.query(
      `select count(*)::int rows, count(distinct (coach_code, seat_number))::int seats
       from seat_segments where status = 'booked'`,
    );
    expect(booked.rows[0]).toEqual({ rows: 24, seats: 8 }); // 8 people x 3 segments, 8 different seats
  });
});

describe("cancelling while waiting", () => {
  it("refunds everything, frees nothing, and moves the line up", async () => {
    await fillSL();
    const w1 = await bookWaitlisted({ cls: "SL" });
    const w2 = await bookWaitlisted({ cls: "SL" });

    const r = await cancel(w1.id);
    expect(r.body).toMatchObject({
      stage: "cancelled",
      refundPaise: FARE,
      refundStatus: "refunded",
    });
    expect(await avail(DATE, "SL")).toBe(0);
    expect(await position(w2.id)).toBe(1);
  });
});
