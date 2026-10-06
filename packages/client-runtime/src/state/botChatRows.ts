import { buildBotChat, type BotChatItem } from "./botConversation.ts";

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
  let previous = new Map<string, BotChatItem>();
  let previousInput: Parameters<typeof buildBotChat>[0] | null = null;
  let result: BotChatItem[] = [];
  return (input: Parameters<typeof buildBotChat>[0]) => {
    const messages = input.messages.filter(
      (message) => message.role !== "assistant" || !message.streaming,
    );
    const turnItems = input.turnItems.filter(
      (item) =>
        item.status === "completed" &&
        (item.type === "command_execution" || item.type === "compaction"),
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
    const items = buildBotChat(previousInput).map((item) => {
      const existing = previous.get(item.id);
      return existing && botChatItemsEqual(existing, item) ? existing : item;
    });
    previous = new Map(items.map((item) => [item.id, item]));
    result = items;
    return result;
  };
}
