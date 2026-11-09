import { connectionGrants, toolOauthStates, type Db, type toolConnections } from "@paperclipai/db";
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { unprocessable } from "../../../errors.js";

type ConnectionRow = typeof toolConnections.$inferSelect;
type Target = { targetType: "company" | "agent"; targetId: string };

/** Check the one-subject reach of a dedicated connection before access writes. */
export async function assertDedicatedAgentTargets(
  db: Db,
  connection: ConnectionRow,
  targets: Target[],
): Promise<void> {
  if (connection.credentialPolicy !== "per_agent") return;
  if (targets.length > 1 || targets.some((target) => target.targetType !== "agent")) {
    throw unprocessable("A dedicated account can be installed for only one agent");
  }
  if (targets.length === 0) return;

  const [grants, pendingAuthorizations] = await Promise.all([
    db.select({ subjectAgentId: connectionGrants.subjectAgentId }).from(connectionGrants).where(and(
      eq(connectionGrants.companyId, connection.companyId),
      eq(connectionGrants.connectionId, connection.id),
      eq(connectionGrants.kind, "agent"),
      inArray(connectionGrants.status, ["active", "needs_reauthorization"]),
      isNotNull(connectionGrants.subjectAgentId),
    )),
    db.select({ subjectAgentId: toolOauthStates.subjectAgentId }).from(toolOauthStates).where(and(
      eq(toolOauthStates.companyId, connection.companyId),
      eq(toolOauthStates.connectionId, connection.id),
      gt(toolOauthStates.expiresAt, new Date()),
      isNotNull(toolOauthStates.subjectAgentId),
    )),
  ]);
  const configuredSubject = (connection.config as Record<string, unknown>).connectorSubjectAgentId;
  const subjects = new Set([
    ...(typeof configuredSubject === "string" ? [configuredSubject] : []),
    ...[...grants, ...pendingAuthorizations].map((row) => row.subjectAgentId).filter((id): id is string => Boolean(id)),
  ]);
  if (subjects.size > 1 || (subjects.size === 1 && !subjects.has(targets[0]!.targetId))) {
    throw unprocessable("A dedicated account can be installed only for its authorized agent");
  }
}
