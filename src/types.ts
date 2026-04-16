export type AgentKind = "claude" | "codex";

export interface Session {
  id: string;
  agent: AgentKind;
  label: string;
  cwd: string;
  firstSeen: number;
  lastSeen: number;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface PendingApproval {
  id: string;
  agent: AgentKind;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  receivedAt: number;
  resolve: (decision: ApprovalDecision) => void;
  telegramChatId?: number;
  telegramMessageId?: number;
}

export interface ClaudePermissionRequestInput {
  session_id: string;
  cwd: string;
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: unknown[];
}

export interface CodexPreToolUseInput {
  session_id: string;
  cwd: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  turn_id?: string;
}
