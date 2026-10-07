import {
  EnvironmentId,
  ThreadId,
  type RunId,
  type BotDetail,
  type BotSummary,
  type ChatAttachmentId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import {
  usageLimitBlockedRun,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Hash from "effect/Hash";

import type { EnvironmentThreadShell } from "./models.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";
import type { ThreadHistoryMeta } from "./threadHistoryMerge.ts";

import { formatContextWindowTokens } from "../contextWindowTokens.ts";

export type BotChatItem =
  | {
      readonly kind: "you";
      readonly id: string;
      readonly at: number;
      readonly text: string;
      readonly imageIds: ReadonlyArray<ChatAttachmentId>;
      readonly runId: RunId | null;
      readonly runStatus: OrchestrationV2Run["status"] | null;
    }
  | { readonly kind: "bot"; readonly id: string; readonly at: number; readonly text: string }
  | { readonly kind: "compaction"; readonly id: string; readonly at: number; readonly text: string }
  | {
      readonly kind: "wake";
      readonly id: string;
      readonly at: number;
      readonly senderThreadId: ThreadId | null;
      readonly scheduledTaskId: ScheduledTaskId | null;
      readonly text: string;
      readonly reply: string | null;
      readonly runStatus: OrchestrationV2Run["status"] | null;
    }
  | {
      readonly kind: "worker";
      readonly id: string;
      readonly at: number;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly status: string | null;
    };

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function isActiveRunStatus(status: string | null | undefined): boolean {
  return status != null && ACTIVE_RUN_STATUSES.has(status);
}

export function botNeedsYou(
  bot: Pick<BotSummary, "lastReply">,
  shell:
    | Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "lastVisitedAt">
    | null
    | undefined,
): boolean {
  if (shell?.hasPendingApprovals || shell?.hasPendingUserInput) return true;
  if (!bot.lastReply) return false;
  const replyAt = Date.parse(bot.lastReply.at);
  if (!Number.isFinite(replyAt)) return false;
  const visitedAt = shell?.lastVisitedAt ? Date.parse(shell.lastVisitedAt) : NaN;
  return !Number.isFinite(visitedAt) || replyAt > visitedAt;
}

export function botThreadShellStatus(
  shell: EnvironmentThreadShell | null | undefined,
  bot: Pick<BotSummary, "homeThreadMissing" | "homeThreadArchived" | "homeThreadQueueHeld"> = {},
):
  | "idle"
  | "working"
  | "needs-approval"
  | "needs-input"
  | "failed"
  | "stopped"
  | "missing"
  | "archived"
  | "queue-held" {
  if (bot.homeThreadMissing) return "missing";
  if (bot.homeThreadArchived || shell?.archivedAt != null) return "archived";
  const request = shell?.source.pendingRuntimeRequest?.kind;
  if (request === "user_input") return "needs-input";
  if (request && request !== "auth_refresh" && request !== "dynamic_tool_call")
    return "needs-approval";
  const status = shell?.latestRun?.status;
  if (isActiveRunStatus(status) && !(status === "queued" && bot.homeThreadQueueHeld))
    return "working";
  if (status === "failed") return "failed";
  if (bot.homeThreadQueueHeld) return "queue-held";
  if (status === "interrupted") return "stopped";
  return "idle";
}

const BOT_THREAD_STATUS_LABELS = {
  idle: null,
  working: "Working…",
  "needs-approval": "Needs your approval",
  "needs-input": "Needs your input",
  failed: "Failed",
  stopped: null,
  missing: "Home thread missing",
  archived: "Home thread archived",
  "queue-held": "Queue held",
} as const;

export function botThreadShellStatusLabel(status: ReturnType<typeof botThreadShellStatus>) {
  return BOT_THREAD_STATUS_LABELS[status];
}

type ChatRun = Pick<OrchestrationV2Run, "id" | "status" | "queueHeld">;
type ChatMessage = Pick<
  OrchestrationV2ConversationMessage,
  | "id"
  | "role"
  | "createdBy"
  | "creationSource"
  | "senderThreadId"
  | "scheduledTaskId"
  | "runId"
  | "streaming"
  | "text"
  | "attachments"
  | "createdAt"
>;

export function isBotWorking(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
  sessionError: string | null = null,
): boolean {
  if (usageLimitBlockedRun(runs, turnItems, sessionError) !== null) return false;
  const queueHeld = isBotQueueHeld(runs);
  return runs.some(
    (run) => isActiveRunStatus(run.status) && !(run.status === "queued" && queueHeld),
  );
}

export function isBotQueueHeld(runs: ReadonlyArray<ChatRun>): boolean {
  return runs.some((run) => run.status === "queued" && run.queueHeld === true);
}

export function botConversationStatus(
  projection: OrchestrationV2ThreadProjection,
):
  | { readonly kind: "idle" | "working" | "stopped" | "queue-held" }
  | { readonly kind: "needs-attention"; readonly request: "approval" | "input" }
  | { readonly kind: "failed"; readonly error: string | null } {
  const pending = derivePendingThreadRequests(projection);
  if (pending.approvals.length > 0) return { kind: "needs-attention", request: "approval" };
  if (pending.userInputs.length > 0) return { kind: "needs-attention", request: "input" };
  const sessionError =
    projection.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    )?.lastError ?? null;
  const usageLimitRun = usageLimitRunPresentedAsLatest(
    projection.runs,
    projection.turnItems,
    sessionError,
  );
  if (isBotWorking(projection.runs, projection.turnItems, sessionError)) return { kind: "working" };
  const queueHeld = isBotQueueHeld(projection.runs);
  const latest =
    usageLimitRun ??
    projection.runs.reduce<OrchestrationV2Run | null>((current, run) => {
      if (queueHeld && run.status === "queued") return current;
      return current === null || run.ordinal > current.ordinal ? run : current;
    }, null);
  if (latest?.status === "interrupted") return { kind: "stopped" };
  if (latest?.status !== "failed") return { kind: queueHeld ? "queue-held" : "idle" };
  const error = projection.turnItems.findLast(
    (item) => item.runId === latest.id && item.type === "error",
  );
  return { kind: "failed", error: error?.type === "error" ? error.failure.message : sessionError };
}

export function botChatHistoryStart(
  messages: ReadonlyArray<ChatMessage>,
  hasMoreHistory: boolean,
): number | undefined {
  if (!hasMoreHistory || messages.length === 0) return undefined;
  return Math.min(...messages.map((message) => DateTime.toEpochMillis(message.createdAt)));
}

export function shouldLoadEarlierBotChatHistory(input: {
  readonly hasOwnerMessage: boolean;
  readonly history: Pick<
    ThreadHistoryMeta,
    "hasMoreHistory" | "historyCursor" | "loading" | "error"
  >;
  readonly autoLoadedPages: number;
}): boolean {
  return (
    !input.hasOwnerMessage &&
    input.history.hasMoreHistory &&
    input.history.historyCursor !== null &&
    !input.history.loading &&
    input.history.error === null &&
    input.autoLoadedPages < 5
  );
}

export function botChatRunStatusLabel(status: OrchestrationV2Run["status"] | null) {
  if (status === "failed") return "Failed";
  if (status === "interrupted" || status === "cancelled") return "Stopped";
  if (status === "queued") return "Queued";
  return null;
}

export function buildBotChat(input: {
  readonly bot: BotSummary;
  readonly since?: number | undefined;
  readonly detail?: BotDetail | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly runs: ReadonlyArray<ChatRun>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): BotChatItem[] {
  const incoming = input.messages.filter(
    (message) =>
      message.role === "user" &&
      !(
        message.createdBy === "agent" &&
        (message.senderThreadId === input.bot.homeThreadId ||
          message.creationSource === "server") &&
        message.text === "/compact"
      ),
  );
  const ownerMessages = incoming.filter(
    (message) =>
      message.createdBy === "user" &&
      message.senderThreadId === undefined &&
      message.scheduledTaskId === undefined,
  );
  const ownerRunIds = new Set(ownerMessages.flatMap((message) => message.runId ?? []));
  const ownerMessageIds = new Set(ownerMessages.map((message) => message.id));
  const runStatusById = new Map(input.runs.map((run) => [run.id, run.status]));
  const activeRunIds = new Set(
    input.runs.filter((run) => isActiveRunStatus(run.status)).map((run) => run.id),
  );
  const finalReplyByRun = new Map<string, ChatMessage>();
  for (const message of input.messages) {
    if (message.role !== "assistant" || message.streaming || message.runId === null) continue;
    if (!activeRunIds.has(message.runId)) finalReplyByRun.set(message.runId, message);
  }
  const replies = [...ownerRunIds].flatMap((runId) => finalReplyByRun.get(runId) ?? []);
  const wakesBySender = new Map<string, ChatMessage[]>();
  for (const message of incoming) {
    if (ownerMessageIds.has(message.id)) continue;
    const key = JSON.stringify([
      message.runId ?? message.id,
      message.senderThreadId,
      message.scheduledTaskId,
    ]);
    const wakes = wakesBySender.get(key);
    if (wakes) wakes.push(message);
    else wakesBySender.set(key, [message]);
  }

  const dmSends = input.turnItems.flatMap((item) => {
    if (item.type !== "command_execution" || item.status !== "completed") return [];
    if (item.exitCode !== undefined && item.exitCode !== 0) return [];
    const text = slackTextFromCommand(item.input);
    return text === null ? [] : [{ item, text }];
  });
  const dmSendRunIds = new Set<string>(dmSends.flatMap(({ item }) => item.runId ?? []));

  const items: BotChatItem[] = [
    ...ownerMessages.map((message) => ({
      kind: "you" as const,
      id: `message:${message.id}`,
      at: DateTime.toEpochMillis(message.createdAt),
      text: withoutInlineImages(message.text),
      imageIds: message.attachments.flatMap((attachment) =>
        attachment.type === "image" ? [attachment.id] : [],
      ),
      runId: message.runId,
      runStatus: message.runId === null ? null : (runStatusById.get(message.runId) ?? null),
    })),
    ...replies.map((message) => ({
      kind: "bot" as const,
      id: `message:${message.id}`,
      at: DateTime.toEpochMillis(message.createdAt),
      text: message.text,
    })),
    ...input.turnItems.flatMap((item) => {
      if (item.type !== "compaction" || item.status !== "completed") return [];
      const sizes =
        item.beforeTokenCount === undefined || item.afterTokenCount === undefined
          ? ""
          : ` · ${formatContextWindowTokens(item.beforeTokenCount)} → ${formatContextWindowTokens(item.afterTokenCount)}`;
      return [
        {
          kind: "compaction" as const,
          id: `compaction:${item.id}`,
          at: DateTime.toEpochMillis(item.completedAt ?? item.updatedAt),
          text: `Context reset${sizes}`,
        },
      ];
    }),
    ...Array.from(wakesBySender.values()).flatMap((wakes) => {
      const first = wakes[0]!;
      const runId = first.runId;
      if (first.senderThreadId === undefined && runId !== null && dmSendRunIds.has(runId))
        return [];
      return [
        {
          kind: "wake" as const,
          id: `wake:${first.id}`,
          at: DateTime.toEpochMillis(first.createdAt),
          senderThreadId: first.senderThreadId ?? null,
          scheduledTaskId: first.scheduledTaskId ?? null,
          text: wakes.map((wake) => wake.text).join("\n\n"),
          reply:
            runId === null || ownerRunIds.has(runId)
              ? null
              : (finalReplyByRun.get(runId)?.text ?? null),
          runStatus: runId === null ? null : (runStatusById.get(runId) ?? null),
        },
      ];
    }),
    ...(input.detail?.slackDms ?? [])
      .filter((dm) => input.since === undefined || Date.parse(dm.at) >= input.since)
      .map((dm) => ({
        kind: "you" as const,
        id: `slack-dm:${dm.at}:${(Hash.string(dm.text) >>> 0).toString(36)}`,
        at: Date.parse(dm.at),
        text: dm.text,
        imageIds: [],
        runId: null,
        runStatus: null,
      })),
    ...dmSends.map(({ item, text }) => ({
      kind: "bot" as const,
      id: `slack-send:${item.id}`,
      at: DateTime.toEpochMillis(item.completedAt ?? item.updatedAt),
      text: slackMarkupToMarkdown(text),
    })),
    ...(input.detail?.workers ?? [])
      .filter((worker) => input.since === undefined || Date.parse(worker.createdAt) >= input.since)
      .map((worker) => ({
        kind: "worker" as const,
        id: `worker:${worker.threadId}`,
        at: Date.parse(worker.createdAt),
        threadId: worker.threadId,
        title: worker.title,
        status: worker.status,
      })),
  ];
  return [...items].filter((item) => Number.isFinite(item.at)).sort((a, b) => a.at - b.at);
}

function withoutInlineImages(text: string): string {
  return replaceComposerContextReferences(text, (reference) =>
    reference.image ? "" : reference.label,
  ).trim();
}

export function slackMarkupToMarkdown(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^|>\s]+)>/g, "$1");
}

