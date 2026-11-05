import {
  NavigationRouteContext,
  useIsFocused,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { createBotChatProjector } from "@t3tools/client-runtime/state/bot-chat-rows";
import {
  botChatHistoryStart,
  botWorkingLabel,
  shouldLoadEarlierBotChatHistory,
} from "@t3tools/client-runtime/state/bot-conversation";
import { EnvironmentId, type BotSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Keyboard, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useThreadServerBrowserTabs } from "../../state/preview";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironmentIds } from "../../state/workspace";
import { latestBrowserTab } from "../browser/browserTabs";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { createBotFeedFilter } from "./botFeed";
import { useBotDetail, useBotRunSettlement, useBots } from "./useBots";

type BotChatRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly botId: string;
}>;

export function BotChatRouteScreen({ route }: BotChatRouteProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  return (
    <ScopedBotChat
      key={JSON.stringify([environmentId, route.params.botId])}
      environmentId={environmentId}
      botId={route.params.botId}
    />
  );
}

function ScopedBotChat(props: { readonly environmentId: EnvironmentId; readonly botId: string }) {
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const connected = presentation?.connection.phase === "connected";
  const connectionFailed =
    presentation?.connection.phase === "error" ||
    presentation?.connection.phase === "unsupported" ||
    presentation?.connection.error != null;
  const connectionReason = connected
    ? null
    : presentation === null
      ? "Environment unavailable. Reconnect to message this bot."
      : `${connectionStatusText(presentation.connection)} Reconnect to message this bot.`;
  const bots = useBots(props.environmentId);
  const bot = bots.data?.bots.find((entry) => entry.id === props.botId);
  const navigation = useNavigation();
  if (!bot || bot.homeThreadMissing)
    return (
      <View className="flex-1 bg-screen">
        <AppBar title={bot?.name ?? "Bots"} onBack={() => navigation.goBack()} />
        <Text
          className={
            connectionFailed || (bots.error && connectionReason === null)
              ? "p-6 text-base text-danger-foreground"
              : "p-6 text-base text-foreground-muted"
          }
        >
          {bot
            ? "This bot's home thread is missing"
            : (connectionReason ??
              bots.error ??
              (bots.data === null ? "Loading…" : "Bot unavailable in this environment."))}
        </Text>
        {bots.error ? (
          <Pressable accessibilityRole="button" onPress={bots.refresh} className="p-6">
            <Text className="text-primary-text">Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  return (
    <BotConversation
      key={bot.homeThreadId}
      bot={bot}
      environmentId={props.environmentId}
      refresh={bots.refresh}
    />
  );
}

function BotConversation(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const { bot, environmentId } = props;
  const threadId = bot.homeThreadId;
  const detail = useBotDetail(environmentId, bot.id);
  const thread = useEnvironmentThread(environmentId, threadId);
  const projection = Option.getOrNull(thread.data);
  const history = thread.history;
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
  }, [projectChat, bot, detail.data, projection, history.hasMoreHistory]);
  const workingLabel = useMemo(() => botWorkingLabel(projection), [projection]);

  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const visitedReplyAt = useRef<string | null>(null);
  const lastReplyAt = bot.lastReply?.at;
  const visitedAt = projection?.thread.lastVisitedAt;
  const lastVisitedAt = visitedAt ? DateTime.formatIso(visitedAt) : visitedAt;
  useEffect(() => {
    if (!focused || !appActive || lastReplyAt === undefined || lastVisitedAt === undefined) return;
    if (visitedReplyAt.current === lastReplyAt) return;
    if (lastVisitedAt !== null && Date.parse(lastVisitedAt) >= Date.parse(lastReplyAt)) return;
    visitedReplyAt.current = lastReplyAt;
    void visitThread({ environmentId, input: { threadId, visitedAt: lastReplyAt } });
  }, [appActive, environmentId, focused, lastReplyAt, lastVisitedAt, threadId, visitThread]);

  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const autoHistory = useRef({ pages: 0, cursor: null as string | null });
  const hasOwnerMessage = items.some((item) => item.kind === "you");
  useEffect(() => {
    if (projection === null || thread.status === "deleted") return;
    if (autoHistory.current.cursor === history.historyCursor) return;
    const autoLoadedPages = autoHistory.current.pages;
    if (!shouldLoadEarlierBotChatHistory({ hasOwnerMessage, history, autoLoadedPages })) return;
    autoHistory.current = { pages: autoLoadedPages + 1, cursor: history.historyCursor };
    void loadEarlier({ environmentId, input: { threadId } });
  }, [environmentId, hasOwnerMessage, history, loadEarlier, projection, thread.status, threadId]);

  const refreshBots = props.refresh;
  const refreshDetail = detail.refresh;
  const refresh = useCallback(() => {
    refreshBots();
    refreshDetail();
  }, [refreshBots, refreshDetail]);
  useBotRunSettlement(workingLabel !== null, refresh);

  const knownEnvironmentIds = useWorkspaceEnvironmentIds();
  const feed = useMemo(
    () => createBotFeedFilter({ items, threadId, knownEnvironmentIds }),
    [items, knownEnvironmentIds, threadId],
  );
  const archived =
    projection !== null ? projection.thread.archivedAt !== null : bot.homeThreadArchived === true;
  const header = (
    <BotHeader bot={bot} environmentId={environmentId} archived={archived} onUnarchived={refresh} />
  );
  const presentation = { header, feed, workingLabel };
  const route = useRoute();
  const threadRoute = useMemo(
    () => ({ ...route, params: { environmentId, threadId } }),
    [environmentId, route, threadId],
  );

  return (
    <NavigationRouteContext.Provider value={threadRoute}>
      <ThreadRouteScreen route={threadRoute} presentation={presentation} />
    </NavigationRouteContext.Provider>
  );
}

function BotHeader(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly archived: boolean;
  readonly onUnarchived: () => void;
}) {
  const { bot, environmentId } = props;
  const navigation = useNavigation();
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const browserTabs = useThreadServerBrowserTabs({
    environmentId,
    threadId: bot.homeThreadId,
    enabled: serverConfig?.environment.capabilities.serverBrowser === true,
  });
  const browserTab = latestBrowserTab(browserTabs.tabs);
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, "unarchive thread");
  const [unarchiving, setUnarchiving] = useState(false);
  const unarchive = async () => {
    if (unarchiving) return;
    setUnarchiving(true);
    try {
      await unarchiveThread({ environmentId, input: { threadId: bot.homeThreadId } });
      props.onUnarchived();
    } finally {
      setUnarchiving(false);
    }
  };
  return (
    <AppBar
      title={bot.name}
      subtitle={props.archived ? "Home thread archived" : bot.paused ? "Paused" : undefined}
      onBack={() => navigation.goBack()}
      trailing={
        browserTab ? (
          <ScreenHeaderButton
            accessibilityLabel="Open browser"
            icon="globe"
            label="Open browser"
            onPress={() => {
              Keyboard.dismiss();
              navigation.navigate("ThreadBrowserPreview", {
                environmentId,
                threadId: bot.homeThreadId,
                tabId: browserTab.tabId,
              });
            }}
          />
        ) : null
      }
      actions={[
        ...(props.archived
          ? [
              {
                accessibilityLabel: unarchiving ? "Unarchiving…" : "Unarchive home thread",
                icon: "archivebox" as const,
                onPress: () => void unarchive(),
              },
            ]
          : []),
        {
          accessibilityLabel: `About ${bot.name}`,
          icon: "info.circle" as const,
          onPress: () => navigation.navigate("BotInfo", { environmentId, botId: bot.id }),
        },
      ]}
    />
  );
}
