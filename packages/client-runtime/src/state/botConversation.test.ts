import {
  ChatAttachmentId,
  EnvironmentId,
  MessageId,
  RuntimeRequestId,
  NodeId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type BotSummary,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderSession,
} from "@t3tools/contracts";
import { v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveLatestThreadRun } from "./threadExecution.ts";
import { presentThreadShell } from "./models.ts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  answerBotMorningFinding,
  dismissBotMorning,
  EMPTY_BOT_MORNING_MEMORY,
  threadsWithoutBotHomes,
  pinnedBotMenuThreads,
  parseThreadLink,
  rewriteThreadLinks,
  botChatHistoryStart,
  botChatRunStatusLabel,
  botConversationStatus,
  botWorkingLabel,
  botThreadShellStatus,
  botThreadShellStatusLabel,
  isBotQueueHeld,
  isBotWorking,
  buildBotChat,
  slackMarkupToMarkdown,
  shouldLoadEarlierBotChatHistory,
  botRouteEnvironment,
  botRouteText,
} from "./botConversation.ts";

describe("bot routing input", () => {
  it("routes only text of at least two words and eight characters", () => {
    expect(botRouteText("  omni pods crash  ")).toBe("omni pods crash");
    expect(botRouteText("deployment")).toBeNull();
    expect(botRouteText("fix it")).toBeNull();
    expect(botRouteText("   ")).toBeNull();
  });

  it("routes only when every bot lives in one environment", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    expect(botRouteEnvironment([{ environmentId: local }, { environmentId: local }])).toBe(local);
    expect(botRouteEnvironment([{ environmentId: local }, { environmentId: remote }])).toBeNull();
    expect(botRouteEnvironment([])).toBeNull();
  });
});

describe("slackMarkupToMarkdown", () => {
  it("turns Slack links into Markdown links", () => {
    expect(slackMarkupToMarkdown("See <https://example.com/pr/1|PR 1> and <https://x.dev>")).toBe(
      "See [PR 1](https://example.com/pr/1) and https://x.dev",
    );
  });
});

const at = (iso: string) => DateTime.makeUnsafe(iso);

