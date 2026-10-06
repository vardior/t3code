import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList, useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { createBotChatProjector } from "@t3tools/client-runtime/state/bot-chat-rows";
import {
  botChatHistoryStart,
  botConversationStatus,
  isBotWorking,
  isBotQueueHeld,
} from "@t3tools/client-runtime/state/bot-conversation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  MessageId,
  type BotSummary,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert, Platform, Pressable, View, type ViewInstance } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerEditor } from "../../components/ComposerEditor";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { ScreenHeader } from "../../components/ScreenHeader";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useComposerMediaAttachments } from "../../state/use-composer-media-attachments";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { prepareComposerDraftAttachments } from "../../state/prepare-composer-draft-attachments";
import {
  composerAttachmentUploadsAtom,
  composerAttachmentsStillUploading,
  composerAttachmentUploadBlockReason,
} from "../../state/composer-attachment-uploads";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentThread, environmentThreads, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotChatRow } from "./BotChatRow";
import { botChatScrollReducer, botComposerReducer, initialBotComposer } from "./botChat.logic";
import { useBots, useBotDetail, useBotRunSettlement } from "./useBots";

const EMPTY_SCHEDULES: ReadonlyArray<ScheduledTask> = [];

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
  const detail = useBotDetail(environmentId, bot.id);
  const thread = useEnvironmentThread(environmentId, bot.homeThreadId);
  const projection = Option.getOrNull(thread.data);
  const retryThread = useAtomRefresh(environmentThreads.stateAtom(environmentId, bot.homeThreadId));
  const threadError = Option.getOrNull(thread.error);
  const homeThreadArchived =
    projection !== null ? projection.thread.archivedAt !== null : bot.homeThreadArchived === true;
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, "unarchive thread");
  const [unarchiving, setUnarchiving] = useState(false);
  const unarchive = async () => {
    if (unarchiving) return;
    setUnarchiving(true);
    try {
      await unarchiveThread({ environmentId, input: { threadId: bot.homeThreadId } });
      props.refresh();
    } finally {
      setUnarchiving(false);
    }
  };
  const unavailableReason =
    thread.status === "deleted"
      ? "This bot's home thread is missing"
      : homeThreadArchived
        ? "Home thread archived"
        : threadError !== null
          ? `Could not load this bot's home thread: ${threadError}`
          : projection === null
            ? "Loading this bot's home thread…"
            : null;
  const schedules = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const projectChat = useMemo(() => createBotChatProjector(), []);
  const items = useMemo(
    () =>
      projectChat({
        bot,
        detail: detail.data,
        since: botChatHistoryStart(projection?.messages ?? [], thread.history.hasMoreHistory),
        messages: projection?.messages ?? [],
        runs: projection?.runs ?? [],
        turnItems: projection?.turnItems ?? [],
      }),
    [projectChat, bot, detail.data, projection, thread.history.hasMoreHistory],
  );
  const status = useMemo(
    () => (projection === null ? { kind: "idle" as const } : botConversationStatus(projection)),
    [projection],
  );
  const working = isBotWorking(projection?.runs ?? []);
  const queueHeld = isBotQueueHeld(projection?.runs ?? []);
  const refreshBots = props.refresh;
  const refreshDetail = detail.refresh;
  const refresh = useCallback(() => {
    refreshBots();
    refreshDetail();
  }, [refreshBots, refreshDetail]);
  useBotRunSettlement(working, refresh);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerContentHeight, setComposerContentHeight] = useState(40);
  const composerBottomInset = (Platform.OS === "android" ? isKeyboardVisible : composerFocused)
    ? 0
    : Math.max(insets.bottom, 12);
  const nativeInsetOvercount = Platform.OS === "ios" ? insets.bottom : 0;
  const listRef = useRef<LegendListRef>(null);
  const composerOverlayRef = useRef<ViewInstance>(null);
  const followingEnd = useRef(true);
  const [togglingDisclosureKey, setTogglingDisclosureKey] = useState<string | null>(null);
  const lastItem = items.at(-1);
  const previousEnd = useRef({ length: 0, lastItem });
  useLayoutEffect(() => {
    const endChanged =
      items.length > previousEnd.current.length || lastItem !== previousEnd.current.lastItem;
    previousEnd.current = { length: items.length, lastItem };
    if (items.length > 0 && endChanged && followingEnd.current)
      void listRef.current?.scrollToEnd({ animated: false });
  }, [items.length, lastItem]);
  const onDisclosureToggle = useCallback((itemId: string) => {
    setTogglingDisclosureKey(itemId);
    followingEnd.current = botChatScrollReducer(followingEnd.current, {
      type: "disclosure",
      atEnd: listRef.current?.getState().isWithinMaintainScrollAtEndThreshold ?? false,
    });
  }, []);
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
  const draftKey = `${environmentId}:bot-chat-${encodeURIComponent(bot.homeThreadId)}`;
  const draft = useComposerDraft(draftKey);
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const getDraftKey = useCallback(() => draftKey, [draftKey]);
  const { onPickDraftMedia, onRemoveDraftImage } = useComposerMediaAttachments({
    getDraftKey,
    serverConfig,
    imagesOnly: true,
    appendReference: false,
  });
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const uploadInput = {
    environmentId,
    attachments: draft.attachments,
    serverConfig,
    states: uploadStates,
  };
  const attachmentsUploading = composerAttachmentsStillUploading(uploadInput);
  const uploadError = composerAttachmentUploadBlockReason({ ...uploadInput, connected: true });
  const pending = useRef(false);
  const sending = composer.pendingRequestId !== null;
  const busy = sending;
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const resumeQueue = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const [resuming, setResuming] = useState(false);
  const resume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await resumeQueue({ environmentId, input: { threadId: bot.homeThreadId } });
      refresh();
    } finally {
      setResuming(false);
    }
  };
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await interruptTurn({ environmentId, input: { threadId: bot.homeThreadId } });
    } finally {
      setStopping(false);
    }
  };
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const ready =
    projection !== null && thread.status === "live" && threadError === null && !homeThreadArchived;
  const canSend =
    ready &&
    !busy &&
    !attachmentsUploading &&
    uploadError === null &&
    (draft.text.trim().length > 0 || draft.attachments.length > 0);
  usePreventRemove(busy, () =>
    Alert.alert("Command pending", "Wait for the bot command to finish before leaving."),
  );
  const openThread = useCallback(
    (threadId: ThreadId, targetEnvironmentId = environmentId) => {
      if (!pending.current)
        navigation.navigate("Thread", { environmentId: targetEnvironmentId, threadId });
    },
    [navigation, environmentId],
  );
  const send = async () => {
    if (!canSend || projection === null || pending.current) return;
    pending.current = true;
    const requestId = uuidv4();
    const sentText = draft.text;
    dispatch({ type: "send", requestId, hasContent: true });
    let success = false;
    let error: string | null = null;
    try {
      const prepared = await prepareComposerDraftAttachments({
        draftKey,
        environmentId,
        supportsImageUploads: serverConfig?.environment.capabilities.attachmentUploads === true,
      });
      if (prepared.status !== "ready") return;
      const result = await startTurn({
        environmentId,
        input: {
          threadId: bot.homeThreadId,
          message: {
            messageId: MessageId.make(requestId),
            role: "user",
            text: sentText.trim(),
            attachments: prepared.attachments,
          },
          runtimeMode: projection.thread.runtimeMode,
          interactionMode: projection.thread.interactionMode,
          dispatchMode: "queue",
        },
      });
      success = result._tag === "Success";
      const failure =
        result._tag === "Success" || isAtomCommandInterrupted(result)
          ? null
          : squashAtomCommandFailure(result);
      error =
        failure === null ? null : failure instanceof Error ? failure.message : String(failure);
      if (success && getComposerDraftSnapshot(draftKey).text === sentText)
        clearComposerDraftContent(draftKey);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      pending.current = false;
      dispatch({ type: "settled", scope: composer.scope, requestId, success, error });
    }
  };
  const history = thread.history;
  const historyError = history.error;
  const error = composer.error ?? uploadError;
  const conversationShown = projection !== null && thread.status !== "deleted";
  const threadLoadFailed = threadError !== null && thread.status !== "deleted";
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
          data={conversationShown ? items : []}
          extraData={schedules.data}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <BotChatRow
              item={item}
              botName={bot.name}
              environmentId={environmentId}
              schedules={schedules.data?.tasks ?? EMPTY_SCHEDULES}
              onOpenThread={openThread}
              onPreview={setPreview}
              onDisclosureToggle={onDisclosureToggle}
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
          onScrollBeginDrag={() => {
            followingEnd.current = botChatScrollReducer(followingEnd.current, { type: "drag" });
          }}
          initialScrollAtEnd
          alignItemsAtEnd
          maintainScrollAtEnd={{
            animated: false,
            on: { dataChange: true, itemLayout: false, layout: true },
          }}
          maintainVisibleContentPosition={togglingDisclosureKey === null}
          onItemSizeChanged={({ itemKey }) => {
            if (itemKey === togglingDisclosureKey) setTogglingDisclosureKey(null);
          }}
          getItemType={(item) => item.kind}
          ListHeaderComponent={
            unavailableReason === null && (history.hasMoreHistory || historyError) ? (
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
                  <Text className="text-sm text-danger-foreground">{historyError}</Text>
                ) : null}
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            threadLoadFailed ? undefined : (
              <View
                className="gap-3 py-6"
                style={
                  Platform.OS === "android" ? { marginBottom: initialComposerHeight } : undefined
                }
              >
                <Text className="text-center text-sm text-foreground-muted">
                  {unavailableReason ?? `Nothing between you and ${bot.name} yet.`}
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            <View className="gap-2">
              {unavailableReason !== null ? undefined : status.kind === "working" ? (
                <View className="self-start flex-row items-center gap-2 rounded-2xl bg-card px-3.5 py-2">
                  <Text className="text-sm text-foreground-muted">Working…</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Stop agent"
                    accessibilityState={{ disabled: stopping || !ready }}
                    disabled={stopping || !ready}
                    onPress={() => void stop()}
                    className="rounded-full border border-border-subtle px-3 py-2 active:opacity-70 disabled:opacity-50"
                  >
                    <Text className="text-sm text-foreground-muted">
                      {stopping ? "Stopping…" : "Stop"}
                    </Text>
                  </Pressable>
                </View>
              ) : status.kind === "needs-attention" || status.kind === "failed" ? (
                <View className="self-start gap-2 rounded-2xl bg-card px-3.5 py-2">
                  <Text
                    accessibilityRole={status.kind === "failed" ? "alert" : undefined}
                    className={
                      status.kind === "failed"
                        ? "text-sm text-danger-foreground"
                        : "text-sm text-foreground"
                    }
                  >
                    {status.kind === "failed"
                      ? `Run failed${status.error ? `: ${status.error}` : "."}`
                      : status.request === "approval"
                        ? "Needs your approval"
                        : "Needs your input"}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => openThread(bot.homeThreadId)}
                    className="self-start rounded-full border border-border-subtle px-3 py-2 active:opacity-70 disabled:opacity-50"
                  >
                    <Text className="text-sm text-primary-text">
                      {status.kind === "failed"
                        ? "Open thread"
                        : status.request === "approval"
                          ? "Review approval in thread"
                          : "Answer in thread"}
                    </Text>
                  </Pressable>
                </View>
              ) : status.kind === "stopped" ? (
                <Text className="self-start rounded-2xl bg-card px-3.5 py-2 text-sm text-foreground-muted">
                  Stopped
                </Text>
              ) : undefined}
              {queueHeld ? (
                <View className="self-start flex-row items-center gap-2 rounded-2xl bg-card px-3.5 py-2">
                  <Text className="text-sm text-foreground-muted">Queue held</Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={resuming || !ready}
                    onPress={() => void resume()}
                    className="rounded-full border border-border-subtle px-3 py-2 active:opacity-70 disabled:opacity-50"
                  >
                    <Text className="text-sm text-primary-text">
                      {resuming ? "Resuming…" : "Resume"}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
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
          {threadLoadFailed ? (
            <View className="flex-row items-center gap-2">
              <Text accessibilityRole="alert" className="flex-1 text-sm text-danger-foreground">
                {unavailableReason}
              </Text>
              <Pressable accessibilityRole="button" onPress={retryThread} className="p-2">
                <Text className="text-sm text-primary-text">Try again</Text>
              </Pressable>
            </View>
          ) : null}
          {unavailableReason && !threadLoadFailed ? (
            <Text className="text-sm text-foreground-muted">{unavailableReason}</Text>
          ) : null}
          {homeThreadArchived && thread.status !== "deleted" ? (
            <Pressable
              accessibilityRole="button"
              disabled={unarchiving}
              onPress={() => void unarchive()}
              className="self-start rounded-full border border-border-subtle px-3 py-2 active:opacity-70 disabled:opacity-50"
            >
              <Text className="text-sm text-primary-text">
                {unarchiving ? "Unarchiving…" : "Unarchive"}
              </Text>
            </Pressable>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {error}
            </Text>
          ) : null}
          {draft.attachments.length > 0 ? (
            <ComposerAttachmentStrip
              environmentId={environmentId}
              attachments={draft.attachments}
              onRemove={busy ? () => undefined : onRemoveDraftImage}
              onPressPreview={setPreview}
            />
          ) : null}
          <View className="flex-row items-end gap-2">
            <ComposerAttachmentButton
              supportsFiles={false}
              disabled={!ready || busy}
              onPickMedia={onPickDraftMedia}
              onPickFiles={onPickDraftMedia}
            />
            <View className="min-w-0 flex-1 rounded-2xl bg-subtle px-3 py-2">
              <ComposerEditor
                value={draft.text}
                onChangeText={(text) => {
                  setComposerDraftText(draftKey, text);
                  dispatch({ type: "edit" });
                }}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                environmentId={environmentId}
                placeholder={`Message ${bot.name}`}
                readOnly={!ready || busy}
                multiline
                onContentHeightChange={setComposerContentHeight}
                scrollEnabled={composerContentHeight >= 160}
                style={{ height: Math.max(40, Math.min(160, composerContentHeight)) }}
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
