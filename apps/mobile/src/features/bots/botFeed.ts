import type { VisibleBotChatItem } from "@t3tools/client-runtime/state/bot-chat-rows";
import { MessageId, type ThreadId } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { botMarkdownThreadLinks } from "./botChat.logic";

type MessageEntry = Extract<ThreadFeedEntry, { readonly type: "message" }>;

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
  let lastEntries: ReadonlyArray<ThreadFeedEntry> | null = null;
  let lastResult: ReadonlyArray<ThreadFeedEntry> | null = null;
  return (entries: ReadonlyArray<ThreadFeedEntry>) => {
    if (lastResult !== null && entries === lastEntries) return lastResult;
    const messages = new Map<string, MessageEntry>();
    const unsent: ThreadFeedEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      messages.set(`message:${entry.message.id}`, entry);
      if (entry.message.role === "user" && entry.message.createdBy === undefined) {
        unsent.push(entry);
      }
    }
    const next = [
      ...input.items.flatMap((item) => {
        const entry = messages.get(item.id);
        if (entry) return [item.kind === "bot" ? withLinks(entry, entry) : entry];
        return item.id.startsWith("message:") ? [] : [synthetic(item)];
      }),
      ...unsent,
    ];
    lastEntries = entries;
    if (lastResult === null || !sameEntries(lastResult, next)) lastResult = next;
    return lastResult;
  };
}
