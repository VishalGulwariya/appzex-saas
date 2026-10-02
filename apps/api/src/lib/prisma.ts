import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

export function withPrismaPoolDefaults(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const defaults: Record<string, string> = {
    connection_limit: "10",
    pool_timeout: "20",
    connect_timeout: "10",
    socket_timeout: "30"
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (!url.searchParams.has(name)) url.searchParams.set(name, value);
  }
  return url.toString();
}

const prismaGlobal = globalThis as typeof globalThis & { appzexPrisma?: PrismaClient };

export const prisma = prismaGlobal.appzexPrisma ?? new PrismaClient({
  datasources: { db: { url: withPrismaPoolDefaults(env.DATABASE_URL) } }
});

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.appzexPrisma = prisma;
}
