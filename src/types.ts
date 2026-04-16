export type AgentKind = "claude" | "codex";

export interface Session {
  id: string;
  agent: AgentKind;
  label: string;
  cwd: string;
  lastSeen: number;
  /** Most recent user prompt, captured via UserPromptSubmit. */
  currentTask?: string;
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
  /** Snapshot of the session's currentTask at approval creation time. */
  task?: string;
}

export interface ClaudePermissionRequestInput {
  session_id: string;
  cwd: string;
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface CodexPreToolUseInput {
  session_id: string;
  cwd: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface ClaudePostToolUseInput {
  session_id: string;
  cwd: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
}

export interface ClaudeUserPromptSubmitInput {
  session_id: string;
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface ClaudeStopFailureInput {
  session_id: string;
  cwd: string;
  hook_event_name: "StopFailure";
  /** One of: rate_limit, authentication_failed, billing_error, invalid_request, server_error, max_output_tokens, unknown. */
  error_type: string;
  error_message: string;
}
