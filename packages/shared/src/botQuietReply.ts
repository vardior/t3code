export const QUIET_BOT_REPLIES: ReadonlyArray<string> = ["Nothing needs you.", "Nothing needs Or."];

export function isQuietBotReply(text: string): boolean {
  return QUIET_BOT_REPLIES.includes(text.trim());
}
