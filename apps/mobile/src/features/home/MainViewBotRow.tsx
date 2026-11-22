import {
  botThreadShellStatus,
  type MainViewBotEntry,
} from "@t3tools/client-runtime/state/bot-conversation";
import { countOpenItems } from "@t3tools/client-runtime/state/open-items";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useBotRunSettlement } from "../bots/useBots";

export function MainViewBotRow({
  entry: { bot, environmentId, shell, attention, activityAt },
  now,
  environmentLabel,
  refresh,
  onSelectBot,
}: {
  readonly entry: MainViewBotEntry;
  readonly now: number;
  readonly environmentLabel: string | undefined;
  readonly refresh: () => void;
  readonly onSelectBot: (environmentId: EnvironmentId, botId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const working = botThreadShellStatus(shell, bot) === "working";
  const quiet = attention === null;
  useBotRunSettlement(working, refresh);
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
      : relativeTime(activityAt, now, m);
  const hue = [...bot.name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, environmentLabel, detail, time].filter(Boolean).join(", ")}
      className={cn(
        "flex-row gap-3 px-4 active:opacity-70",
        quiet ? "items-center py-1" : "items-start py-2",
      )}
      onPress={() => onSelectBot(environmentId, bot.id)}
    >
      <View
        className={cn("items-center justify-center rounded-full", quiet ? "size-4" : "size-5")}
        style={{ backgroundColor: `hsl(${hue}, 45%, 45%)` }}
      >
        <Text className={cn("font-t3-medium text-white", quiet ? "text-[9px]" : "text-3xs")}>
          {bot.name.trim().charAt(0).toUpperCase() || "?"}
        </Text>
      </View>
      <View className="min-w-0 flex-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className={cn(
              "min-w-0 flex-1 text-sm",
              quiet ? "text-foreground-muted" : "text-foreground",
            )}
          >
            {name}
          </Text>
          {!quiet ? <View className="size-1.5 rounded-full bg-primary" /> : null}
          {time ? <Text className="text-xs text-foreground-muted">{time}</Text> : null}
        </View>
        {detail !== null ? (
          <Text numberOfLines={1} className="text-xs text-foreground">
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
