import type { VisibleBotChatItem } from "@t3tools/client-runtime/state/bot-chat-rows";
import { MessageId, type ThreadId } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { botMarkdownThreadLinks } from "./botChat.logic";

type MessageEntry = Extract<ThreadFeedEntry, { readonly type: "message" }>;
type ActivityGroupEntry = Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;

function sameEntries(
  previous: ReadonlyArray<ThreadFeedEntry>,
  next: ReadonlyArray<ThreadFeedEntry>,
) {
  return previous.length === next.length && next.every((entry, index) => entry === previous[index]);
}

export function createBotFeedFilter(input: {
  readonly items: ReadonlyArray<VisibleBotChatItem>;
  readonly threadId: ThreadId;
  readonly knownEnvironmentIds: ReadonlyArray<string>;
}) {
  const linked = new WeakMap<object, MessageEntry>();
  const withLinks = (key: object, entry: MessageEntry): MessageEntry => {
    const cached = linked.get(key);
    if (cached) return cached;
    const text = botMarkdownThreadLinks(entry.message.text, input.knownEnvironmentIds);
    const next =
      text === entry.message.text ? entry : { ...entry, message: { ...entry.message, text } };
    linked.set(key, next);
    return next;
  };
  const synthetic = (item: VisibleBotChatItem): MessageEntry => {
    const createdAt = new Date(item.at).toISOString();
    return withLinks(item, {
      type: "message",
      id: item.id,
      createdAt,
      message: {
        id: MessageId.make(item.id),
        role: item.kind === "you" ? "user" : "assistant",
        text: item.text,
        attachments: [],
        runId: null,
        streaming: false,
        visibility: "local",
        sourceThreadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      },
    });
  };
  const ownerRunIds = new Set(
    input.items.flatMap((item) => (item.kind === "you" && item.runId !== null ? [item.runId] : [])),
  );
  const interruptions = new WeakMap<ActivityGroupEntry, ActivityGroupEntry | null>();
  const ownerInterruption = (entry: ActivityGroupEntry): ActivityGroupEntry | null => {
    const cached = interruptions.get(entry);
    if (cached !== undefined) return cached;
    const activities = entry.activities.filter(
      (activity) =>
        activity.projectedItem.item.type === "run_interrupt_result" &&
        activity.runId !== null &&
        ownerRunIds.has(activity.runId),
    );
    let next: ActivityGroupEntry | null;
    if (activities.length === 0) next = null;
    else if (activities.length === entry.activities.length) next = entry;
    else next = { ...entry, activities };
    interruptions.set(entry, next);
    return next;
  };
  const kinds = new Map(input.items.map((item) => [item.id, item.kind]));
  let lastEntries: ReadonlyArray<ThreadFeedEntry> | null = null;
  let lastResult: ReadonlyArray<ThreadFeedEntry> | null = null;
  return (entries: ReadonlyArray<ThreadFeedEntry>) => {
    if (lastResult !== null && entries === lastEntries) return lastResult;
    const next = entries.flatMap((entry): ThreadFeedEntry[] => {
      if (entry.type === "activity-group") {
        const interruption = ownerInterruption(entry);
        return interruption ? [interruption] : [];
      }
      if (entry.type === "html-render") return [entry];
      if (entry.type !== "message") return [];
      const kind = kinds.get(`message:${entry.message.id}`);
      if (kind === "bot") return [withLinks(entry, entry)];
      if (kind === "you") return [entry];
      return entry.message.role === "user" && entry.message.createdBy === undefined ? [entry] : [];
    });
    for (const item of input.items) {
      if (item.id.startsWith("message:")) continue;
      const entry = synthetic(item);
      const index = next.findIndex((candidate) => candidate.createdAt > entry.createdAt);
      next.splice(index === -1 ? next.length : index, 0, entry);
    }
    lastEntries = entries;
    if (lastResult === null || !sameEntries(lastResult, next)) lastResult = next;
    return lastResult;
  };
}
