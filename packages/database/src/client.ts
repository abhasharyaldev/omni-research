import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Singleton Prisma client. Call bootstrapDatabase() first in app entrypoints. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

export type { PrismaClient };
export * from "@prisma/client";
