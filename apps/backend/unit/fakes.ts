import { vi } from "vitest";

export type Reply = { rows?: any[]; rowCount?: number } | Error;
// pattern -> a reply, a list of replies (one per call), or a function of the parameters
type Rule = readonly [RegExp, any];

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

// A fake database connection. Each rule says: "when the SQL matches this pattern, answer with this".
// A list of replies is used one per call (the last one repeats). Unmatched SQL gets an empty answer.
// Every statement is recorded, so tests can check what was (and wasn't) sent.
export function fakeDb(rules: readonly Rule[] = []) {
  const counters = new Map<number, number>();
  const log: { sql: string; params: any[] }[] = [];

  const query = vi.fn(async (sql: string, params: any[] = []) => {
    const s = norm(sql);
    log.push({ sql: s, params });
    for (let i = 0; i < rules.length; i++) {
      const [pattern, reply] = rules[i];
      if (!pattern.test(s)) continue;
      let r: Reply;
      if (typeof reply === "function") r = reply(params);
      else if (Array.isArray(reply)) {
        const n = counters.get(i) ?? 0;
        counters.set(i, n + 1);
        r = reply[Math.min(n, reply.length - 1)];
      } else r = reply;
      if (r instanceof Error) throw r;
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  const db = {
    query,
    release: vi.fn(),
    log,
    /** every SQL statement that matched the pattern */
    ran: (pattern: RegExp) => log.filter((c) => pattern.test(c.sql)),
    /** did it run at all? */
    did: (pattern: RegExp) => log.some((c) => pattern.test(c.sql)),
    /** all statements in order, for checking begin -> ... -> commit */
    sqls: () => log.map((c) => c.sql),
  };
  return db;
}

export type FakeDb = ReturnType<typeof fakeDb>;
