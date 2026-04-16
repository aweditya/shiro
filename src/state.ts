import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentKind,
  ApprovalDecision,
  PendingApproval,
  Session,
} from "./types.js";

const sessions = new Map<string, Session>();
const pendingApprovals = new Map<string, PendingApproval>();

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
  approval.resolve(decision);
  return approval;
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