type ShellToken =
  | { readonly type: "word"; readonly value: string }
  | { readonly type: "operator"; readonly value: string }
  | { readonly type: "heredoc"; readonly body: string };

const COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&", "\n"]);

export function slackTextFromCommand(command: string): string | null {
  if (!command.includes("dm-send")) return null;
  const tokens = tokenizeShell(command);
  if (tokens === null) return null;
  const commands = splitCommands(tokens);
  const [shell, flag, script] = commands[0]?.words ?? [];
  if (commands.length === 1 && isShell(shell) && /^-[a-z]*c$/.test(flag ?? "") && script) {
    return slackTextFromCommand(script);
  }
  for (let index = 0; index < commands.length; index += 1) {
    const current = commands[index]!;
    if (!isDmSend(current.words[0])) continue;
    if (current.heredoc !== null) return current.heredoc.trim() || null;
    const previous = commands[index - 1];
    if (previous === undefined || previous.separator !== "|") continue;
    const text = stdoutOf(previous);
    if (text !== null && text.trim()) return text.trim();
  }
  return null;
}

interface SimpleCommand {
  readonly words: ReadonlyArray<string>;
  readonly heredoc: string | null;
  readonly separator: string | null;
}

function isShell(word: string | undefined): boolean {
  return word !== undefined && /(^|\/)(sh|bash|zsh)$/.test(word);
}

