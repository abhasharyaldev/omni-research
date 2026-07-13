import { newId } from "@omni/shared";
import type { PrismaClient } from "./client.js";

export type TimelineEventType =
  | "project-created"
  | "run-started"
  | "run-completed"
  | "run-failed"
  | "source-added"
  | "note-created"
  | "note-updated"
  | "claim-created"
  | "report-generated"
  | "export-created"
  | "story-generated"
  | "import-completed"
  | "import-failed";

/**
 * Append one compact project-timeline event. Events store stable entity
 * references and short summaries — never large document bodies. Failures are
 * swallowed: the timeline is an audit convenience and must never break the
 * operation it describes.
 */
export async function recordTimelineEvent(
  prisma: PrismaClient,
  event: {
    projectId: string;
    type: TimelineEventType;
    summary: string;
    actor?: "user" | "system";
    entityType?: string;
    entityId?: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await prisma.timelineEvent.create({
      data: {
        id: newId("tev"),
        projectId: event.projectId,
        type: event.type,
        actor: event.actor ?? "user",
        entityType: event.entityType,
        entityId: event.entityId,
        summary: event.summary.slice(0, 480),
        metaJson: event.meta as object | undefined,
      },
    });
  } catch {
    /* timeline must never break the primary operation */
  }
}
