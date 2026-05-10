import { useEffect, useReducer, useRef, useState } from "react";
import { useApiKey } from "./store/auth";
import { ApiKeyDialog } from "./components/ApiKeyDialog";
import { MessageBlock } from "./components/MessageBlock";
import { Composer } from "./components/Composer";
import { FileViewer } from "./components/FileViewer";
import { useT } from "./i18n";
import {
  ApiError,
  checkAuth,
  createSession,
  decidePermission,
  getSession,
  listDirs,
  listSessions,
  streamMessage,
} from "./api/client";
import type {
  AllowedDir,
  SessionPreview,
  StreamEvent,
  TimelineItem,
} from "./api/types";

// ────────────────────────────────────────────────────────────────
// timeline reducer
// ────────────────────────────────────────────────────────────────

interface ChatState {
  items: TimelineItem[];
  openByIndex: Record<number, string>;
}

const emptyChat: ChatState = { items: [], openByIndex: {} };

type ChatAction =
  | { kind: "reset" }
  | { kind: "user_send"; text: string }
  | { kind: "history"; events: Array<Record<string, unknown>> }
  | { kind: "stream"; evt: StreamEvent }
  | {
      kind: "permission_status";
      requestId: string;
      status:
        | "pending"
        | "allow"
        | "allow_always"
        | "deny"
        | "submitting"
        | "cancelled";
    }
  | { kind: "expire_pending" };