const message = (input: {
  id: string;
  role: "user" | "assistant";
  runId: string;
  createdAt: string;
  text: string;
  createdBy?: "user" | "agent";
  creationSource?: "web" | "mcp" | "provider" | "server";
  senderThreadId?: string;
  scheduledTaskId?: string;
  streaming?: boolean;
  imageId?: string;
}) => ({
  id: MessageId.make(input.id),
  role: input.role,
  createdBy: input.createdBy ?? (input.role === "user" ? "user" : "agent"),
  creationSource:
    input.creationSource ??
    (input.role === "assistant" ? "provider" : input.createdBy === "agent" ? "mcp" : "web"),
  ...(input.senderThreadId ? { senderThreadId: ThreadId.make(input.senderThreadId) } : {}),
  ...(input.scheduledTaskId
    ? { scheduledTaskId: ScheduledTaskId.make(input.scheduledTaskId) }
    : {}),
  runId: RunId.make(input.runId),
  streaming: input.streaming ?? false,
  text: input.text,
  attachments: input.imageId
    ? [
        {
          type: "image" as const,
          id: ChatAttachmentId.make(input.imageId),
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ]
    : [],
  createdAt: at(input.createdAt),
});

const commandItem = (input: {
  id: string;
  command: string;
  completedAt: string;
  exitCode?: number;
  runId?: string;
}): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> => ({
  id: TurnItemId.make(input.id),
  threadId: ThreadId.make("home"),
  runId: RunId.make(input.runId ?? "run-tick"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at(input.completedAt),
  completedAt: at(input.completedAt),
  updatedAt: at(input.completedAt),
  type: "command_execution",
  input: input.command,
  ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
});

const notificationItem = (
  toolName = "t3-code.notify_owner",
  status: OrchestrationV2TurnItem["status"] = "completed",
  runId = "run-wake",
): OrchestrationV2TurnItem => ({
  ...commandItem({ id: "notification", command: "", runId, completedAt: "2026-10-01T00:02:00Z" }),
  type: "dynamic_tool",
  toolName,
  status,
  input: {},
});

const compactionItem = (input: {
  id: string;
  runId: string;
  completedAt: string;
  beforeTokenCount?: number;
  afterTokenCount?: number;
}): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(input.id),
  threadId: ThreadId.make("home"),
  runId: RunId.make(input.runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: "Context compacted",
  startedAt: at(input.completedAt),
  completedAt: at(input.completedAt),
  updatedAt: at(input.completedAt),
  type: "compaction",
  driver: null,
  ...(input.beforeTokenCount === undefined ? {} : { beforeTokenCount: input.beforeTokenCount }),
  ...(input.afterTokenCount === undefined ? {} : { afterTokenCount: input.afterTokenCount }),
});

describe("buildBotChat", () => {
  it("shows owner final replies, DM sends and workers while hiding background turns", () => {
    const bot: BotSummary = {
      id: "helper",
      name: "Helper",
      homeThreadId: ThreadId.make("home"),
      scheduledTaskIds: [],
      paused: false,
    };

    const detail = {
      charter: null,
      workers: [
        {
          threadId: ThreadId.make("worker-1"),
          title: "Fix the build",
          createdAt: "2026-10-01T00:05:00.000Z",
          status: "running",
        },
      ],
      slackDms: [{ text: "From Slack", at: "2026-10-01T00:06:00Z" }],
    };
    const input = {
      bot,
      detail,
      messages: [
        message({
          id: "owner-ask",
          role: "user",
          runId: "run-owner",
          createdAt: "2026-10-01T00:01:00.000Z",
          text: "How is it going? ![shot.png](t3-context://v1/image/ctx_1)",
          imageId: "shot",
        }),
        message({
          id: "draft",
          role: "assistant",
          runId: "run-owner",
          createdAt: "2026-10-01T00:02:00.000Z",
          text: "Looking",
        }),
        message({
          id: "final",
          role: "assistant",
          runId: "run-owner",
          createdAt: "2026-10-01T00:03:00.000Z",
          text: "All good",
        }),
        message({
          id: "from-triage",
          role: "user",
          runId: "run-tick",
          createdAt: "2026-10-01T00:04:00.000Z",
          text: "triage note",
          createdBy: "agent",
          senderThreadId: "triage",
        }),
        message({
          id: "tick-progress",
          role: "assistant",
          runId: "run-tick",
          createdAt: "2026-10-01T00:04:10.000Z",
          text: "Loading memory",
        }),
        message({
          id: "tick-reply",
          role: "assistant",
          runId: "run-tick",
          createdAt: "2026-10-01T00:04:30.000Z",
          text: "Handled the triage note",
        }),
        message({
          id: "owner-pending",
          role: "user",
          runId: "run-active",
          createdAt: "2026-10-01T00:08:00.000Z",
          text: "And now?",
        }),
        message({
          id: "active-progress",
          role: "assistant",
          runId: "run-active",
          createdAt: "2026-10-01T00:08:30.000Z",
          text: "Checking the logs",
        }),
        message({
          id: "partial",
          role: "assistant",
          runId: "run-active",
          createdAt: "2026-10-01T00:09:00.000Z",
          text: "Still thinking",
          streaming: true,
        }),
      ],
      runs: [
        { id: RunId.make("run-owner"), status: "completed" },
        { id: RunId.make("run-tick"), status: "completed" },
        { id: RunId.make("run-active"), status: "running" },
      ],
      turnItems: [
        commandItem({
          id: "send",
          command: `printf '%s' "See <https://example.com|this>" | bin/dm-send`,
          completedAt: "2026-10-01T00:07:00.000Z",
          runId: "run-owner",
        }),
        commandItem({
          id: "refused",
          command: `printf '%s' "Late night" | bin/dm-send`,
          completedAt: "2026-10-01T00:07:30.000Z",
          exitCode: 1,
        }),
      ],
    } satisfies Parameters<typeof buildBotChat>[0];
    const items = buildBotChat(input);
    expect(buildBotChat({ ...input, detail: null })).toEqual(
      items.filter((item) => item.kind !== "worker" && !item.id.startsWith("slack-dm:")),
    );

    expect(items.map((item) => [item.kind, "text" in item ? item.text : item.title])).toEqual([
      ["you", "How is it going?"],
      ["bot", "All good"],
      ["worker", "Fix the build"],
      ["you", "From Slack"],
      ["bot", "See [this](https://example.com)"],
      ["you", "And now?"],
    ]);
    expect(items[0]).toMatchObject({ imageIds: ["shot"] });
  });
});

const botWithoutHistory: BotSummary = {
  id: "helper",
  name: "Helper",
  homeThreadId: ThreadId.make("home"),
  scheduledTaskIds: [],
  paused: false,
};

describe("bot chat run status", () => {
  it.each([
    ["failed", "Failed"],
    ["interrupted", "Stopped"],
    ["cancelled", "Stopped"],
    ["queued", "Queued"],
    ["running", null],
    ["completed", null],
  ] as const)("preserves %s on owner rows after a later run", (status, label) => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [
        message({
          id: "owner",
          role: "user",
          runId: "owner-run",
          createdAt: "2026-10-01T00:00:00Z",
          text: "Hello",
        }),
        message({
          id: "wake",
          role: "user",
          runId: "wake-run",
          createdAt: "2026-10-01T00:01:00Z",
          text: "Wake",
          createdBy: "agent",
          senderThreadId: "sender",
        }),
        message({
          id: "later",
          role: "user",
          runId: "later-run",
          createdAt: "2026-10-01T00:02:00Z",
          text: "Later",
        }),
      ],
      runs: [
        { id: RunId.make("owner-run"), status },
        { id: RunId.make("wake-run"), status },
        { id: RunId.make("later-run"), status: "completed" },
      ],
      turnItems: [],
    });
    expect(items[0]).toMatchObject({ kind: "you", runId: "owner-run", runStatus: status });
    expect(items).toHaveLength(2);
    for (const item of items.slice(0, 1)) {
      if (item.kind !== "you") throw new Error("Expected owner row");
      expect(botChatRunStatusLabel(item.runStatus)).toBe(label);
    }
  });

  it.each([false, true])("labels a queued owner message with queueHeld=%s", (queueHeld) => {
    const [item] = buildBotChat({
      bot: botWithoutHistory,
      messages: [
        message({
          id: "queued",
          role: "user",
          runId: "queued-run",
          createdAt: "2026-10-01T00:00:00Z",
          text: "Wait",
        }),
      ],
      runs: [
        { id: RunId.make("active-run"), status: "running" },
        { id: RunId.make("queued-run"), status: "queued", queueHeld },
      ],
      turnItems: [],
    });
    expect(item).toMatchObject({ kind: "you", runId: "queued-run", runStatus: "queued" });
    if (item?.kind !== "you") throw new Error("Expected owner row");
    expect(botChatRunStatusLabel(item.runStatus)).toBe("Queued");
  });
});

