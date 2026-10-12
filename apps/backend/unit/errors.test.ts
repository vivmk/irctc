import Fastify, { type FastifyError } from "fastify";
import { describe, expect, it } from "vitest";
import { frameworkErrors, installErrorHandlers, toErrorShape } from "../src/errors";

const isShape = (b: any) => typeof b.code === "string" && typeof b.message === "string" && typeof b.canRetry === "boolean";

function app() {
  const a = Fastify({ logger: false });
  installErrorHandlers(a);
  a.post("/echo", async (req) => ({ got: req.body }));
  a.get("/boom", async () => { throw new Error("secret database detail"); });
  a.get("/teapot", async () => { const e: any = new Error("custom"); e.statusCode = 418; throw e; });
  return a;
}

describe("toErrorShape", () => {
  const e = (statusCode?: number, message = "m") => Object.assign(new Error(message), { statusCode }) as FastifyError;

  it("maps well-known client errors to readable codes", () => {
    expect(toErrorShape(e(413)).shape.code).toBe("PAYLOAD_TOO_LARGE");
    expect(toErrorShape(e(414)).shape.code).toBe("URI_TOO_LONG");
    expect(toErrorShape(e(415)).shape.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(toErrorShape(e(400)).shape).toEqual({ code: "BAD_REQUEST", message: "m", canRetry: false });
  });

  it("treats anything that isn't a 4xx as a server error that is worth retrying", () => {
    for (const code of [undefined, 500, 502, 200, 301]) {
      const { status, shape } = toErrorShape(e(code, "internal secret"));
      expect(status).toBe(500);
      expect(shape).toEqual({ code: "INTERNAL", message: "Something went wrong. Please try again.", canRetry: true });
    }
  });
});

describe("installErrorHandlers", () => {
  it("broken JSON is a 400 in our shape", async () => {
    const r = await app().inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(r.statusCode).toBe(400);
    expect(isShape(r.json())).toBe(true);
  });

  it("an unsupported content type is 415", async () => {
    const r = await app().inject({ method: "POST", url: "/echo", headers: { "content-type": "application/xml" }, payload: "<a/>" });
    expect(r.statusCode).toBe(415);
    expect(r.json().code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("an unknown route is a 404 in our shape", async () => {
    const r = await app().inject({ method: "GET", url: "/nowhere" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ code: "NOT_FOUND", message: "No such route", canRetry: false });
  });

  it("an unexpected crash is a 500 that does NOT leak the internal message", async () => {
    const r = await app().inject({ method: "GET", url: "/boom" });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("secret database detail");
    expect(r.json()).toMatchObject({ code: "INTERNAL", canRetry: true });
  });

  it("other client errors keep their status", async () => {
    const r = await app().inject({ method: "GET", url: "/teapot" });
    expect(r.statusCode).toBe(418);
    expect(isShape(r.json())).toBe(true);
  });
});

describe("frameworkErrors (problems Fastify answers before any route runs)", () => {
  const withFramework = () => {
    const a = Fastify({ logger: false, frameworkErrors });
    installErrorHandlers(a);
    a.get("/items/:id", async (req) => ({ id: (req.params as any).id }));
    return a;
  };

  it("a path that is too long is 414 in our shape, WITHOUT echoing the address back", async () => {
    const long = "x".repeat(5000);
    const r = await withFramework().inject({ method: "GET", url: `/items/${long}` });
    expect(r.statusCode).toBe(414);
    expect(isShape(r.json())).toBe(true);
    expect(r.json().code).toBe("URI_TOO_LONG");
    expect(r.body.length).toBeLessThan(300);
    expect(r.body).not.toContain("xxxxx");
  });

  it("a malformed URL is 400 in our shape", async () => {
    const r = await withFramework().inject({ method: "GET", url: "/items/%E0%A4%A" });
    expect(r.statusCode).toBe(400);
    expect(isShape(r.json())).toBe(true);
  });

  it("normal requests are unaffected", async () => {
    const r = await withFramework().inject({ method: "GET", url: "/items/42" });
    expect(r.json()).toEqual({ id: "42" });
  });

  it("toErrorShape replaces the URL-echoing messages with fixed ones", () => {
    const e = Object.assign(new Error("'/very/long/url...' is exceeding the max param length"), { statusCode: 414, code: "FST_ERR_MAX_PARAM_LENGTH" }) as any;
    expect(toErrorShape(e).shape.message).toBe("The address is too long");
  });
});
