import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthResponse,
  BookingSummary,
  ErrorShape,
} from "@irctc/shared-types";
import { pool } from "./db";
import { redis } from "./redis";
import { config } from "./config";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string; // filled in by requireUser
  }
}

const err = (code: string, message: string, canRetry: boolean): ErrorShape => ({
  code,
  message,
  canRetry,
});
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[6-9]\d{9}$/; // 10-digit Indian mobile number

// ---------- passwords: slow, salted scramble ----------
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (e, key) => (e ? reject(e) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16); // a random extra ingredient, so equal passwords scramble differently
  const key = await derive(password, salt);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

async function checkPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");
  const expected = Buffer.from(keyHex, "hex");
  const actual = await derive(password, Buffer.from(saltHex, "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// For unknown emails we still do the slow work, so response time doesn't reveal who has an account.
const dummyHash = hashPassword("not-a-real-password");

// ---------- login passes ----------
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function tokenFrom(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith("Bearer ") ? h.slice(7).trim() || null : null;
}

async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.sessionHours * 3_600_000);
  await pool.query(
    "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)",
    [hashToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

// The doorman. Put it in front of any route that needs a logged-in user.
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const token = tokenFrom(req);
  if (!token)
    return reply.code(401).send(err("UNAUTHENTICATED", "Please log in", false));
  const r = await pool.query(
    "select user_id from sessions where token_hash = $1 and expires_at > now()",
    [hashToken(token)],
  );
  if (r.rowCount === 0)
    return reply
      .code(401)
      .send(
        err(
          "UNAUTHENTICATED",
          "Your login has expired. Please log in again",
          false,
        ),
      );
  req.userId = r.rows[0].user_id;
}

// "Is this booking mine?" A missing booking and someone else's booking look the same.
export async function ownedBy(
  bookingId: string,
  userId: string,
): Promise<boolean> {
  const r = await pool.query(
    "select 1 from bookings where id = $1 and user_id = $2",
    [bookingId, userId],
  );
  return r.rowCount === 1;
}

// ---------- lockout after repeated wrong passwords ----------
const failKey = (email: string) => `${config.queuePrefix}:loginfail:${email}`;

async function isLockedOut(email: string): Promise<boolean> {
  try {
    if (redis.status === "wait") await redis.connect().catch(() => {});
    return (
      Number((await redis.get(failKey(email))) ?? 0) >= config.loginMaxFailures
    );
  } catch {
    return false; // Redis trouble must not lock everybody out
  }
}
async function recordFailure(email: string) {
  try {
    if (redis.status === "wait") await redis.connect().catch(() => {});
    const n = await redis.incr(failKey(email));
    if (n === 1) await redis.expire(failKey(email), config.loginWindowSeconds);
  } catch {
    /* ignore */
  }
}
async function clearFailures(email: string) {
  try {
    await redis.del(failKey(email));
  } catch {
    /* ignore */
  }
}

const authResponse = (
  s: { token: string; expiresAt: Date },
  u: { id: string; email: string; phone: string },
): AuthResponse => ({
  token: s.token,
  expiresAt: s.expiresAt.toISOString(),
  user: { id: u.id, email: u.email, phone: u.phone },
});

type Credentials = { email?: unknown; phone?: unknown; password?: unknown };

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: Credentials }>("/auth/signup", async (req, reply) => {
    const { email, phone, password } = req.body ?? {};
    const norm = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!EMAIL.test(norm) || norm.length > 254)
      return reply
        .code(400)
        .send(err("BAD_REQUEST", "a valid email is required", false));
    if (typeof phone !== "string" || !PHONE.test(phone))
      return reply
        .code(400)
        .send(
          err(
            "BAD_REQUEST",
            "phone must be a 10-digit Indian mobile number",
            false,
          ),
        );
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128
    )
      return reply
        .code(400)
        .send(
          err("BAD_REQUEST", "password must be 8 to 128 characters", false),
        );

    try {
      const r = await pool.query(
        "insert into users (email, phone, password_hash) values ($1, $2, $3) returning id",
        [norm, phone, await hashPassword(password)],
      );
      const id: string = r.rows[0].id;
      return reply
        .code(201)
        .send(
          authResponse(await createSession(id), { id, email: norm, phone }),
        );
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        return reply
          .code(409)
          .send(
            err(
              "EMAIL_TAKEN",
              "An account with this email already exists",
              false,
            ),
          );
      throw e;
    }
  });

  app.post<{ Body: Credentials }>("/auth/login", async (req, reply) => {
    const { email, password } = req.body ?? {};
    const norm = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!norm || typeof password !== "string" || !password)
      return reply
        .code(400)
        .send(err("BAD_REQUEST", "email and password are required", false));

    if (await isLockedOut(norm))
      return reply
        .code(429)
        .send(
          err(
            "TOO_MANY_ATTEMPTS",
            "Too many wrong attempts. Try again in a few minutes",
            true,
          ),
        );

    const u = await pool.query(
      "select id, email, phone, password_hash from users where email = $1",
      [norm],
    );
    const found = u.rowCount === 1;
    const ok = await checkPassword(
      password,
      found ? u.rows[0].password_hash : await dummyHash,
    );
    if (!found || !ok) {
      await recordFailure(norm);
      return reply
        .code(401)
        .send(err("BAD_CREDENTIALS", "Wrong email or password", false));
    }
    await clearFailures(norm);
    const user = u.rows[0];
    return authResponse(await createSession(user.id), user);
  });

  app.post("/auth/logout", { preHandler: requireUser }, async (req) => {
    await pool.query("delete from sessions where token_hash = $1", [
      hashToken(tokenFrom(req)!),
    ]);
    return { ok: true };
  });

  app.post("/auth/logout-all", { preHandler: requireUser }, async (req) => {
    await pool.query("delete from sessions where user_id = $1", [req.userId]);
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireUser }, async (req) => {
    const r = await pool.query(
      "select id, email, phone from users where id = $1",
      [req.userId],
    );
    return r.rows[0];
  });

  // "My bookings", newest first
  app.get("/me/bookings", { preHandler: requireUser }, async (req) => {
    const r = await pool.query(
      `select b.id, b.created_at, t.number as train_number,
              to_char(r.journey_date, 'YYYY-MM-DD') as date,
              case when b.stage = 'seats_held' and b.hold_expires_at < now()
                   then 'expired' else b.stage end as stage,
              sf.code as from_code, st.code as to_code,
              (select count(*)::int from booking_passengers p where p.booking_id = b.id) as passengers
       from bookings b
       join train_runs r on r.id = b.run_id
       join trains t on t.id = r.train_id
       join train_stops f on f.train_id = t.id and f.stop_order = b.first_segment
       join stations sf on sf.id = f.station_id
       join train_stops e on e.train_id = t.id and e.stop_order = b.last_segment + 1
       join stations st on st.id = e.station_id
       where b.user_id = $1
       order by b.created_at desc, b.id
       limit 50`,
      [req.userId],
    );
    const list: BookingSummary[] = r.rows.map((x) => ({
      bookingId: x.id,
      stage: x.stage,
      trainNumber: x.train_number,
      date: x.date,
      from: x.from_code,
      to: x.to_code,
      passengers: x.passengers,
      createdAt: x.created_at.toISOString(),
    }));
    return list;
  });
}
