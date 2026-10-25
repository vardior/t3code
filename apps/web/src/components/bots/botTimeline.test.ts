import type { VisibleBotChatItem } from "@t3tools/client-runtime/state/bot-chat-rows";
import { MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { botTimelineEntries, createBotTimelineFilter } from "./botTimeline";

const at = "2026-10-07T10:00:00.000Z";

function messageEntry(
  id: string,
  role: "user" | "assistant",
  createdBy?: "user" | "agent",
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
      ...(createdBy ? { createdBy } : {}),
    },
  };
}

const workEntry: TimelineEntry = {
  id: "tool",
  kind: "work",
  createdAt: at,
  entry: { id: "tool", createdAt: at, label: "Ran rg", tone: "tool" },
};

function interruption(runId: string): TimelineEntry {
  const id = TurnItemId.make(`interrupt-${runId}`);
  const threadId = ThreadId.make("home");
  return {
    id,
    kind: "event",
    createdAt: at,
    projectedItem: {
      position: 0,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: id,
      item: {
        id,
        threadId,
        runId: RunId.make(runId),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(at),
        type: "run_interrupt_result",
        message: "Stopped",
      },
    },
  };
}

const you = (id: string): VisibleBotChatItem => ({
  kind: "you",
  id,
  at: Date.parse(at),
  text: id,
  imageIds: [],
  runId: RunId.make("run"),
  runStatus: "completed",
});
const bot = (id: string): VisibleBotChatItem => ({
  kind: "bot",
  id,
  at: Date.parse(at),
  text: "Posted to Slack",
});

describe("botTimelineEntries", () => {
  it("keeps only the clean stream, in its order, plus unsent owner messages", () => {
    const owner = messageEntry("owner", "user", "user");
    const wake = messageEntry("wake", "user", "agent");
    const progress = messageEntry("progress", "assistant");
    const reply = messageEntry("reply", "assistant");
    const unsent = messageEntry("unsent", "user");
    const entries = botTimelineEntries(
      [you("message:owner"), bot("message:reply")],
      [owner, wake, workEntry, progress, reply, unsent],
    );
    expect(entries).toEqual([owner, reply, unsent]);
  });

  it("keeps the interruption marker of an owner run only", () => {
    const owner = messageEntry("owner", "user", "user");
    const partial = messageEntry("partial", "assistant");
    const ownerStop = interruption("run");
    const wakeStop = interruption("wake-run");
    expect(
      botTimelineEntries(
        [you("message:owner"), bot("message:partial")],
        [owner, partial, ownerStop, wakeStop],
      ),
    ).toEqual([owner, partial, ownerStop]);
  });

  it("keeps pages the bot published with html_render", () => {
    const owner = messageEntry("owner", "user", "user");
    const page: TimelineEntry = {
      id: "page",
      kind: "html-render",
      createdAt: at,
      runId: RunId.make("run"),
      htmlRender: { attachmentId: "attachment", title: "Your work, put in order", height: 480 },
    };
    const reply = messageEntry("reply", "assistant");
    expect(
      botTimelineEntries([you("message:owner"), bot("message:reply")], [owner, page, reply]),
    ).toEqual([owner, page, reply]);
  });

  it("renders Slack items that have no thread message", () => {
    const [slack] = botTimelineEntries([bot("slack-send:item"), bot("message:gone")], []);
    expect(slack).toMatchObject({
      id: "slack-send:item",
      message: { role: "assistant", text: "Posted to Slack" },
    });
  });

  it("returns the previous array while the visible entries are unchanged", () => {
    const owner = messageEntry("owner", "user", "user");
    const filter = createBotTimelineFilter([you("message:owner")]);
    const first = filter([owner, workEntry]);
    expect(filter([owner])).toBe(first);
  });
});
