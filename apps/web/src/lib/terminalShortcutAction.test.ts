import { describe, expect, it } from "vite-plus/test";

import { terminalShortcutAction } from "./terminalShortcutAction";

const denied = { terminalOpen: false, canReadTerminal: false, canOperateTerminal: false };

describe("terminalShortcutAction", () => {
  it("requires read or operate access to open, but allows hiding after access is revoked", () => {
    expect(terminalShortcutAction("terminal.toggle", denied)).toBeNull();
    expect(terminalShortcutAction("terminal.toggle", { ...denied, canReadTerminal: true })).toBe(
      "toggle",
    );
    expect(terminalShortcutAction("terminal.toggle", { ...denied, canOperateTerminal: true })).toBe(
      "toggle",
    );
    expect(terminalShortcutAction("terminal.toggle", { ...denied, terminalOpen: true })).toBe(
      "toggle",
    );
  });

  it.each(["terminal.new", "terminal.split", "terminal.splitVertical", "terminal.close"] as const)(
    "leaves %s to the native handler without operate access",
    (command) => {
      expect(terminalShortcutAction(command, denied)).toBeNull();
      expect(
        terminalShortcutAction(command, { ...denied, canReadTerminal: true, terminalOpen: true }),
      ).toBeNull();
      expect(terminalShortcutAction(command, { ...denied, canOperateTerminal: true })).toBe(
        command.slice("terminal.".length),
      );
    },
  );

  it("leaves unrelated shortcuts alone", () => {
    expect(
      terminalShortcutAction("rightPanel.toggle", { ...denied, canOperateTerminal: true }),
    ).toBeNull();
    expect(terminalShortcutAction(null, { ...denied, canOperateTerminal: true })).toBeNull();
  });
});
