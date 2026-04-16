import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentKind,
  ApprovalDecision,
  PendingApproval,
  Session,
} from "./types.js";

// Keep recent approvals around long enough that a PostToolUse hook can
// correlate back to the Telegram message we already showed. Five minutes
// covers all but the slowest-running tools; beyond that, an outcome update
// would be too stale to be useful.
const RECENT_APPROVAL_TTL_MS = 5 * 60 * 1000;

const sessions = new Map<string, Session>();
const pendingApprovals = new Map<string, PendingApproval>();
const recentApprovals = new Map<string, RecentApproval>();

export interface RecentApproval {
  approval: PendingApproval;
  decision: ApprovalDecision;
  resolvedAt: number;
}

export function upsertSession(
  agent: AgentKind,
  sessionId: string,
  cwd: string,
): Session {
  const now = Date.now();
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastSeen = now;
    existing.cwd = cwd;
    return existing;
  }
  const session: Session = {
    id: sessionId,
    agent,
    label: path.basename(cwd) || cwd,
    cwd,
    firstSeen: now,
    lastSeen: now,
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getActiveSessions(staleSeconds: number): Session[] {
  const cutoff = Date.now() - staleSeconds * 1000;
  return Array.from(sessions.values()).filter((s) => s.lastSeen >= cutoff);
}

export function pruneStaleSessions(staleSeconds: number): number {
  const cutoff = Date.now() - staleSeconds * 1000;
  let removed = 0;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

interface NewApprovalInput {
  agent: AgentKind;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  resolve: (decision: ApprovalDecision) => void;
}

export function addPendingApproval(input: NewApprovalInput): PendingApproval {
  const approval: PendingApproval = {
    id: randomUUID(),
    agent: input.agent,
    sessionId: input.sessionId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    cwd: input.cwd,
    receivedAt: Date.now(),
    resolve: input.resolve,
  };
  pendingApprovals.set(approval.id, approval);
  return approval;
}

export function getPendingApproval(id: string): PendingApproval | undefined {
  return pendingApprovals.get(id);
}

export function resolvePendingApproval(
  id: string,
  decision: ApprovalDecision,
): PendingApproval | undefined {
  const approval = pendingApprovals.get(id);
  if (!approval) return undefined;
  pendingApprovals.delete(id);
  // Record for potential PostToolUse correlation. Only worth stashing if a
  // Telegram message exists to edit later.
  if (approval.telegramMessageId !== undefined) {
    recordRecentApproval(approval, decision);
  }
  approval.resolve(decision);
  return approval;
}

export function correlationKey(
  agent: AgentKind,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  let inputHash: string;
  try {
    inputHash = createHash("sha256")
      .update(JSON.stringify(toolInput) ?? "")
      .digest("hex")
      .slice(0, 16);
  } catch {
    inputHash = "unhashable";
  }
  return `${agent}:${sessionId}:${toolName}:${inputHash}`;
}

export function findPendingByCorrelation(
  agent: AgentKind,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): PendingApproval | undefined {
  const key = correlationKey(agent, sessionId, toolName, toolInput);
  for (const approval of pendingApprovals.values()) {
    if (
      correlationKey(
        approval.agent,
        approval.sessionId,
        approval.toolName,
        approval.toolInput,
      ) === key
    ) {
      return approval;
    }
  }
  return undefined;
}

export function popRecentApproval(
  agent: AgentKind,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): RecentApproval | undefined {
  pruneRecentApprovals();
  const key = correlationKey(agent, sessionId, toolName, toolInput);
  const recent = recentApprovals.get(key);
  if (recent) {
    recentApprovals.delete(key);
  }
  return recent;
}

function recordRecentApproval(
  approval: PendingApproval,
  decision: ApprovalDecision,
): void {
  pruneRecentApprovals();
  const key = correlationKey(
    approval.agent,
    approval.sessionId,
    approval.toolName,
    approval.toolInput,
  );
  recentApprovals.set(key, {
    approval,
    decision,
    resolvedAt: Date.now(),
  });
}

function pruneRecentApprovals(): void {
  const cutoff = Date.now() - RECENT_APPROVAL_TTL_MS;
  for (const [key, recent] of recentApprovals) {
    if (recent.resolvedAt < cutoff) {
      recentApprovals.delete(key);
    }
  }
}

export function getPendingApprovals(): PendingApproval[] {
  return Array.from(pendingApprovals.values()).sort(
    (a, b) => a.receivedAt - b.receivedAt,
  );
}

export function attachTelegramMessage(
  approvalId: string,
  chatId: number,
  messageId: number,
): void {
  const approval = pendingApprovals.get(approvalId);
  if (approval) {
    approval.telegramChatId = chatId;
    approval.telegramMessageId = messageId;
  }
}