describe("bot chat automatic history", () => {
  const history = { hasMoreHistory: true, historyCursor: "earlier", loading: false, error: null };
  const input = { hasOwnerMessage: false, history, autoLoadedPages: 0 };

  it("loads through wake-only pages until an owner message appears", () => {
    const wake = message({
      id: "wake",
      role: "user",
      runId: "wake-run",
      createdAt: "2026-10-01T00:01:00Z",
      text: "Wake",
      createdBy: "agent",
      senderThreadId: "sender",
    });
    const owner = message({
      id: "owner",
      role: "user",
      runId: "owner-run",
      createdAt: "2026-10-01T00:00:00Z",
      text: "Hello",
    });
    for (const messages of [[], [wake], [owner, wake]]) {
      const items = buildBotChat({ bot: botWithoutHistory, messages, runs: [], turnItems: [] });
      expect(
        shouldLoadEarlierBotChatHistory({
          ...input,
          hasOwnerMessage: items.some((item) => item.kind === "you"),
        }),
      ).toBe(!messages.includes(owner));
    }
  });

  it("stops after five pages and waits during loads or errors", () => {
    expect(shouldLoadEarlierBotChatHistory({ ...input, autoLoadedPages: 4 })).toBe(true);
    expect(shouldLoadEarlierBotChatHistory({ ...input, autoLoadedPages: 5 })).toBe(false);
    for (const change of [
      { hasMoreHistory: false },
      { historyCursor: null },
      { loading: true },
      { error: "Unavailable" },
    ]) {
      expect(
        shouldLoadEarlierBotChatHistory({ ...input, history: { ...history, ...change } }),
      ).toBe(false);
    }
  });
});

describe("buildBotChat compaction rows", () => {
  it("hides a server-queued /compact and keeps its context reset divider", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [
        message({
          id: "server-compact",
          role: "user",
          runId: "run-compact",
          createdAt: "2026-10-01T00:01:00.000Z",
          text: "/compact",
          createdBy: "agent",
          creationSource: "server",
        }),
      ],
      runs: [{ id: RunId.make("run-compact"), status: "completed" }],
      turnItems: [
        compactionItem({
          id: "compact",
          runId: "run-compact",
          completedAt: "2026-10-01T00:02:00.000Z",
        }),
      ],
    });

    expect(items).toMatchObject([{ kind: "compaction", text: "Context reset" }]);
  });

  it("shows one divider for a notified self-sent /compact without its prompt or reply", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [
        message({
          id: "self-compact",
          role: "user",
          runId: "run-compact",
          createdAt: "2026-10-01T00:01:00.000Z",
          text: "/compact",
          createdBy: "agent",
          senderThreadId: "home",
        }),
        message({
          id: "compact-reply",
          role: "assistant",
          runId: "run-compact",
          createdAt: "2026-10-01T00:02:00.000Z",
          text: "Compacted",
        }),
      ],
      runs: [{ id: RunId.make("run-compact"), status: "completed" }],
      turnItems: [
        notificationItem("t3-code.notify_owner", "completed", "run-compact"),
        compactionItem({
          id: "compact",
          runId: "run-compact",
          completedAt: "2026-10-01T00:01:30.000Z",
          beforeTokenCount: 182_000,
          afterTokenCount: 12_000,
        }),
      ],
    });

    expect(items).toMatchObject([{ kind: "compaction", text: "Context reset · 182k → 12k" }]);
  });

  it("shows a divider for auto-compaction without a /compact message", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [],
      runs: [],
      turnItems: [
        compactionItem({
          id: "auto-compact",
          runId: "run-auto",
          completedAt: "2026-10-01T00:01:00.000Z",
        }),
      ],
    });

    expect(items).toMatchObject([{ kind: "compaction", text: "Context reset" }]);
  });
});

