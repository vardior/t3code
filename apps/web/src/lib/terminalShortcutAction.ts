import type { KeybindingCommand } from "@t3tools/contracts";

export function terminalShortcutAction(
  command: KeybindingCommand | null,
  context: {
    terminalOpen: boolean;
    canReadTerminal: boolean;
    canOperateTerminal: boolean;
  },
) {
  if (command === "terminal.toggle") {
    return context.terminalOpen || context.canReadTerminal || context.canOperateTerminal
      ? "toggle"
      : null;
  }
  if (!context.canOperateTerminal) return null;
  switch (command) {
    case "terminal.new":
      return "new";
    case "terminal.split":
      return "split";
    case "terminal.splitVertical":
      return "splitVertical";
    case "terminal.close":
      return "close";
    default:
      return null;
  }
}
