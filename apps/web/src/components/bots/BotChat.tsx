import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createBotChatProjector } from "@t3tools/client-runtime/state/bot-chat-rows";
import {
  botChatHistoryStart,
  botWorkingLabel,
  shouldLoadEarlierBotChatHistory,
} from "@t3tools/client-runtime/state/bot-conversation";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useThreadHistory, useThreadProjection, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotBrowserButton } from "./BotBrowserButton";
import { BotsState } from "./BotsState";
import { createBotTimelineFilter } from "./botTimeline";
import { useBotPreviewShortcuts } from "./useBotPreviewShortcuts";

export function BotsBreadcrumb(props: { readonly botName: string | null }) {
  return (
    <WorkspaceBreadcrumb ariaLabel="Bots breadcrumb" className="min-w-0 flex-1">
      <WorkspaceBreadcrumbItem current={props.botName === null}>
        <h1>Bots</h1>
      </WorkspaceBreadcrumbItem>
      {props.botName !== null ? (
        <>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <WorkspaceBreadcrumbText title={props.botName}>{props.botName}</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
        </>
      ) : null}
    </WorkspaceBreadcrumb>
  );
}

export function BotChat(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly onOpenInfo: () => void;
  readonly onRunSettled: () => void;
}) {
  const { bot, environmentId, onOpenInfo, onRunSettled } = props;
  const threadId = bot.homeThreadId;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  useBotPreviewShortcuts(threadRef);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const history = useThreadHistory(threadRef);
  const detail = useEnvironmentQuery(
    serverEnvironment.bots.get({ environmentId, input: { botId: bot.id } }),
  );
  const projectChat = useMemo(() => createBotChatProjector(), []);
  const items = useMemo(() => {
    const messages = projection?.messages ?? [];
    return projectChat({
      bot,
      detail: detail.data,
      since: botChatHistoryStart(messages, history.hasMoreHistory),
      messages,
      runs: projection?.runs ?? [],
      turnItems: projection?.turnItems ?? [],
    });
  }, [projectChat, bot, detail.data, history.hasMoreHistory, projection]);
  const workingLabel = useMemo(() => botWorkingLabel(projection), [projection]);

  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const visitedReplyAt = useRef<string | null>(null);
  const lastReplyAt = bot.lastReply?.at;
  const lastVisitedAt = shell?.lastVisitedAt;
  useEffect(() => {
    if (lastReplyAt === undefined || lastVisitedAt === undefined) return;
    if (visitedReplyAt.current === lastReplyAt) return;
    if (lastVisitedAt !== null && Date.parse(lastVisitedAt) >= Date.parse(lastReplyAt)) return;
    visitedReplyAt.current = lastReplyAt;
    void visitThread({ environmentId, input: { threadId, visitedAt: lastReplyAt } });
  }, [environmentId, lastReplyAt, lastVisitedAt, threadId, visitThread]);

  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const autoHistory = useRef({ pages: 0, cursor: null as string | null });
  const hasOwnerMessage = items.some((item) => item.kind === "you");
  useEffect(() => {
    if (projection === null) return;
    if (autoHistory.current.cursor === history.historyCursor) return;
    const autoLoadedPages = autoHistory.current.pages;
    if (!shouldLoadEarlierBotChatHistory({ hasOwnerMessage, history, autoLoadedPages })) return;
    autoHistory.current = { pages: autoLoadedPages + 1, cursor: history.historyCursor };
    void loadEarlierHistory({ environmentId, input: { threadId } });
  }, [environmentId, hasOwnerMessage, history, loadEarlierHistory, projection, threadId]);

  const working = workingLabel !== null;
  const settle = useEffectEvent(() => {
    onRunSettled();
    detail.refresh();
  });
  useEffect(() => {
    if (!working) settle();
  }, [working]);

  const archived = shell?.archivedAt != null;
  const header = useMemo(
    () => (
      <BotHeader
        bot={bot}
        environmentId={environmentId}
        archived={archived}
        onOpenInfo={onOpenInfo}
        onUnarchived={onRunSettled}
      />
    ),
    [archived, bot, environmentId, onOpenInfo, onRunSettled],
  );
  const timelineEntries = useMemo(() => createBotTimelineFilter(items), [items]);
  const presentation = useMemo(
    () => ({ header, workingLabel, timelineEntries }),
    [header, timelineEntries, workingLabel],
  );

  if (shell === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>{header}</WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <BotsState
            title={bot.homeThreadMissing ? "This bot's home thread is missing" : "Loading…"}
          />
        </div>
      </div>
    );
  }
  return (
    <ChatView
      environmentId={environmentId}
      threadId={threadId}
      routeKind="server"
      presentation={presentation}
    />
  );
}

function BotHeader(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly archived: boolean;
  readonly onOpenInfo: () => void;
  readonly onUnarchived: () => void;
}) {
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive);
  const [unarchiving, setUnarchiving] = useState(false);
  const unarchive = async () => {
    setUnarchiving(true);
    try {
      await unarchiveThread({
        environmentId: props.environmentId,
        input: { threadId: props.bot.homeThreadId },
      });
      props.onUnarchived();
    } finally {
      setUnarchiving(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 pr-24">
      <BotsBreadcrumb botName={props.bot.name} />
      {props.archived ? (
        <Button size="sm" variant="outline" disabled={unarchiving} onClick={() => void unarchive()}>
          {unarchiving ? "Unarchiving…" : "Unarchive"}
        </Button>
      ) : null}
      <BotBrowserButton environmentId={props.environmentId} threadId={props.bot.homeThreadId} />
      <Button
        aria-label={`About ${props.bot.name}`}
        size="icon-sm"
        variant="ghost"
        onClick={props.onOpenInfo}
      >
        <InfoIcon />
      </Button>
    </div>
  );
}
