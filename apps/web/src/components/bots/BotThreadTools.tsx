import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthPreviewOperateScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, type ReactNode } from "react";

import { usePreviewAvailable } from "../../browser/previewRuntime";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { readThreadPreviewState, setActivePreviewTab } from "../../previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useProject, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useRemoteOpenState } from "../../remoteOpen";
import { useOpenFavoriteEditorShortcut } from "../chat/OpenInPickerShortcut";
import { shouldShowOpenInPicker } from "../chat/OpenInPicker.logic";
import { PersistentThreadTerminalDrawer } from "../PersistentThreadTerminalDrawer";

export function BotThreadTools(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const shell = useThreadShell(threadRef);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpen = useRemoteOpenState(props.environmentId);
  const browserAvailable = usePreviewAvailable(props.environmentId);
  const navigate = useNavigate();
  useOpenFavoriteEditorShortcut({
    enabled: shouldShowOpenInPicker({
      activeProjectName: project?.title,
      activeThreadEnvironmentId: props.environmentId,
      primaryEnvironmentId,
      remoteOpenMode: remoteOpen.mode,
    }),
    environmentId: props.environmentId,
    keybindings,
    availableEditors,
    openInCwd: project
      ? projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: shell?.worktreePath ?? null,
        })
      : null,
  });

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen()) return;
    const terminalOpen = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    ).terminalOpen;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: getTerminalFocusOwner() !== null,
        terminalOpen,
        previewFocus: false,
        previewOpen: false,
        editableFocus: isEditableFocused(event.target),
        modelPickerOpen: isModelPickerOpen(),
      },
    });
    if (
      command !== "rightPanel.toggle" &&
      command !== "threadPanel.toggle" &&
      command !== "diff.toggle" &&
      command !== "preview.toggle"
    )
      return;
    if (
      command === "preview.toggle" &&
      (!browserAvailable || !readEnvironmentScope(props.environmentId, AuthPreviewOperateScope))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const panels = useRightPanelStore.getState();
    if (command === "preview.toggle") {
      const tabId = readThreadPreviewState(threadRef).activeTabId;
      if (tabId !== null) setActivePreviewTab(threadRef, tabId);
      panels.openBrowser(threadRef, tabId);
    } else if (command === "diff.toggle") {
      panels.open(threadRef, "diff");
    } else if (command === "threadPanel.toggle") {
      panels.setThreadPanelOpen(threadRef, "inline", true);
    } else {
      const state = selectThreadRightPanelState(panels.byThreadKey, threadRef);
      if (state.surfaces.length === 0) panels.open(threadRef, "files");
      else panels.show(threadRef);
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: props.environmentId, threadId: props.threadId },
    });
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {props.children}
      <PersistentThreadTerminalDrawer
        threadRef={threadRef}
        threadId={props.threadId}
        active
        launchContext={null}
        focusRequestId={0}
        splitShortcutLabel={undefined}
        splitVerticalShortcutLabel={undefined}
        newShortcutLabel={undefined}
        closeShortcutLabel={undefined}
        keybindings={keybindings}
        handleShortcuts
      />
    </div>
  );
}
