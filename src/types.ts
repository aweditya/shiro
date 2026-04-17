export type AgentKind = "claude" | "codex";

export interface Session {
  id: string;
  agent: AgentKind;
  label: string;
  cwd: string;
  lastSeen: number;
  /** Most recent user prompt, captured via UserPromptSubmit. */
  currentTask?: string;
  /**
   * Wall-clock timestamp (ms) when currentTask was captured. Used by the
   * Stop hook to filter out short interactive turns — without this, every
   * chat message would fire a Telegram ping.
   */
  taskStartedAt?: number;
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

/** Shared by Claude + Codex — both hooks deliver the same shape for UserPromptSubmit. */
export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

/** Shared by Claude + Codex — both fire the same shape for StopFailure / error hooks. */
export interface StopFailureInput {
  session_id: string;
  cwd: string;
  hook_event_name: "StopFailure";
  /** One of: rate_limit, authentication_failed, billing_error, invalid_request, server_error, max_output_tokens, unknown. */
  error_type: string;
  error_message: string;
}

/** Shared by Claude + Codex — both fire the same shape for Stop / turn-completion hooks. */
export interface StopInput {
  session_id: string;
  cwd: string;
  hook_event_name: "Stop";
  /** Final assistant text for the turn — included so hooks don't have to read the transcript file. */
  last_assistant_message?: string;
}
