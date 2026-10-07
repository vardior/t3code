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

export function botTimelineEntries(
  items: ReadonlyArray<VisibleBotChatItem>,
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  const messageEntries = new Map<string, TimelineEntry>();
  const unsent: TimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    messageEntries.set(`message:${entry.message.id}`, entry);
    if (entry.message.role === "user" && entry.message.createdBy === undefined) unsent.push(entry);
  }
  return [
    ...items.flatMap((item) => {
      const entry = messageEntries.get(item.id);
      if (entry) return [entry];
      return item.id.startsWith("message:") ? [] : [syntheticEntry(item)];
    }),
    ...unsent,
  ];
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
