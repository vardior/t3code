import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
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
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, GripVerticalIcon, InfoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { resolveBotSelection } from "./botNavigation";
import { refreshEnvironmentBots, useEnvironmentBots } from "./useEnvironmentBots";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./BotAvatar";
import {
  resolveBotListOrder,
  botThreadShellStatus,
  botThreadShellStatusLabel,
  type PendingBotOrder,
} from "@t3tools/client-runtime/state/bot-conversation";
import { BotChat } from "./BotChat";
import { BotInfoSheet } from "./BotInfoSheet";

export function BotsPage({
  botId,
  environmentId: requestedEnvironmentId,
}: {
  readonly botId: string | undefined;
  readonly environmentId: string | undefined;
}) {
  useEscapeToGoBack();
  const { environments, isReady } = useEnvironments();
  const { bots, queries } = useEnvironmentBots();
  useEffect(() => {
    refreshEnvironmentBots();
    window.addEventListener("focus", refreshEnvironmentBots);
    return () => window.removeEventListener("focus", refreshEnvironmentBots);
  }, []);
  const navigate = useNavigate();
  const [infoOpen, setInfoOpen] = useState(false);
  const selection = resolveBotSelection(bots, { bot: botId, env: requestedEnvironmentId });
  const selected = selection?.bot ?? null;
  const environmentId = selection?.environmentId;
  const showEnvironmentLabels = new Set(bots.map((entry) => entry.environmentId)).size > 1;
  const disconnected = environments.filter(
    (environment) => environment.connection.phase !== "connected",
  );
  const relevantQueries = requestedEnvironmentId
    ? queries.filter((query) => query.environmentId === requestedEnvironmentId)
    : queries;
  const failedQuery = relevantQueries.find((query) => query.error !== null);
  const loading = !isReady || relevantQueries.some((query) => query.isLoading);
  const unavailable =
    isReady &&
    (requestedEnvironmentId
      ? !queries.some((query) => query.environmentId === requestedEnvironmentId) ||
        (disconnected.some((environment) => environment.environmentId === requestedEnvironmentId) &&
          relevantQueries.every((query) => query.data === null))
      : queries.length === 0 || (bots.length === 0 && disconnected.length > 0));
  const pageState = unavailable ? (
    <BotsState
      title="Environment disconnected"
      description="Connect to the environment to see its bots."
    />
  ) : loading ? (
    <BotsState title="Loading bots…" />
  ) : failedQuery ? (
    <BotsState
      title="Could not load bots"
      description={failedQuery.error!}
      retry={failedQuery.refresh}
    />
  ) : !relevantQueries.some((query) => query.supported) ? (
    <BotsState
      title="Bots aren't available"
      description="This environment's server doesn't support bots."
    />
  ) : botId ? (
    <BotsState title="Bot not found" description="This bot may have been removed." />
  ) : (
    <BotsState
      title="No bots yet"
      description="Add a bot folder to the bots directory in your T3 home."
    />
  );
  const selectBot = (entry: typeof selection) =>
    void navigate({
      to: "/bots",
      search: entry ? { env: entry.environmentId, bot: entry.bot.id } : {},
    });
  useEffect(() => {
    if (selection && requestedEnvironmentId === undefined) {
      void navigate({
        to: "/bots",
        search: { env: selection.environmentId, bot: selection.bot.id },
        replace: true,
      });
    }
  }, [navigate, selection, requestedEnvironmentId]);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-2">
            {botId ? (
              <Button
                aria-label="All bots"
                className="md:hidden"
                size="icon-sm"
                variant="ghost"
                onClick={() => selectBot(null)}
              >
                <ArrowLeftIcon />
              </Button>
            ) : null}
            <WorkspaceBreadcrumb ariaLabel="Bots breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current={selected === null}>
                <h1>Bots</h1>
              </WorkspaceBreadcrumbItem>
              {selected ? (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current>
                    <WorkspaceBreadcrumbText title={selected.name}>
                      {selected.name}
                    </WorkspaceBreadcrumbText>
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
            </WorkspaceBreadcrumb>
            {selected ? (
              <Button
                aria-label={`About ${selected.name}`}
                size="icon-sm"
                variant="ghost"
                onClick={() => setInfoOpen(true)}
              >
                <InfoIcon />
              </Button>
            ) : null}
          </div>
        </WorkspacePageHeader>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Bots"
            className={cn(
              "min-h-0 w-full shrink-0 flex-col overflow-y-auto border-border/60 md:flex md:w-72 md:border-r",
              bots.length === 0 ? "hidden md:hidden" : selected || botId ? "hidden" : "flex",
            )}
          >
            {queries.map((query) =>
              query.error ? (
                <BotsState
                  key={query.environmentId}
                  title={`Could not load bots from ${environments.find((environment) => environment.environmentId === query.environmentId)?.label ?? query.environmentId}`}
                  description={query.error}
                  retry={query.refresh}
                />
              ) : query.isLoading && query.data === null ? (
                <BotsState key={query.environmentId} title="Loading bots…" />
              ) : null,
            )}
            {disconnected.map((environment) => (
              <BotsState
                key={environment.environmentId}
                title={`${environment.label} is disconnected`}
                description="Reconnect to message these bots."
              />
            ))}
            {queries.map((query) => (
              <SortableBotList
                key={query.environmentId}
                environmentId={query.environmentId}
                bots={query.data?.bots ?? []}
                refresh={query.refresh}
                environmentLabel={
                  showEnvironmentLabels
                    ? environments.find(
                        (environment) => environment.environmentId === query.environmentId,
                      )?.label
                    : undefined
                }
                selectedId={environmentId === query.environmentId ? selected?.id : undefined}
                onSelect={selectBot}
              />
            ))}
          </nav>

          {selected && environmentId ? (
            <BotChat
              key={`${environmentId}:${selected.id}`}
              bot={selected}
              environmentId={environmentId}
              onRunSettled={selection!.refresh}
            />
          ) : (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center",
                bots.length > 0 && !botId && "hidden md:flex",
              )}
            >
              {bots.length > 0 && !botId ? (
                <p className="text-sm text-muted-foreground">
                  Pick a bot to see your conversation.
                </p>
              ) : (
                pageState
              )}
            </div>
          )}
        </div>
      </div>

      {selected && environmentId ? (
        <BotInfoSheet
          bot={selected}
          environmentId={environmentId}
          open={infoOpen}
          onOpenChange={setInfoOpen}
          onPausedChange={selection!.refresh}
        />
      ) : null}
    </SidebarInset>
  );
}

