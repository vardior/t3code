import { useAtomValue } from "@effect/atom-react";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type ModelSelection,
  type BotSummary,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { type ComponentProps, useCallback, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { threadAllowsProviderSwitch } from "../../state/thread-provider-switching";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";
import { editDraft } from "../settings/scheduledTaskDraft";
import { formatNextScheduledTaskRun } from "../settings/scheduledTaskPresentation";
import { describeSchedule } from "../settings/SettingsScheduledTasksRouteScreen";
import { BotMarkdown } from "./BotMarkdown";
import { useBots, useBotDetail } from "./useBots";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export function BotInfoSheet({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly botId: string;
}>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const bots = useBots(environmentId);
  const bot = bots.data?.bots.find((entry) => entry.id === route.params.botId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {bot ? (
        <BotInfo key={bot.id} bot={bot} environmentId={environmentId} refresh={bots.refresh} />
      ) : (
        <View className="gap-2">
          <Text className="text-base text-foreground-muted">
            {bots.error ??
              (bots.data === null ? "Loading…" : "Bot unavailable in this environment.")}
          </Text>
          {bots.error ? (
            <Pressable accessibilityRole="button" onPress={bots.refresh}>
              <Text className="text-primary-text">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="bot-info-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="About bot"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar sheet title="About bot" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}

function useBotModelSession(environmentId: EnvironmentId, homeThreadId: ThreadId) {
  const shell = useThreadShell(scopeThreadRef(environmentId, homeThreadId));
  const thread = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, homeThreadId)),
  );
  const config = useEnvironmentServerConfig(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, { reportFailure: false });
  const ownerId = scopedThreadKey(environmentId, homeThreadId);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = shell?.modelSelection ?? null;
  const canSwitchProvider = threadAllowsProviderSwitch({
    thread: shell,
    projection: thread?.projection,
  });
  const models = useMemo(
    () =>
      buildModelOptions(
        config,
        selection,
        canSwitchProvider ? undefined : selection?.instanceId,
        shell?.projectId ?? null,
      ),
    [config, selection, canSwitchProvider, shell?.projectId],
  );
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === selection?.instanceId &&
      option.selection.model === selection.model,
  );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: selection?.options,
      }),
    [selectedOption?.capabilities, selection?.options],
  );
  const session = useMemo(() => {
    const save = async (modelSelection: ModelSelection) => {
      if (pending.current || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
        return;
      pending.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await updateMetadata({
          environmentId,
          input: { threadId: homeThreadId, modelSelection },
        });
        if (result._tag === "Success") {
          updateComposerDraftSettings(ownerId, { modelSelection });
        } else if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      } finally {
        pending.current = false;
        setBusy(false);
      }
    };

    return shell && selection
      ? ({
          environmentId,
          projectId: shell.projectId,
          providerInstanceId: selection.instanceId,
          providerGroups,
          selectedModel: selection,
          prompt: "",
          onPromptChange: () => undefined,
          onSelectModel: (option) => void save(withRememberedModelOptions(option.selection)),
          optionDescriptors,
          onUpdateOptionSelections: (options) => {
            rememberModelOptions(selection.instanceId, selection.model, options);
            void save({ ...selection, options });
          },
          runtimeMode: shell.runtimeMode,
          onUpdateRuntimeMode: (runtimeMode) => {
            if (
              pending.current ||
              !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
            )
              return;
            void setRuntimeMode({
              environmentId,
              input: { threadId: homeThreadId, runtimeMode },
            }).then((result) => {
              if (result._tag === "Success") updateComposerDraftSettings(ownerId, { runtimeMode });
              else if (!isAtomCommandInterrupted(result)) {
                const failure = squashAtomCommandFailure(result);
                setError(failure instanceof Error ? failure.message : String(failure));
              }
            });
          },
        } satisfies Omit<ComponentProps<typeof ThreadSettingsPickerScreen>, "onClose">)
      : null;
  }, [
    shell,
    selection,
    ownerId,
    environmentId,
    providerGroups,
    optionDescriptors,
    setRuntimeMode,
    homeThreadId,
  ]);
  return { session, selection, selectedOption, config, canOperate, busy, error };
}

