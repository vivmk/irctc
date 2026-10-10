import type { FastifyInstance } from "fastify";
import { pool } from "./db";
import { setSmsDown } from "./providers";
import { sweepExpiredHolds } from "./sweeper";
import { setClock } from "./clock";
import { promoteAllWaitlists } from "./waitlist";

export async function adminRoutes(app: FastifyInstance) {
  app.post("/admin/sweep", async () => ({
    released: await sweepExpiredHolds(),
  }));

  app.post<{ Querystring: { down?: string } }>("/admin/sms", async (req) => {
    setSmsDown(req.query.down === "true");
    return { smsDown: req.query.down === "true" };
  });

  app.get<{ Params: { bookingId: string } }>(
    "/admin/notifications/:bookingId",
    async (req) => {
      const events = await pool.query(
        `select type, status, attempts, last_error from outbox
       where booking_id = $1 order by created_at`,
        [req.params.bookingId],
      );
      const delivered = await pool.query(
        `select l.channel, l.body from notification_log l
       join outbox o on o.id = l.outbox_id
       where o.booking_id = $1 order by l.sent_at`,
        [req.params.bookingId],
      );
      return {
        events: events.rows.map((r) => ({
          type: r.type,
          status: r.status,
          attempts: r.attempts,
          lastError: r.last_error,
        })),
        delivered: delivered.rows,
      };
    },
  );

  app.post("/admin/promote", async () => ({
    promoted: await promoteAllWaitlists(),
  }));

  // pretend it is a different time. ?now=2026-12-27T08:30:00Z   (no parameter = real time)
  app.post<{ Querystring: { now?: string } }>(
    "/admin/clock",
    async (req, reply) => {
      if (!req.query.now) {
        setClock(null);
        return { clock: "real" };
      }
      const t = Date.parse(req.query.now);
      if (Number.isNaN(t)) {
        return reply.code(400).send({
          code: "BAD_REQUEST",
          message: "now must be an ISO date",
          canRetry: false,
        });
      }
      setClock(t);
      return { now: new Date(t).toISOString() };
    },
  );
}
