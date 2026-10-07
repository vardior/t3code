import { isNotifyOwnerToolName } from "@t3tools/shared/notifyOwnerTool";
import { buildBotChat, type BotChatItem } from "./botConversation.ts";

export type VisibleBotChatItem = Extract<BotChatItem, { readonly kind: "you" | "bot" }>;

export function visibleBotChatItem(item: BotChatItem): VisibleBotChatItem | null {
  return item.kind === "you" || item.kind === "bot" ? item : null;
}

export function botChatItemsEqual(left: BotChatItem, right: BotChatItem): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "you" && right.kind === "you") {
    return (
      left.id === right.id &&
      left.at === right.at &&
      left.text === right.text &&
      left.runId === right.runId &&
      left.runStatus === right.runStatus &&
      left.imageIds.length === right.imageIds.length &&
      left.imageIds.every((id, index) => id === right.imageIds[index])
    );
  }
  return Object.entries(left).every(([key, value]) => value === Reflect.get(right, key));
}

export function createBotChatProjector() {
  type Input = Parameters<typeof buildBotChat>[0];
  let previous = new Map<string, VisibleBotChatItem>();
  let previousInput: Input | null = null;
  let result: VisibleBotChatItem[] = [];
  return (input: Input) => {
    const messages = input.messages.filter(
      (message) => message.role !== "assistant" || !message.streaming,
    );
    const turnItems = input.turnItems.filter(
      (item) =>
        item.status === "completed" &&
        (item.type === "command_execution" ||
          item.type === "compaction" ||
          (item.type === "dynamic_tool" && isNotifyOwnerToolName(item.toolName))),
    );
    if (
      previousInput !== null &&
      previousInput.bot === input.bot &&
      previousInput.detail === input.detail &&
      previousInput.since === input.since &&
      messages.length === previousInput.messages.length &&
      messages.every((message, index) => message === previousInput?.messages[index]) &&
      turnItems.length === previousInput.turnItems.length &&
      turnItems.every((item, index) => item === previousInput?.turnItems[index]) &&
      input.runs.length === previousInput.runs.length &&
      input.runs.every(
        (run, index) =>
          run.id === previousInput?.runs[index]?.id &&
          run.status === previousInput?.runs[index]?.status,
      )
    )
      return result;
    previousInput = { ...input, messages, turnItems };
    const items = buildBotChat(previousInput).flatMap((item) => {
      const visible = visibleBotChatItem(item);
      if (visible === null) return [];
      const existing = previous.get(item.id);
      return [existing && botChatItemsEqual(existing, visible) ? existing : visible];
    });
    if (items.length === result.length && items.every((item, index) => item === result[index]))
      return result;
    previous = new Map(items.map((item) => [item.id, item]));
    result = items;
    return result;
  };
}
