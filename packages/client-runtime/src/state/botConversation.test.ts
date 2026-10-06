import {
  ChatAttachmentId,
  MessageId,
  RuntimeRequestId,
  NodeId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type BotSummary,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  botConversationStatus,
  botWakeSenderLabel,
  buildBotChat,
  slackMarkupToMarkdown,
  slackTextFromCommand,
} from "./botConversation.ts";

describe("slackTextFromCommand", () => {
  it("reads the text piped from printf into dm-send", () => {
    expect(
      slackTextFromCommand(
        `cd ~/bots && printf '%s' 'Deploy is live. It'"'"'s green.' | bin/dm-send --thread 1.2 >/dev/null && echo sent`,
      ),
    ).toBe("Deploy is live. It's green.");
  });

  it("reads double-quoted escapes and single-quoted text", () => {
    expect(slackTextFromCommand(`printf '%s' "Say \\"hi\\"" | dm-send`)).toBe('Say "hi"');
    expect(slackTextFromCommand(`printf '%s' 'Line one\nLine two' | /x/bin/dm-send 2>&1`)).toBe(
      "Line one\nLine two",
    );
  });

  it("unwraps the shell -c wrapper some providers add", () => {
    expect(
      slackTextFromCommand(`/bin/zsh -lc "printf '%s' 'Wrapped hello' | /x/bin/dm-send"`),
    ).toBe("Wrapped hello");
  });

  it("reads heredoc bodies fed to dm-send or piped from cat", () => {
    expect(slackTextFromCommand("bin/dm-send --long <<'EOF'\nFirst\nSecond\nEOF\necho done")).toBe(
      "First\nSecond",
    );
    expect(slackTextFromCommand("cat <<EOF | dm-send\nHello\nEOF")).toBe("Hello");
  });

  it("ignores commands that only mention dm-send", () => {
    expect(slackTextFromCommand("bin/dm-send --help 2>&1 | head -5")).toBeNull();
    expect(slackTextFromCommand(`grep -n "dm-send" log.md; bin/dm-send --check`)).toBeNull();
    expect(slackTextFromCommand(`printf '%s' "unterminated | dm-send`)).toBeNull();
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
  it("shows each turn's final reply only, and each agent wake as one row with its final reply", () => {
    const bot: BotSummary = {
      id: "helper",
      name: "Helper",
      homeThreadId: ThreadId.make("home"),
      scheduledTaskIds: [],
      paused: false,
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

    const items = buildBotChat({
      bot,
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
    });

    expect(
      items.map((item) => [
        item.kind,
        item.kind === "wake" ? item.reply : "text" in item ? item.text : item.title,
      ]),
    ).toEqual([
      ["you", "How is it going?"],
      ["bot", "All good"],
      ["wake", "Handled the triage note"],
      ["worker", "Fix the build"],
      ["you", "From Slack"],
      ["bot", "See [this](https://example.com)"],
      ["you", "And now?"],
    ]);
    expect(items[0]).toMatchObject({ imageIds: ["shot"] });
    expect(items[2]).toMatchObject({ senderThreadId: "triage", text: "triage note" });
  });
});

const botWithoutHistory: BotSummary = {
  id: "helper",
  name: "Helper",
  homeThreadId: ThreadId.make("home"),
  scheduledTaskIds: [],
  paused: false,
  charter: null,
  workers: [],
  slackDms: [],
};

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

  it("shows one divider for a self-sent /compact without a wake, user row, or reply", () => {
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

  it("keeps normal wake rows and replies around compactions", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [
        message({
          id: "wake-before",
          role: "user",
          runId: "run-before",
          createdAt: "2026-10-01T00:01:00.000Z",
          text: "First wake",
          createdBy: "agent",
          senderThreadId: "triage",
        }),
        message({
          id: "reply-before",
          role: "assistant",
          runId: "run-before",
          createdAt: "2026-10-01T00:01:30.000Z",
          text: "First reply",
        }),
        message({
          id: "self-compact",
          role: "user",
          runId: "run-compact",
          createdAt: "2026-10-01T00:02:00.000Z",
          text: "/compact",
          createdBy: "agent",
          senderThreadId: "home",
        }),
        message({
          id: "wake-after",
          role: "user",
          runId: "run-after",
          createdAt: "2026-10-01T00:03:00.000Z",
          text: "Second wake",
          createdBy: "agent",
          senderThreadId: "triage",
        }),
        message({
          id: "reply-after",
          role: "assistant",
          runId: "run-after",
          createdAt: "2026-10-01T00:03:30.000Z",
          text: "Second reply",
        }),
      ],
      runs: [
        { id: RunId.make("run-before"), status: "completed" },
        { id: RunId.make("run-compact"), status: "completed" },
        { id: RunId.make("run-after"), status: "completed" },
      ],
      turnItems: [
        compactionItem({
          id: "manual",
          runId: "run-compact",
          completedAt: "2026-10-01T00:02:30.000Z",
        }),
        compactionItem({
          id: "auto",
          runId: "run-after",
          completedAt: "2026-10-01T00:03:15.000Z",
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["wake", "compaction", "wake", "compaction"]);
    expect(items.filter((item) => item.kind === "wake")).toMatchObject([
      { text: "First wake", reply: "First reply" },
      { text: "Second wake", reply: "Second reply" },
    ]);
  });
});

describe("buildBotChat wake rows", () => {
  const wake = message({
    id: "wake",
    role: "user",
    runId: "run-wake",
    createdAt: "2026-10-01T00:01:00.000Z",
    text: "Wake prompt",
    createdBy: "agent",
    scheduledTaskId: "schedule-triage",
  });
  const dmSend = commandItem({
    id: "dm-send",
    runId: "run-wake",
    command: `printf '%s' 'Done' | bin/dm-send`,
    completedAt: "2026-10-01T00:02:00.000Z",
    exitCode: 0,
  });

  it("drops a wake when the same run sent a Slack DM", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [wake],
      runs: [{ id: RunId.make("run-wake"), status: "completed" }],
      turnItems: [dmSend],
    });
    expect(items.map((item) => item.kind)).toEqual(["bot"]);
  });

  it("keeps a wake when its run did not send a Slack DM", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [wake],
      runs: [{ id: RunId.make("run-wake"), status: "completed" }],
      turnItems: [
        commandItem({
          id: "other-command",
          runId: "run-wake",
          command: "echo done",
          completedAt: "2026-10-01T00:02:00.000Z",
          exitCode: 0,
        }),
      ],
    });
    expect(items.filter((item) => item.kind === "wake")).toHaveLength(1);
  });

  it("keeps a wake when another run sent the Slack DM", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [wake],
      runs: [{ id: RunId.make("run-wake"), status: "completed" }],
      turnItems: [{ ...dmSend, runId: RunId.make("other-run") }],
    });
    expect(items.filter((item) => item.kind === "wake")).toHaveLength(1);
  });

  it("carries the scheduled task ID on a wake", () => {
    const items = buildBotChat({
      bot: botWithoutHistory,
      messages: [wake],
      runs: [{ id: RunId.make("run-wake"), status: "completed" }],
      turnItems: [],
    });
    expect(items[0]).toMatchObject({
      kind: "wake",
      scheduledTaskId: ScheduledTaskId.make("schedule-triage"),
    });
  });
});

