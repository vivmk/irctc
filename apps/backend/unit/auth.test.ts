import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pool, redis } = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  redis: { status: "ready", connect: vi.fn(), get: vi.fn(), incr: vi.fn(), expire: vi.fn(), del: vi.fn() },
}));
vi.mock("../src/db", () => ({ pool }));
vi.mock("../src/redis", () => ({ redis }));

import { authRoutes, checkPassword, hashPassword, ownedBy, requireUser } from "../src/auth";
import { installErrorHandlers } from "../src/errors";
import { fakeDb, type FakeDb } from "./fakes";

const isShape = (b: any) => typeof b.code === "string" && typeof b.message === "string" && typeof b.canRetry === "boolean";
const app = () => {
  const a = Fastify();
  installErrorHandlers(a);
  a.register(authRoutes);
  a.get("/guarded", { preHandler: requireUser }, async (req) => ({ userId: req.userId }));
  return a;
};
let db: FakeDb;
const use = (rules: any[]) => { db = fakeDb(rules); pool.query.mockImplementation(db.query); };

beforeEach(() => {
  pool.query.mockReset();
  redis.status = "ready";
  redis.connect.mockReset().mockResolvedValue(undefined);
  redis.get.mockReset().mockResolvedValue(null);
  redis.incr.mockReset().mockResolvedValue(1);
  redis.expire.mockReset().mockResolvedValue(1);
  redis.del.mockReset().mockResolvedValue(1);
});

describe("passwords", () => {
  it("are stored as salt:hash, never as the password", async () => {
    const h = await hashPassword("correct-horse");
    expect(h).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(h).not.toContain("correct-horse");
  });

  it("the same password scrambles differently each time (random salt)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("checkPassword: right password yes, anything else no", async () => {
    const h = await hashPassword("correct-horse");
    expect(await checkPassword("correct-horse", h)).toBe(true);
    expect(await checkPassword("correct-horsE", h)).toBe(false);
    expect(await checkPassword("", h)).toBe(false);
    expect(await checkPassword("correct-horse ", h)).toBe(false);
  });

  it("handles unicode passwords", async () => {
    const h = await hashPassword("पासवर्ड-बहुत-सुरक्षित-🔐");
    expect(await checkPassword("पासवर्ड-बहुत-सुरक्षित-🔐", h)).toBe(true);
  });
});