function isDmSend(word: string | undefined): boolean {
  return word !== undefined && (word === "dm-send" || word.endsWith("/dm-send"));
}

function stdoutOf(command: SimpleCommand): string | null {
  const [name, ...args] = command.words;
  if (name === "cat" && args.length === 0) return command.heredoc;
  if (name === "echo") return args.filter((arg) => arg !== "-n" && arg !== "-e").join(" ");
  if (name !== "printf" || args.length === 0) return null;
  const [format, ...values] = args as [string, ...string[]];
  if (values.length === 0) return unescapePrintf(format);
  if (!/^%s(\\n)?$/.test(format)) return null;
  return values.join("");
}

const PRINTF_ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\" };

function unescapePrintf(format: string): string {
  return format.replace(/\\([nt\\])/g, (_, char: string) => PRINTF_ESCAPES[char]!);
}

function splitCommands(tokens: ReadonlyArray<ShellToken>): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let heredoc: string | null = null;
  let skipNextWord = false;
  const flush = (separator: string | null) => {
    if (words.length > 0 || heredoc !== null) commands.push({ words, heredoc, separator });
    words = [];
    heredoc = null;
  };
  for (const token of tokens) {
    if (token.type === "heredoc") {
      heredoc = token.body;
    } else if (token.type === "operator") {
      if (COMMAND_SEPARATORS.has(token.value)) {
        flush(token.value);
      } else {
        skipNextWord = true;
      }
    } else if (skipNextWord) {
      skipNextWord = false;
    } else {
      words.push(token.value);
    }
  }
  flush(null);
  return commands;
}

