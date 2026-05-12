// Tiny client around fetch() with X-API-Key injection and an SSE parser
// that yields parsed JSON payloads from the chat endpoint.

import type {
  AllowedDir,
  FileCompletionItem,
  SessionMeta,
  SessionPreview,
  SlashCompletionItem,
  StreamEvent,
} from "./types";

const KEY_HEADER = "X-API-Key";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function authHeaders(apiKey: string, extra: HeadersInit = {}): HeadersInit {
  return { ...extra, [KEY_HEADER]: apiKey };
}

async function jsonGet<T>(url: string, apiKey: string): Promise<T> {
  const r = await fetch(url, { headers: authHeaders(apiKey) });
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.json();
}

async function jsonPost<T>(
  url: string,
  apiKey: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.json();
}

export async function checkAuth(apiKey: string): Promise<boolean> {
  try {
    const r = await fetch("/api/dirs", { headers: authHeaders(apiKey) });
    return r.ok;
  } catch {
    return false;
  }
}

export function listDirs(apiKey: string): Promise<{ dirs: AllowedDir[] }> {
  return jsonGet("/api/dirs", apiKey);
}

export function listSessions(
  apiKey: string,
  dir?: string,
): Promise<{ sessions: SessionPreview[] }> {
  const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  return jsonGet(`/api/sessions${q}`, apiKey);
}

export function createSession(
  apiKey: string,
  dir: string,
  permissionMode: string = "default",
): Promise<SessionMeta> {
  return jsonPost("/api/sessions", apiKey, {
    dir,
    permission_mode: permissionMode,
  });
}

export interface ActiveTurn {
  turn_id: string;
  done: boolean;
  cancelled: boolean;
  last_event_id: number;
}

export interface SessionDetail {
  id: string;
  working_dir: string;
  dir_name: string;
  permission_mode: string;
  events: Array<Record<string, unknown>>;
  active_turn: ActiveTurn | null;
}

export function getSession(
  apiKey: string,
  sessionId: string,
): Promise<SessionDetail> {
  return jsonGet(`/api/sessions/${encodeURIComponent(sessionId)}`, apiKey);
}

export function fetchSlashCompletions(
  apiKey: string,
  sessionId: string,
  q: string,
): Promise<{ items: SlashCompletionItem[] }> {
  return jsonGet(
    `/api/sessions/${encodeURIComponent(sessionId)}/completions/slash?q=${encodeURIComponent(q)}`,
    apiKey,
  );
}

export function fetchFileCompletions(
  apiKey: string,
  sessionId: string,
  q: string,
  limit = 50,
): Promise<{ items: FileCompletionItem[] }> {
  return jsonGet(
    `/api/sessions/${encodeURIComponent(sessionId)}/completions/files?q=${encodeURIComponent(q)}&limit=${limit}`,
    apiKey,
  );
}

export function decidePermission(
  apiKey: string,
  sessionId: string,
  requestId: string,
  decision: "allow" | "allow_always" | "deny",
  reason?: string,
  setMode?: string,
): Promise<{ ok: boolean; session_allowlist: string[]; permission_mode: string }> {
  const body: Record<string, unknown> = { request_id: requestId, decision };
  if (reason) body.reason = reason;
  if (setMode) body.set_mode = setMode;
  return jsonPost(
    `/api/sessions/${encodeURIComponent(sessionId)}/permissions`,
    apiKey,
    body,
  );
}

export interface FilePayload {
  path: string;
  relative_path: string;
  size: number;
  is_binary: boolean;
  content: string | null;
  language: string;
}

export function fetchFile(
  apiKey: string,
  sessionId: string,
  path: string,
): Promise<FilePayload> {
  return jsonGet(
    `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
    apiKey,
  );
}

export interface StreamEnvelope {
  /**
   * Server-assigned event id (monotonic per turn, starts at 1). Used by the
   * client to resume the stream after a disconnect via GET /messages?since.
   */
  id: number;
  event: StreamEvent;
}

/**
 * Start a new turn (POST) and stream events as they arrive. The returned
 * iterator can be torn down at any time (close the fetch, refresh the
 * tab) — the server-side turn keeps running and its events are buffered
 * for later replay through ``resumeMessage``.
 *
 * If `permissionMode` is provided it overrides the session's default for
 * this turn AND becomes the session's new sticky default.
 */
export async function* streamMessage(
  apiKey: string,
  sessionId: string,
  text: string,
  signal?: AbortSignal,
  permissionMode?: string,
): AsyncGenerator<StreamEnvelope> {
  const r = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(
        permissionMode
          ? { text, permission_mode: permissionMode }
          : { text },
      ),
      signal,
    },
  );
  if (!r.ok) throw new ApiError(r.status, await r.text());
  yield* _readSSE(r);
}

/**
 * Resubscribe to a session's current (or most recently finished) turn,
 * replaying everything with event id > since and then continuing live.
 * Used when the client comes back from background / network blip.
 *
 * Throws ApiError(404) if there's no turn to resume.
 */
export async function* resumeMessage(
  apiKey: string,
  sessionId: string,
  since: number,
  signal?: AbortSignal,
): AsyncGenerator<StreamEnvelope> {
  const r = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?since=${since}`,
    {
      method: "GET",
      headers: authHeaders(apiKey),
      signal,
    },
  );
  if (!r.ok) throw new ApiError(r.status, await r.text());
  yield* _readSSE(r);
}

/** Cancel the active turn for a session (terminates the claude subprocess). */
export async function cancelMessage(
  apiKey: string,
  sessionId: string,
): Promise<{ ok: boolean }> {
  return jsonPost(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/cancel`,
    apiKey,
    {},
  );
}

async function* _readSSE(r: Response): AsyncGenerator<StreamEnvelope> {
  if (!r.body) return;
  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = parseSSEData(raw);
        if (data == null) continue;
        try {
          const event = JSON.parse(data) as StreamEvent & { _id?: number };
          const id = typeof event._id === "number" ? event._id : 0;
          if ("_id" in event) delete (event as { _id?: number })._id;
          yield { id, event: event as StreamEvent };
        } catch {
          // ignore unparsable
        }
      }
    }
  } finally {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  }
}

function parseSSEData(rawEvent: string): string | null {
  // We only care about `data:` lines. Concatenate them with "\n" per spec.
  const lines = rawEvent.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0 ? null : dataLines.join("\n");
}
