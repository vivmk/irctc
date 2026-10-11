import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, db, PASSWORD } from "./helpers";

const email = () => `a-${randomUUID()}@example.com`;
const signup = (e: string, over: object = {}) =>
  api(
    "POST",
    "/auth/signup",
    { email: e, phone: "9876543210", password: PASSWORD, ...over },
    null,
  );
const login = (e: string, password = PASSWORD) =>
  api("POST", "/auth/login", { email: e, password }, null);

describe("sign up", () => {
  it("creates an account and logs you in", async () => {
    const e = email();
    const r = await signup(e);
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: e, phone: "9876543210" });
    const me = await api("GET", "/auth/me", undefined, r.body.token);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(e);
  });

  it("emails are case-insensitive: the same address twice is refused", async () => {
    const e = email();
    await signup(e);
    const r = await signup(e.toUpperCase());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("EMAIL_TAKEN");
  });

  const bad: [string, object][] = [
    ["not an email", { email: "nope" }],
    ["short password", { password: "short" }],
    ["bad phone number", { phone: "12345" }],
    ["missing phone", { phone: undefined }],
  ];
  it.each(bad)("rejects: %s", async (_name, over) => {
    const r = await signup(email(), over);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("BAD_REQUEST");
  });
});

describe("log in", () => {
  it("right password works in any letter case; wrong password and unknown email look identical", async () => {
    const e = email();
    await signup(e);
    expect((await login(e)).status).toBe(200);
    expect((await login(e.toUpperCase())).status).toBe(200);
    const wrong = await login(e, "wrong-password");
    const ghost = await login(email());
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body).toEqual(ghost.body);
  });

  it("5 wrong passwords lock the account for a while, even for the right password", async () => {
    const e = email();
    await signup(e);
    for (let i = 0; i < 5; i++)
      expect((await login(e, "wrong-password")).status).toBe(401);
    const locked = await login(e);
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
      canRetry: true,
    });
  });
});

describe("login passes", () => {
  it("logout ends one pass and leaves your other devices alone", async () => {
    const e = email();
    const a = await signup(e);
    const b = await login(e);
    expect(
      (await api("POST", "/auth/logout", undefined, a.body.token)).status,
    ).toBe(200);
    expect((await api("GET", "/auth/me", undefined, a.body.token)).status).toBe(
      401,
    );
    expect((await api("GET", "/auth/me", undefined, b.body.token)).status).toBe(
      200,
    );
  });

  it("logout-all ends every pass", async () => {
    const e = email();
    const a = await signup(e);
    const b = await login(e);
    await api("POST", "/auth/logout-all", undefined, b.body.token);
    expect((await api("GET", "/auth/me", undefined, a.body.token)).status).toBe(
      401,
    );
    expect((await api("GET", "/auth/me", undefined, b.body.token)).status).toBe(
      401,
    );
  });

  it("an expired pass is refused", async () => {
    const r = await signup(email());
    await db.query(
      "update sessions set expires_at = now() - interval '1 second' where user_id = $1",
      [r.body.user.id],
    );
    expect((await api("GET", "/auth/me", undefined, r.body.token)).status).toBe(
      401,
    );
  });

  it("we never store the password or the pass itself", async () => {
    const e = email();
    const r = await signup(e);
    const u = await db.query(
      "select password_hash from users where email = $1",
      [e],
    );
    expect(u.rows[0].password_hash).not.toContain(PASSWORD);
    const raw = await db.query(
      "select count(*)::int n from sessions where token_hash = $1",
      [r.body.token],
    );
    expect(raw.rows[0].n).toBe(0);
  });
});

describe("routes that need a login", () => {
  const id = randomUUID();
  const calls: [string, string][] = [
    ["POST", "/bookings"],
    ["GET", `/bookings/${id}`],
    ["POST", `/bookings/${id}/pay`],
    ["GET", `/bookings/${id}/payment`],
    ["POST", `/bookings/${id}/cancel`],
    ["GET", "/me/bookings"],
    ["GET", "/auth/me"],
  ];
  it.each(calls)("%s %s refuses strangers", async (method, path) => {
    const body = method === "POST" ? {} : undefined;
    for (const as of [null, "garbage-token"]) {
      const r = await api(method, path, body, as);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("UNAUTHENTICATED");
    }
  });
});