describe("buildBotChat background replies", () => {
  const prompt = message({
    id: "wake",
    role: "user",
    runId: "run-wake",
    createdAt: "2026-10-01T00:01:00Z",
    text: "Wake prompt",
    scheduledTaskId: "schedule-triage",
  });
  const reply = message({
    id: "reply",
    role: "assistant",
    runId: "run-wake",
    createdAt: "2026-10-01T00:03:00Z",
    text: "Zoom agenda prepared",
  });
  const input = {
    bot: botWithoutHistory,
    messages: [prompt, reply],
    runs: [{ id: RunId.make("run-wake"), status: "completed" as const }],
    turnItems: [],
  };

  it.each(["mcp__t3-code__notify_owner", "t3-code.notify_owner"])(
    "shows only the final settled poll reply after %s completes",
    (toolName) => {
      expect(
        buildBotChat({
          ...input,
          messages: [prompt, { ...reply, id: MessageId.make("progress"), text: "Checking" }, reply],
          turnItems: [notificationItem(toolName)],
        }),
      ).toMatchObject([{ kind: "bot", id: "message:reply", text: "Zoom agenda prepared" }]);
    },
  );

  it.each([
    { scheduledTaskId: ScheduledTaskId.make("schedule-triage") },
    { scheduledTaskId: undefined, createdBy: "agent" as const, creationSource: "server" as const },
    {
      scheduledTaskId: undefined,
      createdBy: "agent" as const,
      senderThreadId: ThreadId.make("other-bot"),
    },
  ])("hides background prompts and replies without notification: %s", (origin) => {
    expect(buildBotChat({ ...input, messages: [{ ...prompt, ...origin }, reply] })).toEqual([]);
    expect(
      buildBotChat({
        ...input,
        messages: [{ ...prompt, ...origin }, reply],
        turnItems: [notificationItem()],
      }),
    ).toMatchObject([{ kind: "bot", text: reply.text }]);
  });

  it.each(["pending", "running", "failed", "interrupted"] as const)(
    "ignores a %s notify_owner call",
    (status) => {
      expect(
        buildBotChat({ ...input, turnItems: [notificationItem("t3-code.notify_owner", status)] }),
      ).toEqual([]);
    },
  );

  it.each([
    "notify_owner",
    "mcp__other__notify_owner",
    "t3-code.notify_owner_extra",
    "t3-code.thread_send",
  ])("ignores the unrelated tool %s", (toolName) => {
    expect(buildBotChat({ ...input, turnItems: [notificationItem(toolName)] })).toEqual([]);
  });

  it("ignores notifications from other runs or without a run", () => {
    for (const runId of [RunId.make("other-run"), null]) {
      expect(buildBotChat({ ...input, turnItems: [{ ...notificationItem(), runId }] })).toEqual([]);
    }
  });

  it("waits for a settled run and excludes streaming replies", () => {
    const notified = { ...input, turnItems: [notificationItem()] };
    expect(
      buildBotChat({ ...notified, runs: [{ id: RunId.make("run-wake"), status: "running" }] }),
    ).toEqual([]);
    expect(
      buildBotChat({ ...notified, messages: [prompt, { ...reply, streaming: true }] }),
    ).toEqual([]);
  });

  it("does not duplicate an owner reply when that run also notifies", () => {
    expect(
      buildBotChat({
        ...input,
        messages: [{ ...prompt, scheduledTaskId: undefined }, reply],
        turnItems: [notificationItem()],
      }).map((item) => item.kind),
    ).toEqual(["you", "bot"]);
  });

  it("keeps completed answers when an owner request continues on background completions", () => {
    const completion = (id: string, runId: string, createdAt: string) => ({
      ...message({
        id,
        role: "user",
        runId,
        createdAt,
        text: "Background command completed",
        createdBy: "agent",
        creationSource: "provider",
      }),
      notification: {
        source: { kind: "command" as const },
        outcome: "completed" as const,
        summary: "Command finished",
      },
    });
    const ask = message({
      id: "ask",
      role: "user",
      runId: "run-ask",
      createdAt: "2026-10-01T00:01:00Z",
      text: "Verify deployment and design provisioning",
    });
    const designAnswer = message({
      id: "designAnswer",
      role: "assistant",
      runId: "run-ask",
      createdAt: "2026-10-01T00:02:00Z",
      text: "Provisioning design: use a dedicated workspace",
    });
    const autoCompact = message({
      id: "auto-compact",
      role: "user",
      runId: "run-compact",
      createdAt: "2026-10-01T00:03:00Z",
      text: "/compact",
      createdBy: "agent",
      creationSource: "server",
    });
    const delivered = message({
      id: "delivered",
      role: "assistant",
      runId: "run-done",
      createdAt: "2026-10-01T00:05:00Z",
      text: "Deployment verified",
    });
    const tick = { ...prompt, createdAt: at("2026-10-01T00:06:00Z") };
    const tickCompletion = completion("tick-done", "run-tick-done", "2026-10-01T00:08:00Z");
    const tickReply = message({
      id: "tick-reply",
      role: "assistant",
      runId: "run-tick-done",
      createdAt: "2026-10-01T00:09:00Z",
      text: "Poll follow-up",
    });
    const chat = (runs: ReadonlyArray<{ id: RunId; status: OrchestrationV2Run["status"] }>) =>
      buildBotChat({
        ...input,
        runs,
        messages: [
          ask,
          designAnswer,
          autoCompact,
          completion("done", "run-done", "2026-10-01T00:04:00Z"),
          delivered,
          tick,
          tickCompletion,
          tickReply,
        ],
      }).map((item) => [item.kind, "text" in item ? item.text : null]);

    expect(chat([])).toEqual([
      ["you", "Verify deployment and design provisioning"],
      ["bot", "Provisioning design: use a dedicated workspace"],
      ["bot", "Deployment verified"],
    ]);
    expect(chat([{ id: RunId.make("run-done"), status: "running" }])).toEqual([
      ["you", "Verify deployment and design provisioning"],
      ["bot", "Provisioning design: use a dedicated workspace"],
    ]);

    const taskResult = {
      ...message({
        id: "task-result",
        role: "user",
        runId: "run-task",
        createdAt: "2026-10-01T00:10:00Z",
        text: "Delegated task reached a terminal state",
        createdBy: "agent",
        creationSource: "server",
      }),
      delegatedCompletion: { parentRunId: RunId.make("run-ask"), generation: 1, taskIds: [] },
    };
    const summary = message({
      id: "summary",
      role: "assistant",
      runId: "run-task",
      createdAt: "2026-10-01T00:11:00Z",
      text: "Meeting summary",
    });
    expect(
      buildBotChat({
        ...input,
        runs: [],
        messages: [
          ask,
          designAnswer,
          completion("done", "run-done", "2026-10-01T00:04:00Z"),
          delivered,
          tick,
          tickCompletion,
          tickReply,
          taskResult,
          summary,
        ],
      }).map((item) => ("text" in item ? item.text : null)),
    ).toEqual([
      "Verify deployment and design provisioning",
      "Provisioning design: use a dedicated workspace",
      "Deployment verified",
      "Meeting summary",
    ]);
  });

  it("keeps the answer to an owner request when a watch update follows", () => {
    const ask = message({
      id: "ask",
      role: "user",
      runId: "run-ask",
      createdAt: "2026-10-01T00:01:00Z",
      text: "Where does the UX work stand?",
    });
    const answer = message({
      id: "answer",
      role: "assistant",
      runId: "run-ask",
      createdAt: "2026-10-01T00:02:00Z",
      text: "Two PRs are open",
    });
    const watchUpdate = {
      ...message({
        id: "watch-update",
        role: "user",
        runId: "run-watch",
        createdAt: "2026-10-01T00:03:00Z",
        text: "Update on pull request #1",
        createdBy: "agent",
        creationSource: "server",
      }),
      notification: {
        source: { kind: "monitor" as const },
        outcome: "updated" as const,
        summary: "Checks passed",
      },
    };
    const quiet = message({
      id: "quiet",
      role: "assistant",
      runId: "run-watch",
      createdAt: "2026-10-01T00:04:00Z",
      text: "Nothing needs you.",
    });
    expect(
      buildBotChat({
        ...input,
        runs: [],
        messages: [ask, answer, watchUpdate, quiet],
      }).map((item) => ("text" in item ? item.text : null)),
    ).toEqual(["Where does the UX work stand?", "Two PRs are open"]);
  });

  it("keeps successful DM sends visible without a notification", () => {
    expect(
      buildBotChat({
        ...input,
        turnItems: [
          commandItem({
            id: "dm-send",
            runId: "run-wake",
            command: "printf '%s' 'Done' | bin/dm-send",
            completedAt: "2026-10-01T00:02:00Z",
            exitCode: 0,
          }),
        ],
      }),
    ).toMatchObject([{ kind: "bot", text: "Done" }]);
  });
});

