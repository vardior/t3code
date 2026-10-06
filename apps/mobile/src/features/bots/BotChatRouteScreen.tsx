import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { buildBotChat, isBotWorking } from "@t3tools/client-runtime/state/bot-conversation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, MessageId, type BotSummary, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert, Platform, Pressable, View, type ViewInstance } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ComposerEditor } from "../../components/ComposerEditor";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { ScreenHeader } from "../../components/ScreenHeader";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotChatRow } from "./BotChatRow";
import { botComposerReducer, initialBotComposer } from "./botChat.logic";
import { useBots, useBotRunSettlement } from "./useBots";

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
  const bots = useBots(props.environmentId);
  const bot = bots.data?.bots.find((entry) => entry.id === props.botId);
  const navigation = useNavigation();
  if (!bot)
    return (
      <View className="flex-1 bg-screen">
        <ScreenHeader title="Bots" sidebar={false} onBack={() => navigation.goBack()} />
        <Text className="p-6 text-base text-foreground-muted">
          {bots.error ?? (bots.data === null ? "Loading…" : "Bot unavailable in this environment.")}
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
  const thread = useEnvironmentThread(environmentId, bot.homeThreadId);
  const projection = Option.getOrNull(thread.data);
  const schedules = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const items = useMemo(
    () =>
      buildBotChat({
        bot,
        messages: projection?.messages ?? [],
        runs: projection?.runs ?? [],
        turnItems: projection?.turnItems ?? [],
      }),
    [bot, projection],
  );
  const working = isBotWorking(projection?.runs ?? []);
  useBotRunSettlement(working, props.refresh);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const [composerFocused, setComposerFocused] = useState(false);
  const composerBottomInset = (Platform.OS === "android" ? isKeyboardVisible : composerFocused)
    ? 0
    : Math.max(insets.bottom, 12);
  const nativeInsetOvercount = Platform.OS === "ios" ? insets.bottom : 0;
  const listRef = useRef<LegendListRef>(null);
  const composerOverlayRef = useRef<ViewInstance>(null);
  const initialComposerHeight = 88 + Math.max(insets.bottom, 12) - nativeInsetOvercount;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    initialComposerHeight,
    -nativeInsetOvercount,
    Platform.OS === "ios" ? 220 : 0,
  );
  const listMountKey = projection === null ? "loading" : "loaded";
  useLayoutEffect(() => {
    if (listMountKey === "loading") return;
    listRef.current?.reportContentInset({ bottom: contentInsetEndAdjustment.value });
  }, [contentInsetEndAdjustment, listMountKey]);
  const [composer, dispatch] = useReducer(
    botComposerReducer,
    JSON.stringify([environmentId, bot.id]),
    initialBotComposer,
  );
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const pending = useRef(false);
  const sending = composer.pendingRequestId !== null;
  const busy = sending;
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const ready = projection !== null && thread.status === "live";
  const canSend = ready && !busy && composer.text.trim().length > 0;
  usePreventRemove(busy, () =>
    Alert.alert("Command pending", "Wait for the bot command to finish before leaving."),
  );
  const openThread = (threadId: ThreadId) => {
    if (!pending.current) navigation.navigate("Thread", { environmentId, threadId });
  };
  const send = async () => {
    if (!canSend || projection === null || pending.current) return;
    pending.current = true;
    const requestId = uuidv4();
    dispatch({ type: "send", requestId });
    const result = await startTurn({
      environmentId,
      input: {
        threadId: bot.homeThreadId,
        message: {
          messageId: MessageId.make(requestId),
          role: "user",
          text: composer.text.trim(),
          attachments: [],
        },
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
        dispatchMode: "queue",
      },
    });
    pending.current = false;
    const failure =
      result._tag === "Success" || isAtomCommandInterrupted(result)
        ? null
        : squashAtomCommandFailure(result);
    dispatch({
      type: "settled",
      scope: composer.scope,
      requestId,
      success: result._tag === "Success",
      error: failure === null ? null : failure instanceof Error ? failure.message : String(failure),
    });
  };
  const history = thread.history;
  const historyError = history.error;
  const error = composer.error ?? Option.getOrNull(thread.error);
  return (
    <View className="flex-1 bg-screen">
      <ScreenHeader
        title={bot.name}
        subtitle={bot.paused ? "Paused" : undefined}
        sidebar={false}
        onBack={() => navigation.goBack()}
        actions={[
          {
            accessibilityLabel: `About ${bot.name}`,
            icon: "info.circle",
            disabled: busy,
            onPress: () => navigation.navigate("BotInfo", { environmentId, botId: bot.id }),
          },
        ]}
      />
      <View className="flex-1">
        <KeyboardAwareLegendList
          key={listMountKey}
          ref={listRef}
          data={items}
          extraData={schedules.data}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <BotChatRow
              item={item}
              botName={bot.name}
              environmentId={environmentId}
              schedules={schedules.data?.tasks ?? []}
              onOpenThread={openThread}
              onPreview={setPreview}
            />
          )}
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          contentInsetEndStaticAdjustment={nativeInsetOvercount}
          adjustedInsetCompensation={nativeInsetOvercount}
          {...(Platform.OS === "android"
            ? { contentInset: { bottom: initialComposerHeight } }
            : {})}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 18, gap: 12 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialScrollAtEnd
          alignItemsAtEnd
          maintainScrollAtEnd={{
            animated: false,
            on: { dataChange: true, itemLayout: true, layout: true },
          }}
          maintainVisibleContentPosition
          getItemType={(item) => item.kind}
          ListHeaderComponent={
            history.hasMoreHistory || historyError ? (
              <View className="gap-2">
                <Pressable
                  accessibilityRole="button"
                  disabled={history.loading}
                  onPress={() =>
                    void loadEarlier({ environmentId, input: { threadId: bot.homeThreadId } })
                  }
                  className="self-center rounded-full border border-border-subtle px-4 py-2 disabled:opacity-50"
                >
                  <Text className="text-sm text-foreground-muted">
                    {history.loading ? "Loading…" : "Load earlier history"}
                  </Text>
                </Pressable>
                {historyError ? (
                  <Text className="text-sm text-destructive">{historyError}</Text>
                ) : null}
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            <Text className="py-6 text-center text-sm text-foreground-muted">
              {projection === null ? "Loading…" : `Nothing between you and ${bot.name} yet.`}
            </Text>
          }
          ListFooterComponent={
            working ? (
              <Text className="self-start rounded-2xl bg-card px-3.5 py-2 text-sm text-foreground-muted">
                Working…
              </Text>
            ) : undefined
          }
        />
      </View>
      <KeyboardStickyView
        enabled={Platform.OS === "ios" || isKeyboardVisible}
        pointerEvents="box-none"
        style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
        offset={{ closed: 0, opened: 0 }}
      >
        <View
          ref={composerOverlayRef}
          onLayout={onComposerLayout}
          className="absolute bottom-0 left-0 right-0 gap-2 border-t border-border-subtle bg-screen px-4 pt-3"
          style={{ paddingBottom: composerBottomInset }}
        >
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-destructive">
              {error}
            </Text>
          ) : null}
          <View className="flex-row items-end gap-2">
            <View className="min-w-0 flex-1 rounded-2xl bg-subtle px-3 py-2">
              <ComposerEditor
                value={composer.text}
                onChangeText={(text) => dispatch({ type: "edit", text })}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                environmentId={environmentId}
                placeholder={`Message ${bot.name}`}
                readOnly={!ready || busy}
                multiline
                scrollEnabled
                style={{ minHeight: 40, maxHeight: 160 }}
                onSubmit={() => void send()}
                submitTitle={`Send to ${bot.name}`}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={() => void send()}
              className="h-11 justify-center rounded-full bg-primary px-4 disabled:opacity-50"
            >
              <Text className="font-t3-medium text-primary-foreground">
                {sending ? "Sending…" : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardStickyView>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}
