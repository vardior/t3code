import {
  botThreadShellStatus,
  mainViewEntries,
  type MainViewBotEntry,
} from "@t3tools/client-runtime/state/bot-conversation";
import { countOpenItems } from "@t3tools/client-runtime/state/open-items";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import Sidebar from "../Sidebar";
import { SidebarThreadHeader } from "../sidebar/SidebarThreadHeader";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import type { SidebarRouteReveal } from "../sidebar/routeReveal";
import { Button } from "../ui/button";
import { SidebarGroup, useSidebar } from "../ui/sidebar";
import { BotAvatar } from "./BotAvatar";
import { useBotsData } from "./BotsDataProvider";
import { BotsState } from "./BotsState";
import { parseBotsSearch, resolveBotSelection } from "./botNavigation";

export function BotsSidebar() {
  const gt = useGT();
  const { bots, queries } = useBotsData();
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const projects = useProjects();
  const newThreadContext = useHandleNewThread();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const search = useLocation({ select: (location) => parseBotsSearch(location.search) });
  const selected = resolveBotSelection(bots, search);
  const [query, setQuery] = useState("");
  const [routeReveal] = useState<SidebarRouteReveal>(() => ({
    observedKey: null,
    pendingKey: null,
  }));
  const searchInputRef = useRef<HTMLInputElement>(null);
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const allEntries = mainViewEntries({ threads, bots });
  const needsYouCount = allEntries.filter((entry) => entry.attention === "needs-you").length;
  const searchQuery = query.trim().toLocaleLowerCase();
  const entries =
    searchQuery.length === 0
      ? allEntries
      : allEntries.filter((entry) =>
          entry.kind === "bot"
            ? entry.bot.name.toLocaleLowerCase().includes(searchQuery) ||
              entry.bot.id.toLocaleLowerCase().includes(searchQuery)
            : entry.thread.title.toLocaleLowerCase().includes(searchQuery),
        );
  const refreshByEnvironment = new Map(
    queries.map((entry) => [entry.environmentId, entry.refresh]),
  );
  const labelByEnvironment = new Map(
    environments.map((entry) => [entry.environmentId, entry.label]),
  );

  return (
    <Sidebar
      routeReveal={routeReveal}
      mainView={{
        items: entries.map((entry) =>
          entry.kind === "thread"
            ? { thread: entry.thread }
            : {
                botRow: (
                  <BotListItem
                    key={`bot:${entry.environmentId}:${entry.bot.id}`}
                    entry={entry}
                    selected={
                      selected?.environmentId === entry.environmentId &&
                      selected.bot.id === entry.bot.id
                    }
                    environmentLabel={
                      environments.length > 1
                        ? labelByEnvironment.get(entry.environmentId)
                        : undefined
                    }
                    refresh={refreshByEnvironment.get(entry.environmentId)}
                    onSelect={() => {
                      closeMobileSidebar();
                      void navigate({
                        to: "/bots",
                        search: { env: entry.environmentId, bot: entry.bot.id },
                      });
                    }}
                  />
                ),
              },
        ),
        fixedHeader: (
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
              searchLabel={gt("Search bots and threads")}
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
        ),
        states: (
          <>
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
          </>
        ),
      }}
    />
  );
}

function BotListItem({
  entry: { bot, shell, attention, activityAt },
  selected,
  environmentLabel,
  refresh,
  onSelect,
}: {
  readonly entry: MainViewBotEntry;
  readonly selected: boolean;
  readonly environmentLabel: string | undefined;
  readonly refresh: (() => void) | undefined;
  readonly onSelect: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const now = useNowMinute();
  const working = botThreadShellStatus(shell, bot) === "working";
  const quiet = attention === null;
  const error = shell?.source.lastError?.trim();
  const detail =
    attention === "needs-you"
      ? shell?.hasPendingApprovals
        ? gt("Needs approval")
        : shell?.hasPendingUserInput
          ? gt("Needs input")
          : gt("{count, plural, one {# open item} other {# open items}}", {
              count: countOpenItems(shell?.openItems),
            })
      : attention === "failed"
        ? error
          ? gt("Failed · {error}", { error })
          : gt("Failed")
        : attention === "unread"
          ? (bot.lastReply?.text ?? gt("Unread reply"))
          : null;
  const name = bot.paused ? gt("{name} · paused", { name: bot.name }) : bot.name;
  const time = working
    ? gt("working…")
    : activityAt === null
      ? ""
      : formatRelativeTimeLabel(activityAt, Date.parse(`${now}:00.000Z`), m);
  const wasWorking = useRef(working);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh server bot data when its thread run settles
  useEffect(() => {
    if (wasWorking.current && !working) refresh?.();
    wasWorking.current = working;
  }, [working, refresh]);
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        aria-label={[name, environmentLabel, detail, time].filter(Boolean).join(", ")}
        className={cn(
          "flex w-full min-w-0 gap-3 rounded-md px-3 text-left hover:bg-accent/60",
          quiet ? "items-center py-1" : "items-start py-2",
          selected && "bg-accent",
        )}
        onClick={onSelect}
      >
        <BotAvatar name={bot.name} size={quiet ? "xs" : "sm"} />
        <span className="min-w-0 flex-1">
          <span className="flex min-h-5 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                quiet ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {name}
            </span>
            {!quiet ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
            {time ? <span className="shrink-0 text-xs text-muted-foreground">{time}</span> : null}
          </span>
          {detail !== null ? (
            <span className="block truncate text-xs text-foreground">{detail}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
