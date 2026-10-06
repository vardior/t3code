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
import { useEnvironmentBots } from "./useEnvironmentBots";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
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
  const { environments } = useEnvironments();
  const { bots, queries } = useEnvironmentBots();
  const navigate = useNavigate();
  const [infoOpen, setInfoOpen] = useState(false);
  const selection = resolveBotSelection(bots, { bot: botId, env: requestedEnvironmentId });
  const selected = selection?.bot ?? null;
  const environmentId = selection?.environmentId;
  const showEnvironmentLabels = new Set(bots.map((entry) => entry.environmentId)).size > 1;
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
            {selected ? (
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
                  <WorkspaceBreadcrumbItem current>{selected.name}</WorkspaceBreadcrumbItem>
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
              selected ? "hidden" : "flex",
            )}
          >
            {queries.map((query) =>
              query.error ? (
                <p key={query.environmentId} className="p-4 text-sm text-destructive">
                  Could not load bots: {query.error}
                </p>
              ) : null,
            )}
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
            <div className="hidden flex-1 items-center justify-center text-sm text-muted-foreground md:flex">
              {bots.length > 0 ? "Pick a bot to see your conversation." : null}
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

function BotListItem(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly selected: boolean;
  readonly environmentLabel?: string;
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
