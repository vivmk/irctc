import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorShape } from "@irctc/shared-types";

const CODES: Record<number, string> = {
  413: "PAYLOAD_TOO_LARGE",
  414: "URI_TOO_LONG",
  415: "UNSUPPORTED_MEDIA_TYPE",
};

// Turns any error (including the framework's own: bad JSON, wrong content type, too large)
// into our ErrorShape, so the frontend only ever has to understand one error format.
// These framework messages repeat the caller's whole URL back (it can be thousands of characters).
const FIXED_MESSAGES: Record<string, string> = {
  FST_ERR_MAX_PARAM_LENGTH: "The address is too long",
  FST_ERR_BAD_URL: "The address is not valid",
};

export function toErrorShape(error: FastifyError): { status: number; shape: ErrorShape } {
  const status =
    error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
  const shape: ErrorShape =
    status === 500
      ? { code: "INTERNAL", message: "Something went wrong. Please try again.", canRetry: true }
      : {
          code: CODES[status] ?? "BAD_REQUEST",
          message: FIXED_MESSAGES[error.code] ?? error.message,
          canRetry: false,
        };
  return { status, shape };
}

// Fastify answers some problems itself before any route runs (a path that is too long, a malformed URL).
// Pass this as the `frameworkErrors` option when creating the app so those use our shape too.
export function frameworkErrors(error: FastifyError, _req: FastifyRequest, reply: FastifyReply) {
  const { status, shape } = toErrorShape(error);
  return reply.code(status).send(shape);
}

export function installErrorHandlers(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, req, reply) => {
    const { status, shape } = toErrorShape(error);
    if (status === 500) req.log.error(error);
    return reply.code(status).send(shape);
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", message: "No such route", canRetry: false } satisfies ErrorShape),
  );
}
