import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isActiveRunStatus } from "@t3tools/client-runtime/state/bot-conversation";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useThreadShell } from "../../state/entities";
import { botStatusLabel } from "../bots/botChat.logic";
import { useBots, useBotRunSettlement } from "../bots/useBots";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";

export function SettingsBotsRouteScreen() {
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const environments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : group,
  );
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Bots" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {environments.map((environment) => (
            <EnvironmentBots key={environment.environmentId} environment={environment} />
          ))}
          {environments.length === 0 ? (
            <Text className="text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect an environment to view bots."
                : "No environments match these filters."}
            </Text>
          ) : null}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentBots({ environment }: { readonly environment: SettingsTarget }) {
  const query = useBots(environment.environmentId);
  return (
    <SettingsSection title={environment.label}>
      {query.error ? (
        <Text className="p-4 text-sm text-destructive">Could not load bots: {query.error}</Text>
      ) : null}
      {query.data === null && query.error === null ? (
        <Text className="p-4 text-sm text-foreground-muted">Loading…</Text>
      ) : null}
      {query.data?.bots.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">No bots yet.</Text>
      ) : null}
      {query.data?.bots.map((bot) => (
        <BotListItem
          key={bot.id}
          bot={bot}
          environmentId={environment.environmentId}
          refresh={query.refresh}
        />
      ))}
    </SettingsSection>
  );
}

function BotListItem(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const navigation = useNavigation();
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.bot.homeThreadId));
  const working = isActiveRunStatus(shell?.latestRun?.status);
  useBotRunSettlement(working, props.refresh);
  const status = botStatusLabel({
    working,
    paused: props.bot.paused,
    lastActivity: shell?.latestRun?.completedAt ?? shell?.updatedAt ?? null,
  });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.bot.name}, ${status}`}
      className="flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
      onPress={() =>
        navigation.dispatch(
          StackActions.push("BotChat", { environmentId: props.environmentId, botId: props.bot.id }),
        )
      }
    >
      <View className="size-10 items-center justify-center rounded-full bg-subtle">
        <Text className="text-lg font-t3-medium text-foreground">
          {props.bot.name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-t3-medium text-foreground">
          {props.bot.name}
        </Text>
        <Text className="text-sm text-foreground-muted">{status}</Text>
      </View>
    </Pressable>
  );
}
