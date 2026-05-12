import { memo, useMemo, useState } from "react";
import { diffLines, type Change } from "diff";
import type { TimelineItem } from "../api/types";
import { Markdown } from "./Markdown";
import { useT } from "../i18n";

interface Props {
  item: TimelineItem;
  onDecide?: (
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    reason?: string,
    setMode?: string,
  ) => void;
  onInterrupt?: () => void;
  onOpenFile?: (path: string) => void;
}

export const MessageBlock = memo(function MessageBlock({
  item,
  onDecide,
  onInterrupt,
  onOpenFile,
}: Props) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} />;
    case "assistant_text":
      return <AssistantText text={item.text} onOpenFile={onOpenFile} />;
    case "assistant_thinking":
      return <Thinking text={item.text} done={item.done} onOpenFile={onOpenFile} />;
    case "tool_use":
      return <ToolUseCard item={item} onOpenFile={onOpenFile} />;
    case "tool_result":
      return <ToolResultCard item={item} />;
    case "permission_request":
      if (item.toolName === "AskUserQuestion") {
        return (
          <AskQuestionCard
            item={item}
            onDecide={onDecide}
            onInterrupt={onInterrupt}
          />
        );
      }
      return (
        <PermissionCard
          item={item}
          onDecide={onDecide}
          onInterrupt={onInterrupt}
        />
      );
    case "summary":
      return <SummaryRow item={item} />;
    default:
      return null;
  }
});

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-indigo-500/90 px-4 py-2 text-white whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function AssistantText({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
}) {
  if (!text) return null;
  return (
    <div className="text-white/95">
      <Markdown source={text} onOpenFile={onOpenFile} />
    </div>
  );
}

function Thinking({
  text,
  done,
  onOpenFile,
}: {
  text: string;
  done?: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-white/55"
    >
      <summary className="cursor-pointer select-none text-white/60">
        {done ? t("block.thinkingDone") : t("block.thinkingActive")}
      </summary>
      <div className="prose-cc mt-2 text-white/60">
        <Markdown source={text} onOpenFile={onOpenFile} />
      </div>
    </details>
  );
}

function ToolUseCard({
  item,
  onOpenFile,
}: {
  item: Extract<TimelineItem, { kind: "tool_use" }>;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useT();
  const inputObj = (item.input as Record<string, unknown>) ?? null;
  const filePath =
    inputObj && typeof inputObj.file_path === "string"
      ? (inputObj.file_path as string)
      : null;

  // TodoWrite gets its own visual: don't dump JSON, render the checklist.
  if (item.name === "TodoWrite") {
    return <TodoListCard item={item} />;
  }

  // Edit / MultiEdit: render before/after diff instead of raw JSON.
  if (
    (item.name === "Edit" || item.name === "MultiEdit") &&
    item.input != null
  ) {
    return <EditDiffCard item={item} onOpenFile={onOpenFile} />;
  }

  const inputText = item.input != null
    ? JSON.stringify(item.input, null, 2)
    : item.partial ?? "…";
  return (
    <div className="min-w-0 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-amber-300">
        <span className="text-xs uppercase tracking-wider">{t("block.toolBadge")}</span>
        <span className="font-mono">{item.name}</span>
        {!item.done && (
          <span className="text-amber-400/70 text-xs">{t("block.toolStreaming")}</span>
        )}
        {filePath && onOpenFile && (
          <button
            type="button"
            onClick={() => onOpenFile(filePath)}
            className="ml-auto min-w-0 truncate font-mono text-sm text-amber-200 underline hover:text-amber-100"
            title={filePath}
          >
            {filePath.length > 50 ? "…" + filePath.slice(-48) : filePath}
          </button>
        )}
      </div>
      <pre className="mt-1 overflow-x-auto text-xs text-amber-100/80">
        {inputText}
      </pre>
    </div>
  );
}

interface TodoEntry {
  content: string;
  activeForm?: string;
  status: "completed" | "in_progress" | "pending";
}

function parseTodos(input: unknown): TodoEntry[] {
  if (!input || typeof input !== "object") return [];
  const arr = (input as Record<string, unknown>).todos;
  if (!Array.isArray(arr)) return [];
  const out: TodoEntry[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.content !== "string") continue;
    const status = r.status;
    if (
      status !== "completed" &&
      status !== "in_progress" &&
      status !== "pending"
    )
      continue;
    out.push({
      content: r.content,
      activeForm: typeof r.activeForm === "string" ? r.activeForm : undefined,
      status,
    });
  }
  return out;
}