describe("requireUser", () => {
  const call = (headers: Record<string, string>) => app().inject({ method: "GET", url: "/guarded", headers });

  it("401 without a header", async () => {
    use([]);
    const r = await call({});
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("UNAUTHENTICATED");
    expect(db.query).not.toHaveBeenCalled(); // no point asking the database
  });

  it("looks up a FINGERPRINT of the token, never the token itself", async () => {
    use([[/from sessions/, { rows: [{ user_id: "u-1" }] }]]);
    await call({ authorization: "Bearer my-secret-token" });
    const param = db.log[0].params[0];
    expect(param).toMatch(/^[0-9a-f]{64}$/);
    expect(param).not.toContain("my-secret-token");
    expect(db.log[0].sql).toMatch(/expires_at > now\(\)/);
  });

  it("accepts a valid pass and tells the route who it is", async () => {
    use([[/from sessions/, { rows: [{ user_id: "u-1" }] }]]);
    const r = await call({ authorization: "Bearer abc" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ userId: "u-1" });
  });

  it("rejects an unknown or expired pass", async () => {
    use([[/from sessions/, { rows: [], rowCount: 0 }]]);
    const r = await call({ authorization: "Bearer abc" });
    expect(r.statusCode).toBe(401);
    expect(isShape(r.json())).toBe(true);
  });

  it("the word Bearer is case-insensitive and extra spaces are fine", async () => {
    use([[/from sessions/, { rows: [{ user_id: "u-1" }] }]]);
    for (const h of ["bearer abc", "BEARER abc", "Bearer    abc"]) expect((await call({ authorization: h })).statusCode, h).toBe(200);
  });

  it("malformed headers never reach the database", async () => {
    use([[/from sessions/, { rows: [{ user_id: "u-1" }] }]]);
    for (const h of ["Bearer", "Bearer ", "Basic abc", "abc", "Bearer a b", "Token abc"]) {
      expect((await call({ authorization: h })).statusCode, h).toBe(401);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("ownedBy", () => {
  it("true only when the booking exists AND belongs to the user", async () => {
    use([[/from bookings/, [{ rowCount: 1 }, { rowCount: 0 }]]]);
    expect(await ownedBy("b", "u")).toBe(true);
    expect(await ownedBy("b", "u")).toBe(false);
    expect(db.log[0].params).toEqual(["b", "u"]);
  });
});

describe("POST /auth/signup", () => {
  const body = (over: object = {}) => ({ email: "Asha@Example.com", phone: "9876543210", password: "long-enough-pw", ...over });
  const post = (b: any) => app().inject({ method: "POST", url: "/auth/signup", payload: b });

  it("creates the account (email lowercased, password scrambled) and logs the user in", async () => {
    use([[/insert into users/, { rows: [{ id: "u-1" }] }], [/insert into sessions/, { rowCount: 1 }]]);
    const r = await post(body());
    expect(r.statusCode).toBe(201);
    expect(r.json().user).toEqual({ id: "u-1", email: "asha@example.com", phone: "9876543210" });
    expect(r.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(r.json().expiresAt).getTime()).toBeGreaterThan(Date.now());
    const ins = db.ran(/insert into users/)[0];
    expect(ins.params[0]).toBe("asha@example.com");
    expect(ins.params[2]).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(ins.params).not.toContain("long-enough-pw");
  });

  it("the stored session is the fingerprint of the token handed out", async () => {
    use([[/insert into users/, { rows: [{ id: "u-1" }] }]]);
    const r = await post(body());
    const stored = db.ran(/insert into sessions/)[0].params[0];
    const { createHash } = await import("node:crypto");
    expect(stored).toBe(createHash("sha256").update(r.json().token).digest("hex"));
  });

  it("a duplicate email is 409", async () => {
    use([[/insert into users/, Object.assign(new Error("dup"), { code: "23505" })]]);
    const r = await post(body());
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("EMAIL_TAKEN");
  });

  it("any other database error is a 500, not a 409", async () => {
    use([[/insert into users/, new Error("disk full")]]);
    expect((await post(body())).statusCode).toBe(500);
  });

  const bad: [string, object][] = [
    ["email not an email", { email: "nope" }],
    ["email missing", { email: undefined }],
    ["email an object", { email: {} }],
    ["email a list", { email: ["a@b.co"] }],
    ["email 300 characters", { email: "a".repeat(300) + "@example.com" }],
    ["password 7 characters", { password: "1234567" }],
    ["password 129 characters", { password: "x".repeat(129) }],
    ["password a number", { password: 12345678 }],
    ["password missing", { password: undefined }],
    ["phone too short", { phone: "12345" }],
    ["phone too long", { phone: "98765432101" }],
    ["phone starting with 5", { phone: "5876543210" }],
    ["phone a number", { phone: 9876543210 }],
    ["phone missing", { phone: undefined }],
  ];
  it.each(bad)("400 for: %s (database untouched)", async (_n, over) => {
    use([]);
    const r = await post(body(over));
    expect(r.statusCode).toBe(400);
    expect(isShape(r.json())).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("accepts the password length edges and unicode", async () => {
    for (const password of ["x".repeat(8), "x".repeat(128), "पासवर्ड-बहुत-सुरक्षित-🔐"]) {
      use([[/insert into users/, { rows: [{ id: "u-1" }] }]]);
      expect((await post(body({ password }))).statusCode, password.length + "").toBe(201);
    }
  });

  it("a missing body is a clean 400", async () => {
    use([]);
    const r = await app().inject({ method: "POST", url: "/auth/signup" });
    expect(r.statusCode).toBe(400);
  });
});

describe("POST /auth/login", () => {
  const post = (b: any) => app().inject({ method: "POST", url: "/auth/login", payload: b });
  let stored: string;
  beforeEach(async () => { stored = await hashPassword("right-password"); });
  const userRow = () => ({ id: "u-1", email: "a@b.co", phone: "9876543210", password_hash: stored });

  it("right password: a fresh pass, and the failure counter is cleared", async () => {
    use([[/from users/, { rows: [userRow()], rowCount: 1 }]]);
    const r = await post({ email: "A@B.co", password: "right-password" });
    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBeTruthy();
    expect(db.log[0].params).toEqual(["a@b.co"]); // email normalised
    expect(redis.del).toHaveBeenCalledWith("irctc:loginfail:a@b.co");
  });

  it("wrong password and unknown email give the IDENTICAL answer", async () => {
    use([[/from users/, [{ rows: [userRow()], rowCount: 1 }, { rows: [], rowCount: 0 }]]]);
    const wrong = await post({ email: "a@b.co", password: "wrong" });
    const ghost = await post({ email: "nobody@b.co", password: "wrong" });
    expect(wrong.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(wrong.json()).toEqual(ghost.json());
    expect(wrong.json().code).toBe("BAD_CREDENTIALS");
  });

  it("each failure is counted, and the counter expires", async () => {
    use([[/from users/, { rows: [], rowCount: 0 }]]);
    await post({ email: "a@b.co", password: "x" });
    expect(redis.incr).toHaveBeenCalledWith("irctc:loginfail:a@b.co");
    expect(redis.expire).toHaveBeenCalledWith("irctc:loginfail:a@b.co", 900); // first failure starts the window
    redis.incr.mockResolvedValue(2);
    redis.expire.mockClear();
    await post({ email: "a@b.co", password: "x" });
    expect(redis.expire).not.toHaveBeenCalled(); // later failures don't extend it
  });

  it("locked out after 5 failures: 429, and the right password is not even checked", async () => {
    use([[/from users/, { rows: [userRow()], rowCount: 1 }]]);
    redis.get.mockResolvedValue("5");
    const r = await post({ email: "a@b.co", password: "right-password" });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "TOO_MANY_ATTEMPTS", canRetry: true });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("4 failures is still allowed", async () => {
    use([[/from users/, { rows: [userRow()], rowCount: 1 }]]);
    redis.get.mockResolvedValue("4");
    expect((await post({ email: "a@b.co", password: "right-password" })).statusCode).toBe(200);
  });

  it("if Redis is down, login still works (the lockout just pauses)", async () => {
    use([[/from users/, { rows: [userRow()], rowCount: 1 }]]);
    redis.get.mockRejectedValue(new Error("Redis down"));
    redis.del.mockRejectedValue(new Error("Redis down"));
    expect((await post({ email: "a@b.co", password: "right-password" })).statusCode).toBe(200);
    redis.incr.mockRejectedValue(new Error("Redis down"));
    use([[/from users/, { rows: [], rowCount: 0 }]]);
    expect((await post({ email: "a@b.co", password: "x" })).statusCode).toBe(401);
  });

  it("connects to Redis first if it hasn't yet", async () => {
    use([[/from users/, { rows: [], rowCount: 0 }]]);
    redis.status = "wait";
    await post({ email: "a@b.co", password: "x" });
    expect(redis.connect).toHaveBeenCalled();
  });

  it.each([
    ["empty body", {}],
    ["email a number", { email: 1, password: "x" }],
    ["password missing", { email: "a@b.co" }],
    ["password an object", { email: "a@b.co", password: {} }],
    ["password empty", { email: "a@b.co", password: "" }],
  ])("400 for: %s", async (_n, b) => {
    use([]);
    const r = await post(b);
    expect(r.statusCode).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("logout, me, my bookings", () => {
  const authed = (method: "GET" | "POST", url: string) =>
    app().inject({ method, url, headers: { authorization: "Bearer tok" } });
  const session = [/from sessions/, { rows: [{ user_id: "u-1" }] }] as const;

  it("logout deletes only THIS pass", async () => {
    use([session]);
    expect((await authed("POST", "/auth/logout")).statusCode).toBe(200);
    const del = db.ran(/^delete from sessions where token_hash/)[0];
    expect(del.params[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("logout-all deletes every pass of the user", async () => {
    use([session]);
    await authed("POST", "/auth/logout-all");
    expect(db.ran(/^delete from sessions where user_id/)[0].params).toEqual(["u-1"]);
  });

  it("both need a login", async () => {
    use([]);
    for (const url of ["/auth/logout", "/auth/logout-all"]) expect((await app().inject({ method: "POST", url })).statusCode).toBe(401);
  });

  it("/auth/me returns the account", async () => {
    use([session, [/from users where id/, { rows: [{ id: "u-1", email: "a@b.co", phone: "9876543210" }] }]]);
    expect((await authed("GET", "/auth/me")).json()).toEqual({ id: "u-1", email: "a@b.co", phone: "9876543210" });
  });

  it("/me/bookings lists the user's bookings in our shape, scoped to the user", async () => {
    use([session, [/from bookings b/, { rows: [{
      id: "b-1", created_at: new Date("2026-12-01T10:00:00Z"), train_number: "12345", date: "2026-12-27",
      stage: "confirmed", from_code: "NDLS", to_code: "PNBE", passengers: 2,
    }] }]]);
    const r = await authed("GET", "/me/bookings");
    expect(r.json()).toEqual([{
      bookingId: "b-1", stage: "confirmed", trainNumber: "12345", date: "2026-12-27",
      from: "NDLS", to: "PNBE", passengers: 2, createdAt: "2026-12-01T10:00:00.000Z",
    }]);
    const q = db.ran(/from bookings b/)[0];
    expect(q.params).toEqual(["u-1"]);
    expect(q.sql).toMatch(/order by b\.created_at desc/);
    expect(q.sql).toMatch(/limit 50/);
  });
});
