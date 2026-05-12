import { useEffect, useRef, useState } from "react";
import {
  fetchSlashCompletions,
  fetchFileCompletions,
} from "../api/client";
import type {
  FileCompletionItem,
  SlashCompletionItem,
} from "../api/types";
import { useT } from "../i18n";

type Mode = "slash" | "file" | null;

interface TriggerState {
  mode: Mode;
  query: string;
  // Range in the textarea value that the trigger covers (start..end exclusive),
  // so we can replace it on accept.
  start: number;
  end: number;
}

interface Props {
  apiKey: string;
  sessionId: string | null;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  disabled: boolean;
  sending: boolean;
  mode: string;
  onModeChange: (m: string) => void;
}

export function Composer({
  apiKey,
  sessionId,
  value,
  onChange,
  onSend,
  onCancel,
  disabled,
  sending,
  mode,
  onModeChange,
}: Props) {
  const { t } = useT();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [items, setItems] = useState<
    (SlashCompletionItem | FileCompletionItem)[]
  >([]);
  const [active, setActive] = useState(0);
  const debounceRef = useRef<number | null>(null);

  // Detect trigger from current cursor position whenever value changes.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const cur = ta.selectionStart ?? value.length;
    setTrigger(detectTrigger(value, cur));
  }, [value]);

  // Fetch suggestions when trigger changes (debounced).
  useEffect(() => {
    if (!trigger || !sessionId) {
      setItems([]);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      try {
        if (trigger.mode === "slash") {
          const r = await fetchSlashCompletions(
            apiKey,
            sessionId,
            trigger.query,
          );
          setItems(r.items);
        } else if (trigger.mode === "file") {
          const r = await fetchFileCompletions(apiKey, sessionId, trigger.query);
          setItems(r.items);
        }
      } catch {
        setItems([]);
      }
      setActive(0);
    }, 120);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [trigger, sessionId, apiKey]);

  const accept = (idx: number = active) => {
    if (!trigger || items.length === 0) return;
    const it = items[idx];
    if (!it) return;
    const insert =
      "kind" in it
        ? `/${it.name} `
        : `@${it.path} `;
    const before = value.slice(0, trigger.start);
    const after = value.slice(trigger.end);
    const next = before + insert + after;
    onChange(next);
    setTrigger(null);
    setItems([]);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        const pos = (before + insert).length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;

    if (trigger && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTrigger(null);
        setItems([]);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div
      className="relative border-t border-white/5 bg-[#0d0d14] px-3 py-2"
      style={{
        paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
        paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
        paddingRight: "max(0.75rem, env(safe-area-inset-right))",
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        <textarea
          ref={taRef}
          value={value}
          rows={1}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          placeholder={
            disabled
              ? t("composer.disabled")
              : t("composer.placeholder")
          }
          disabled={disabled}
          className="max-h-40 min-h-[2.4rem] w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-base text-white placeholder-white/50 outline-none focus:border-indigo-400 disabled:opacity-50"
        />
        <div className="flex items-center gap-2">
          <ModeChip mode={mode} onChange={onModeChange} disabled={disabled} />
          {sending ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-11 shrink-0 items-center rounded-xl bg-red-500/80 px-4 text-sm font-medium text-white hover:bg-red-500"
            >
              {t("composer.stop")}
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || !value.trim()}
              className="inline-flex h-11 shrink-0 items-center rounded-xl bg-indigo-500 px-5 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-40"
            >
              {t("composer.send")}
            </button>
          )}
        </div>
      </div>

      {trigger && items.length > 0 && (
        <SuggestionPopover
          mode={trigger.mode!}
          items={items}
          active={active}
          onPick={accept}
          onHover={setActive}
        />
      )}
    </div>
  );
}

function SuggestionPopover({
  mode,
  items,
  active,
  onPick,
  onHover,
}: {
  mode: "slash" | "file";
  items: (SlashCompletionItem | FileCompletionItem)[];
  active: number;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
}) {
  const { t } = useT();
  return (
    <div className="pointer-events-none absolute left-0 right-0 bottom-full px-3">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl">
        <div className="mb-1 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-[#15151c] py-1 shadow-2xl">
          {items.map((it, i) => {
            const isSlash = "kind" in it;
            return (
              <button
                key={isSlash ? `${it.kind}:${it.name}` : it.path}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(i);
                }}
                onMouseEnter={() => onHover(i)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  i === active ? "bg-white/10" : "hover:bg-white/[0.04]"
                }`}
              >
                {isSlash ? (
                  <>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${
                        it.kind === "skill"
                          ? "bg-purple-500/20 text-purple-200"
                          : "bg-indigo-500/20 text-indigo-200"
                      }`}
                    >
                      {it.kind}
                    </span>
                    <span className="font-mono text-white">/{it.name}</span>
                  </>
                ) : (
                  <span className="truncate font-mono text-white">
                    {it.path}
                  </span>
                )}
              </button>
            );
          })}
          <div className="px-3 pt-1 text-[11px] text-white/55">
            {mode === "slash" ? t("composer.suggestSlash") : t("composer.suggestFile")}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Look backwards from the cursor for a trigger character (`/` or `@`) that
 * is either at the start of the textarea or preceded by whitespace.
 * Returns the trigger spec or null.
 */
export function detectTrigger(text: string, cursor: number): TriggerState | null {
  let i = cursor;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === "/" || ch === "@") {
      const before = i >= 2 ? text[i - 2] : "";
      if (i === 1 || /\s/.test(before)) {
        const query = text.slice(i, cursor);
        if (/[\s\n]/.test(query)) return null;
        return {
          mode: ch === "/" ? "slash" : "file",
          query,
          start: i - 1,
          end: cursor,
        };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

const MODE_VALUES: string[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

function ModeChip({
  mode,
  onChange,
  disabled,
}: {
  mode: string;
  onChange: (m: string) => void;
  disabled: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const colourFor = (m: string) => {
    switch (m) {
      case "acceptEdits":
        return "border-blue-500/40 text-blue-200 hover:bg-blue-500/10";
      case "bypassPermissions":
        return "border-amber-500/50 text-amber-200 hover:bg-amber-500/10";
      case "plan":
        return "border-purple-500/40 text-purple-200 hover:bg-purple-500/10";
      default:
        return "border-white/15 text-white/70 hover:bg-white/5";
    }
  };

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        disabled={disabled}
        title={t("composer.modeTitle")}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-11 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-3 text-sm transition-colors disabled:opacity-40 ${colourFor(
          mode,
        )}`}
      >
        <span className="min-w-0 truncate">{t(`mode.${mode}`)}</span>
        <span className="shrink-0 text-xs opacity-70">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[12rem] rounded-lg border border-white/10 bg-[#15151c] py-1 shadow-2xl">
          {MODE_VALUES.map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
              className={`flex min-h-[44px] w-full items-center px-3 text-left text-sm hover:bg-white/5 ${
                m === mode ? "text-white" : "text-white/70"
              }`}
            >
              <span className="mr-2 inline-block w-3 text-center">
                {m === mode ? "•" : ""}
              </span>
              {t(`mode.${m}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