function BotsState({
  title,
  description,
  retry,
}: {
  readonly title: string;
  readonly description?: string;
  readonly retry?: () => void;
}) {
  return (
    <div
      role="status"
      className="flex min-w-0 flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground"
    >
      <p className="font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm break-words">{description}</p> : null}
      {retry ? (
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function BotListItem(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
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
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.bot.homeThreadId));
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
        disabled={props.disabled}
        aria-label={`Reorder ${props.bot.name}`}
        className="ml-2 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left hover:bg-accent/60",
          props.selected && "bg-accent",
        )}
        onClick={props.onSelect}
      >
        <BotAvatar name={props.bot.name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">{props.bot.name}</span>
          {props.environmentLabel ? (
            <span className="truncate text-muted-foreground text-xs">{props.environmentLabel}</span>
          ) : null}
          <span className="truncate text-muted-foreground text-xs">
            {attentionLabel ??
              (props.bot.paused ? statusLabel : (props.bot.lastReply?.text ?? statusLabel))}
          </span>
        </span>
      </button>
    </div>
  );
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
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const order = resolveBotListOrder(props.bots, pendingOrder, saving);
  const byId = new Map(props.bots.map((bot) => [bot.id, bot]));
  const handleDragEnd = async (event: DragEndEvent) => {
    if (busy.current || event.over === null || event.active.id === event.over.id) return;
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
            return bot ? (
              <BotListItem
                key={id}
                bot={bot}
                environmentId={props.environmentId}
                environmentLabel={props.environmentLabel}
                selected={id === props.selectedId}
                refresh={props.refresh}
                disabled={saving}
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
