import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock("../src/db", () => ({ pool }));

import { bankRefund, bankStatus, createBankTransaction, fakeBankRoutes } from "../src/fakebank";
import { sign } from "../src/signature";
import { fakeDb, type FakeDb } from "./fakes";

let db: FakeDb;
const use = (...rules: any[]) => { db = fakeDb(rules); pool.query.mockImplementation(db.query); return db; };
const fetchMock = vi.fn();

beforeEach(() => {
  pool.query.mockReset();
  fetchMock.mockReset().mockResolvedValue({ status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("what our code may ask the bank", () => {
  it("createBankTransaction records the expected payment through the connection it is GIVEN", async () => {
    const mine = fakeDb();
    await createBankTransaction("r1", 50000, mine as any);
    expect(mine.log[0].sql).toMatch(/insert into fake_bank_transactions/);
    expect(mine.log[0].params).toEqual(["r1", 50000]);
    expect(pool.query).not.toHaveBeenCalled(); // regression: never a second pool connection
  });

  it("…and uses the shared pool when none is given", async () => {
    use();
    await createBankTransaction("r1", 5);
    expect(db.log).toHaveLength(1);
  });

  it("bankStatus: the bank's status, or 'unknown'", async () => {
    use([/select status from fake_bank_transactions/, [{ rows: [{ status: "paid" }], rowCount: 1 }, { rows: [], rowCount: 0 }]]);
    expect(await bankStatus("r1")).toBe("paid");
    expect(await bankStatus("r2")).toBe("unknown");
  });

  it("bankRefund only affects a PAID transaction (so repeating it is harmless)", async () => {
    use();
    await bankRefund("r1", 44000);
    expect(db.log[0].sql).toMatch(/where ref = \$1 and status = 'paid'/);
    expect(db.log[0].params).toEqual(["r1", 44000]);
  });
});

describe("the bank's pages", () => {
  const app = () => { const a = Fastify(); a.register(fakeBankRoutes); return a; };
  const post = (url: string) => app().inject({ method: "POST", url });
  const pending = [/select amount_paise, status from fake_bank_transactions/, { rows: [{ amount_paise: 50000, status: "pending" }], rowCount: 1 }] as const;

  it("pay: settles as paid and calls us once with a valid signature", async () => {
    use(pending);
    const r = await post("/fakebank/r1/pay");
    expect(r.json()).toEqual({ bankStatus: "paid", webhookResponses: [200] });
    expect(db.ran(/^update fake_bank_transactions set status = \$2/)[0].params).toEqual(["r1", "paid"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3001/webhooks/payment");
    expect(init.headers["x-bank-signature"]).toBe(sign("r1", "paid", 50000));
    expect(JSON.parse(init.body)).toEqual({ ref: "r1", status: "paid", amountPaise: 50000 });
  });

  it("fail: settles as failed and says so in the call", async () => {
    use(pending);
    await post("/fakebank/r1/fail");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status).toBe("failed");
  });

  it("?webhook=twice calls us twice; ?webhook=never calls us not at all (but still settles)", async () => {
    use(pending);
    expect((await post("/fakebank/r1/pay?webhook=twice")).json().webhookResponses).toEqual([200, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockClear();
    use(pending);
    const r = await post("/fakebank/r1/pay?webhook=never");
    expect(r.json()).toEqual({ bankStatus: "paid", webhookResponses: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.ran(/^update fake_bank_transactions set status = \$2/)).toHaveLength(1);
  });

  it("reports what our server answered to each call", async () => {
    use(pending);
    fetchMock.mockResolvedValue({ status: 401 });
    expect((await post("/fakebank/r1/pay")).json().webhookResponses).toEqual([401]);
  });

  it("an unknown reference is 404", async () => {
    use([/select amount_paise/, { rows: [], rowCount: 0 }]);
    for (const p of ["pay", "fail"]) expect((await post(`/fakebank/nope/${p}`)).statusCode).toBe(404);
  });

  it.each(["paid", "failed", "refunded"])("an already-%s transaction can't be settled again, and sends no call", async (status) => {
    use([/select amount_paise/, { rows: [{ amount_paise: 5, status }], rowCount: 1 }]);
    const r = await post("/fakebank/r1/pay");
    expect(r.json()).toEqual({ bankStatus: status, note: "already settled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.did(/^update/)).toBe(false);
  });

  it("forge: sends a call with a WRONG signature", async () => {
    use();
    fetchMock.mockResolvedValue({ status: 401 });
    const r = await post("/fakebank/r1/forge");
    expect(r.json()).toEqual({ webhookResponse: 401 });
    expect(fetchMock.mock.calls[0][1].headers["x-bank-signature"]).toBe("not-a-real-signature");
  });

  it("GET shows the transaction, or 404", async () => {
    use([/select ref, status, amount_paise, refunded_paise/, [{ rows: [{ ref: "r1", status: "refunded", amount_paise: 50000, refunded_paise: 44000 }], rowCount: 1 }, { rows: [], rowCount: 0 }]]);
    expect((await app().inject({ method: "GET", url: "/fakebank/r1" })).json()).toMatchObject({ status: "refunded", refunded_paise: 44000 });
    expect((await app().inject({ method: "GET", url: "/fakebank/r2" })).statusCode).toBe(404);
  });
});
