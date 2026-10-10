export const config = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://irctc:irctc@localhost:5432/irctc",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  holdSeconds: Number(process.env.HOLD_SECONDS ?? 300),
};
