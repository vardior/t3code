import {
  EnvironmentId,
  ThreadId,
  type RunId,
  type BotDetail,
  BotFindingDecision,
  type BotMorning,
  type BotSummary,
  type ChatAttachmentId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  usageLimitBlockedRun,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { isNotifyOwnerToolName } from "@t3tools/shared/notifyOwnerTool";
import { countOpenItems } from "./openItems.ts";
import { slackTextFromCommand } from "@t3tools/shared/slackTextFromCommand";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Hash from "effect/Hash";
import * as Schema from "effect/Schema";

import type { EnvironmentThreadShell } from "./models.ts";

import { derivePendingThreadRequests } from "./threadRequests.ts";
import type { ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export function threadsWithoutBotHomes<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  threads: ReadonlyArray<T>,
  bots: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly bot: Pick<BotSummary, "homeThreadId">;
  }>,
) {
  if (bots.length === 0) return threads;
  const homes = new Set(
    bots.map(({ environmentId, bot }) => `${environmentId}:${bot.homeThreadId}`),
  );
  return threads.filter((thread) => !homes.has(`${thread.environmentId}:${thread.id}`));
}

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

function isActiveRunStatus(status: string | null | undefined): boolean {
  return status != null && ACTIVE_RUN_STATUSES.has(status);
}

export function botNeedsYou(
  bot: Pick<BotSummary, "lastReply">,
  shell:
    | Pick<
        EnvironmentThreadShell,
        "hasPendingApprovals" | "hasPendingUserInput" | "lastVisitedAt" | "openItems"
      >
    | null
    | undefined,
): boolean {
  if (shell?.hasPendingApprovals || shell?.hasPendingUserInput) return true;
  if (countOpenItems(shell?.openItems) > 0) return true;
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
  | "notification"
  | "delegatedCompletion"
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

export function botWorkingLabel(projection: OrchestrationV2ThreadProjection | null) {
  if (projection === null || botConversationStatus(projection).kind !== "working") return null;
  const activeRunIds = new Set(
    projection.runs
      .filter((run) => isActiveRunStatus(run.status) && run.status !== "queued")
      .map((run) => run.id),
  );
  const progress = projection.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.runId !== null &&
      activeRunIds.has(message.runId) &&
      message.text.trim().length > 0,
  );
  const line = progress?.text.replace(/\s+/g, " ").trim();
  return line ? `Working… · ${line}` : "Working…";
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
  const ownerMessageSet = new Set(ownerMessages);
  const ownerRequests: RunId[][] = [];
  let request: RunId[] | null = null;
  for (const message of incoming) {
    if (message.runId === null || message.notification?.source.kind === "monitor") continue;
    const parentRunId = message.delegatedCompletion?.parentRunId;
    if (ownerMessageSet.has(message)) {
      request = [message.runId];
      ownerRequests.push(request);
    } else if (parentRunId !== undefined) {
      ownerRequests.find((runIds) => runIds.includes(parentRunId))?.push(message.runId);
    } else if (message.notification === undefined) {
      request = null;
    } else if (request !== null && !request.includes(message.runId)) {
      request.push(message.runId);
    }
  }
  const compactRunIds = new Set(
    input.messages.flatMap((message) =>
      message.role === "user" && message.text === "/compact" ? (message.runId ?? []) : [],
    ),
  );
  const notifiedRunIds = input.turnItems.flatMap((item) =>
    item.type === "dynamic_tool" &&
    item.status === "completed" &&
    isNotifyOwnerToolName(item.toolName)
      ? (item.runId ?? [])
      : [],
  );
  const runStatusById = new Map(input.runs.map((run) => [run.id, run.status]));
  const activeRunIds = new Set(
    input.runs.filter((run) => isActiveRunStatus(run.status)).map((run) => run.id),
  );
  const finalReplyByRun = new Map<string, ChatMessage>();
  for (const message of input.messages) {
    if (message.role !== "assistant" || message.streaming || message.runId === null) continue;
    if (!activeRunIds.has(message.runId)) finalReplyByRun.set(message.runId, message);
  }
  const latestReplyRunIds = ownerRequests.flatMap(
    (runIds) =>
      runIds.findLast((runId) => !compactRunIds.has(runId) && finalReplyByRun.has(runId)) ?? [],
  );
  const replies = [...new Set([...latestReplyRunIds, ...notifiedRunIds])].flatMap((runId) =>
    compactRunIds.has(runId) ? [] : (finalReplyByRun.get(runId) ?? []),
  );

  const dmSends = input.turnItems.flatMap((item) => {
    if (item.type !== "command_execution" || item.status !== "completed") return [];
    if (item.exitCode !== undefined && item.exitCode !== 0) return [];
    const text = slackTextFromCommand(item.input);
    return text === null ? [] : [{ item, text }];
  });

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

const BOT_MORNING_MEMORY_LIMIT = 12;
export const BotMorningMemory = Schema.Struct({
  dismissed: Schema.Array(Schema.String),
  answered: Schema.Record(Schema.String, BotFindingDecision),
});
export type BotMorningMemory = typeof BotMorningMemory.Type;
export const EMPTY_BOT_MORNING_MEMORY: BotMorningMemory = { dismissed: [], answered: {} };

export function dismissBotMorning(memory: BotMorningMemory, key: string): BotMorningMemory {
  return {
    ...memory,
    dismissed: [...memory.dismissed.filter((entry) => entry !== key), key].slice(
      -BOT_MORNING_MEMORY_LIMIT,
    ),
  };
}

export function answerBotMorningFinding(
  memory: BotMorningMemory,
  key: string,
  decision: BotFindingDecision | null,
): BotMorningMemory {
  const { [key]: _, ...rest } = memory.answered;
  return {
    ...memory,
    answered: Object.fromEntries(
      Object.entries(decision === null ? rest : { ...rest, [key]: decision }).slice(
        -BOT_MORNING_MEMORY_LIMIT,
      ),
    ),
  };
}

export function botMorningLine(
  bot: Pick<BotMorning["bots"][number], "replyCount" | "latestReply">,
) {
  return bot.replyCount > 1 ? `${bot.replyCount} replies · ${bot.latestReply}` : bot.latestReply;
}

export const BOT_ROUTE_DEBOUNCE_MS = 600;

export function botRouteText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length >= 8 && trimmed.split(/\s+/).length >= 2 ? trimmed : null;
}

