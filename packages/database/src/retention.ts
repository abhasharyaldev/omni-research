import type { PrismaClient } from "@prisma/client";

/**
 * Retention cleanup: delete stored source content past its retention window.
 * Source records (metadata + citation locators) are kept so citations remain
 * auditable; only stored full text is purged.
 */
export async function cleanupExpiredContent(prisma: PrismaClient): Promise<{ purgedSnapshots: number }> {
  const now = new Date();
  const expired = await prisma.source.findMany({
    where: { retentionUntil: { not: null, lt: now } },
    select: { id: true },
  });
  if (expired.length === 0) return { purgedSnapshots: 0 };
  const ids = expired.map((s) => s.id);
  const { count } = await prisma.sourceSnapshot.deleteMany({ where: { sourceId: { in: ids } } });
  await prisma.source.updateMany({
    where: { id: { in: ids } },
    data: { retentionUntil: null, status: "archived" },
  });
  return { purgedSnapshots: count };
}

/** Delete expired sessions. */
export async function cleanupExpiredSessions(prisma: PrismaClient): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}
