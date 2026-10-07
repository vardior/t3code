import { ChatAttachmentId, MessageId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { botChatItemsEqual, createBotChatProjector, visibleBotChatItem } from "./botChatRows.ts";
import { botChatRunStatusLabel, shouldLoadEarlierBotChatHistory } from "./botConversation.ts";

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

const senderBot = {
  ...bot,
  id: "chief",
  name: "chief-of-staff",
  homeThreadId: ThreadId.make("chief"),
};
const wake = {
  kind: "wake" as const,
  id: "wake",
  at: 1,
  senderThreadId: senderBot.homeThreadId,
  scheduledTaskId: null,
  text: "Please check the build",
  reply: "Done",
  runStatus: "completed" as const,
};

describe("visibleBotChatItem", () => {
  it("shows bot senders by their bot name", () => {
    expect(visibleBotChatItem(wake, [bot, senderBot], bot.homeThreadId)).toEqual({
      ...wake,
      senderName: "chief-of-staff",
    });
  });

  it.each(["worker", "delegated-child", "missing-thread", "home", null])(
    "hides messages and results from %s",
    (sender) => {
      expect(
        visibleBotChatItem(
          { ...wake, senderThreadId: sender === null ? null : ThreadId.make(sender) },
          [bot, senderBot],
          bot.homeThreadId,
        ),
      ).toBeNull();
    },
  );

  it("hides scheduled wake prompts even with a bot sender", () => {
    expect(
      visibleBotChatItem(
        { ...wake, scheduledTaskId: ScheduledTaskId.make("schedule") },
        [senderBot],
        bot.homeThreadId,
      ),
    ).toBeNull();
  });

  it.each(["running", "completed"])("hides %s child-thread chips", (status) => {
    expect(
      visibleBotChatItem(
        {
          kind: "worker",
          id: "worker",
          at: 1,
          threadId: ThreadId.make("child"),
          title: "Task",
          status,
        },
        [senderBot],
        bot.homeThreadId,
      ),
    ).toBeNull();
  });

  it("hides context reset rows", () => {
    expect(
      visibleBotChatItem(
        { kind: "compaction", id: "reset", at: 1, text: "Context reset" },
        [senderBot],
        bot.homeThreadId,
      ),
    ).toBeNull();
  });

  it.each([
    ["interrupted", "Stopped"],
    ["failed", "Failed"],
    ["queued", "Queued"],
  ] as const)("keeps %s labels on bot messages", (runStatus, label) => {
    const visible = visibleBotChatItem({ ...wake, runStatus }, [senderBot], bot.homeThreadId);
    expect(visible).toMatchObject({ senderName: senderBot.name, runStatus });
    if (visible?.kind !== "wake") throw new Error("Expected bot sender row");
    expect(botChatRunStatusLabel(visible.runStatus)).toBe(label);
  });
});

describe("bot chat row projection", () => {
  it.each([message.runId, null])(
    "shows bot messages with run %s alongside owner messages",
    (runId) => {
      const items = createBotChatProjector()({
        bot,
        bots: [bot, senderBot],
        messages: [
          message,
          {
            ...message,
            id: MessageId.make("chief"),
            createdBy: "agent",
            senderThreadId: senderBot.homeThreadId,
            runId,
            text: "Bot message",
          },
          { ...message, id: MessageId.make("reply"), role: "assistant", text: "Final reply" },
        ],
        runs: [{ id: message.runId, status: "completed" }],
        turnItems: [],
      });
      expect(items).toMatchObject([
        { kind: "you", text: "Hello" },
        { kind: "bot", text: "Final reply" },
        { kind: "wake", senderName: senderBot.name, text: "Bot message", reply: null },
      ]);
    },
  );

  it("keeps bot messages separate from worker messages delivered in the same run", () => {
    const project = createBotChatProjector();
    const input = {
      bot,
      bots: [bot, senderBot],
      detail: {
        charter: null,
        slackDms: [],
        workers: [
          {
            threadId: ThreadId.make("spawned"),
            title: "Spawned task",
            status: "running",
            createdAt: "2026-10-06T10:00:00Z",
          },
          {
            threadId: ThreadId.make("delegated"),
            title: "Delegated task",
            status: "completed",
            createdAt: "2026-10-06T10:00:00Z",
          },
        ],
      },
      messages: [
        {
          ...message,
          createdBy: "agent" as const,
          senderThreadId: ThreadId.make("worker"),
          text: "Worker result",
        },
        {
          ...message,
          id: MessageId.make("chief"),
          createdBy: "agent" as const,
          senderThreadId: senderBot.homeThreadId,
          text: "Bot message",
        },
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
    expect(initial).toMatchObject([
      { kind: "wake", senderName: "chief-of-staff", text: "Bot message", reply: "Final reply" },
    ]);
    expect(project({ ...input, bots: [bot] })).toEqual([]);
    expect(project({ ...input, bots: [bot, { ...senderBot, name: "Chief" }] })).toMatchObject([
      { senderName: "Chief", text: "Bot message" },
    ]);
  });

  it("loads earlier history through pages containing only hidden rows", () => {
    const project = createBotChatProjector();
    const input = {
      bot,
      bots: [bot],
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
      bots: [bot],
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
      bots: [bot],
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
        bots: [bot],
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
      bots: [bot],
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
      bots: [bot],
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
      bots: [bot],
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