function tokenizeShell(input: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  const pendingHeredocs: Array<{ delimiter: string; insertAt: number }> = [];
  let index = 0;
  let word: string | null = null;
  const pushWord = () => {
    if (word !== null) tokens.push({ type: "word", value: word });
    word = null;
  };
  const appendToWord = (text: string) => {
    word = (word ?? "") + text;
  };

  while (index < input.length) {
    const char = input[index]!;
    if (char === "\n") {
      pushWord();
      tokens.push({ type: "operator", value: "\n" });
      index += 1;
      for (const pending of pendingHeredocs.splice(0)) {
        const lines: string[] = [];
        while (index <= input.length) {
          const end = input.indexOf("\n", index);
          const line = input.slice(index, end === -1 ? input.length : end);
          index = end === -1 ? input.length + 1 : end + 1;
          if (line.trim() === pending.delimiter) break;
          lines.push(line);
        }
        tokens.splice(pending.insertAt, 0, { type: "heredoc", body: lines.join("\n") });
      }
      continue;
    }
    if (char === " " || char === "\t") {
      pushWord();
      index += 1;
      continue;
    }
    if (char === "#" && word === null) {
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }
    if (char === "\\") {
      if (input[index + 1] === "\n") {
        index += 2;
        continue;
      }
      appendToWord(input[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = input.indexOf("'", index + 1);
      if (end === -1) return null;
      appendToWord(input.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === "\\" && '"\\$`\n'.includes(input[index + 1] ?? "")) {
          if (input[index + 1] !== "\n") value += input[index + 1];
          index += 2;
        } else {
          value += input[index];
          index += 1;
        }
      }
      if (index >= input.length) return null;
      appendToWord(value);
      index += 1;
      continue;
    }
    const operator = /^(\|\||&&|<<-?|>>|>&|<&|[|&;<>])/.exec(input.slice(index))?.[0];
    if (operator !== undefined) {
      const fdPrefix = word !== null && /^\d+$/.test(word) && /^[<>]/.test(operator);
      if (fdPrefix) word = null;
      pushWord();
      index += operator.length;
      if (operator.startsWith("<<")) {
        while (input[index] === " ") index += 1;
        const start = index;
        while (index < input.length && !/[\s|&;<>]/.test(input[index]!)) index += 1;
        const delimiter = input.slice(start, index).replace(/['"]/g, "");
        if (!delimiter) return null;
        pendingHeredocs.push({ delimiter, insertAt: tokens.length });
        continue;
      }
      tokens.push({ type: "operator", value: operator });
      continue;
    }
    appendToWord(char);
    index += 1;
  }
  pushWord();
  if (pendingHeredocs.length > 0) return null;
  return tokens;
}

export type PendingBotOrder = {
  readonly ids: ReadonlyArray<string>;
  readonly source: ReadonlyArray<BotSummary>;
};

export function resolveBotListOrder(
  bots: ReadonlyArray<BotSummary>,
  pending: PendingBotOrder | null,
  saving: boolean,
) {
  if (!pending || (!saving && pending.source !== bots)) return bots.map((bot) => bot.id);
  return [
    ...pending.ids.filter((id) => bots.some((bot) => bot.id === id)),
    ...bots.filter((bot) => !pending.ids.includes(bot.id)).map((bot) => bot.id),
  ];
}

const THREAD_LINK_PATTERN = /t3-thread:\/\/v1\/([^/\s)>\]?#]+)\/([^/\s)>\]?#]+)/g;
const THREAD_LINK_HREF_PATTERN = new RegExp(`^${THREAD_LINK_PATTERN.source}$`);

export function parseThreadLink(href: string, rewrittenOrigin?: string) {
  if (rewrittenOrigin && !href.startsWith("t3-thread://")) {
    try {
      const url = new URL(href);
      if (url.origin !== rewrittenOrigin || url.search || url.hash) return null;
      href = `t3-thread://v1${url.pathname}`;
    } catch {
      return null;
    }
  }
  const match = THREAD_LINK_HREF_PATTERN.exec(href);
  if (!match) return null;
  try {
    const environmentId = decodeURIComponent(match[1]!);
    const threadId = decodeURIComponent(match[2]!);
    if (!environmentId || !threadId || /[/\s]/.test(environmentId)) return null;
    if (threadId.includes("/")) return null;
    return { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) };
  } catch {
    return null;
  }
}

export function rewriteThreadLinks(text: string, origin: string): string {
  return text.replace(THREAD_LINK_PATTERN, (href) => {
    const target = parseThreadLink(href);
    return target
      ? [
          origin,
          encodeURIComponent(target.environmentId),
          encodeURIComponent(target.threadId),
        ].join("/")
      : href;
  });
}

export function botVisitWatermark(
  threadUpdatedAt: string | null,
  lastReplyAt: string | undefined,
): string | null {
  if (threadUpdatedAt === null || lastReplyAt === undefined) return threadUpdatedAt;
  return Date.parse(lastReplyAt) > Date.parse(threadUpdatedAt) ? lastReplyAt : threadUpdatedAt;
}
