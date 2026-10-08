import {
  botThreadShellStatus,
  botThreadShellStatusLabel,
  botNeedsYou,
} from "@t3tools/client-runtime/state/bot-conversation";
import { countOpenItems } from "@t3tools/client-runtime/state/open-items";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { botStatusLabel } from "../bots/botChat.logic";
import { SortableBotList } from "../bots/SortableBotList";
import { useBotRunSettlement } from "../bots/useBots";
import { HomeBotComposer } from "./HomeBotComposer";
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
  const groups = useMemo(() => {
    const byEnvironment = new Map<EnvironmentId, ReturnType<typeof useHomeBots>["bots"]>();
    for (const entry of props.bots.bots) {
      const group = byEnvironment.get(entry.environmentId) ?? [];
      byEnvironment.set(entry.environmentId, [...group, entry]);
    }
    return [...byEnvironment].map(([environmentId, entries]) => ({
      environmentId,
      entries,
      bots: entries.map((entry) => entry.bot),
    }));
  }, [props.bots.bots]);
  if (props.bots.bots.length === 0 && props.bots.errors.length === 0) return null;
  return (
    <View className="mb-4 px-4">
      <Text
        accessibilityRole="header"
        className="px-1 pb-2 text-sm font-t3-medium text-foreground-muted"
      >
        Bots
      </Text>
      {props.bots.bots.length > 0 ? (
        <HomeBotComposer
          bots={props.bots.bots}
          environmentLabels={props.environmentLabels}
          onSent={props.onSelectBot}
        />
      ) : null}
      {props.bots.errors.map((entry) => (
        <View key={entry.environmentId} className="flex-row items-center gap-3 py-3">
          <Text accessibilityRole="alert" className="min-w-0 flex-1 text-sm text-danger-foreground">
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
      {groups.map(({ environmentId, entries, bots }) => (
        <SortableBotList
          key={environmentId}
          environmentId={environmentId}
          bots={bots}
          renderBot={(bot) => (
            <HomeBotRow
              entry={entries.find((entry) => entry.bot.id === bot.id)!}
              shell={shells.get(scopedThreadKey(environmentId, bot.homeThreadId))}
              environmentLabel={
                props.environmentLabels.size > 1
                  ? props.environmentLabels.get(environmentId)
                  : undefined
              }
              now={props.now}
              onSelectBot={props.onSelectBot}
            />
          )}
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
  const needsYou = botNeedsYou(bot, props.shell);
  const status = botThreadShellStatus(props.shell, bot);
  const working = status === "working";
  const openItemCount = countOpenItems(props.shell?.openItems);
  const statusText = props.shell?.hasPendingApprovals
    ? "Needs approval"
    : props.shell?.hasPendingUserInput
      ? "Needs input"
      : openItemCount > 0
        ? openItemCount === 1
          ? "1 open item"
          : `${openItemCount} open items`
        : botThreadShellStatusLabel(status);
  useBotRunSettlement(working, refresh);
  const lastActivity = props.shell?.latestRun?.completedAt ?? props.shell?.updatedAt ?? null;
  const time = botStatusLabel({ working: false, paused: false, lastActivity }, props.now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}${props.environmentLabel ? `, ${props.environmentLabel}` : ""}${bot.paused ? ", paused" : ""}${needsYou ? ", needs you" : ""}, ${statusText ?? time}`}
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
            className={
              needsYou
                ? "min-w-0 flex-1 text-base font-t3-bold text-foreground"
                : "min-w-0 flex-1 text-base font-t3-medium text-foreground"
            }
          >
            {bot.name}
          </Text>
          {needsYou ? <View className="size-2 rounded-full bg-primary" /> : null}
          {openItemCount > 0 ? (
            <View className="min-w-5 items-center rounded-full bg-primary px-1.5">
              <Text className="text-xs font-t3-medium tabular-nums text-primary-foreground">
                {openItemCount}
              </Text>
            </View>
          ) : null}
          {bot.paused ? <Text className="text-xs text-foreground-muted">Paused</Text> : null}
          {lastActivity ? <Text className="text-xs text-foreground-muted">{time}</Text> : null}
        </View>
        <Text
          numberOfLines={1}
          className={needsYou ? "text-sm text-foreground" : "text-sm text-foreground-muted"}
        >
          {props.environmentLabel ? `${props.environmentLabel} · ` : ""}
          {statusText ?? bot.lastReply?.text ?? "Open conversation"}
        </Text>
      </View>
    </Pressable>
  );
}
