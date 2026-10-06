import { ChatAttachmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { botChatItemsEqual, createBotChatProjector } from "./botChatRows.ts";

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

describe("bot chat row projection", () => {
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
    expect(settled[0]).toBe(initial[0]);
    expect(settled[1]).toMatchObject({ kind: "bot", text: "Done" });
  });

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
    };
    expect(botChatItemsEqual(item, { ...item, imageIds: [...item.imageIds] })).toBe(true);
    expect(
      botChatItemsEqual(item, { ...item, imageIds: [ChatAttachmentId.make("replacement")] }),
    ).toBe(false);
  });
});
