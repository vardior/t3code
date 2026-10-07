import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { countOpenItems } from "@t3tools/client-runtime/state/open-items";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";
import {
  resolveBotListOrder,
  botThreadShellStatus,
  botThreadShellStatusLabel,
  botNeedsYou,
  type PendingBotOrder,
} from "@t3tools/client-runtime/state/bot-conversation";

import { isElectron } from "../../env";
import { openCommandPalette } from "../../commandPaletteBus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SidebarChromeHeader, SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarThreadHeader } from "../sidebar/SidebarThreadHeader";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { BotAvatar } from "./BotAvatar";
import { useBotsData } from "./BotsDataProvider";
import { BotsState } from "./BotsState";
import { parseBotsSearch, resolveBotSelection } from "./botNavigation";
import type { useEnvironmentBots } from "./useEnvironmentBots";

export function BotsSidebar() {
  const { bots, queries } = useBotsData();
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const shells = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );
  const projects = useProjects();
  const newThreadContext = useHandleNewThread();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const search = useLocation({ select: (location) => parseBotsSearch(location.search) });
  const selected = resolveBotSelection(bots, search);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const showEnvironmentLabels = new Set(bots.map((entry) => entry.environmentId)).size > 1;
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const needsYouCount = bots.filter(({ environmentId, bot }) =>
    botNeedsYou(bot, shells.get(`${environmentId}:${bot.homeThreadId}`)),
  ).length;

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        fixedHeader={
          <SidebarGroup>
            <div className="mb-2 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  closeMobileSidebar();
                  void navigateToMainApp();
                }}
              >
                <ArrowLeftIcon />
                Threads
              </Button>
              <span className="min-w-0 truncate text-sm font-medium">
                Bots{needsYouCount > 0 ? ` · ${needsYouCount} need you` : ""}
              </span>
            </div>
            <SidebarThreadHeader
              hasProjects={projects.length > 0}
              projectScope={null}
              onNewProject={() => {
                closeMobileSidebar();
                openCommandPalette({ open: "add-project" });
              }}
              onNewThread={(event) => {
                closeMobileSidebar();
                if (event.shiftKey || projects.length <= 1) {
                  void startNewThreadFromContext({
                    activeDraftThread: newThreadContext.activeDraftThread,
                    activeThread: newThreadContext.activeThread ?? undefined,
                    defaultProjectRef: newThreadContext.defaultProjectRef,
                    handleNewThread: newThreadContext.handleNewThread,
                  });
                } else {
                  openCommandPalette({ open: "new-thread-in" });
                }
              }}
              newThreadDisabled={projects.length === 0}
              newThreadShortcutLabel={null}
              newThreadInProjectShortcutLabel={null}
              showNewThreadInProjectHint={projects.length > 1}
              searchInputRef={searchInputRef}
              searchQuery={query}
              searchLabel="Search bots"
              onSearchQueryChange={setQuery}
              onSearchKeyDown={(event) => {
                if (event.key === "Escape" && query.length > 0) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              isSearching={query.length > 0}
              searchResultCount={0}
              activeSearchResultIndex={0}
              onClearSearch={() => setQuery("")}
            />
          </SidebarGroup>
        }
      >
        {queries.map((entry) =>
          entry.error ? (
            <BotsState
              key={entry.environmentId}
              title={`Could not load bots from ${environments.find((environment) => environment.environmentId === entry.environmentId)?.label ?? entry.environmentId}`}
              description={entry.error}
              retry={entry.refresh}
            />
          ) : entry.isLoading && entry.data === null ? (
            <BotsState key={entry.environmentId} title="Loading bots…" />
          ) : null,
        )}
        {environments
          .filter((environment) => environment.connection.phase !== "connected")
          .map((environment) => (
            <BotsState
              key={environment.environmentId}
              title={`${environment.label} is disconnected`}
              description="Reconnect to message these bots."
            />
          ))}
        {queries.map((entry) => (
          <SortableBotList
            key={entry.environmentId}
            environmentId={entry.environmentId}
            bots={entry.data?.bots ?? []}
            shells={shells}
            searchQuery={query}
            refresh={entry.refresh}
            environmentLabel={
              showEnvironmentLabels
                ? environments.find(
                    (environment) => environment.environmentId === entry.environmentId,
                  )?.label
                : undefined
            }
            selectedId={
              selected?.environmentId === entry.environmentId ? selected.bot.id : undefined
            }
            onSelect={(bot) => {
              closeMobileSidebar();
              void navigate({ to: "/bots", search: { env: bot.environmentId, bot: bot.bot.id } });
            }}
          />
        ))}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function BotListItem(props: {
  readonly bot: BotSummary;
  readonly shell: EnvironmentThreadShell | undefined;
  readonly selected: boolean;
  readonly environmentLabel: string | undefined;
  readonly onSelect: () => void;
  readonly refresh: () => void;
  readonly disabled: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.bot.id, disabled: props.disabled });
  const shell = props.shell;
  const needsYou = botNeedsYou(props.bot, shell);
  const openItemCount = countOpenItems(shell?.openItems);
  const status = botThreadShellStatus(shell, props.bot);
  const working = status === "working";
  const lastActivity = shell?.latestRun?.completedAt ?? shell?.updatedAt ?? null;
  const attentionLabel = botThreadShellStatusLabel(status);
  const statusLabel = botStatusLabel({ paused: props.bot.paused, lastActivity });
  const wasWorking = useRef(working);
  const refresh = props.refresh;
  useEffect(() => {
    if (wasWorking.current && !working) refresh();
    wasWorking.current = working;
  }, [working, refresh]);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn("flex items-center", isDragging && "relative z-10 bg-background shadow-md")}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-disabled={undefined}
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 select-none items-center gap-3 px-3 py-3 text-left hover:bg-accent/60",
          props.selected && "bg-accent",
        )}
        onClick={props.onSelect}
      >
        <BotAvatar name={props.bot.name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-sm", needsYou ? "font-semibold" : "font-medium")}>
              {props.bot.name}
            </span>
            {needsYou ? (
              <span
                className="size-2 shrink-0 rounded-full bg-primary"
                role="img"
                aria-label="Needs you"
              />
            ) : null}
            {openItemCount > 0 ? (
              <span
                className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-primary text-xs tabular-nums"
                aria-label={openItemsLabel(openItemCount)}
              >
                {openItemCount}
              </span>
            ) : null}
          </span>
          {props.environmentLabel ? (
            <span className="truncate text-muted-foreground text-xs">{props.environmentLabel}</span>
          ) : null}
          <span
            className={cn(
              "truncate text-xs",
              needsYou ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {(shell?.hasPendingApprovals
              ? "Needs approval"
              : shell?.hasPendingUserInput
                ? "Needs input"
                : openItemCount > 0
                  ? openItemsLabel(openItemCount)
                  : attentionLabel) ??
              (props.bot.paused ? statusLabel : (props.bot.lastReply?.text ?? statusLabel))}
          </span>
        </span>
      </button>
    </div>
  );
}

function openItemsLabel(count: number) {
  return count === 1 ? "1 open item" : `${count} open items`;
}

function botStatusLabel(status: {
  readonly paused: boolean;
  readonly lastActivity: string | null;
}) {
  if (status.paused) return "Paused";
  if (status.lastActivity) return formatRelativeTimeLabel(status.lastActivity);
  return "Idle";
}

function SortableBotList(props: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<BotSummary>;
  readonly shells: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly searchQuery: string;
  readonly refresh: () => void;
  readonly environmentLabel: string | undefined;
  readonly selectedId: string | undefined;
  readonly onSelect: (entry: ReturnType<typeof useEnvironmentBots>["bots"][number]) => void;
}) {
  const [pendingOrder, setPendingOrder] = useState<PendingBotOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const reorder = useAtomCommand(serverEnvironment.bots.reorder, "Reorder bots");
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter", "Tab"] },
    }),
  );
  const order = resolveBotListOrder(props.bots, pendingOrder, saving);
  const byId = new Map(props.bots.map((bot) => [bot.id, bot]));
  const searchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const handleDragEnd = async (event: DragEndEvent) => {
    if (
      searchQuery.length > 0 ||
      busy.current ||
      event.over === null ||
      event.active.id === event.over.id
    )
      return;
    const from = order.indexOf(String(event.active.id));
    const to = order.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    const names = arrayMove([...order], from, to);
    busy.current = true;
    setSaving(true);
    setPendingOrder({ ids: names, source: props.bots });
    try {
      const result = await reorder({ environmentId: props.environmentId, input: { names } });
      if (result._tag === "Failure") setPendingOrder(null);
    } catch {
      setPendingOrder(null);
    } finally {
      setSaving(false);
      busy.current = false;
    }
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={(event) => void handleDragEnd(event)}
    >
      <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
        <div>
          {order.map((id) => {
            const bot = byId.get(id);
            return bot && bot.name.toLocaleLowerCase().includes(searchQuery) ? (
              <BotListItem
                key={id}
                bot={bot}
                shell={props.shells.get(`${props.environmentId}:${bot.homeThreadId}`)}
                environmentLabel={props.environmentLabel}
                selected={id === props.selectedId}
                refresh={props.refresh}
                disabled={saving || searchQuery.length > 0}
                onSelect={() =>
                  props.onSelect({
                    bot,
                    environmentId: props.environmentId,
                    refresh: props.refresh,
                  })
                }
              />
            ) : null;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