describe("botConversationStatus", () => {
  const run: OrchestrationV2Run = {
    id: RunId.make("run"),
    threadId: v2ThreadShell.id,
    ordinal: 1,
    providerInstanceId: v2ThreadShell.providerInstanceId,
    modelSelection: v2ThreadShell.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message"),
    rootNodeId: NodeId.make("node"),
    activeAttemptId: null,
    status: "waiting",
    requestedAt: at("2026-10-01T00:00:00Z"),
    startedAt: at("2026-10-01T00:00:00Z"),
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const request = {
    id: RuntimeRequestId.make("request"),
    nodeId: NodeId.make("node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command" as const,
    status: "pending" as const,
    responseCapability: { type: "message" as const },
    createdAt: at("2026-10-01T00:01:00Z"),
    resolvedAt: null,
  };

  it("shows one working line from the latest active assistant message, including streaming updates", () => {
    const progress = {
      ...message({
        id: "progress",
        role: "assistant",
        runId: "run",
        createdAt: "2026-10-01T00:01:00Z",
        text: "  Fixing the\n sidebar crash  ",
      }),
      threadId: v2ThreadShell.id,
      nodeId: null,
      updatedAt: at("2026-10-01T00:01:00Z"),
    };
    const projection = { ...v2Projection, runs: [run], messages: [progress] };
    expect(botWorkingLabel(projection)).toBe("Working… · Fixing the sidebar crash");
    expect(
      botWorkingLabel({
        ...projection,
        messages: [
          progress,
          { ...progress, id: MessageId.make("new"), streaming: true, text: "Testing" },
        ],
      }),
    ).toBe("Working… · Testing");
    expect(
      botWorkingLabel({
        ...projection,
        messages: [progress, { ...progress, id: MessageId.make("empty"), text: " \n " }],
      }),
    ).toBe("Working… · Fixing the sidebar crash");
    expect(
      botWorkingLabel({
        ...projection,
        messages: [progress, { ...progress, runId: RunId.make("old"), text: "Old reply" }],
      }),
    ).toBe("Working… · Fixing the sidebar crash");
    expect(botWorkingLabel({ ...projection, messages: [] })).toBe("Working…");
    expect(botWorkingLabel({ ...projection, runs: [{ ...run, status: "queued" }] })).toBe(
      "Working…",
    );
    expect(botWorkingLabel({ ...projection, runs: [{ ...run, status: "completed" }] })).toBeNull();
    expect(botWorkingLabel({ ...projection, runs: [{ ...run, status: "cancelled" }] })).toBeNull();
    expect(
      botWorkingLabel({ ...projection, runs: [{ ...run, status: "interrupted" }] }),
    ).toBeNull();
    expect(
      botWorkingLabel({ ...projection, runs: [{ ...run, status: "queued", queueHeld: true }] }),
    ).toBeNull();
    expect(botWorkingLabel({ ...projection, runtimeRequests: [request] })).toBeNull();
    expect(botWorkingLabel(null)).toBeNull();
  });

  it("keeps held messages idle and exposes failures before newer held wakes", () => {
    const queued = {
      ...run,
      id: RunId.make("queued"),
      ordinal: 2,
      status: "queued" as const,
      queueHeld: true,
    };
    const error: OrchestrationV2TurnItem = {
      ...commandItem({
        id: "error",
        command: "",
        completedAt: "2026-10-01T00:01:00Z",
        runId: "run",
      }),
      type: "error",
      failure: { class: "unknown", message: "Provider stopped", code: null, retryable: false },
    };
    expect(isBotWorking([queued])).toBe(false);
    expect(isBotQueueHeld([queued])).toBe(true);
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [queued],
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({
      kind: "queue-held",
    });
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [{ ...run, status: "failed" }, queued],
        runtimeRequests: [],
        turnItems: [error],
      }),
    ).toEqual({ kind: "failed", error: "Provider stopped" });
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [{ ...run, status: "interrupted" }, queued],
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ kind: "stopped" });
    expect(isBotWorking([run, queued])).toBe(true);
    expect(isBotWorking([queued, { ...queued, queueHeld: false }])).toBe(false);
    expect(isBotWorking([{ ...queued, queueHeld: false }])).toBe(true);
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [{ ...queued, queueHeld: false }],
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ kind: "working" });
  });

  it("shows the usage limit failure instead of working while newer wakes wait", () => {
    const failed = { ...run, status: "failed" as const, completedAt: run.requestedAt };
    const queued = {
      ...run,
      id: RunId.make("queued"),
      ordinal: 2,
      status: "queued" as const,
      startedAt: null,
    };
    const error: OrchestrationV2TurnItem = {
      ...commandItem({
        id: "limit",
        command: "",
        completedAt: "2026-10-01T00:01:00Z",
        runId: "run",
      }),
      nodeId: failed.rootNodeId,
      status: "failed",
      type: "error",
      failure: {
        class: "usage_limit",
        message: "Plan limit reached",
        code: null,
        retryable: false,
      },
    };
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [error] };
    expect(botConversationStatus(projection)).toEqual({
      kind: "failed",
      error: "Plan limit reached",
    });
    expect(isBotWorking(projection.runs, projection.turnItems)).toBe(false);
    expect(
      botThreadShellStatus({
        ...presentThreadShell(EnvironmentId.make("env"), v2ThreadShell),
        latestRun: deriveLatestThreadRun(projection),
      }),
    ).toBe("failed");
    expect(
      botConversationStatus({
        ...projection,
        turnItems: [{ ...error, nodeId: NodeId.make("child") }],
      }),
    ).toEqual({ kind: "working" });
    expect(
      botConversationStatus({ ...projection, runs: [failed, { ...queued, status: "running" }] }),
    ).toEqual({ kind: "working" });
  });

  it("shows a session-only usage limit error while newer wakes are held", () => {
    const sessionError = "You have hit your usage limit";
    const projection = {
      ...v2Projection,
      runs: [
        { ...run, status: "failed" as const, completedAt: run.requestedAt },
        {
          ...run,
          id: RunId.make("queued"),
          ordinal: 2,
          status: "queued" as const,
          queueHeld: true,
          startedAt: null,
        },
      ],
      turnItems: [],
      providerSessions: [
        {
          providerInstanceId: v2Projection.thread.providerInstanceId,
          lastError: sessionError,
        } as OrchestrationV2ProviderSession,
      ],
    };
    expect(botConversationStatus(projection)).toEqual({ kind: "failed", error: sessionError });
    expect(isBotWorking(projection.runs, [], sessionError)).toBe(false);
  });

  it("distinguishes pending approval from an active run", () => {
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [run],
        runtimeRequests: [request],
        turnItems: [],
      }),
    ).toEqual({ kind: "needs-attention", request: "approval" });
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [run],
        runtimeRequests: [{ ...request, status: "resolved" }],
        turnItems: [],
      }),
    ).toEqual({ kind: "working" });
  });

  it("uses the same pending user input join as the regular chat", () => {
    const item: OrchestrationV2TurnItem = {
      ...commandItem({ id: "question", command: "", completedAt: "2026-10-01T00:01:00Z" }),
      type: "user_input_request",
      requestId: request.id,
      questions: [],
    };
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [run],
        runtimeRequests: [{ ...request, kind: "user_input" }],
        turnItems: [item],
      }),
    ).toEqual({ kind: "needs-attention", request: "input" });
  });

  it("reports stopped only when the latest run was interrupted", () => {
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [
          { ...run, ordinal: 2, status: "interrupted" },
          { ...run, status: "failed" },
        ],
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ kind: "stopped" });
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [
          { ...run, status: "interrupted" },
          { ...run, ordinal: 2, status: "completed" },
        ],
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ kind: "idle" });
  });

  it.each(["failed", "interrupted"] as const)(
    "prioritizes attention over working over a latest %s run",
    (status) => {
      const runs = [run, { ...run, id: RunId.make("latest"), ordinal: 2, status }];
      expect(
        botConversationStatus({ ...v2Projection, runs, runtimeRequests: [request], turnItems: [] }),
      ).toEqual({
        kind: "needs-attention",
        request: "approval",
      });
      expect(
        botConversationStatus({ ...v2Projection, runs, runtimeRequests: [], turnItems: [] }),
      ).toEqual({
        kind: "working",
      });
      const item: OrchestrationV2TurnItem = {
        ...commandItem({ id: "question", command: "", completedAt: "2026-10-01T00:01:00Z" }),
        type: "user_input_request",
        requestId: request.id,
        questions: [],
      };
      expect(
        botConversationStatus({
          ...v2Projection,
          runs: [runs[1]!],
          runtimeRequests: [{ ...request, kind: "user_input" }],
          turnItems: [item],
        }),
      ).toEqual({ kind: "needs-attention", request: "input" });
    },
  );

  it("reports only the latest failed run and its own error", () => {
    const item: OrchestrationV2TurnItem = {
      ...commandItem({
        id: "error",
        command: "",
        completedAt: "2026-10-01T00:01:00Z",
        runId: "run",
      }),
      type: "error",
      failure: { class: "unknown", message: "Provider stopped", code: null, retryable: false },
    };
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [{ ...run, status: "failed" }],
        runtimeRequests: [],
        turnItems: [item],
      }),
    ).toEqual({ kind: "failed", error: "Provider stopped" });
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [
          { ...run, ordinal: 2, status: "completed" },
          { ...run, status: "failed" },
        ],
        runtimeRequests: [],
        turnItems: [item],
      }),
    ).toEqual({ kind: "idle" });
    expect(
      botConversationStatus({
        ...v2Projection,
        runs: [{ ...run, status: "failed" }],
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ kind: "failed", error: null });
  });
});

