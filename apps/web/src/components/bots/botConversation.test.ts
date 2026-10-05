import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type BotSummary,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildBotChat, slackMarkupToMarkdown, slackTextFromCommand } from "./botConversation";

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
  senderThreadId?: string;
  streaming?: boolean;
}) => ({
  id: MessageId.make(input.id),
  role: input.role,
  createdBy: input.createdBy ?? (input.role === "user" ? "user" : "agent"),
  ...(input.senderThreadId ? { senderThreadId: ThreadId.make(input.senderThreadId) } : {}),
  runId: RunId.make(input.runId),
  streaming: input.streaming ?? false,
  text: input.text,
  createdAt: at(input.createdAt),
});

const commandItem = (input: {
  id: string;
  command: string;
  completedAt: string;
  exitCode?: number;
}): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(input.id),
  threadId: ThreadId.make("home"),
  runId: RunId.make("run-tick"),
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

describe("buildBotChat", () => {
  it("keeps only what the owner and the bot said to each other, plus spawned workers", () => {
    const bot: BotSummary = {
      id: "helper",
      name: "Helper",
      homeThreadId: ThreadId.make("home"),
      scheduledTaskIds: [],
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
          text: "How is it going?",
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
          id: "tick-reply",
          role: "assistant",
          runId: "run-tick",
          createdAt: "2026-10-01T00:04:30.000Z",
          text: "nothing new",
        }),
        message({
          id: "owner-pending",
          role: "user",
          runId: "run-active",
          createdAt: "2026-10-01T00:08:00.000Z",
          text: "And now?",
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
      turnItems: [
        commandItem({
          id: "send",
          command: `printf '%s' "See <https://example.com|this>" | bin/dm-send`,
          completedAt: "2026-10-01T00:07:00.000Z",
        }),
        commandItem({
          id: "refused",
          command: `printf '%s' "Late night" | bin/dm-send`,
          completedAt: "2026-10-01T00:07:30.000Z",
          exitCode: 1,
        }),
      ],
    });

    expect(items.map((item) => [item.kind, "text" in item ? item.text : item.title])).toEqual([
      ["you", "How is it going?"],
      ["bot", "Looking"],
      ["bot", "All good"],
      ["worker", "Fix the build"],
      ["you", "From Slack"],
      ["bot", "See [this](https://example.com)"],
      ["you", "And now?"],
    ]);
  });
});