function TodoListCard({
  item,
}: {
  item: Extract<TimelineItem, { kind: "tool_use" }>;
}) {
  const { t } = useT();
  const todos = parseTodos(item.input);
  if (todos.length === 0) {
    // Either still streaming or empty input — show a minimal placeholder
    // so the card is recognisable but not noisy.
    return (
      <div className="text-xs text-white/60 italic">
        {t("todo.empty")}
      </div>
    );
  }
  const counts = todos.reduce(
    (acc, t_) => {
      acc[t_.status] += 1;
      return acc;
    },
    { completed: 0, in_progress: 0, pending: 0 } as Record<
      TodoEntry["status"],
      number
    >,
  );
  return (
    <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 px-3 py-2">
      <div className="flex items-center gap-2 text-indigo-200">
        <span className="text-xs uppercase tracking-wider">{t("todo.title")}</span>
        <span className="text-[11px] text-indigo-300/70">
          {counts.completed}/{todos.length} {t("todo.done")}
        </span>
      </div>
      <ul className="mt-1.5 space-y-0.5 text-sm">
        {todos.map((td, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className={
                td.status === "completed"
                  ? "mt-0.5 shrink-0 text-emerald-400"
                  : td.status === "in_progress"
                    ? "mt-0.5 shrink-0 text-amber-300"
                    : "mt-0.5 shrink-0 text-white/55"
              }
            >
              {td.status === "completed"
                ? "✓"
                : td.status === "in_progress"
                  ? "▶"
                  : "○"}
            </span>
            <span
              className={
                td.status === "completed"
                  ? "text-white/45 line-through decoration-white/20"
                  : td.status === "in_progress"
                    ? "text-white"
                    : "text-white/70"
              }
            >
              {td.status === "in_progress" && td.activeForm
                ? td.activeForm
                : td.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolResultCard({
  item,
}: {
  item: Extract<TimelineItem, { kind: "tool_result" }>;
}) {
  const { t } = useT();
  const content = useMemo(
    () =>
      typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .map((c) =>
                typeof c === "string"
                  ? c
                  : (c as { text?: string }).text ?? JSON.stringify(c),
              )
              .join("\n")
          : JSON.stringify(item.content, null, 2),
    [item.content],
  );

  // TodoWrite's success result is a verbose system reminder. The list itself
  // is already rendered upstream by TodoListCard — suppress the result.
  if (
    !item.isError &&
    typeof content === "string" &&
    content.startsWith("Todos have been modified successfully")
  ) {
    return null;
  }

  // Tool results that came from one of our own UI decisions (deny+reason)
  // arrive with `is_error: true` because that's the only path PreToolUse
  // hooks have. Detect them via well-known prefixes set by formatRejectionReason
  // / formatAnswers and render them as user-feedback rows, not as red errors.
  const variant: "answers" | "plan-approved" | "plan-feedback" | "decline" | "error" =
    !item.isError
      ? "error" // fall through to normal-result styling below
      : typeof content !== "string"
        ? "error"
        : content.startsWith("User answered the questions")
          ? "answers"
          : content.startsWith("The user has approved the plan")
            ? "plan-approved"
            : content.startsWith("The user declined the plan") ||
                content.startsWith("The user wants to keep planning")
              ? "plan-feedback"
              : content.startsWith("The user declined this tool call")
                ? "decline"
                : "error";

  const { cls, label } = (() => {
    if (!item.isError) {
      return {
        cls: "border-emerald-500/20 bg-emerald-500/5 text-emerald-100/90",
        label: t("block.toolResult"),
      };
    }
    if (variant === "answers")
      return {
        cls: "border-emerald-500/20 bg-emerald-500/5 text-emerald-100/90",
        label: t("block.toolResult"),
      };
    if (variant === "plan-approved")
      return {
        cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
        label: t("block.planApproved"),
      };
    if (variant === "plan-feedback")
      return {
        cls: "border-sky-500/30 bg-sky-500/5 text-sky-100",
        label: t("block.userFeedback"),
      };
    if (variant === "decline")
      return {
        cls: "border-amber-500/30 bg-amber-500/5 text-amber-100",
        label: t("block.userFeedback"),
      };
    return {
      cls: "border-red-500/30 bg-red-500/5 text-red-200",
      label: t("block.toolError"),
    };
  })();

  // User-facing variants (answers / plan-approved / plan-feedback / decline)
  // always render in full — they're the actual conversation, not tool noise.
  // Plain success results and real errors collapse by default; tap the header
  // to expand. This keeps long sessions tractable on mobile.
  const alwaysExpand =
    variant === "answers" ||
    variant === "plan-approved" ||
    variant === "plan-feedback" ||
    variant === "decline";
  const [expanded, setExpanded] = useState(alwaysExpand);
  const preview = useMemo(() => buildPreview(content), [content]);
  const isCollapsible = !alwaysExpand;

  return (
    <div className={`min-w-0 rounded-lg border ${cls} px-3 py-2 text-sm`}>
      <button
        type="button"
        onClick={isCollapsible ? () => setExpanded((v) => !v) : undefined}
        disabled={!isCollapsible}
        className={`flex w-full items-center gap-2 text-left ${
          isCollapsible ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="text-xs uppercase tracking-wider opacity-70">{label}</span>
        {isCollapsible && !expanded && preview && (
          <span className="min-w-0 flex-1 truncate text-xs opacity-70">
            {preview}
          </span>
        )}
        {isCollapsible && (
          <span className="ml-auto text-xs opacity-60">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-96 overflow-auto overscroll-contain whitespace-pre-wrap break-words text-sm">
          {content}
        </pre>
      )}
    </div>
  );
}

function buildPreview(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= 80) return flat;
  return flat.slice(0, 80) + "…";
}

// Edit / MultiEdit get a unified diff render: each (old_string, new_string)
// pair is fed to diffLines() and printed with -/+/space prefixes plus a
// truncated context window so big files don't drown the chat.
interface EditEntry {
  old: string;
  next: string;
}

function parseEditEntries(input: unknown): EditEntry[] {
  if (!input || typeof input !== "object") return [];
  const r = input as Record<string, unknown>;
  // Single-edit Edit tool
  if (typeof r.old_string === "string" && typeof r.new_string === "string") {
    return [{ old: r.old_string, next: r.new_string }];
  }
  // MultiEdit
  const edits = r.edits;
  if (Array.isArray(edits)) {
    const out: EditEntry[] = [];
    for (const e of edits) {
      if (!e || typeof e !== "object") continue;
      const ee = e as Record<string, unknown>;
      if (typeof ee.old_string === "string" && typeof ee.new_string === "string") {
        out.push({ old: ee.old_string, next: ee.new_string });
      }
    }
    return out;
  }
  return [];
}

function EditDiffCard({
  item,
  onOpenFile,
}: {
  item: Extract<TimelineItem, { kind: "tool_use" }>;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useT();
  const inputObj = (item.input as Record<string, unknown>) ?? null;
  const filePath =
    inputObj && typeof inputObj.file_path === "string"
      ? (inputObj.file_path as string)
      : null;
  const entries = useMemo(() => parseEditEntries(item.input), [item.input]);
  const total = useMemo(
    () =>
      entries.reduce(
        (acc, e) => {
          const ch = diffLines(e.old, e.next);
          ch.forEach((c) => {
            const lines = countLines(c.value);
            if (c.added) acc.add += lines;
            else if (c.removed) acc.del += lines;
          });
          return acc;
        },
        { add: 0, del: 0 },
      ),
    [entries],
  );

  return (
    <div className="min-w-0 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-amber-300">
        <span className="text-xs uppercase tracking-wider">{item.name}</span>
        {!item.done && (
          <span className="text-amber-400/70 text-xs">{t("block.toolStreaming")}</span>
        )}
        <span className="text-[11px] text-emerald-300">+{total.add}</span>
        <span className="text-[11px] text-red-300">−{total.del}</span>
        {filePath && (
          <button
            type="button"
            onClick={() => onOpenFile?.(filePath)}
            className="ml-auto min-w-0 truncate font-mono text-sm text-amber-200 underline hover:text-amber-100"
            title={filePath}
            disabled={!onOpenFile}
          >
            {filePath.length > 50 ? "…" + filePath.slice(-48) : filePath}
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <pre className="mt-1 overflow-x-auto text-xs text-amber-100/80">
          {item.input != null ? JSON.stringify(item.input, null, 2) : item.partial ?? "…"}
        </pre>
      ) : (
        <div className="mt-2 space-y-2">
          {entries.map((e, i) => (
            <DiffBlock key={i} oldText={e.old} newText={e.next} index={i} total={entries.length} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiffBlock({
  oldText,
  newText,
  index,
  total,
}: {
  oldText: string;
  newText: string;
  index: number;
  total: number;
}) {
  const changes = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <div className="overflow-hidden rounded-md border border-white/5 bg-black/30">
      {total > 1 && (
        <div className="border-b border-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
          edit {index + 1}/{total}
        </div>
      )}
      <pre className="m-0 overflow-x-auto px-2 py-1 text-[12px] leading-snug">
        {changes.map((c, ci) => (
          <DiffChunk key={ci} change={c} />
        ))}
      </pre>
    </div>
  );
}

function DiffChunk({ change }: { change: Change }) {
  // For unchanged context blocks larger than a few lines we collapse the
  // middle so big files don't dominate the chat.
  const lines = change.value.split("\n");
  // diffLines tends to leave a trailing empty after a final newline; drop it.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  if (!change.added && !change.removed) {
    if (lines.length > 6) {
      const head = lines.slice(0, 2);
      const tail = lines.slice(-2);
      return (
        <>
          {head.map((l, i) => (
            <DiffLine key={`h${i}`} kind="ctx" text={l} />
          ))}
          <div className="text-[11px] text-white/55 italic px-3">
            … {lines.length - 4} unchanged lines …
          </div>
          {tail.map((l, i) => (
            <DiffLine key={`t${i}`} kind="ctx" text={l} />
          ))}
        </>
      );
    }
    return (
      <>
        {lines.map((l, i) => (
          <DiffLine key={i} kind="ctx" text={l} />
        ))}
      </>
    );
  }

  const kind: "add" | "del" = change.added ? "add" : "del";
  return (
    <>
      {lines.map((l, i) => (
        <DiffLine key={i} kind={kind} text={l} />
      ))}
    </>
  );
}

function DiffLine({
  kind,
  text,
}: {
  kind: "add" | "del" | "ctx";
  text: string;
}) {
  const cls =
    kind === "add"
      ? "bg-emerald-500/10 text-emerald-200"
      : kind === "del"
        ? "bg-red-500/10 text-red-200"
        : "text-white/55";
  const sigil = kind === "add" ? "+" : kind === "del" ? "−" : " ";
  return (
    <div className={`whitespace-pre-wrap break-words px-1 ${cls}`}>
      <span className="select-none mr-2 opacity-70">{sigil}</span>
      <span>{text || " "}</span>
    </div>
  );
}

function countLines(s: string): number {
  if (!s) return 0;
  // diff library segments are line-aligned; count newlines, but a non-newline-
  // terminated trailing chunk still counts as one line.
  const n = (s.match(/\n/g) ?? []).length;
  return s.endsWith("\n") ? n : n + 1;
}

// AskUserQuestion is special: it's a tool that needs answers, not just
// allow/deny. We render the questions with selectable options, and on submit
// pack the user's choices into a structured "deny + reason" payload that the
// model picks up as if it were the tool's result.
interface QuestionDef {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function AskQuestionCard({
  item,
  onDecide,
  onInterrupt,
}: {
  item: Extract<TimelineItem, { kind: "permission_request" }>;
  onDecide?: (
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    reason?: string,
  ) => void;
  onInterrupt?: () => void;
}) {
  const { t } = useT();
  const questions = parseQuestions(item.toolInput);
  // selections[i] holds the chosen labels for question i. multiSelect uses an
  // array; single-select uses a singleton array.
  const [selections, setSelections] = useState<string[][]>(
    () => questions.map(() => []),
  );
  // otherText[i] holds the text typed when "Other" is chosen.
  const [otherText, setOtherText] = useState<string[]>(
    () => questions.map(() => ""),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const submitting = item.status === "submitting";
  const decided =
    item.status === "allow" ||
    item.status === "allow_always" ||
    item.status === "deny";
  const cancelled = item.status === "cancelled";

  const toggleSelection = (qi: number, label: string) => {
    setValidationError(null);
    setSelections((prev) => {
      const next = prev.map((s) => [...s]);
      const q = questions[qi];
      if (q.multiSelect) {
        const idx = next[qi].indexOf(label);
        if (idx >= 0) next[qi].splice(idx, 1);
        else next[qi].push(label);
      } else {
        next[qi] = [label];
      }
      return next;
    });
  };

  const setOther = (qi: number, val: string) => {
    setValidationError(null);
    setOtherText((prev) => {
      const next = [...prev];
      next[qi] = val;
      return next;
    });
  };

  const isOtherSelected = (qi: number) =>
    selections[qi]?.includes("__other__");

  const submit = () => {
    // Validate each question is answered.
    for (let qi = 0; qi < questions.length; qi++) {
      const sel = selections[qi] ?? [];
      if (sel.length === 0) {
        setValidationError(t("ask.allRequired"));
        return;
      }
      if (sel.includes("__other__") && !otherText[qi].trim()) {
        setValidationError(t("ask.allRequired"));
        return;
      }
    }
    const formatted = formatAnswers(questions, selections, otherText);
    onDecide?.(item.requestId, "deny", formatted);
  };

  return (
    <div className="rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2">
      <div className="flex items-center gap-2 text-sky-200">
        <span className="text-xs uppercase tracking-wider">
          {t("ask.title")}
        </span>
        {submitting && (
          <span className="ml-auto text-xs text-sky-300">
            {t("ask.submitting")}
          </span>
        )}
        {decided && !submitting && (
          <span className="ml-auto text-xs text-emerald-300">✓</span>
        )}
        {cancelled && (
          <span className="ml-auto text-xs text-white/60">
            {t("ask.cancelled")}
          </span>
        )}
      </div>

      <div className="mt-2 space-y-3">
        {questions.map((q, qi) => (
          <div key={qi} className="rounded-md bg-black/20 p-2.5">
            {q.header && (
              <div className="text-[10px] uppercase tracking-wider text-sky-300/70">
                {q.header}
              </div>
            )}
            <div className="text-sm text-white">{q.question}</div>
            <div className="mt-2 space-y-1">
              {q.options.map((opt) => (
                <label
                  key={opt.label}
                  className={`flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded p-2.5 hover:bg-white/[0.03] ${
                    selections[qi]?.includes(opt.label) ? "bg-white/[0.05]" : ""
                  } ${decided || cancelled || submitting ? "pointer-events-none opacity-60" : ""}`}
                >
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`q-${item.requestId}-${qi}`}
                    checked={selections[qi]?.includes(opt.label) || false}
                    onChange={() => toggleSelection(qi, opt.label)}
                    className="mt-1 h-4 w-4 shrink-0 accent-sky-500"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white">{opt.label}</div>
                    {opt.description && (
                      <div className="text-xs text-white/55">
                        {opt.description}
                      </div>
                    )}
                  </div>
                </label>
              ))}
              <label
                className={`flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded p-2.5 hover:bg-white/[0.03] ${
                  isOtherSelected(qi) ? "bg-white/[0.05]" : ""
                } ${decided || cancelled || submitting ? "pointer-events-none opacity-60" : ""}`}
              >
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`q-${item.requestId}-${qi}`}
                  checked={isOtherSelected(qi) || false}
                  onChange={() => toggleSelection(qi, "__other__")}
                  className="mt-1 h-4 w-4 shrink-0 accent-sky-500"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white/80">
                    {t("ask.optionOther")}
                  </div>
                  {isOtherSelected(qi) && (
                    <input
                      type="text"
                      value={otherText[qi]}
                      onChange={(e) => setOther(qi, e.target.value)}
                      placeholder={t("ask.otherPlaceholder")}
                      className="mt-1 w-full rounded border border-white/10 bg-black/30 px-2 py-2 text-base text-white placeholder-white/50 outline-none focus:border-sky-400"
                    />
                  )}
                </div>
              </label>
            </div>
          </div>
        ))}
      </div>

      {validationError && (
        <div className="mt-2 text-xs text-red-300">{validationError}</div>
      )}

      {!decided && !submitting && !cancelled && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-sky-500 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white hover:bg-sky-400"
          >
            {t("ask.submit")}
          </button>
          <button
            type="button"
            onClick={() => onInterrupt?.()}
            className="rounded-md border border-white/20 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white/70 hover:bg-white/5"
            title={t("perm.btnInterruptTitle")}
          >
            {t("perm.btnInterrupt")}
          </button>
        </div>
      )}
    </div>
  );
}

function parseQuestions(input: unknown): QuestionDef[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const arr = obj.questions;
  if (!Array.isArray(arr)) return [];
  const result: QuestionDef[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const opts = r.options;
    if (!Array.isArray(opts)) continue;
    const options: QuestionDef["options"] = [];
    for (const o of opts) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== "string") continue;
      options.push({
        label: oo.label,
        description:
          typeof oo.description === "string" ? oo.description : undefined,
      });
    }
    if (typeof r.question !== "string") continue;
    result.push({
      question: r.question,
      header: typeof r.header === "string" ? r.header : undefined,
      options,
      multiSelect: r.multiSelect === true,
    });
  }
  return result;
}

/**
 * Format the user's selections into a string the model can read. We include
 * an explicit marker so the model treats the deny reason as the answers
 * rather than as a permission failure.
 */
function formatAnswers(
  questions: QuestionDef[],
  selections: string[][],
  otherText: string[],
): string {
  const lines: string[] = [
    "User answered the questions (treat this as the AskUserQuestion result):",
  ];
  questions.forEach((q, qi) => {
    const chosen = (selections[qi] ?? []).map((label) =>
      label === "__other__" ? `Other: ${otherText[qi].trim()}` : label,
    );
    const formatted = chosen.length > 1 ? chosen.join("; ") : chosen[0] ?? "";
    lines.push(`- ${q.header ? `[${q.header}] ` : ""}${q.question}`);
    lines.push(`  → ${formatted}`);
  });
  return lines.join("\n");
}

/**
 * Wrap a user's rejection text into a clear directive that the model can
 * read as feedback (rather than a system error). For ExitPlanMode the text
 * also explicitly steers Claude back into the plan-mode loop so it doesn't
 * give up on planning after a single round of feedback.
 *
 * The leading sentences also act as machine-readable markers — ToolResultCard
 * matches their prefix to render the result as user feedback (not a red
 * tool error).
 */
function formatRejectionReason(
  toolName: string,
  rawText: string,
): string {
  const text = rawText.trim();
  if (toolName === "ExitPlanMode") {
    if (text) {
      return (
        "The user declined the plan and wants revisions. " +
        "Please update the plan markdown file with the changes below, " +
        "then call ExitPlanMode again to present the revised plan." +
        "\n\nUser feedback: " +
        text
      );
    }
    return (
      "The user wants to keep planning. Please refine the plan markdown " +
      "file and call ExitPlanMode again with the updated version."
    );
  }
  if (text) {
    return "The user declined this tool call.\n\nUser feedback: " + text;
  }
  return "The user declined this tool call without further feedback.";
}

function PermissionCard({
  item,
  onDecide,
  onInterrupt,
}: {
  item: Extract<TimelineItem, { kind: "permission_request" }>;
  onDecide?: (
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    reason?: string,
    setMode?: string,
  ) => void;
  onInterrupt?: () => void;
}) {
  const { t } = useT();
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectText, setRejectText] = useState("");

  // Special-case: ExitPlanMode carries the plan markdown in tool_input.plan;
  // render it as markdown and use plan-friendly button labels.
  const isPlan = item.toolName === "ExitPlanMode";
  const inputObj =
    item.toolInput && typeof item.toolInput === "object"
      ? (item.toolInput as Record<string, unknown>)
      : null;
  const planMarkdown =
    isPlan && inputObj && typeof inputObj.plan === "string"
      ? (inputObj.plan as string)
      : null;

  const inputText =
    item.toolInput == null ? "" : JSON.stringify(item.toolInput, null, 2);
  const decided =
    item.status === "allow" ||
    item.status === "allow_always" ||
    item.status === "deny";
  const cancelled = item.status === "cancelled";
  const submitting = item.status === "submitting";

  const ringCls =
    item.status === "allow" || item.status === "allow_always"
      ? "ring-1 ring-emerald-500/50"
      : item.status === "deny"
        ? "ring-1 ring-red-500/50"
        : cancelled
          ? "ring-1 ring-white/20 opacity-70"
          : "";

  const statusLabel = (() => {
    if (item.status === "allow") return t("perm.allowedOnce");
    if (item.status === "allow_always")
      return t("perm.allowedAlways", { tool: item.toolName });
    if (item.status === "deny") return t("perm.denied");
    if (cancelled) return t("ask.cancelled");
    if (submitting) return t("perm.submitting");
    return null;
  })();

  const headerLabel = isPlan ? t("plan.title") : t("perm.title");
  const allowLabel = isPlan ? t("plan.allow") : t("perm.btnAllow");
  const denyLabel = isPlan ? t("plan.deny") : t("perm.btnReject");

  return (
    <div
      className={`rounded-lg border border-orange-500/40 bg-orange-500/5 px-3 py-2 ${ringCls}`}
    >
      <div className="flex items-center gap-2 text-orange-200">
        <span className="text-xs uppercase tracking-wider">{headerLabel}</span>
        {!isPlan && <span className="font-mono text-sm">{item.toolName}</span>}
        {statusLabel && (
          <span className="ml-auto text-xs text-white/60">{statusLabel}</span>
        )}
      </div>

      {planMarkdown ? (
        <div className="mt-2 max-h-96 overflow-auto rounded border border-white/5 bg-black/20 p-3">
          <Markdown source={planMarkdown} />
        </div>
      ) : (
        inputText && (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-orange-100/80">
            {inputText}
          </pre>
        )
      )}

      {item.reason && decided && (
        <div className="mt-1 text-xs text-white/60 italic">
          {t("perm.reasonPrefix")}{item.reason}
        </div>
      )}

      {!decided && !submitting && !cancelled && !rejectMode && (
        <div className="mt-2 flex flex-wrap gap-2">
          {isPlan ? (
            <>
              <button
                type="button"
                onClick={() =>
                  onDecide?.(
                    item.requestId,
                    "deny",
                    "The user has approved the plan and chose to auto-accept future edits. " +
                      "You may now exit plan mode and proceed with implementing the plan as described.",
                    "acceptEdits",
                  )
                }
                className="rounded-md bg-emerald-500 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white hover:bg-emerald-400"
                title={t("plan.approveAutoTitle")}
              >
                {t("plan.approveAuto")}
              </button>
              <button
                type="button"
                onClick={() =>
                  onDecide?.(
                    item.requestId,
                    "deny",
                    "The user has approved the plan. You may now exit plan mode " +
                      "and proceed with implementing the plan as described. " +
                      "Individual edits will still be reviewed by the user.",
                  )
                }
                className="rounded-md bg-emerald-500/30 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-emerald-100 hover:bg-emerald-500/50"
                title={t("plan.approveManualTitle")}
              >
                {t("plan.approveManual")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onDecide?.(item.requestId, "allow")}
                className="rounded-md bg-emerald-500 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white hover:bg-emerald-400"
              >
                {allowLabel}
              </button>
              <button
                type="button"
                onClick={() => onDecide?.(item.requestId, "allow_always")}
                className="rounded-md bg-emerald-500/30 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-emerald-100 hover:bg-emerald-500/50"
                title={t("perm.btnAllowAlwaysTitle", { tool: item.toolName })}
              >
                {t("perm.btnAllowAlways", { tool: item.toolName })}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setRejectMode(true)}
            className="rounded-md bg-red-500/80 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white hover:bg-red-500"
          >
            {denyLabel}
          </button>
          <button
            type="button"
            onClick={() => onInterrupt?.()}
            className="rounded-md border border-white/20 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white/70 hover:bg-white/5"
            title={t("perm.btnInterruptTitle")}
          >
            {t("perm.btnInterrupt")}
          </button>
        </div>
      )}

      {!decided && !submitting && !cancelled && rejectMode && (
        <div className="mt-2 space-y-2">
          <textarea
            autoFocus
            value={rejectText}
            onChange={(e) => setRejectText(e.target.value)}
            rows={2}
            placeholder={t("perm.rejectPlaceholder")}
            className="w-full resize-none rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-base text-white placeholder-white/50 outline-none focus:border-indigo-400"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                onDecide?.(
                  item.requestId,
                  "deny",
                  formatRejectionReason(item.toolName, rejectText.trim()),
                )
              }
              className="rounded-md bg-red-500/80 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white hover:bg-red-500"
            >
              {t("perm.rejectConfirm")}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectMode(false);
                setRejectText("");
              }}
              className="rounded-md border border-white/20 px-4 inline-flex min-h-[44px] items-center text-sm font-medium text-white/70 hover:bg-white/5"
            >
              {t("perm.rejectBack")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryRow({
  item,
}: {
  item: Extract<TimelineItem, { kind: "summary" }>;
}) {
  const { t } = useT();
  const parts: string[] = [];
  if (item.input_tokens != null)
    parts.push(t("summary.tokenIn", { n: formatTokens(item.input_tokens) }));
  if (item.output_tokens != null)
    parts.push(t("summary.tokenOut", { n: formatTokens(item.output_tokens) }));
  if (item.cache_read_input_tokens != null && item.cache_read_input_tokens > 0) {
    parts.push(t("summary.cache", { n: formatTokens(item.cache_read_input_tokens) }));
  }
  if (item.duration_ms != null) parts.push(`${(item.duration_ms / 1000).toFixed(1)}s`);
  if (item.permission_denials_count > 0) {
    parts.push(t("summary.denials", { n: item.permission_denials_count }));
  }
  if (item.stop_reason && item.stop_reason !== "end_turn") {
    parts.push(item.stop_reason);
  }

  if (parts.length === 0 && !item.is_error) return null;
  return (
    <div className="text-center text-xs text-white/55">
      {item.is_error && <span className="mr-1 text-red-300">{t("summary.error")}</span>}
      {parts.join(" · ")}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