function makeId() {
  return Math.random().toString(36).slice(2);
}

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "reset":
      return emptyChat;

    case "user_send":
      return {
        ...state,
        items: [
          ...state.items,
          { id: makeId(), kind: "user", text: action.text },
        ],
      };

    case "permission_status":
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "permission_request" && it.requestId === action.requestId
            ? { ...it, status: action.status }
            : it,
        ),
      };

    case "expire_pending":
      // Called when the streaming turn ends — any permission cards still in
      // pending or submitting state are flipped to "cancelled" so the user
      // sees a clear final state instead of dangling buttons.
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "permission_request" &&
          (it.status === "pending" || it.status === "submitting")
            ? { ...it, status: "cancelled" }
            : it,
        ),
      };

    case "history": {
      const items: TimelineItem[] = [];
      for (const evt of action.events) {
        const t = evt.type as string;
        if (t === "user_message") {
          items.push({ id: makeId(), kind: "user", text: String(evt.text ?? "") });
        } else if (t === "assistant_text") {
          items.push({
            id: makeId(),
            kind: "assistant_text",
            text: String(evt.text ?? ""),
            done: true,
          });
        } else if (t === "assistant_thinking") {
          items.push({
            id: makeId(),
            kind: "assistant_thinking",
            text: String(evt.text ?? ""),
            done: true,
          });
        } else if (t === "tool_use") {
          items.push({
            id: makeId(),
            kind: "tool_use",
            toolUseId: String(evt.id ?? ""),
            name: String(evt.name ?? ""),
            input: (evt as Record<string, unknown>).input,
            done: true,
          });
        } else if (t === "tool_result") {
          const results = (evt.results as Array<Record<string, unknown>>) ?? [];
          for (const r of results) {
            items.push({
              id: makeId(),
              kind: "tool_result",
              toolUseId: String(r.tool_use_id ?? ""),
              content: r.content,
              isError: Boolean(r.is_error),
            });
          }
        } else if (t === "done") {
          items.push({
            id: makeId(),
            kind: "summary",
            duration_ms: (evt.duration_ms as number | null) ?? null,
            stop_reason: (evt.stop_reason as string | null) ?? null,
            is_error: Boolean(evt.is_error),
            input_tokens: (evt.input_tokens as number | null) ?? null,
            output_tokens: (evt.output_tokens as number | null) ?? null,
            cache_read_input_tokens:
              (evt.cache_read_input_tokens as number | null) ?? null,
            permission_denials_count: Array.isArray(evt.permission_denials)
              ? (evt.permission_denials as unknown[]).length
              : 0,
          });
        }
      }
      return { items, openByIndex: {} };
    }

    case "stream": {
      const evt = action.evt;
      const items = state.items;
      const openByIndex = { ...state.openByIndex };
      const updateItem = (
        id: string,
        patch: (it: TimelineItem) => TimelineItem,
      ) => items.map((it) => (it.id === id ? patch(it) : it));

      switch (evt.type) {
        case "text_start": {
          const id = makeId();
          openByIndex[evt.index] = id;
          return {
            items: [...items, { id, kind: "assistant_text", text: "" }],
            openByIndex,
          };
        }
        case "thinking_start": {
          const id = makeId();
          openByIndex[evt.index] = id;
          return {
            items: [...items, { id, kind: "assistant_thinking", text: "" }],
            openByIndex,
          };
        }
        case "tool_use_start": {
          const id = makeId();
          openByIndex[evt.index] = id;
          return {
            items: [
              ...items,
              {
                id,
                kind: "tool_use",
                toolUseId: evt.id,
                name: evt.name,
                partial: "",
              },
            ],
            openByIndex,
          };
        }
        case "text_delta": {
          const id = openByIndex[evt.index];
          if (!id) return state;
          return {
            items: updateItem(id, (it) =>
              it.kind === "assistant_text"
                ? { ...it, text: it.text + evt.text }
                : it,
            ),
            openByIndex,
          };
        }
        case "thinking_delta": {
          const id = openByIndex[evt.index];
          if (!id) return state;
          return {
            items: updateItem(id, (it) =>
              it.kind === "assistant_thinking"
                ? { ...it, text: it.text + evt.text }
                : it,
            ),
            openByIndex,
          };
        }
        case "tool_input_delta": {
          const id = openByIndex[evt.index];
          if (!id) return state;
          return {
            items: updateItem(id, (it) =>
              it.kind === "tool_use"
                ? { ...it, partial: (it.partial ?? "") + evt.partial_json }
                : it,
            ),
            openByIndex,
          };
        }
        case "block_stop": {
          const id = openByIndex[evt.index];
          delete openByIndex[evt.index];
          if (!id) return { ...state, openByIndex };
          return {
            items: updateItem(id, (it) =>
              it.kind === "assistant_text" ||
              it.kind === "assistant_thinking" ||
              it.kind === "tool_use"
                ? { ...it, done: true }
                : it,
            ),
            openByIndex,
          };
        }
        case "message_stop":
          return { items, openByIndex: {} };
        case "tool_result": {
          const newItems = [...items];
          for (const r of evt.results) {
            newItems.push({
              id: makeId(),
              kind: "tool_result",
              toolUseId: r.tool_use_id,
              content: r.content,
              isError: r.is_error,
            });
          }
          return { items: newItems, openByIndex };
        }
        case "permission_request": {
          return {
            items: [
              ...items,
              {
                id: makeId(),
                kind: "permission_request",
                requestId: evt.request_id,
                toolName: evt.tool_name,
                toolInput: evt.tool_input,
                status: "pending",
              },
            ],
            openByIndex,
          };
        }
        case "permission_decided": {
          return {
            items: items.map((it) =>
              it.kind === "permission_request" && it.requestId === evt.request_id
                ? { ...it, status: evt.decision, reason: evt.reason }
                : it,
            ),
            openByIndex,
          };
        }
        case "done":
          return {
            items: [
              ...items,
              {
                id: makeId(),
                kind: "summary",
                duration_ms: evt.duration_ms,
                stop_reason: evt.stop_reason,
                is_error: evt.is_error,
                input_tokens: evt.input_tokens,
                output_tokens: evt.output_tokens,
                cache_read_input_tokens: evt.cache_read_input_tokens,
                permission_denials_count: evt.permission_denials.length,
              },
            ],
            openByIndex: {},
          };
        case "error":
          return {
            items: [
              ...items,
              {
                id: makeId(),
                kind: "summary",
                duration_ms: null,
                stop_reason: `error: ${evt.message}`,
                is_error: true,
                input_tokens: null,
                output_tokens: null,
                cache_read_input_tokens: null,
                permission_denials_count: 0,
              },
            ],
            openByIndex: {},
          };
        default:
          return state;
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// app
// ────────────────────────────────────────────────────────────────

export default function App() {
  const { t } = useT();
  const { key, setKey, clear } = useApiKey();
  const [keyValid, setKeyValid] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!key) {
      setKeyValid(false);
      return;
    }
    setKeyValid(null);
    checkAuth(key).then((ok) => {
      if (!cancelled) setKeyValid(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!key || keyValid === false) {
    return (
      <ApiKeyDialog
        onSubmit={(k) => {
          setKey(k);
          setKeyValid(true);
        }}
      />
    );
  }
  if (keyValid === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-white/50">
        {t("app.checking")}
      </div>
    );
  }
  return <Chat apiKey={key} onLogout={clear} />;
}

interface ChatProps {
  apiKey: string;
  onLogout: () => void;
}

function Chat({ apiKey, onLogout }: ChatProps) {
  const { t } = useT();
  const [dirs, setDirs] = useState<AllowedDir[]>([]);
  const [sessions, setSessions] = useState<SessionPreview[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentDirName, setCurrentDirName] = useState<string | null>(null);
  const [currentDirPath, setCurrentDirPath] = useState<string | null>(null);
  const [currentMode, setCurrentMode] = useState<string | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, emptyChat);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listDirs(apiKey)
      .then((r) => setDirs(r.dirs))
      .catch((e) =>
        setErrorMsg(t("err.dirsLoad", { msg: (e as Error).message })),
      );
    listSessions(apiKey)
      .then((r) => setSessions(r.sessions))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const refreshSessions = () => {
    listSessions(apiKey)
      .then((r) => setSessions(r.sessions))
      .catch(() => {});
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.items.length]);

  const openSession = async (id: string, dirName: string) => {
    setCurrentId(id);
    setCurrentDirName(dirName);
    setCurrentMode(null);
    setDrawerOpen(false);
    dispatch({ kind: "reset" });
    try {
      const detail = await getSession(apiKey, id);
      setCurrentMode(detail.permission_mode ?? null);
      setCurrentDirPath(detail.working_dir);
      dispatch({
        kind: "history",
        events: detail.events as Array<Record<string, unknown>>,
      });
    } catch (e) {
      setErrorMsg(t("err.sessionLoad", { msg: (e as Error).message }));
    }
  };

  const startNewSession = async (dir: AllowedDir, permissionMode: string) => {
    try {
      const meta = await createSession(apiKey, dir.path, permissionMode);
      setCurrentId(meta.id);
      setCurrentDirName(meta.dir_name);
      setCurrentDirPath(meta.working_dir);
      setCurrentMode(meta.permission_mode);
      dispatch({ kind: "reset" });
      setPickerOpen(false);
      setDrawerOpen(false);
    } catch (e) {
      const err =
        e instanceof ApiError ? `${e.status}: ${e.message}` : (e as Error).message;
      setErrorMsg(t("err.sessionCreate", { msg: err }));
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !currentId || sending) return;

    // Intercept UI-only slash commands that are CC-TUI affordances rather
    // than tools the model knows. Don't ship them to the model.
    if (text === "/clear") {
      setInput("");
      setErrorMsg(null);
      if (currentDirPath) {
        const dir = dirs.find((d) => d.path === currentDirPath) ?? {
          name: currentDirName ?? currentDirPath,
          path: currentDirPath,
        };
        await startNewSession(dir, currentMode ?? "default");
      }
      return;
    }

    setInput("");
    setErrorMsg(null);
    setSending(true);
    dispatch({ kind: "user_send", text });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      for await (const evt of streamMessage(
        apiKey,
        currentId,
        text,
        ctrl.signal,
        currentMode ?? undefined,
      )) {
        dispatch({ kind: "stream", evt });
      }
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") {
        setErrorMsg(t("err.chat", { msg: (e as Error).message }));
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      dispatch({ kind: "expire_pending" });
      refreshSessions();
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const onPermissionDecide = async (
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    reason?: string,
    setMode?: string,
  ) => {
    if (!currentId) return;
    dispatch({ kind: "permission_status", requestId, status: "submitting" });
    try {
      const r = await decidePermission(
        apiKey,
        currentId,
        requestId,
        decision,
        reason,
        setMode,
      );
      if (r.permission_mode) setCurrentMode(r.permission_mode);
      dispatch({ kind: "permission_status", requestId, status: decision });
    } catch (e) {
      dispatch({ kind: "permission_status", requestId, status: "pending" });
      setErrorMsg(t("err.permissionSubmit", { msg: (e as Error).message }));
    }
  };

  const onPermissionInterrupt = () => {
    cancel();
  };

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        onPick={(s) => openSession(s.id, s.dir_name)}
        onNew={() => setPickerOpen(true)}
        onLogout={onLogout}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      <main className="flex flex-1 flex-col bg-[#0b0b10]">
        <header className="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-sm">
          <button
            type="button"
            className="rounded-md p-1.5 text-white/70 hover:bg-white/5 md:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开侧边栏"
          >
            ☰
          </button>
          <div className="truncate">
            {currentId ? (
              <span className="text-white/80">
                <span className="text-white/40">{currentDirName ?? ""} · </span>
                <span className="font-mono text-xs">{currentId.slice(0, 8)}</span>
              </span>
            ) : (
              <span className="text-white/40">{t("app.noSession")}</span>
            )}
          </div>
        </header>

        {errorMsg && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200">
            {errorMsg}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {!currentId ? (
            <EmptyState onNew={() => setPickerOpen(true)} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {chat.items.map((it) => (
                <MessageBlock
                  key={it.id}
                  item={it}
                  onDecide={onPermissionDecide}
                  onInterrupt={onPermissionInterrupt}
                  onOpenFile={(p) => setViewingFile(p)}
                />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <Composer
          apiKey={apiKey}
          sessionId={currentId}
          value={input}
          onChange={setInput}
          onSend={send}
          onCancel={cancel}
          disabled={!currentId}
          sending={sending}
          mode={currentMode ?? "default"}
          onModeChange={setCurrentMode}
        />
      </main>

      {pickerOpen && (
        <DirPicker
          dirs={dirs}
          onPick={startNewSession}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {viewingFile && currentId && (
        <FileViewer
          apiKey={apiKey}
          sessionId={currentId}
          path={viewingFile}
          onClose={() => setViewingFile(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useT();
  return (
    <div className="flex h-full items-center justify-center text-center text-white/50">
      <div>
        <div className="text-base">{t("app.empty.title")}</div>
        <button
          type="button"
          className="mt-3 rounded-md bg-indigo-500 px-4 py-2 text-sm text-white hover:bg-indigo-400"
          onClick={onNew}
        >
          {t("app.empty.cta")}
        </button>
        <div className="mt-2 text-xs text-white/30">
          {t("app.empty.hint")}
        </div>
      </div>
    </div>
  );
}

interface SidebarProps {
  sessions: SessionPreview[];
  currentId: string | null;
  onPick: (s: SessionPreview) => void;
  onNew: () => void;
  onLogout: () => void;
  open: boolean;
  onClose: () => void;
}

function Sidebar({
  sessions,
  currentId,
  onPick,
  onNew,
  onLogout,
  open,
  onClose,
}: SidebarProps) {
  const { t, locale, setLocale } = useT();
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 transform border-r border-white/5 bg-[#0d0d14] transition-transform md:relative md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-3 py-3">
            <div className="text-sm font-semibold text-white">{t("app.brand")}</div>
            <div className="ml-auto" />
            <button
              type="button"
              onClick={() => setLocale(locale === "en" ? "zh" : "en")}
              title={t("sidebar.langTitle")}
              className="rounded-md border border-white/10 px-2 py-1 text-xs text-white/70 hover:bg-white/5"
            >
              {t("sidebar.lang")}
            </button>
            <button
              type="button"
              className="rounded-md bg-indigo-500 px-3 py-1 text-xs text-white hover:bg-indigo-400"
              onClick={onNew}
            >
              {t("sidebar.new")}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {sessions.length === 0 ? (
              <div className="px-2 py-4 text-xs text-white/30">
                {t("sidebar.empty")}
              </div>
            ) : (
              sessions.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => onPick(s)}
                  className={`mb-1 block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-white/5 ${
                    s.id === currentId ? "bg-white/[0.07]" : ""
                  }`}
                >
                  <div className="truncate text-white/85">{s.title}</div>
                  <div className="mt-0.5 truncate text-xs text-white/40">
                    {s.dir_name} · {new Date(s.mtime * 1000).toLocaleString()}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-white/5 px-3 py-2 text-xs text-white/40">
            <button type="button" onClick={onLogout} className="hover:text-white/70">
              {t("sidebar.logout")}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

interface DirPickerProps {
  dirs: AllowedDir[];
  onPick: (d: AllowedDir, permissionMode: string) => void;
  onClose: () => void;
}

const PERMISSION_MODE_KEYS: Array<{
  value: string;
  labelKey: string;
  hintKey: string;
}> = [
  {
    value: "default",
    labelKey: "picker.mode.default.label",
    hintKey: "picker.mode.default.hint",
  },
  {
    value: "acceptEdits",
    labelKey: "picker.mode.acceptEdits.label",
    hintKey: "picker.mode.acceptEdits.hint",
  },
  {
    value: "bypassPermissions",
    labelKey: "picker.mode.bypass.label",
    hintKey: "picker.mode.bypass.hint",
  },
];

function DirPicker({ dirs, onPick, onClose }: DirPickerProps) {
  const { t } = useT();
  const [mode, setMode] = useState<string>("default");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#15151c] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-white">{t("picker.title")}</div>

        <div className="mt-4 text-xs uppercase tracking-wider text-white/40">
          {t("picker.permLabel")}
        </div>
        <div className="mt-1.5 space-y-1">
          {PERMISSION_MODE_KEYS.map((p) => (
            <button
              type="button"
              key={p.value}
              onClick={() => setMode(p.value)}
              className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                mode === p.value
                  ? "border-indigo-400/60 bg-indigo-500/10"
                  : "border-white/5 bg-black/20 hover:border-white/15"
              }`}
            >
              <div className="text-sm text-white">{t(p.labelKey)}</div>
              <div className="mt-0.5 text-xs text-white/40">{t(p.hintKey)}</div>
            </button>
          ))}
        </div>

        <div className="mt-4 text-xs uppercase tracking-wider text-white/40">
          {t("picker.dirLabel")}
        </div>
        <p className="mt-0.5 text-xs text-white/40">{t("picker.dirHint")}</p>
        <div className="mt-2 flex flex-col gap-1">
          {dirs.map((d) => (
            <button
              type="button"
              key={d.path}
              onClick={() => onPick(d, mode)}
              className="rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-left hover:border-indigo-400/60 hover:bg-indigo-500/5"
            >
              <div className="text-sm text-white">{d.name}</div>
              <div className="mt-0.5 truncate font-mono text-xs text-white/40">
                {d.path}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