describe("botThreadShellStatus", () => {
  it("shows archived homes before activity or attention and allows unarchived homes again", () => {
    const shell = presentThreadShell(EnvironmentId.make("env"), {
      ...v2ThreadShell,
      archivedAt: at("2026-10-01T00:00:00Z"),
      latestRunId: RunId.make("run"),
      status: "running",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request"),
        kind: "command",
        createdAt: at("2026-10-01T00:00:00Z"),
      },
    });
    expect(botThreadShellStatus(shell)).toBe("archived");
    expect(botThreadShellStatus(undefined, { homeThreadArchived: true })).toBe("archived");
    expect(botThreadShellStatus(shell, { homeThreadMissing: true, homeThreadArchived: true })).toBe(
      "missing",
    );
    expect(botThreadShellStatus({ ...shell, archivedAt: null })).toBe("needs-approval");
    expect(botThreadShellStatusLabel("archived")).toBe("Home thread archived");
  });
  it("shows a held queue while preserving an executed failure or active run", () => {
    const shell = presentThreadShell(EnvironmentId.make("env"), {
      ...v2ThreadShell,
      latestRunId: RunId.make("run"),
      status: "interrupted",
    });
    expect(botThreadShellStatus(shell, { homeThreadQueueHeld: true })).toBe("queue-held");
    expect(
      botThreadShellStatus(
        { ...shell, latestRun: { ...shell.latestRun!, status: "failed" } },
        { homeThreadQueueHeld: true },
      ),
    ).toBe("failed");
    expect(
      botThreadShellStatus(
        { ...shell, latestRun: { ...shell.latestRun!, status: "running" } },
        { homeThreadQueueHeld: true },
      ),
    ).toBe("working");
  });
  it("prioritizes user requests over active and failed runs", () => {
    const source = {
      ...v2ThreadShell,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request"),
        kind: "user_input" as const,
        createdAt: at("2026-10-01T00:00:00Z"),
      },
    };
    expect(botThreadShellStatus(presentThreadShell(EnvironmentId.make("env"), source))).toBe(
      "needs-input",
    );
    expect(
      botThreadShellStatus(
        presentThreadShell(EnvironmentId.make("env"), {
          ...source,
          pendingRuntimeRequest: { ...source.pendingRuntimeRequest, kind: "command" },
        }),
      ),
    ).toBe("needs-approval");
  });

  it("classifies absent, active, completed, failed and interrupted shells", () => {
    expect(botThreadShellStatus(undefined)).toBe("idle");
    expect(botThreadShellStatus(presentThreadShell(EnvironmentId.make("env"), v2ThreadShell))).toBe(
      "idle",
    );
    for (const [status, expected] of [
      ["preparing", "working"],
      ["queued", "working"],
      ["starting", "working"],
      ["running", "working"],
      ["waiting", "working"],
      ["completed", "idle"],
      ["failed", "failed"],
      ["interrupted", "stopped"],
    ] as const) {
      const shell = presentThreadShell(EnvironmentId.make("env"), {
        ...v2ThreadShell,
        latestRunId: RunId.make("run"),
        status,
      });
      expect(botThreadShellStatus(shell)).toBe(expected);
      expect(
        botThreadShellStatus({
          ...shell,
          source: {
            ...shell.source,
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request"),
              kind: "user_input",
              createdAt: at("2026-10-01T00:00:00Z"),
            },
          },
        }),
      ).toBe("needs-input");
    }
  });
});

