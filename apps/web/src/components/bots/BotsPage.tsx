import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, InfoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { isActiveRunStatus } from "@t3tools/client-runtime/state/bot-conversation";
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
      ? !queries.some((query) => query.environmentId === requestedEnvironmentId)
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
                description="Connect to this environment to see its bots."
              />
            ))}
            {bots.map((entry) => (
              <BotListItem
                key={`${entry.environmentId}:${entry.bot.id}`}
                bot={entry.bot}
                environmentId={entry.environmentId}
                environmentLabel={
                  showEnvironmentLabels
                    ? environments.find(
                        (environment) => environment.environmentId === entry.environmentId,
                      )?.label
                    : undefined
                }
                selected={entry === selection}
                refresh={entry.refresh}
                onSelect={() => selectBot(entry)}
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
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.bot.homeThreadId));
  const working = isActiveRunStatus(shell?.latestRun?.status);
  const lastActivity = shell?.latestRun?.completedAt ?? shell?.updatedAt ?? null;
  const statusLabel = botStatusLabel({ working, paused: props.bot.paused, lastActivity });
  const wasWorking = useRef(working);
  const refresh = props.refresh;
  useEffect(() => {
    if (wasWorking.current && !working) refresh();
    wasWorking.current = working;
  }, [working, refresh]);
  return (
    <button
      type="button"
      aria-current={props.selected ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/60",
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
          {working || props.bot.paused ? statusLabel : (props.bot.lastReply?.text ?? statusLabel)}
        </span>
      </span>
    </button>
  );
}

function botStatusLabel(status: {
  readonly working: boolean;
  readonly paused: boolean;
  readonly lastActivity: string | null;
}) {
  if (status.working) return "Working…";
  if (status.paused) return "Paused";
  if (status.lastActivity) return formatRelativeTimeLabel(status.lastActivity);
  return "Idle";
}
