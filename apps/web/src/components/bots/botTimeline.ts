import type { VisibleBotChatItem } from "@t3tools/client-runtime/state/bot-chat-rows";
import { MessageId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

const syntheticEntries = new WeakMap<VisibleBotChatItem, TimelineEntry>();

function syntheticEntry(item: VisibleBotChatItem): TimelineEntry {
  const existing = syntheticEntries.get(item);
  if (existing) return existing;
  const createdAt = new Date(item.at).toISOString();
  const entry: TimelineEntry = {
    id: item.id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(item.id),
      role: item.kind === "you" ? "user" : "assistant",
      text: item.text,
      runId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
  syntheticEntries.set(item, entry);
  return entry;
}

function isVisibleBotEvent(entry: TimelineEntry, ownerRunIds: ReadonlySet<string | null>) {
  return (
    entry.kind === "event" &&
    (entry.projectedItem.item.type === "secret_request" ||
      entry.projectedItem.item.type === "link_request" ||
      (entry.projectedItem.item.type === "run_interrupt_result" &&
        ownerRunIds.has(entry.projectedItem.item.runId)))
  );
}

export function botTimelineEntries(
  items: ReadonlyArray<VisibleBotChatItem>,
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  const visibleIds = new Set(items.map((item) => item.id));
  const ownerRunIds = new Set(
    items.flatMap((item) => (item.kind === "you" && item.runId !== null ? [item.runId] : [])),
  );
  const result = entries.filter((entry) =>
    entry.kind === "message"
      ? visibleIds.has(`message:${entry.message.id}`) ||
        (entry.message.role === "user" && entry.message.createdBy === undefined)
      : entry.kind === "html-render" || isVisibleBotEvent(entry, ownerRunIds),
  );
  for (const item of items) {
    if (item.id.startsWith("message:")) continue;
    const entry = syntheticEntry(item);
    const index = result.findIndex((candidate) => candidate.createdAt > entry.createdAt);
    result.splice(index === -1 ? result.length : index, 0, entry);
  }
  return result;
}

function sameEntries(
  left: ReadonlyArray<TimelineEntry>,
  right: ReadonlyArray<TimelineEntry>,
): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function createBotTimelineFilter(items: ReadonlyArray<VisibleBotChatItem>) {
  let lastEntries: ReadonlyArray<TimelineEntry> | null = null;
  let lastResult: ReadonlyArray<TimelineEntry> | null = null;
  return (entries: ReadonlyArray<TimelineEntry>) => {
    if (lastResult !== null && entries === lastEntries) return lastResult;
    const next = botTimelineEntries(items, entries);
    lastEntries = entries;
    if (lastResult === null || !sameEntries(lastResult, next)) lastResult = next;
    return lastResult;
  };
}
