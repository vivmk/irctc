import type { FastifyBaseLogger } from "fastify";
import { config } from "./config";
import { withLock } from "./lock";
import { reconcileOnce } from "./payments";
import { sweepExpiredHolds } from "./sweeper";
import { relayOutbox } from "./queue";
import { promoteAllWaitlists } from "./waitlist";

export function startScheduler(log: FastifyBaseLogger) {
  const every = (seconds: number, name: string, job: () => Promise<unknown>) =>
    setInterval(async () => {
      try {
        // every app copy wakes up, but only one gets the lock and does the work
        await withLock(name, 25_000, async () => {
          await job();
        });
      } catch (e) {
        log.error(e, `scheduled job ${name} failed`);
      }
    }, seconds * 1000);

  const timers = [
    every(config.reconcileEverySeconds, "reconcile", () =>
      reconcileOnce(config.reconcileAfterSeconds),
    ),
    ,
    every(config.sweepEverySeconds, "sweep", sweepExpiredHolds),
    every(config.relayEverySeconds, "relay", relayOutbox),
    every(config.waitlistEverySeconds, "waitlist", promoteAllWaitlists),
  ];
  return () => timers.forEach(clearInterval);
}
