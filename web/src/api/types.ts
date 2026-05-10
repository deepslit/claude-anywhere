// Types shared by the React frontend. Intentionally minimal — backend is
// authoritative on field names; we only model what the UI consumes.

export interface AllowedDir {
  name: string;
  path: string;
}

export interface SessionPreview {
  id: string;
  working_dir: string;
  dir_name: string;
  title: string;
  mtime: number;
  size: number;
}

export interface SessionMeta {
  id: string;
  working_dir: string;
  dir_name: string;
  permission_mode: string;
}

// Compact event types received from the SSE stream. Mirrors what
// `claude_proc._translate` emits.
export type StreamEvent =
  | { type: "turn_started"; argv: string }
  | {
      type: "session_init";
      session_id: string;
      model: string;
      tools: string[];
      slash_commands: string[];
      skills: string[];
      agents: string[];
    }
  | { type: "text_start"; index: number }
  | { type: "thinking_start"; index: number }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "tool_input_delta"; index: number; partial_json: string }
  | { type: "block_stop"; index: number }
  | { type: "message_stop" }
  | { type: "tool_result"; results: Array<{ tool_use_id: string; is_error: boolean; content: unknown }> }
  | {
      type: "done";
      duration_ms: number | null;
      is_error: boolean;
      stop_reason: string | null;
      num_turns: number | null;
      result_text: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_input_tokens: number | null;
      cache_creation_input_tokens: number | null;
      permission_denials: Array<{
        tool_name: string;
        tool_use_id: string;
        tool_input: unknown;
      }>;
    }
  | { type: "log"; level: "warn" | "error" | "info"; message: string }
  | { type: "hook"; raw: unknown }
  | {
      type: "permission_request";
      request_id: string;
      tool_name: string;
      tool_input: unknown;
    }
  | {
      type: "permission_decided";
      request_id: string;
      decision: "allow" | "allow_always" | "deny";
      reason: string | null;
    }
  | { type: "error"; message: string };

// Flat chat-timeline rendering model.
export type TimelineItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant_text"; text: string; done?: boolean }
  | { id: string; kind: "assistant_thinking"; text: string; done?: boolean }
  | {
      id: string;
      kind: "tool_use";
      toolUseId: string;
      name: string;
      input?: unknown;
      partial?: string;
      done?: boolean;
    }
  | {
      id: string;
      kind: "tool_result";
      toolUseId: string;
      content: unknown;
      isError: boolean;
    }
  | {
      id: string;
      kind: "permission_request";
      requestId: string;
      toolName: string;
      toolInput: unknown;
      status: "pending" | "allow" | "allow_always" | "deny" | "submitting" | "cancelled";
      reason?: string | null;
    }
  | {
      id: string;
      kind: "summary";
      duration_ms: number | null;
      stop_reason: string | null;
      is_error: boolean;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_input_tokens: number | null;
      permission_denials_count: number;
    };

// Autocomplete items returned by the completions endpoints.
export interface SlashCompletionItem {
  kind: "command" | "skill";
  name: string;
}

export interface FileCompletionItem {
  path: string;
}