function BotModelPicker(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
}) {
  const { bot, environmentId } = props;
  const navigation = useNavigation();
  const { session, selection, selectedOption, config, canOperate, busy, error } =
    useBotModelSession(environmentId, bot.homeThreadId);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose bot model and effort"
        disabled={!selection || !config || !canOperate || busy}
        className="px-4 py-3 active:opacity-70 disabled:opacity-50"
        onPress={() => {
          if (!session) return;
          navigation.dispatch(
            StackActions.push("BotModelSettings", { environmentId, threadId: bot.homeThreadId }),
          );
        }}
      >
        <Text className="text-base text-foreground">
          {selectedOption?.label ?? selection?.model ?? "Model unavailable"}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function BotModelSettingsRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>) {
  const navigation = useNavigation();
  const { session, error } = useBotModelSession(
    EnvironmentId.make(route.params.environmentId),
    ThreadId.make(route.params.threadId),
  );
  if (!session) return <View className="flex-1 bg-sheet" />;
  return (
    <View className="flex-1 bg-sheet">
      {error ? (
        <Text accessibilityRole="alert" className="px-4 pt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <ThreadSettingsPickerScreen {...session} onClose={() => navigation.goBack()} />
    </View>
  );
}

function BotInfo(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const { bot, environmentId } = props;
  const [pauseResult, setPauseResult] = useState<{ bot: BotSummary; paused: boolean } | null>(null);
  const paused = pauseResult?.bot === bot ? pauseResult.paused : bot.paused;
  const detail = useBotDetail(environmentId, bot.id);
  const navigation = useNavigation();
  const shell = useThreadShell(scopeThreadRef(environmentId, bot.homeThreadId));
  const { environments } = useEnvironments();
  const schedules = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const tasks = (schedules.data?.tasks ?? []).filter((task) =>
    bot.scheduledTaskIds.includes(task.id),
  );
  const setPaused = useAtomCommand(serverEnvironment.bots.setPaused, { reportFailure: false });
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: false,
  });
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const updateNow = () => setNow(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  usePreventRemove(busy, () =>
    Alert.alert("Command pending", "Wait for the bot command to finish before leaving."),
  );

  const act = async (command: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let result: AtomCommandResult<unknown, unknown>;
    try {
      result = await command();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
      pending.current = false;
      setBusy(false);
      return;
    }
    props.refresh();
    schedules.refresh();
    pending.current = false;
    setBusy(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
    }
  };
  const openThread = (threadId: ThreadId, targetEnvironmentId = environmentId) => {
    if (pending.current) return;
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: targetEnvironmentId, threadId }),
    );
  };
  const openTask = (task: ScheduledTask) => {
    if (pending.current) return;
    startScheduledTaskEditor({
      environmentId,
      environmentLabel:
        environments.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId,
      draft: editDraft(task),
    });
    navigation.dispatch(
      StackActions.replace("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsScheduledTaskEdit" },
      }),
    );
  };

  return (
    <>
      <View className="gap-1">
        <Text className="text-xl font-t3-semibold text-foreground">{bot.name}</Text>
        <Text className="text-sm text-foreground-muted">
          {shell?.modelSelection.model ?? "Model unknown"}
          {paused ? " · Paused" : ""}
        </Text>
      </View>
      <SettingsSection title="Model">
        <BotModelPicker bot={bot} environmentId={environmentId} />
      </SettingsSection>
      <SettingsSection title="Schedule">
        {schedules.error ? (
          <Text accessibilityRole="alert" className="p-4 text-sm text-danger-foreground">
            Could not load schedules: {schedules.error}
          </Text>
        ) : schedules.data === null ? (
          <Text className="p-4 text-sm text-foreground-muted">Loading schedules…</Text>
        ) : tasks.length === 0 ? (
          <Text className="p-4 text-sm text-foreground-muted">No schedule.</Text>
        ) : (
          tasks.map((task) => (
            <View key={task.id} className="flex-row items-center gap-3 px-4 py-3">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Edit ${task.title}`}
                disabled={busy}
                onPress={() => openTask(task)}
                className="min-w-0 flex-1 gap-1 active:opacity-70 disabled:opacity-50"
              >
                <Text className="text-base font-t3-medium text-foreground">{task.title}</Text>
                <Text className="text-sm text-foreground-muted">
                  {describeSchedule(task)}
                  {task.threadId === null ? ` · ${task.modelSelection.model}` : ""}
                  {!task.enabled
                    ? " · Paused"
                    : task.nextRunAt
                      ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                      : ""}
                </Text>
                {task.lastRunStatus === "failed" || task.lastRunError ? (
                  <Text className="text-sm text-danger-foreground" numberOfLines={2}>
                    Last run failed: {task.lastRunError || "Unknown error"}
                  </Text>
                ) : null}
              </Pressable>
              <ThemedSwitch
                accessibilityLabel={`${task.enabled ? "Pause" : "Resume"} schedule ${task.title}`}
                value={task.enabled}
                disabled={busy || paused}
                onValueChange={(enabled) => {
                  if (paused) return;
                  void act(() => setEnabled({ environmentId, input: { id: task.id, enabled } }));
                }}
              />
            </View>
          ))
        )}
        {paused ? (
          <Text className="px-4 pb-3 text-sm text-foreground-muted">
            Resume the bot to change its schedules.
          </Text>
        ) : null}
      </SettingsSection>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() =>
          void act(async () => {
            const nextPaused = !paused;
            const result = await setPaused({
              environmentId,
              input: { botId: bot.id, paused: nextPaused },
            });
            if (result._tag === "Success") setPauseResult({ bot, paused: nextPaused });
            return result;
          })
        }
        className="min-h-11 items-center justify-center rounded-full border border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
      >
        <Text className="font-t3-medium text-foreground">
          {paused ? "Resume bot" : "Pause bot"}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <SettingsSection title="Charter">
        <View className="p-4">
          {detail.data?.charter ? (
            <BotMarkdown
              text={detail.data?.charter}
              environmentId={environmentId}
              onOpenThread={openThread}
            />
          ) : (
            <Text className="text-sm text-foreground-muted">
              {detail.error ?? (detail.data === null ? "Loading…" : "No charter.md.")}
            </Text>
          )}
        </View>
      </SettingsSection>
      <SettingsSection title="Workers">
        {(detail.data?.workers.length ?? 0) === 0 ? (
          <Text className="p-4 text-sm text-foreground-muted">
            {detail.error ?? (detail.data === null ? "Loading…" : "No workers yet.")}
          </Text>
        ) : (
          Arr.reverse(detail.data?.workers ?? []).map((worker) => (
            <Pressable
              key={worker.threadId}
              accessibilityRole="button"
              accessibilityLabel={`Open ${worker.title}`}
              disabled={busy}
              onPress={() => openThread(worker.threadId)}
              className="flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
            >
              <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                {worker.title}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {worker.status ?? "not started"}
              </Text>
            </Pressable>
          ))
        )}
      </SettingsSection>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => openThread(bot.homeThreadId)}
        className="min-h-11 items-center justify-center rounded-full border border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
      >
        <Text className="font-t3-medium text-foreground">Open raw thread</Text>
      </Pressable>
    </>
  );
}
