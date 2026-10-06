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
  EnvironmentId,
  type BotSummary,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { useCallback, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";
import { editDraft } from "../settings/scheduledTaskDraft";
import { formatNextScheduledTaskRun } from "../settings/scheduledTaskPresentation";
import { describeSchedule } from "../settings/SettingsScheduledTasksRouteScreen";
import { BotMarkdown } from "./BotChatRow";
import { useBots } from "./useBots";

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
      <AndroidSheetHeader title="About bot" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}

function BotInfo(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const { bot, environmentId } = props;
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
    const result = await command();
    props.refresh();
    schedules.refresh();
    pending.current = false;
    setBusy(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const openThread = (threadId: ThreadId) => {
    if (pending.current) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }));
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
          {bot.paused ? " · Paused" : ""}
        </Text>
      </View>
      <SettingsSection title="Schedule">
        {schedules.error ? (
          <Text accessibilityRole="alert" className="p-4 text-sm text-destructive">
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
                  {describeSchedule(task)} · {task.modelSelection.model}
                  {!task.enabled
                    ? " · Paused"
                    : task.nextRunAt
                      ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                      : ""}
                </Text>
              </Pressable>
              <ThemedSwitch
                accessibilityLabel={`${task.enabled ? "Pause" : "Resume"} schedule ${task.title}`}
                value={task.enabled}
                disabled={busy}
                onValueChange={(enabled) =>
                  void act(() => setEnabled({ environmentId, input: { id: task.id, enabled } }))
                }
              />
            </View>
          ))
        )}
      </SettingsSection>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() =>
          void act(() =>
            setPaused({ environmentId, input: { botId: bot.id, paused: !bot.paused } }),
          )
        }
        className="min-h-11 items-center justify-center rounded-full border border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
      >
        <Text className="font-t3-medium text-foreground">
          {bot.paused ? "Resume bot" : "Pause bot"}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      <SettingsSection title="Charter">
        <View className="p-4">
          {bot.charter ? (
            <BotMarkdown
              text={bot.charter}
              environmentId={environmentId}
              onOpenThread={openThread}
            />
          ) : (
            <Text className="text-sm text-foreground-muted">No charter.md.</Text>
          )}
        </View>
      </SettingsSection>
      <SettingsSection title="Workers">
        {bot.workers.length === 0 ? (
          <Text className="p-4 text-sm text-foreground-muted">No workers yet.</Text>
        ) : (
          Arr.reverse(bot.workers).map((worker) => (
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
