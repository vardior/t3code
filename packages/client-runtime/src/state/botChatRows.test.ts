import {
  ChatAttachmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { botChatItemsEqual, createBotChatProjector, visibleBotChatItem } from "./botChatRows.ts";
import { shouldLoadEarlierBotChatHistory } from "./botConversation.ts";

const bot = {
  id: "bot",
  name: "Bot",
  homeThreadId: ThreadId.make("home"),
  paused: false,
  scheduledTaskIds: [],
};
const message = {
  id: MessageId.make("owner"),
  role: "user" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
  streaming: false,
  runId: RunId.make("run"),
  text: "Hello",
  attachments: [],
  createdAt: DateTime.makeUnsafe("2026-10-06T10:00:00Z"),
};

const notification: OrchestrationV2TurnItem = {
  id: TurnItemId.make("notification"),
  threadId: bot.homeThreadId,
  runId: message.runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: message.createdAt,
  completedAt: message.createdAt,
  updatedAt: message.createdAt,
  type: "dynamic_tool",
  toolName: "t3-code.notify_owner",
  input: {},
};

describe("visibleBotChatItem", () => {
  it("shows normal bot replies", () => {
    const reply = { kind: "bot" as const, id: "reply", at: 1, text: "Done" };
    expect(visibleBotChatItem(reply)).toBe(reply);
  });

  it.each(["running", "completed"])("hides %s child-thread chips", (status) => {
    expect(
      visibleBotChatItem({
        kind: "worker",
        id: "worker",
        at: 1,
        threadId: ThreadId.make("child"),
        title: "Task",
        status,
      }),
    ).toBeNull();
  });

  it("hides context reset rows", () => {
    expect(
      visibleBotChatItem({ kind: "compaction", id: "reset", at: 1, text: "Context reset" }),
    ).toBeNull();
  });
});

describe("bot chat row projection", () => {
  it.each(["mcp__t3-code__notify_owner", "t3-code.notify_owner"])(
    "updates background visibility only when %s completes",
    (toolName) => {
      const project = createBotChatProjector();
      const input = {
        bot,
        messages: [
          { ...message, createdBy: "agent" as const, creationSource: "server" as const },
          {
            ...message,
            id: MessageId.make("reply"),
            role: "assistant" as const,
            text: "Final reply",
          },
        ],
        runs: [{ id: message.runId, status: "completed" as const }],
        turnItems: [],
      };
      const initial = project(input);
      expect(initial).toEqual([]);
      expect(
        project({ ...input, turnItems: [{ ...notification, toolName, status: "running" }] }),
      ).toBe(initial);
      expect(
        project({ ...input, turnItems: [{ ...notification, toolName: "t3-code.thread_send" }] }),
      ).toBe(initial);
      const visible = project({ ...input, turnItems: [{ ...notification, toolName }] });
      expect(visible).toMatchObject([{ kind: "bot", text: "Final reply" }]);
      expect(project(input)).toEqual([]);
    },
  );

  it("loads earlier history through pages containing only hidden rows", () => {
    const project = createBotChatProjector();
    const input = {
      bot,
      messages: [
        { ...message, createdBy: "agent" as const, senderThreadId: ThreadId.make("worker") },
      ],
      runs: [],
      turnItems: [],
    };
    const hidden = project(input);
    expect(hidden).toEqual([]);
    const history = { hasMoreHistory: true, historyCursor: "earlier", loading: false, error: null };
    for (const items of [hidden, project({ ...input, messages: [message, ...input.messages] })]) {
      const hasOwnerMessage = items.some((item) => item.kind === "you");
      expect(
        shouldLoadEarlierBotChatHistory({ hasOwnerMessage, history, autoLoadedPages: 1 }),
      ).toBe(!hasOwnerMessage);
    }
  });

  it("keeps the row list unchanged while an assistant streams, then adds its settled reply", () => {
    const project = createBotChatProjector();
    const input = {
      bot,
      detail: null,
      runs: [{ id: RunId.make("run"), status: "running" as const }],
      messages: [message],
      turnItems: [],
    };
    const initial = project(input);
    const assistant = {
      ...message,
      id: MessageId.make("reply"),
      role: "assistant" as const,
      streaming: true,
      text: "First",
    };
    expect(project({ ...input, messages: [message, assistant] })).toBe(initial);
    expect(project({ ...input, messages: [message, { ...assistant, text: "First second" }] })).toBe(
      initial,
    );
    const settled = project({
      ...input,
      runs: [{ id: RunId.make("run"), status: "completed" }],
      messages: [message, { ...assistant, streaming: false, text: "Done" }],
    });
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({ kind: "you", runStatus: "completed" });
    expect(settled[1]).toMatchObject({ kind: "bot", text: "Done" });
  });

  it("keeps the visible list stable while settled intermediate progress updates", () => {
    const project = createBotChatProjector();
    const input = {
      bot,
      runs: [{ id: message.runId, status: "running" as const }],
      messages: [message],
      turnItems: [],
    };
    const initial = project(input);
    const progress = {
      ...message,
      id: MessageId.make("progress"),
      role: "assistant" as const,
      text: "Checking",
    };
    expect(project({ ...input, messages: [message, progress] })).toBe(initial);
    expect(project({ ...input, messages: [message, { ...progress, text: "Fixing" }] })).toBe(
      initial,
    );
  });

  it.each(["completed", "cancelled", "interrupted"] as const)(
    "shows the latest settled owner reply and hides server restart replies when %s",
    (status) => {
      const reply = {
        ...message,
        id: MessageId.make("reply"),
        role: "assistant" as const,
        text: "Visible reply",
      };
      const hiddenRunId = RunId.make("restart");
      const items = createBotChatProjector()({
        bot,
        messages: [
          message,
          { ...reply, id: MessageId.make("progress"), text: "Checking" },
          reply,
          {
            ...message,
            id: MessageId.make("restart-prompt"),
            runId: hiddenRunId,
            createdBy: "agent",
            creationSource: "server",
          },
          {
            ...reply,
            id: MessageId.make("restart-progress"),
            runId: hiddenRunId,
            text: "Hidden progress",
          },
        ],
        runs: [
          { id: message.runId, status },
          { id: hiddenRunId, status },
        ],
        turnItems: [],
      });
      expect(items.filter((item) => item.kind === "bot")).toMatchObject([
        { text: "Visible reply" },
      ]);
    },
  );

  it("preserves every unchanged row when only the streaming last message changes", () => {
    const project = createBotChatProjector();
    const assistant = {
      ...message,
      id: MessageId.make("streaming"),
      role: "assistant" as const,
      streaming: true,
      text: "First",
    };
    const input = {
      bot,
      runs: [{ id: RunId.make("run"), status: "running" as const }],
      messages: [message, { ...message, id: MessageId.make("second"), text: "Second" }, assistant],
      turnItems: [],
    };
    const initial = project(input);
    const streamed = project({
      ...input,
      messages: [...input.messages.slice(0, -1), { ...assistant, text: "First second" }],
    });
    expect(streamed).toHaveLength(2);
    expect(streamed).toBe(initial);
    for (const [index, row] of streamed.entries()) expect(row).toBe(initial[index]);
  });

  it("updates only a changed row and removes deleted rows", () => {
    const project = createBotChatProjector();
    const input = {
      bot,
      detail: null,
      runs: [],
      messages: [message, { ...message, id: MessageId.make("second"), text: "Second" }],
      turnItems: [],
    };
    const initial = project(input);
    const changed = project({
      ...input,
      messages: [message, { ...input.messages[1]!, text: "Edited" }],
    });
    expect(changed[0]).toBe(initial[0]);
    expect(changed[1]).not.toBe(initial[1]);
    expect(project({ ...input, messages: [message] })).toEqual([initial[0]]);
  });

  it("compares image ids by value and detects a replacement image", () => {
    const item = {
      kind: "you" as const,
      id: "row",
      at: 1,
      text: "",
      imageIds: [ChatAttachmentId.make("image")],
      runId: RunId.make("run"),
      runStatus: "running" as const,
    };
    expect(botChatItemsEqual(item, { ...item, imageIds: [...item.imageIds] })).toBe(true);
    expect(
      botChatItemsEqual(item, { ...item, imageIds: [ChatAttachmentId.make("replacement")] }),
    ).toBe(false);
  });

  it("updates a queued row when it starts or is cancelled while preserving other rows", () => {
    const project = createBotChatProjector();
    const input = {
      bot,
      messages: [
        message,
        { ...message, id: MessageId.make("queued"), runId: RunId.make("queued-run") },
      ],
      runs: [
        { id: RunId.make("run"), status: "running" as const },
        { id: RunId.make("queued-run"), status: "queued" as const },
      ],
      turnItems: [],
    };
    const initial = project(input);
    for (const status of ["running", "cancelled"] as const) {
      const updated = project({ ...input, runs: [input.runs[0]!, { ...input.runs[1]!, status }] });
      expect(updated[0]).toBe(initial[0]);
      expect(updated[1]).not.toBe(initial[1]);
      expect(updated[1]).toMatchObject({ runStatus: status, runId: "queued-run" });
    }
  });
});