export function botRouteEnvironment(
  bots: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): EnvironmentId | null {
  const environmentIds = new Set(bots.map((entry) => entry.environmentId));
  return environmentIds.size === 1 ? bots[0]!.environmentId : null;
}

type BotRouteEntry = {
  readonly environmentId: EnvironmentId;
  readonly bot: { readonly id: string };
};

export function botRouteKey(entry: BotRouteEntry): string {
  return JSON.stringify([entry.environmentId, entry.bot.id]);
}

export function heldBotRouteSuggestion(input: {
  readonly routeText: string | null;
  readonly routed: { readonly botId: string | null } | null;
  readonly heldBotId: string | null;
}): string | null {
  if (input.routeText === null) return null;
  if (input.routed === null) return input.heldBotId;
  return input.routed.botId;
}

export function botRoutePickerLabel(botName: string | null, isRouting: boolean): string {
  if (botName !== null) return `→ ${botName}`;
  return isRouting ? "Finding a bot…" : "Pick a bot";
}

export function findRoutedBot<T extends BotRouteEntry>(
  bots: ReadonlyArray<T>,
  choice: { readonly environmentId: EnvironmentId; readonly botId: string } | null,
): T | null {
  if (choice === null) return null;
  return (
    bots.find(
      (entry) => entry.environmentId === choice.environmentId && entry.bot.id === choice.botId,
    ) ?? null
  );
}
