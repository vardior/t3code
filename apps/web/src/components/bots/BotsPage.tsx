import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, InfoIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./BotAvatar";
import { isActiveRunStatus } from "./botConversation";
import { BotChat } from "./BotChat";
import { BotInfoSheet } from "./BotInfoSheet";

export function BotsPage({ botId }: { readonly botId: string | undefined }) {
  useEscapeToGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const botsQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.bots.list({ environmentId, input: {} }) : null,
  );
  const navigate = useNavigate();
  const [infoOpen, setInfoOpen] = useState(false);
  const bots = botsQuery.data?.bots ?? [];
  const selected = bots.find((bot) => bot.id === botId) ?? null;
  const selectBot = (id: string | undefined) =>
    void navigate({ to: "/bots", search: id === undefined ? {} : { bot: id } });

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
                onClick={() => selectBot(undefined)}
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
            {botsQuery.error !== null ? (
              <p className="p-4 text-sm text-destructive">Could not load bots: {botsQuery.error}</p>
            ) : bots.length === 0 && botsQuery.data !== null ? (
              <p className="p-4 text-sm text-muted-foreground">
                No bots yet. Point T3CODE_BOTS_DIR at a folder of bots, one subfolder per bot with a
                bot.json.
              </p>
            ) : (
              bots.map((bot) =>
                environmentId ? (
                  <BotListItem
                    key={bot.id}
                    bot={bot}
                    environmentId={environmentId}
                    selected={bot.id === selected?.id}
                    onSelect={() => selectBot(bot.id)}
                  />
                ) : null,
              )
            )}
          </nav>

          {selected && environmentId ? (
            <BotChat
              key={selected.id}
              bot={selected}
              environmentId={environmentId}
              onRunSettled={botsQuery.refresh}
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
          onPausedChange={botsQuery.refresh}
        />
      ) : null}
    </SidebarInset>
  );
}

function BotListItem(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.bot.homeThreadId));
  const working = isActiveRunStatus(shell?.latestRun?.status);
  const lastActivity = shell?.latestRun?.completedAt ?? shell?.updatedAt ?? null;
  const statusLabel = botStatusLabel({ working, paused: props.bot.paused, lastActivity });
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
        <span className="truncate text-muted-foreground text-xs">{statusLabel}</span>
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
