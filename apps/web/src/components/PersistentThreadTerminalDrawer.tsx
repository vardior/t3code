import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type EnvironmentId,
  type ThreadId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  nextTerminalId,
  resolveTerminalSessionLabel,
  getTerminalLabel,
} from "@t3tools/shared/terminalLabels";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { memo, useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { isEditableFocused } from "../lib/editableFocus";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { confirmTerminalClose, isTerminalCloseConfirmPending } from "../lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../lib/terminalCloseShortcut";
import { terminalShortcutAction } from "../lib/terminalShortcutAction";
import { type TerminalContextSelection } from "../lib/terminalContext";
import { cn, randomUUID } from "../lib/utils";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useProject, useThreadShell } from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../types";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) {
    return false;
  }
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) {
      return false;
    }
  }
  return true;
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  active: boolean;
  launchContext: { cwd: string; worktreePath: string | null } | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext?: ((selection: TerminalContextSelection) => void) | undefined;
  handleShortcuts?: boolean;
}

export const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  active,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
  handleShortcuts = false,
}: PersistentThreadTerminalDrawerProps) {
  const canReadTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
  const canOperateTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const hasTerminalWriteAccess = useCallback(
    () => readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope),
    [threadRef.environmentId],
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const visible = active && terminalUiState.terminalOpen;
  const [hasOpened, setHasOpened] = useState(!handleShortcuts || visible);
  if (visible && !hasOpened) setHasOpened(true);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        panelSurfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [panelSurfaces],
  );
  const drawerTerminalSessions = useMemo(
    () =>
      knownTerminalSessions?.filter(
        (session) => !panelTerminalIds.has(session.target.terminalId),
      ) ?? [],
    [knownTerminalSessions, panelTerminalIds],
  );
  const terminalLabelsById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of drawerTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [drawerTerminalSessions]);
  const terminalLaunchLocationsById = useMemo(() => {
    const next = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    if (!project) {
      return next;
    }

    for (const session of drawerTerminalSessions) {
      const summary = session.state.summary;
      if (!summary) {
        continue;
      }
      const worktreePathForLaunch =
        launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
      next.set(session.target.terminalId, {
        cwd: launchContext?.cwd ?? summary.cwd,
        worktreePath: worktreePathForLaunch,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: worktreePathForLaunch,
        }),
      });
    }

    return next;
  }, [drawerTerminalSessions, launchContext, project]);
  const serverOrderedTerminalIds = useMemo(
    () => drawerTerminalSessions.map((session) => session.target.terminalId),
    [drawerTerminalSessions],
  );

  const allocatableTerminalIds = useMemo(
    () => [
      ...new Set([
        ...serverOrderedTerminalIds,
        ...terminalUiState.terminalIds,
        ...panelTerminalIds,
      ]),
    ],
    [panelTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const allocateTerminalId = useCallback(
    () =>
      nextTerminalId(
        allocatableTerminalIds,
        knownTerminalSessions === null ||
          !readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope)
          ? randomUUID()
          : undefined,
      ),
    [allocatableTerminalIds, knownTerminalSessions, threadRef.environmentId],
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  useEffect(() => {
    if (terminalIdListsEqual(serverOrderedTerminalIds, terminalUiState.terminalIds)) {
      return;
    }
    if (
      serverTerminalIdsStrictSubsetOfClient(serverOrderedTerminalIds, terminalUiState.terminalIds)
    ) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds, threadRef]);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    if (!hasTerminalWriteAccess() || !cwd) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeSplitTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    allocateTerminalId,
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    storeSplitTerminal,
    threadId,
    threadRef,
    openTerminal,
    hasTerminalWriteAccess,
  ]);
  const splitTerminalVertical = useCallback(() => {
    if (!hasTerminalWriteAccess() || !cwd) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeSplitTerminalVertical(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    allocateTerminalId,
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    openTerminal,
    hasTerminalWriteAccess,
    runtimeEnv,
    storeSplitTerminalVertical,
    threadId,
    threadRef,
  ]);

  const createNewTerminal = useCallback(() => {
    if (!hasTerminalWriteAccess() || !cwd) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeNewTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    allocateTerminalId,
    runtimeEnv,
    storeNewTerminal,
    threadId,
    threadRef,
    openTerminal,
    hasTerminalWriteAccess,
  ]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!hasTerminalWriteAccess()) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId: threadRef.environmentId,
          input: { threadId, terminalId, data: "exit\n" },
        });

      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: {
            threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (
          closeResult._tag === "Failure" &&
          !isAtomCommandInterrupted(closeResult) &&
          hasTerminalWriteAccess()
        ) {
          await fallbackExitWrite();
        }
      })();

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      storeCloseTerminal,
      threadId,
      threadRef,
      closeTerminalMutation,
      hasTerminalWriteAccess,
      writeTerminal,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext?.(selection);
    },
    [onAddTerminalContext, visible],
  );

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!active || isCommandPaletteOpen()) return;
    if (
      preventRepeatedTerminalCloseShortcut(event, keybindings) ||
      (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings))
    ) {
      event.stopPropagation();
      return;
    }
    if (event.defaultPrevented && getTerminalFocusOwner() === null) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: getTerminalFocusOwner() !== null,
        terminalOpen: visible,
        previewFocus: false,
        previewOpen: false,
        editableFocus: isEditableFocused(event.target),
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    const action = terminalShortcutAction(command, {
      terminalOpen: visible,
      canReadTerminal,
      canOperateTerminal,
    });
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    const store = useTerminalUiStateStore.getState();
    if (action === "toggle") {
      if (!visible && hasTerminalWriteAccess() && terminalUiState.terminalIds.length === 0) {
        createNewTerminal();
      } else {
        store.setTerminalOpen(threadRef, !visible);
      }
      return;
    }
    if (action === "close") {
      if (!visible) return;
      const terminalId = terminalUiState.activeTerminalId;
      const label = terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
      void confirmTerminalClose([label]).then((confirmed) => {
        if (confirmed && hasTerminalWriteAccess()) closeTerminal(terminalId);
      });
      return;
    }
    store.setTerminalOpen(threadRef, true);
    if (action === "new") {
      createNewTerminal();
      return;
    }
    const group =
      terminalUiState.terminalGroups.find(
        (entry) => entry.id === terminalUiState.activeTerminalGroupId,
      ) ??
      terminalUiState.terminalGroups.find((entry) =>
        entry.terminalIds.includes(terminalUiState.activeTerminalId),
      );
    if ((group?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP) return;
    if (action === "splitVertical") splitTerminalVertical();
    else splitTerminal();
  });
  useEffect(() => {
    if (!handleShortcuts) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleShortcuts]);

  const shortcutOptions = { context: { terminalFocus: true, terminalOpen: visible } };
  const drawerShortcutLabel = (
    command: "terminal.split" | "terminal.splitVertical" | "terminal.new" | "terminal.close",
    label: string | undefined,
  ) =>
    handleShortcuts
      ? (shortcutLabelForCommand(keybindings, command, shortcutOptions) ?? undefined)
      : label;

  if (!hasOpened && !visible) return null;

  if (!project || (!terminalUiState.terminalOpen && !active) || !cwd) {
    return null;
  }

  return (
    <div
      className={cn(
        "grid shrink-0 overflow-clip",
        active ? (visible ? "grid-rows-[1fr]" : "grid-rows-[0fr]") : "hidden",
        active &&
          "[[data-panel-animations=true]_&]:transition-[grid-template-rows] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        active && visible && "[[data-panel-animations=true]_&]:starting:grid-rows-[0fr]!",
      )}
    >
      <div className="min-h-0 overflow-clip">
        <ThreadTerminalDrawer
          threadRef={threadRef}
          threadId={threadId}
          cwd={cwd}
          worktreePath={effectiveWorktreePath}
          runtimeEnv={runtimeEnv}
          visible={visible}
          height={terminalUiState.terminalHeight}
          terminalIds={canOperateTerminal ? terminalUiState.terminalIds : serverOrderedTerminalIds}
          activeTerminalId={terminalUiState.activeTerminalId}
          terminalGroups={terminalUiState.terminalGroups}
          activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
          focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
          onSplitTerminal={splitTerminal}
          onSplitTerminalVertical={splitTerminalVertical}
          onNewTerminal={createNewTerminal}
          splitShortcutLabel={
            visible ? drawerShortcutLabel("terminal.split", splitShortcutLabel) : undefined
          }
          splitVerticalShortcutLabel={
            visible
              ? drawerShortcutLabel("terminal.splitVertical", splitVerticalShortcutLabel)
              : undefined
          }
          newShortcutLabel={
            visible ? drawerShortcutLabel("terminal.new", newShortcutLabel) : undefined
          }
          closeShortcutLabel={
            visible ? drawerShortcutLabel("terminal.close", closeShortcutLabel) : undefined
          }
          keybindings={keybindings}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={setTerminalHeight}
          onAddTerminalContext={onAddTerminalContext ? handleAddTerminalContext : undefined}
          terminalLabelsById={terminalLabelsById}
          terminalLaunchLocationsById={terminalLaunchLocationsById}
        />
      </div>
    </div>
  );
});
