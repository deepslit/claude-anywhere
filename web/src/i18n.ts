import { useEffect, useState } from "react";

export type Locale = "en" | "zh";

const STORAGE_KEY = "mobile_cc_lang";

type Dict = Record<string, string>;

const en: Dict = {
  // App / shell
  "app.checking": "Checking…",
  "app.noSession": "No session selected",
  "app.empty.title": "No conversation open",
  "app.empty.cta": "+ New session",
  "app.empty.hint": "or pick a past session from the sidebar",
  "app.brand": "Claude Anywhere",
  "chat.loadOlder": "Load {count} earlier · {remaining} hidden",
  "sidebar.new": "+ New",
  "sidebar.empty": "No past sessions",
  "sidebar.logout": "Sign out",
  "sidebar.lang": "中文",
  "sidebar.langTitle": "Switch to Chinese",
  // Errors
  "err.dirsLoad": "Failed to load directories: {msg}",
  "err.permissionSubmit": "Failed to submit permission: {msg}",
  "err.sessionLoad": "Failed to load session: {msg}",
  "err.sessionCreate": "Failed to create session: {msg}",
  "err.chat": "Conversation error: {msg}",
  // DirPicker
  "picker.title": "New session",
  "picker.permLabel": "Permission mode",
  "picker.dirLabel": "Working directory",
  "picker.dirHint":
    "Claude runs in this directory; @-completion lists files here. Click to start.",
  "picker.mode.default.label": "Default (follow local settings)",
  "picker.mode.default.hint":
    "Honors permissions.allow in ~/.claude/settings.json. Other tool calls trigger an approval card in this UI.",
  "picker.mode.acceptEdits.label": "Auto-accept edits",
  "picker.mode.acceptEdits.hint":
    "Edit / Write / NotebookEdit auto-approved; Bash etc. still ask.",
  "picker.mode.bypass.label": "Allow everything (dangerous)",
  "picker.mode.bypass.hint":
    "Equivalent to --dangerously-skip-permissions. No tool ever asks. Personal/sandbox use only.",
  // Mode badges / chip labels (match Claude Code's wording)
  "mode.default": "Ask before edits",
  "mode.acceptEdits": "Edits automatically",
  "mode.bypassPermissions": "Allow everything",
  "mode.plan": "Plan mode",
  "composer.modeTitle": "Permission mode for next message",
  // File viewer
  "file.title": "File preview",
  "file.close": "Close",
  "file.binary": "Binary file ({size} bytes) — preview not shown.",
  "file.empty": "Empty file.",
  "file.loading": "Loading…",
  "file.openFail": "Failed to open file: {msg}",
  // Plan card
  "plan.title": "Proposed plan",
  "plan.allow": "Approve plan",
  "plan.deny": "Keep planning",
  "plan.approveAuto": "Approve plan (auto-accept edits)",
  "plan.approveAutoTitle": "Approve the plan AND switch this session to acceptEdits mode (no per-edit prompts)",
  "plan.approveManual": "Approve plan (review edits)",
  "plan.approveManualTitle": "Approve the plan; individual edits will still ask for approval",
  // AskUserQuestion answer card
  "ask.title": "Questions for you",
  "ask.optionOther": "Other",
  "ask.otherPlaceholder": "Type your own answer…",
  "ask.submit": "Submit answers",
  "ask.cancelled": "Cancelled / interrupted",
  "ask.submitting": "Submitting…",
  "ask.notesOptional": "Notes (optional)",
  "ask.allRequired": "Please answer all questions before submitting.",
  // ApiKeyDialog
  "auth.title": "Connect to Claude Anywhere",
  "auth.help": "Enter the API key printed at server startup (also saved in .api-key).",
  "auth.placeholder": "Paste API key",
  "auth.empty": "API key is required",
  "auth.invalid": "Wrong API key — check the one printed at server startup.",
  "auth.connectFail": "Cannot reach server: {msg}",
  "auth.checking": "Checking…",
  "auth.submit": "Enter",
  // Composer
  "composer.disabled": "Open or create a session first",
  "composer.placeholder":
    "Type a message (Enter to send / Shift+Enter newline; / for skills, @ for files)",
  "composer.stop": "Stop",
  "composer.send": "Send",
  "composer.suggestSlash": "↑↓ select · Enter/Tab insert · Esc close",
  "composer.suggestFile": "↑↓ select · Enter insert",
  // Tool / thinking blocks
  "block.thinkingDone": "💭 Thinking",
  "block.thinkingActive": "💭 Thinking…",
  "block.toolBadge": "tool",
  "block.toolStreaming": "streaming…",
  "block.toolError": "tool error",
  "block.toolResult": "tool result",
  "block.userFeedback": "user feedback",
  "block.planApproved": "plan approved",
  "todo.title": "todo list",
  "todo.done": "done",
  "todo.empty": "(empty todo list)",
  // Permission card
  "perm.title": "Permission request",
  "perm.allowedOnce": "Allowed (this call only)",
  "perm.allowedAlways": "Allowed (no more prompts for {tool} this session)",
  "perm.denied": "Denied",
  "perm.submitting": "Submitting…",
  "perm.reasonPrefix": "Reason: ",
  "perm.btnAllow": "Allow once",
  "perm.btnAllowAlways": "Always allow {tool} in this session",
  "perm.btnAllowAlwaysTitle": "Auto-approve every {tool} call for the rest of this session",
  "perm.btnReject": "Reject with reason",
  "perm.btnInterrupt": "Interrupt",
  "perm.btnInterruptTitle": "Stop the current turn",
  "perm.rejectPlaceholder":
    "Tell Claude what to do instead (optional, sent as the rejection reason)",
  "perm.rejectConfirm": "Confirm reject",
  "perm.rejectBack": "Back",
  // Summary
  "summary.tokenIn": "↑ {n}",
  "summary.tokenOut": "↓ {n}",
  "summary.cache": "cache {n}",
  "summary.denials": "{n} tool(s) denied",
  "summary.error": "⚠ Error",
};

