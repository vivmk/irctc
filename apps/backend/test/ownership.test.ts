import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  book,
  bookConfirmed,
  db,
  DEFAULT_EMAIL,
  DEFAULT_PHONE,
  newUser,
  notifications,
  payStatus,
  resetDb,
  stage,
  waitFor,
} from "./helpers";

beforeEach(resetDb);

describe("bookings belong to their owner", () => {
  it("someone else can't see, pay for, or cancel your booking", async () => {
    const id = (await book()).body.bookingId;
    const other = await newUser();
    const attempts = [
      ["GET", `/bookings/${id}`],
      ["POST", `/bookings/${id}/pay`],
      ["GET", `/bookings/${id}/payment`],
      ["POST", `/bookings/${id}/cancel`],
    ];
    for (const [method, path] of attempts) {
      const r = await api(method, path, undefined, other.token);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body.code).toBe("NOT_FOUND");
    }
    expect(await stage(id)).toBe("seats_held");
    const pays = await db.query(
      "select count(*)::int n from payments where booking_id = $1",
      [id],
    );
    expect(pays.rows[0].n).toBe(0);
  });

  it("someone else can't cancel your confirmed ticket", async () => {
    const { id } = await bookConfirmed();
    const other = await newUser();
    expect(
      (await api("POST", `/bookings/${id}/cancel`, undefined, other.token))
        .status,
    ).toBe(404);
    expect(await stage(id)).toBe("confirmed");
    expect(await payStatus(id)).toBe("succeeded");
  });

  it("reusing someone else's requestId is refused and leaks nothing", async () => {
    const requestId = randomUUID();
    const mine = await book({ requestId });
    const other = await newUser();
    const theirs = await book({ requestId, as: other.token });
    expect(theirs.status).toBe(409);
    expect(theirs.body.code).toBe("REQUEST_ID_TAKEN");
    expect(theirs.body.bookingId).toBeUndefined();

    const again = await book({ requestId }); // the real owner can still retry safely
    expect(again.status).toBe(200);
    expect(again.body.bookingId).toBe(mine.body.bookingId);
  });
});

describe("my bookings", () => {
  it("lists only mine, newest first", async () => {
    const a = await book();
    const b = await book({ cls: "SL" });
    const other = await newUser();
    await book({ as: other.token });

    const mine = await api("GET", "/me/bookings");
    expect(mine.body.map((x: any) => x.bookingId)).toEqual([
      b.body.bookingId,
      a.body.bookingId,
    ]);
    expect(mine.body[0]).toMatchObject({
      trainNumber: "12345",
      date: "2026-12-27",
      from: "NDLS",
      to: "PNBE",
      stage: "seats_held",
      passengers: 1,
    });
    const theirs = await api("GET", "/me/bookings", undefined, other.token);
    expect(theirs.body).toHaveLength(1);
  });
});

describe("notifications go to the account's real contacts", () => {
  it("email to the account email, sms to the account mobile", async () => {
    const { id } = await bookConfirmed();
    await waitFor(
      async () => (await notifications(id)).events[0]?.status === "sent",
    );
    const rows = await db.query(
      `select l.channel, l.recipient from notification_log l
       join outbox o on o.id = l.outbox_id
       where o.booking_id = $1 order by l.channel`,
      [id],
    );
    expect(rows.rows).toEqual([
      { channel: "email", recipient: DEFAULT_EMAIL },
      { channel: "sms", recipient: DEFAULT_PHONE },
    ]);
  });
});