describe("bot auxiliary history", () => {
  const detail = {
    charter: null,
    slackDms: [
      { at: "2026-09-01T00:00:00Z", text: "old" },
      { at: "2026-10-01T00:00:00Z", text: "current" },
      { at: "2026-10-01T00:00:00Z", text: "different" },
    ],
    workers: [
      {
        threadId: ThreadId.make("old"),
        title: "Old",
        status: null,
        createdAt: "2026-09-01T00:00:00Z",
      },
      {
        threadId: ThreadId.make("current"),
        title: "Current",
        status: null,
        createdAt: "2026-10-01T00:00:00Z",
      },
    ],
  };
  const input = { bot: botWithoutHistory, detail, messages: [], runs: [], turnItems: [] };

  it("clips auxiliary rows to the loaded window including its boundary", () => {
    expect(
      buildBotChat({ ...input, since: Date.parse("2026-10-01T00:00:00Z") }).map((item) =>
        "text" in item ? item.text : item.kind,
      ),
    ).toEqual(["current", "different", "worker"]);
    expect(buildBotChat(input)).toHaveLength(5);
    expect(buildBotChat({ ...input, since: Infinity })).toEqual([]);
  });

  it("starts the window at the earliest loaded message only while more history exists", () => {
    const loaded = [
      message({ id: "b", role: "user", runId: "r2", createdAt: "2026-10-02T00:00:00Z", text: "" }),
      message({ id: "a", role: "user", runId: "r1", createdAt: "2026-10-01T00:00:00Z", text: "" }),
    ];
    expect(botChatHistoryStart(loaded, true)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(botChatHistoryStart(loaded, false)).toBeUndefined();
    expect(botChatHistoryStart([], true)).toBeUndefined();
  });

  it("keeps DM keys stable as the window slides and distinguishes same-time texts", () => {
    const full = buildBotChat(input).filter((item) => item.kind === "you");
    const slid = buildBotChat({
      ...input,
      detail: { ...detail, slackDms: detail.slackDms.slice(1) },
    }).filter((item) => item.kind === "you");
    expect(slid.map((item) => item.id)).toEqual(full.slice(1).map((item) => item.id));
    expect(new Set(full.map((item) => item.id)).size).toBe(3);
  });
});

describe("parseThreadLink", () => {
  it("preserves environment and MCP thread ids on repeated parses", () => {
    const href =
      "t3-thread://v1/1d3b0db4-c92d-4f53-b04c-8d4d03f283c8/mcp:af3ed104-7f1f-4632-b11f-2f3b91543d29";
    const target = {
      environmentId: "1d3b0db4-c92d-4f53-b04c-8d4d03f283c8",
      threadId: "mcp:af3ed104-7f1f-4632-b11f-2f3b91543d29",
    };
    expect(parseThreadLink(href)).toEqual(target);
    expect(parseThreadLink(href)).toEqual(target);
    expect(parseThreadLink("t3-thread://v1/remote/thread%201")).toEqual({
      environmentId: "remote",
      threadId: "thread 1",
    });
    expect(rewriteThreadLinks(`[Thread](${href})`, "https://t3.invalid")).toBe(
      `[Thread](https://t3.invalid/${target.environmentId}/mcp%3Aaf3ed104-7f1f-4632-b11f-2f3b91543d29)`,
    );
  });

  it.each([
    "https://example.com/env/thread",
    "t3-thread://v2/env/thread",
    "t3-thread://v1/env",
    "t3-thread://v1//thread",
    "t3-thread://v1/env/thread/extra",
    "t3-thread://v1/env/%ZZ",
    "t3-thread://v1/env/thread#fragment",
    "t3-thread://v1/env/thread?query",
    "t3-thread://v1/env/%2F",
  ])("rejects malformed href %s", (href) => {
    expect(parseThreadLink(href)).toBeNull();
  });
});

describe("home bot threads", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const otherEnvironmentId = EnvironmentId.make("environment-remote");
  const homeThreadId = ThreadId.make("bot-home");
  const bot = {
    id: "chief-of-staff",
    name: "Chief of staff",
    homeThreadId,
    scheduledTaskIds: [],
    paused: false,
  };
  const home = {
    environmentId,
    id: homeThreadId,
    title: bot.name,
  };

  it("moves only the bot home out of the ordinary list, preserving workers and order", () => {
    const worker = {
      environmentId,
      id: ThreadId.make("worker"),
      title: "Worker",
    };
    const ordinary = {
      environmentId,
      id: ThreadId.make("ordinary"),
      title: "Task",
    };
    const subagent = {
      ...worker,
      id: ThreadId.make("subagent"),
      lineage: { relationshipToParent: "subagent" },
    };
    expect(
      threadsWithoutBotHomes([worker, home, subagent, ordinary], [{ environmentId, bot }]),
    ).toEqual([worker, subagent, ordinary]);
  });

  it("keeps a matching thread ID from another environment", () => {
    const otherHome = {
      environmentId: otherEnvironmentId,
      id: homeThreadId,
      title: "Another task",
    };
    expect(threadsWithoutBotHomes([home, otherHome], [{ environmentId, bot }])).toEqual([
      otherHome,
    ]);
  });

  it("selects live pins in pin order without duplicating environment-qualified bot homes", () => {
    const pinned = {
      ...home,
      pinnedAt: "2026-11-03T00:00:00Z",
      pinOrderKey: "m",
      archivedAt: null,
      createdAt: "2026-11-01T00:00:00Z",
    };
    const ordinary = {
      ...pinned,
      id: ThreadId.make("ordinary"),
      title: "My task",
      pinOrderKey: "a",
    };
    const remote = { ...pinned, environmentId: otherEnvironmentId, title: "Remote task" };
    const unpinned = { ...ordinary, id: ThreadId.make("unpinned"), pinnedAt: null };
    const archived = { ...ordinary, id: ThreadId.make("archived"), archivedAt: pinned.pinnedAt };
    const entries = [{ environmentId, bot }];
    expect(pinnedBotMenuThreads([remote, pinned, archived, unpinned, ordinary], entries)).toEqual([
      ordinary,
      remote,
    ]);
    expect(pinnedBotMenuThreads([ordinary, remote], entries, "REMOTE")).toEqual([remote]);
    expect(pinnedBotMenuThreads([{ ...ordinary, pinnedAt: null }, remote], entries)).toEqual([
      remote,
    ]);
    expect(pinnedBotMenuThreads([remote], entries)).toEqual([remote]);
    expect(
      pinnedBotMenuThreads([{ ...unpinned, pinnedAt: pinned.pinnedAt }], entries),
    ).toHaveLength(1);
  });

  it("keeps the ordinary list when no bot summaries are available", () => {
    const threads = [home];
    expect(threadsWithoutBotHomes(threads, [])).toBe(threads);
  });
});

describe("bot morning memory", () => {
  it("remembers recent dismissals once each and forgets the oldest", () => {
    let memory = EMPTY_BOT_MORNING_MEMORY;
    for (let index = 0; index < 14; index++) memory = dismissBotMorning(memory, `env:${index}`);
    memory = dismissBotMorning(memory, "env:5");
    expect(memory.dismissed).toHaveLength(12);
    expect(memory.dismissed[0]).toBe("env:2");
    expect(memory.dismissed.at(-1)).toBe("env:5");
    expect(memory.dismissed.filter((entry) => entry === "env:5")).toHaveLength(1);
  });

  it("records a finding decision and rolls it back when the send fails", () => {
    const answered = answerBotMorningFinding(EMPTY_BOT_MORNING_MEMORY, "env:finding", "accept");
    expect(answered.answered).toEqual({ "env:finding": "accept" });
    expect(answerBotMorningFinding(answered, "env:finding", null).answered).toEqual({});
  });
});
