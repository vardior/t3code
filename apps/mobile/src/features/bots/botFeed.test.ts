import type { VisibleBotChatItem } from "@t3tools/client-runtime/state/bot-chat-rows";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, type ThreadFeedEntry } from "../../lib/threadActivity";
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

function turnItem(id: string, runId: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(at);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make(runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function workFeed(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return buildThreadFeed(
    items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
  );
}

const item = (
  kind: "you" | "bot",
  id: string,
  text = id,
  runId: RunId | null = null,
): VisibleBotChatItem =>
  kind === "you"
    ? { kind, id, at: Date.parse(at), text, imageIds: [], runId, runStatus: null }
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

  it("keeps pages the bot published with html_render", () => {
    const owner = messageEntry("owner", "user", "owner", "user");
    const page: ThreadFeedEntry = {
      type: "html-render",
      id: "page",
      createdAt: at,
      runId: RunId.make("run"),
      render: { attachmentId: "attachment", title: "Your work, put in order", height: 480 },
    };
    const reply = messageEntry("reply", "assistant");
    const filter = createBotFeedFilter({
      items: [item("you", "message:owner"), item("bot", "message:reply")],
      threadId,
      knownEnvironmentIds: [],
    });
    expect(filter([owner, page, reply]).map((entry) => entry.id)).toEqual([
      "owner",
      "page",
      "reply",
    ]);
  });

  it("keeps the interruption marker of an owner run only", () => {
    const owner = messageEntry("owner", "user", "owner", "user");
    const work = workFeed([
      {
        ...turnItem("command", "owner-run", 0),
        type: "command_execution",
        input: "vp check",
        output: "ok",
        exitCode: 0,
      },
      { ...turnItem("owner-stop", "owner-run", 1), type: "run_interrupt_result", message: "" },
      { ...turnItem("wake-stop", "wake-run", 2), type: "run_interrupt_result", message: "" },
    ]);
    const filter = createBotFeedFilter({
      items: [item("you", "message:owner", "owner", RunId.make("owner-run"))],
      threadId,
      knownEnvironmentIds: [],
    });
    const entries = filter([owner, ...work]);
    expect(
      entries.map((entry) =>
        entry.type === "activity-group"
          ? entry.activities.map((activity) => activity.projectedItem.item.id)
          : entry.id,
      ),
    ).toEqual(["owner", ["owner-stop"]]);
  });
});
