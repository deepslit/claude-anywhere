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

export interface SessionDetail {
  id: string;
  working_dir: string;
  dir_name: string;
  permission_mode: string;
  events: Array<Record<string, unknown>>;
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

/**
 * Stream chat events from the SSE endpoint. The returned async iterable
 * yields one StreamEvent per SSE `data:` payload.
 *
 * Cancellation: pass an AbortSignal — calling `.abort()` will close the
 * underlying fetch and propagate as a thrown DOMException. Callers should
 * treat AbortError as a graceful cancel, not a failure.
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
): AsyncGenerator<StreamEvent> {
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
  if (!r.body) return;

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Each SSE event is terminated by a blank line (\n\n).
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = parseSSEData(raw);
        if (data == null) continue;
        try {
          yield JSON.parse(data) as StreamEvent;
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
