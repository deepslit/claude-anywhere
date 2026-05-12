import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useApiKey } from "./store/auth";
import { ApiKeyDialog } from "./components/ApiKeyDialog";
import { MessageBlock } from "./components/MessageBlock";
import { Composer } from "./components/Composer";
import { FileViewer } from "./components/FileViewer";
import { useBodyScrollLock } from "./hooks/useBodyScrollLock";
import { useT } from "./i18n";
import {
  ApiError,
  cancelMessage,
  checkAuth,
  createSession,
  decidePermission,
  getSession,
  listDirs,
  listSessions,
  resumeMessage,
  streamMessage,
  type StreamEnvelope,
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

const INITIAL_WINDOW = 30;
const OLDER_PAGE_SIZE = 30;

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
  // Each in-flight stream (POST or resume) holds an AbortController so we
  // can swap it for a fresh resume when the page returns from background.
  // Aborting only kills the local fetch — it does NOT terminate the
  // server-side turn (that's now an explicit POST /messages/cancel).
  const streamCtrlRef = useRef<AbortController | null>(null);
  // Server-assigned id of the last SSE event we successfully dispatched.
  // The reconnect endpoint replays everything with id > lastEventId.
  const lastEventIdRef = useRef(0);
  // Whether we believe the server still has a turn running for this session.
  // Driven by the stream's done/error events; reset on session change /
  // session resume.
  const turnActiveRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Progressive history loading: render items.slice(firstIdx).
  // - On session change → firstIdx reset to 0
  // - When items first populate (history load) → anchor to the tail
  // - On scroll-up sentinel hit → firstIdx -= OLDER_PAGE_SIZE
  // - On streaming (items.length grows during a turn) → firstIdx unchanged,
  //   so new items appear at the tail and old offscreen items stay hidden.
  const [firstIdx, setFirstIdx] = useState(0);
  const prevItemsLenRef = useRef(0);
  const loadingOlderRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

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
    // Only auto-stick to the bottom while the user is actually reading the
    // latest content. If they scrolled up to read history, we don't want to
    // yank them down on every text_delta — that's why this is gated by
    // `isAtBottom`.
    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [chat.items, isAtBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distFromBottom < 60);
  };

  // Whenever the user switches into a new session, reset the
  // sticky-to-bottom flag so the initial history scrolls into place.
  useEffect(() => {
    setIsAtBottom(true);
    setFirstIdx(0);
    prevItemsLenRef.current = 0;
  }, [currentId]);

  // When the items array first populates for a session (history load),
  // anchor firstIdx so we only render the last INITIAL_WINDOW items.
  // Subsequent grows (streaming) leave firstIdx alone — new items just
  // appear at the tail.
  useEffect(() => {
    if (prevItemsLenRef.current === 0 && chat.items.length > INITIAL_WINDOW) {
      setFirstIdx(chat.items.length - INITIAL_WINDOW);
    }
    prevItemsLenRef.current = chat.items.length;
  }, [chat.items.length]);

  // Scroll preservation when prepending older items: capture pre-render
  // scroll metrics before firstIdx decreases, then adjust scrollTop after
  // the render so the user's viewport stays anchored to the same content.
  useLayoutEffect(() => {
    const pending = loadingOlderRef.current;
    if (!pending) return;
    const el = scrollRef.current;
    if (el) {
      const delta = el.scrollHeight - pending.prevScrollHeight;
      el.scrollTop = pending.prevScrollTop + delta;
    }
    loadingOlderRef.current = null;
  }, [firstIdx]);

  const loadOlder = useCallback(() => {
    if (firstIdx <= 0) return;
    const el = scrollRef.current;
    if (el) {
      loadingOlderRef.current = {
        prevScrollHeight: el.scrollHeight,
        prevScrollTop: el.scrollTop,
      };
    }
    setFirstIdx((idx) => Math.max(0, idx - OLDER_PAGE_SIZE));
  }, [firstIdx]);

  // Wire up an IntersectionObserver on the "load older" sentinel so the
  // user just has to scroll up — no button — to bring in 30 more items.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || firstIdx <= 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlder();
      },
      { root: scrollRef.current, rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [firstIdx, loadOlder]);

  // Drives an async iterable of StreamEnvelopes into the reducer. Returns
  // gracefully on abort (resume will be tried elsewhere) and only flips the
  // "sending" / "turn active" flags off when we see a true terminator
  // (`done` or `error`).
  const consumeStream = useCallback(
    async (gen: AsyncGenerator<StreamEnvelope>) => {
      let terminated = false;
      try {
        for await (const { id, event } of gen) {
          lastEventIdRef.current = id;
          dispatch({ kind: "stream", evt: event });
          if (event.type === "done" || event.type === "error") {
            terminated = true;
          }
        }
      } catch (e) {
        if ((e as DOMException).name !== "AbortError") {
          // 404 on resume usually means "no active turn" — treat as benign,
          // we'll just stop trying.
          if (e instanceof ApiError && e.status === 404) {
            terminated = true;
          } else {
            setErrorMsg(t("err.chat", { msg: (e as Error).message }));
            terminated = true;
          }
        }
      } finally {
        streamCtrlRef.current = null;
        if (terminated) {
          turnActiveRef.current = false;
          setSending(false);
          dispatch({ kind: "expire_pending" });
          refreshSessions();
        }
      }
    },
    [t],
  );

  const openSession = async (id: string, dirName: string) => {
    setCurrentId(id);
    setCurrentDirName(dirName);
    setCurrentMode(null);
    setDrawerOpen(false);
    dispatch({ kind: "reset" });
    // Stop any prior in-flight stream from a previous session.
    streamCtrlRef.current?.abort();
    turnActiveRef.current = false;
    lastEventIdRef.current = 0;
    setSending(false);
    try {
      const detail = await getSession(apiKey, id);
      setCurrentMode(detail.permission_mode ?? null);
      setCurrentDirPath(detail.working_dir);
      dispatch({
        kind: "history",
        events: detail.events as Array<Record<string, unknown>>,
      });
      // If the session has an active (or recently-finished) turn we don't
      // have in our local timeline yet, subscribe to it.
      const at = detail.active_turn;
      if (at && !at.done) {
        turnActiveRef.current = true;
        setSending(true);
        const ctrl = new AbortController();
        streamCtrlRef.current = ctrl;
        // Resume from 0 so we get every event of the in-flight turn. The
        // JSONL we just loaded contains older completed turns; the
        // in-memory log starts fresh at id=1 per turn so there's no overlap.
        consumeStream(resumeMessage(apiKey, id, 0, ctrl.signal));
      }
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

  // Drives an async iterable of StreamEnvelopes into the reducer. Returns
  // gracefully on abort (resume will be tried elsewhere) and only flips the
  // "sending" / "turn active" flags off when we see a true terminator
  // (`done` or `error`).
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
    turnActiveRef.current = true;
    lastEventIdRef.current = 0;
    dispatch({ kind: "user_send", text });

    streamCtrlRef.current?.abort();
    const ctrl = new AbortController();
    streamCtrlRef.current = ctrl;
    await consumeStream(
      streamMessage(
        apiKey,
        currentId,
        text,
        ctrl.signal,
        currentMode ?? undefined,
      ),
    );
  };

  const cancel = useCallback(async () => {
    if (!currentId) return;
    try {
      await cancelMessage(apiKey, currentId);
    } catch {
      // Ignore — the server may have already finished the turn. The
      // outstanding stream will surface a `done` event with stop_reason
      // soon (or already has), which flips sending off.
    }
  }, [apiKey, currentId]);

  // Mobile Safari closes background fetches aggressively. When the user
  // returns to the tab while we still think a turn is in flight, swap the
  // (likely dead) stream for a fresh resume from the last event id we saw.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      if (!turnActiveRef.current || !currentId) return;
      streamCtrlRef.current?.abort();
      const ctrl = new AbortController();
      streamCtrlRef.current = ctrl;
      setSending(true);
      consumeStream(
        resumeMessage(apiKey, currentId, lastEventIdRef.current, ctrl.signal),
      );
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [apiKey, currentId, consumeStream]);

  const onPermissionDecide = useCallback(
    async (
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
    },
    [apiKey, currentId, t],
  );

  const onPermissionInterrupt = useCallback(() => {
    cancel();
  }, [cancel]);

  const onOpenFile = useCallback((p: string) => setViewingFile(p), []);

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

      <main className="flex min-w-0 flex-1 flex-col bg-[#0b0b10]">
        <header
          className="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-sm"
          style={{
            paddingTop: "max(0.5rem, env(safe-area-inset-top))",
            paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
            paddingRight: "max(0.75rem, env(safe-area-inset-right))",
          }}
        >
          <button
            type="button"
            className="-ml-1 inline-flex h-11 w-11 items-center justify-center rounded-md text-lg text-white/70 hover:bg-white/5 md:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开侧边栏"
          >
            ☰
          </button>
          <div className="min-w-0 truncate">
            {currentId ? (
              <span className="text-white/90">
                <span className="text-white/60">{currentDirName ?? ""} · </span>
                <span className="font-mono text-xs">{currentId.slice(0, 8)}</span>
              </span>
            ) : (
              <span className="text-white/60">{t("app.noSession")}</span>
            )}
          </div>
        </header>

        {errorMsg && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {errorMsg}
          </div>
        )}

        <div className="relative flex-1 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="absolute inset-0 overflow-y-auto overscroll-contain px-3 py-4"
            style={{
              paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
              paddingRight: "max(0.75rem, env(safe-area-inset-right))",
            }}
          >
            {!currentId ? (
              <EmptyState onNew={() => setPickerOpen(true)} />
            ) : (
              <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-3">
                {firstIdx > 0 && (
                  <div ref={sentinelRef} className="flex justify-center py-3">
                    <button
                      type="button"
                      onClick={loadOlder}
                      className="inline-flex h-9 items-center rounded-full border border-white/10 bg-white/5 px-3 text-xs text-white/70 hover:bg-white/10"
                    >
                      {t("chat.loadOlder", {
                        count: Math.min(OLDER_PAGE_SIZE, firstIdx),
                        remaining: firstIdx,
                      })}
                    </button>
                  </div>
                )}
                {chat.items.slice(firstIdx).map((it) => (
                  <MessageBlock
                    key={it.id}
                    item={it}
                    onDecide={onPermissionDecide}
                    onInterrupt={onPermissionInterrupt}
                    onOpenFile={onOpenFile}
                  />
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {!isAtBottom && currentId && (
            <button
              type="button"
              aria-label="跳到底部"
              onClick={() => {
                bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                setIsAtBottom(true);
              }}
              className="absolute bottom-3 right-3 inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-[#15151c]/95 text-lg text-white shadow-xl backdrop-blur hover:bg-[#1a1a22]"
              style={{
                bottom: "max(0.75rem, env(safe-area-inset-bottom))",
                right: "max(0.75rem, env(safe-area-inset-right))",
              }}
            >
              ↓
            </button>
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
    <div className="flex h-full items-center justify-center text-center text-white/70">
      <div>
        <div className="text-base">{t("app.empty.title")}</div>
        <button
          type="button"
          className="mt-3 inline-flex h-11 items-center rounded-md bg-indigo-500 px-5 text-sm font-medium text-white hover:bg-indigo-400"
          onClick={onNew}
        >
          {t("app.empty.cta")}
        </button>
        <div className="mt-2 text-sm text-white/55">
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
  const formatTime = (mtimeSec: number) => {
    const d = new Date(mtimeSec * 1000);
    const now = new Date();
    const isSameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const within7d = now.getTime() - d.getTime() < sevenDays;
    const tagLocale = locale === "zh" ? "zh-CN" : "en-US";
    if (isSameDay) {
      return d.toLocaleTimeString(tagLocale, { hour: "2-digit", minute: "2-digit" });
    }
    if (within7d) {
      return d.toLocaleDateString(tagLocale, { weekday: "short" }) +
        " " +
        d.toLocaleTimeString(tagLocale, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(tagLocale, { month: "2-digit", day: "2-digit" });
  };
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
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-3 py-3">
            <div className="text-sm font-semibold text-white">{t("app.brand")}</div>
            <div className="ml-auto" />
            <button
              type="button"
              onClick={() => setLocale(locale === "en" ? "zh" : "en")}
              title={t("sidebar.langTitle")}
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-white/10 px-3 text-sm text-white/70 hover:bg-white/5"
            >
              {t("sidebar.lang")}
            </button>
            <button
              type="button"
              className="inline-flex h-11 items-center justify-center rounded-md bg-indigo-500 px-4 text-sm font-medium text-white hover:bg-indigo-400"
              onClick={onNew}
            >
              {t("sidebar.new")}
            </button>
          </div>
          <div
            className="flex-1 overflow-y-auto overscroll-contain px-2 py-2"
            style={{
              paddingLeft: "max(0.5rem, env(safe-area-inset-left))",
            }}
          >
            {sessions.length === 0 ? (
              <div className="px-2 py-4 text-sm text-white/55">
                {t("sidebar.empty")}
              </div>
            ) : (
              sessions.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => onPick(s)}
                  className={`mb-1 block w-full rounded-md px-3 py-3 text-left text-sm hover:bg-white/5 ${
                    s.id === currentId ? "bg-white/[0.07]" : ""
                  }`}
                >
                  <div className="truncate text-white/90">{s.title}</div>
                  <div className="mt-0.5 truncate text-xs text-white/55">
                    {s.dir_name} · {formatTime(s.mtime)}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-white/5 px-2 py-2 text-white/60">
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex h-11 items-center rounded-md px-3 text-sm hover:bg-white/5 hover:text-white/85"
            >
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
  useBodyScrollLock();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15151c] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          <div className="text-base font-semibold text-white">{t("picker.title")}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("file.close")}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-lg text-white/70 hover:bg-white/5"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="text-xs uppercase tracking-wider text-white/60">
            {t("picker.permLabel")}
          </div>
          <div className="mt-1.5 space-y-1">
            {PERMISSION_MODE_KEYS.map((p) => (
              <button
                type="button"
                key={p.value}
                onClick={() => setMode(p.value)}
                className={`block w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  mode === p.value
                    ? "border-indigo-400/60 bg-indigo-500/10"
                    : "border-white/5 bg-black/20 hover:border-white/15"
                }`}
              >
                <div className="text-sm text-white">{t(p.labelKey)}</div>
                <div className="mt-0.5 text-xs text-white/60">{t(p.hintKey)}</div>
              </button>
            ))}
          </div>

          <div className="mt-4 text-xs uppercase tracking-wider text-white/60">
            {t("picker.dirLabel")}
          </div>
          <p className="mt-0.5 text-sm text-white/55">{t("picker.dirHint")}</p>
          <div className="mt-2 flex flex-col gap-1">
            {dirs.map((d) => (
              <button
                type="button"
                key={d.path}
                onClick={() => onPick(d, mode)}
                className="rounded-lg border border-white/5 bg-black/20 px-3 py-2.5 text-left hover:border-indigo-400/60 hover:bg-indigo-500/5"
              >
                <div className="text-sm text-white">{d.name}</div>
                <div className="mt-0.5 truncate font-mono text-xs text-white/55">
                  {d.path}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