describe("botConversationStatus", () => {
  const run = { id: RunId.make("run"), ordinal: 1, status: "waiting" as const };
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

  it("distinguishes pending approval from an active run", () => {
    expect(
      botConversationStatus({ runs: [run], runtimeRequests: [request], turnItems: [] }),
    ).toEqual({ kind: "needs-attention", request: "approval" });
    expect(
      botConversationStatus({
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
        runs: [run],
        runtimeRequests: [{ ...request, kind: "user_input" }],
        turnItems: [item],
      }),
    ).toEqual({ kind: "needs-attention", request: "input" });
  });

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
        runs: [{ ...run, status: "failed" }],
        runtimeRequests: [],
        turnItems: [item],
      }),
    ).toEqual({ kind: "failed", error: "Provider stopped" });
    expect(
      botConversationStatus({
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
        runs: [{ ...run, status: "failed" }],
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ kind: "failed", error: null });
  });
});

describe("botWakeSenderLabel", () => {
  const input = { botName: "Helper", scheduled: false };

  it("names a known sender before considering schedule metadata", () => {
    expect(
      botWakeSenderLabel({
        ...input,
        senderTitle: " Release coordinator ",
        scheduleTitle: "bot Helper Check",
      }),
    ).toBe("Release coordinator");
  });

  it("falls back to another thread without exposing identifiers", () => {
    expect(botWakeSenderLabel(input)).toBe("another thread");
    expect(botWakeSenderLabel({ ...input, senderTitle: " " })).toBe("another thread");
  });

  it("keeps scheduled wake labels readable", () => {
    expect(
      botWakeSenderLabel({ ...input, scheduled: true, scheduleTitle: "bot Helper Check builds" }),
    ).toBe("Check builds");
    expect(botWakeSenderLabel({ ...input, scheduled: true, scheduleTitle: " " })).toBe(
      "a scheduled task",
    );
    expect(botWakeSenderLabel({ ...input, scheduled: true, scheduleTitle: "Daily update" })).toBe(
      "Daily update",
    );
  });
});
