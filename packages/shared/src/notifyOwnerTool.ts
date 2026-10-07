export const NOTIFY_OWNER_TOOL_NAMES: ReadonlyArray<string> = [
  "mcp__t3-code__notify_owner",
  "t3-code.notify_owner",
];

export function isNotifyOwnerToolName(toolName: string | null): boolean {
  return toolName !== null && NOTIFY_OWNER_TOOL_NAMES.includes(toolName);
}
