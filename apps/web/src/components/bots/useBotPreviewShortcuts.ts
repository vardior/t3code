import { useAtomValue } from "@effect/atom-react";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { dispatchPreviewAction, type PreviewAction } from "../preview/previewActionBus";

const PREVIEW_ACTIONS: Partial<Record<string, PreviewAction>> = {
  "preview.toggle": "toggle-panel",
  "preview.refresh": "refresh",
  "preview.focusUrl": "focus-url",
  "preview.zoomIn": "zoom-in",
  "preview.zoomOut": "zoom-out",
  "preview.resetZoom": "reset-zoom",
};

export function useBotPreviewShortcuts(threadRef: ScopedThreadRef) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen()) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen: selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          threadRef,
        ).terminalOpen,
        previewFocus: isPreviewFocused(),
        previewOpen:
          selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) ===
          "preview",
        editableFocus: isEditableFocused(event.target),
        modelPickerOpen: isModelPickerOpen(),
      },
    });
    const action = command === null ? undefined : PREVIEW_ACTIONS[command];
    if (action === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      isPreviewAvailableFor(threadRef.environmentId) &&
      readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope)
    ) {
      dispatchPreviewAction(action);
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
