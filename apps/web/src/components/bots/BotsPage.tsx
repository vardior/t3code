import { useNavigate } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { resolveBotSelection } from "./botNavigation";
import { refreshEnvironmentBots } from "./useEnvironmentBots";
import { useBotsData } from "./BotsDataProvider";
import { BotsState } from "./BotsState";
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
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const { environments, isReady } = useEnvironments();
  const { bots, queries } = useBotsData();
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
          {selected && environmentId ? (
            <BotChat
              key={`${environmentId}:${selected.id}`}
              bot={selected}
              environmentId={environmentId}
              onRunSettled={selection!.refresh}
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center justify-center">
              {bots.length > 0 && !botId ? (
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm text-muted-foreground">
                    Pick a bot to see your conversation.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (isMobile) setOpenMobile(true);
                      else setOpen(true);
                    }}
                  >
                    Choose a bot
                  </Button>
                </div>
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
