import { isActiveRunStatus } from "@t3tools/client-runtime/state/bot-conversation";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { botStatusLabel } from "../bots/botChat.logic";
import { useBotRunSettlement } from "../bots/useBots";
import type { useHomeBots } from "./useHomeBots";

export function HomeBotsSection(props: {
  readonly bots: ReturnType<typeof useHomeBots>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentLabels: ReadonlyMap<string, string>;
  readonly now: number;
  readonly onSelectBot: (environmentId: EnvironmentId, botId: string) => void;
}) {
  const shells = useMemo(
    () =>
      new Map(
        props.bots.bots.length === 0
          ? []
          : props.threads.map((thread) => [
              scopedThreadKey(thread.environmentId, thread.id),
              thread,
            ]),
      ),
    [props.bots.bots.length, props.threads],
  );
  if (props.bots.bots.length === 0 && props.bots.errors.length === 0) return null;
  return (
    <View className="mb-4 px-4">
      <Text
        accessibilityRole="header"
        className="px-1 pb-2 text-sm font-t3-medium text-foreground-muted"
      >
        Bots
      </Text>
      {props.bots.errors.map((entry) => (
        <View key={entry.environmentId} className="flex-row items-center gap-3 py-3">
          <Text accessibilityRole="alert" className="min-w-0 flex-1 text-sm text-destructive">
            {props.environmentLabels.size > 1
              ? `${props.environmentLabels.get(entry.environmentId)} · `
              : ""}
            Could not load bots: {entry.error}
          </Text>
          <Pressable accessibilityRole="button" onPress={entry.refresh} className="p-2">
            <Text className="text-sm text-primary-text">Try again</Text>
          </Pressable>
        </View>
      ))}
      {props.bots.bots.map((entry) => (
        <HomeBotRow
          key={scopedThreadKey(entry.environmentId, entry.bot.homeThreadId)}
          entry={entry}
          shell={shells.get(scopedThreadKey(entry.environmentId, entry.bot.homeThreadId))}
          environmentLabel={
            props.environmentLabels.size > 1
              ? props.environmentLabels.get(entry.environmentId)
              : undefined
          }
          now={props.now}
          onSelectBot={props.onSelectBot}
        />
      ))}
    </View>
  );
}

function HomeBotRow(props: {
  readonly entry: ReturnType<typeof useHomeBots>["bots"][number];
  readonly shell: EnvironmentThreadShell | undefined;
  readonly environmentLabel: string | undefined;
  readonly now: number;
  readonly onSelectBot: (environmentId: EnvironmentId, botId: string) => void;
}) {
  const { bot, environmentId, refresh } = props.entry;
  const working = isActiveRunStatus(props.shell?.latestRun?.status);
  useBotRunSettlement(working, refresh);
  const lastActivity = props.shell?.latestRun?.completedAt ?? props.shell?.updatedAt ?? null;
  const time = botStatusLabel({ working: false, paused: false, lastActivity }, props.now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}${props.environmentLabel ? `, ${props.environmentLabel}` : ""}${bot.paused ? ", paused" : ""}, ${time}`}
      className="flex-row items-center gap-3 border-b border-border-subtle px-1 py-3 active:opacity-70"
      onPress={() => props.onSelectBot(environmentId, bot.id)}
    >
      <View className="size-10 items-center justify-center rounded-full bg-subtle">
        <Text className="text-lg font-t3-medium text-foreground">
          {bot.name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className="min-w-0 flex-1 text-base font-t3-medium text-foreground"
          >
            {bot.name}
          </Text>
          {bot.paused ? <Text className="text-xs text-foreground-muted">Paused</Text> : null}
          {lastActivity ? <Text className="text-xs text-foreground-muted">{time}</Text> : null}
        </View>
        <Text numberOfLines={1} className="text-sm text-foreground-muted">
          {props.environmentLabel ? `${props.environmentLabel} · ` : ""}
          {working ? "Working…" : (bot.lastReply?.text ?? "Open conversation")}
        </Text>
      </View>
    </Pressable>
  );
}
