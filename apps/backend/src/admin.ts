import type { FastifyInstance } from "fastify";
import { pool } from "./db";
import { setSmsDown } from "./providers";
import { sweepExpiredHolds } from "./sweeper";

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
}