const zh: Dict = {
  "app.checking": "校验中…",
  "app.noSession": "未选择会话",
  "app.empty.title": "还没有打开任何会话",
  "app.empty.cta": "+ 新建会话",
  "app.empty.hint": "或者从侧边栏选一个历史会话",
  "app.brand": "Claude Anywhere",
  "chat.loadOlder": "加载更早的 {count} 条 · 还有 {remaining} 条隐藏",
  "sidebar.new": "+ 新建",
  "sidebar.empty": "没有历史会话",
  "sidebar.logout": "退出登录",
  "sidebar.lang": "EN",
  "sidebar.langTitle": "切回英文",
  "err.dirsLoad": "加载目录失败：{msg}",
  "err.permissionSubmit": "提交权限决定失败：{msg}",
  "err.sessionLoad": "加载会话失败：{msg}",
  "err.sessionCreate": "新建会话失败：{msg}",
  "err.chat": "对话出错：{msg}",
  "picker.title": "新建会话",
  "picker.permLabel": "权限模式",
  "picker.dirLabel": "工作目录",
  "picker.dirHint": "Claude 在此目录运行；@ 联想从这里开始。点击即创建会话。",
  "picker.mode.default.label": "默认（按本地配置）",
  "picker.mode.default.hint":
    "遵循 ~/.claude/settings.json 的 permissions.allow 规则；其它工具调用会在此 web 上弹出确认卡片。",
  "picker.mode.acceptEdits.label": "自动接受编辑",
  "picker.mode.acceptEdits.hint":
    "Edit / Write / NotebookEdit 自动放行；Bash 等仍按本地配置。",
  "picker.mode.bypass.label": "全部允许（危险）",
  "picker.mode.bypass.hint":
    "等同 --dangerously-skip-permissions，任意工具不询问。仅在私人 / 沙箱环境用。",
  "mode.default": "编辑前先问",
  "mode.acceptEdits": "自动接受编辑",
  "mode.bypassPermissions": "全部允许",
  "mode.plan": "计划模式",
  "composer.modeTitle": "下一条消息使用的权限模式",
  "file.title": "文件预览",
  "file.close": "关闭",
  "file.binary": "二进制文件（{size} 字节），不显示预览。",
  "file.empty": "空文件。",
  "file.loading": "加载中…",
  "file.openFail": "打开文件失败：{msg}",
  "plan.title": "建议的计划",
  "plan.allow": "批准计划",
  "plan.deny": "继续规划",
  "plan.approveAuto": "批准计划（自动接受编辑）",
  "plan.approveAutoTitle": "批准计划并把会话切到 acceptEdits 模式（编辑不再每次询问）",
  "plan.approveManual": "批准计划（仍审核编辑）",
  "plan.approveManualTitle": "批准计划；后续每次编辑仍会弹卡片",
  "ask.title": "需要你回答",
  "ask.optionOther": "其它（自定义）",
  "ask.otherPlaceholder": "输入自定义回答…",
  "ask.submit": "提交回答",
  "ask.cancelled": "已取消 / 中断",
  "ask.submitting": "提交中…",
  "ask.notesOptional": "备注（可选）",
  "ask.allRequired": "请把所有问题答完再提交。",
  "auth.title": "连接 Claude Anywhere",
  "auth.help": "输入服务器启动时打印的 API key（保存在 .api-key）。",
  "auth.placeholder": "粘贴 API key",
  "auth.empty": "API key 不能为空",
  "auth.invalid": "API key 不正确，请检查服务器启动时打印的那串。",
  "auth.connectFail": "无法连接服务器：{msg}",
  "auth.checking": "校验中…",
  "auth.submit": "进入",
  "composer.disabled": "请先新建或打开一个会话",
  "composer.placeholder":
    "输入消息（Enter 发送 / Shift+Enter 换行；/ 选 skill，@ 选文件）",
  "composer.stop": "停",
  "composer.send": "发送",
  "composer.suggestSlash": "↑↓ 选择 · Enter/Tab 插入 · Esc 关闭",
  "composer.suggestFile": "↑↓ 选择 · Enter 插入",
  "block.thinkingDone": "💭 思考过程",
  "block.thinkingActive": "💭 思考中…",
  "block.toolBadge": "工具",
  "block.toolStreaming": "传输中…",
  "block.toolError": "工具出错",
  "block.toolResult": "工具结果",
  "block.userFeedback": "用户反馈",
  "block.planApproved": "计划已批准",
  "todo.title": "任务清单",
  "todo.done": "已完成",
  "todo.empty": "(任务清单为空)",
  "perm.title": "权限请求",
  "perm.allowedOnce": "已允许（仅本次）",
  "perm.allowedAlways": "已允许（本会话内 {tool} 不再询问）",
  "perm.denied": "已拒绝",
  "perm.submitting": "提交中…",
  "perm.reasonPrefix": "理由：",
  "perm.btnAllow": "允许本次",
  "perm.btnAllowAlways": "本会话都允许 {tool}",
  "perm.btnAllowAlwaysTitle": "本会话里所有 {tool} 调用都自动允许",
  "perm.btnReject": "拒绝并填理由",
  "perm.btnInterrupt": "打断",
  "perm.btnInterruptTitle": "终止当前对话回合",
  "perm.rejectPlaceholder":
    "告诉 Claude 应该怎么改（可选，会以拒绝理由的形式返给它）",
  "perm.rejectConfirm": "确认拒绝",
  "perm.rejectBack": "返回",
  "summary.tokenIn": "↑ {n}",
  "summary.tokenOut": "↓ {n}",
  "summary.cache": "cache {n}",
  "summary.denials": "{n} 工具被拒",
  "summary.error": "⚠ 出错",
};

const dictionaries: Record<Locale, Dict> = { en, zh };

function readStored(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    // ignore
  }
  return "en";
}

let currentLocale: Locale = readStored();
const subscribers = new Set<(loc: Locale) => void>();

export function setLocale(loc: Locale) {
  currentLocale = loc;
  try {
    localStorage.setItem(STORAGE_KEY, loc);
  } catch {
    // ignore
  }
  subscribers.forEach((fn) => fn(loc));
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[currentLocale];
  let str = dict[key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

/** React hook: re-renders the consumer when the locale changes. */
export function useT(): {
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: Locale;
  setLocale: (loc: Locale) => void;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);
  return {
    t,
    locale: currentLocale,
    setLocale,
  };
}
