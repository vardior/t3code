import type { VisibleBotChatItem } from "@t3tools/client-runtime/state/bot-chat-rows";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { createBotFeedFilter } from "./botFeed";

const at = "2026-10-07T10:00:00.000Z";
const threadId = ThreadId.make("home");

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text = id,
  createdBy?: "user" | "agent",
): ThreadFeedEntry {
  return {
    type: "message",
    id,
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text,
      attachments: [],
      runId: null,
      streaming: false,
      visibility: "local",
      sourceThreadId: threadId,
      createdAt: at,
      updatedAt: at,
      ...(createdBy ? { createdBy } : {}),
    },
  };
}

const item = (kind: "you" | "bot", id: string, text = id): VisibleBotChatItem =>
  kind === "you"
    ? { kind, id, at: Date.parse(at), text, imageIds: [], runId: null, runStatus: null }
    : { kind, id, at: Date.parse(at), text };

describe("createBotFeedFilter", () => {
  it("keeps the clean stream and rewrites known thread links in replies", () => {
    const owner = messageEntry("owner", "user", "owner", "user");
    const wake = messageEntry("wake", "user", "wake", "agent");
    const reply = messageEntry(
      "reply",
      "assistant",
      "[Task](t3-thread://v1/local/task) [Gone](t3-thread://v1/gone/task)",
    );
    const filter = createBotFeedFilter({
      items: [
        item("you", "message:owner"),
        item("bot", "message:reply"),
        item("bot", "slack-send:1", "Hi"),
      ],
      threadId,
      knownEnvironmentIds: ["local"],
    });
    const entries = filter([owner, wake, reply]);
    expect(entries.map((entry) => entry.id)).toEqual(["owner", "reply", "slack-send:1"]);
    expect(entries[1]).toMatchObject({
      message: { text: "[Task](https://t3.invalid/local/task) Gone" },
    });
    expect(filter([owner, wake, reply])).toBe(entries);
  });
});
