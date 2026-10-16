import {
  BOT_ROUTE_DEBOUNCE_MS,
  botRouteEnvironment,
  botRouteKey,
  botRoutePickerLabel,
  botRouteText,
  findRoutedBot,
  heldBotRouteSuggestion,
} from "@t3tools/client-runtime/state/bot-conversation";
import { AuthOrchestrationOperateScope, CommandId, MessageId } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import type { useHomeBots } from "./useHomeBots";

type BotChoice = { readonly environmentId: EnvironmentId; readonly botId: string };

export function HomeBotComposer(props: {
  readonly bots: ReturnType<typeof useHomeBots>["bots"];
  readonly environmentLabels: ReadonlyMap<string, string>;
  readonly onSent: (environmentId: EnvironmentId, botId: string) => void;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<BotChoice | null>(null);
  const [heldBotId, setHeldBotId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const routeEnvironmentId = botRouteEnvironment(props.bots);
  const routeText = botRouteText(useDebouncedValue(text, BOT_ROUTE_DEBOUNCE_MS));
  const route = useEnvironmentQuery(
    routeEnvironmentId === null || routeText === null || picked !== null
      ? null
      : serverEnvironment.bots.route({
          environmentId: routeEnvironmentId,
          input: { text: routeText },
        }),
  );
  const suggestedBotId = heldBotRouteSuggestion({ routeText, routed: route.data, heldBotId });
  if (suggestedBotId !== heldBotId) setHeldBotId(suggestedBotId);
  const suggested =
    routeEnvironmentId === null || suggestedBotId === null
      ? null
      : { environmentId: routeEnvironmentId, botId: suggestedBotId };

  const chosen = findRoutedBot(props.bots, picked ?? suggested);
  const canOperate = useEnvironmentScope(
    chosen?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const message = text.trim();
  const canSend = chosen !== null && canOperate && message.length > 0 && !sending;

  const send = async () => {
    if (chosen === null || !canSend) return;
    const metadata = makeQueuedMessageMetadata();
    setSending(true);
    try {
      await enqueueThreadOutboxMessage({
        environmentId: chosen.environmentId,
        threadId: chosen.bot.homeThreadId,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: message,
        attachments: [],
        createdAt: metadata.createdAt,
      });
    } catch (error) {
      Alert.alert(
        "Could not send",
        error instanceof Error ? error.message : "Failed to save the message.",
      );
      return;
    } finally {
      setSending(false);
    }
    setText("");
    setPicked(null);
    setHeldBotId(null);
    props.onSent(chosen.environmentId, chosen.bot.id);
  };

  return (
    <View className="mb-3 gap-2 rounded-2xl border border-border-subtle px-3 py-2">
      <TextInput
        accessibilityLabel="Message a bot"
        value={text}
        onChangeText={setText}
        multiline
        textAlignVertical="top"
        maxLength={8_000}
        placeholder="Tell a bot…"
        placeholderTextColorClassName="accent-foreground-muted"
        className="max-h-32 min-h-11 font-sans text-base text-foreground"
      />
      <View className="flex-row items-center justify-between gap-2">
        <Menu
          title="Send to"
          actions={props.bots.map((entry) => ({
            id: botRouteKey(entry),
            title: entry.bot.name,
            subtitle:
              props.environmentLabels.size > 1
                ? props.environmentLabels.get(entry.environmentId)
                : undefined,
            state: chosen === entry ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const entry = props.bots.find(
              (candidate) => botRouteKey(candidate) === nativeEvent.event,
            );
            if (entry) setPicked({ environmentId: entry.environmentId, botId: entry.bot.id });
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={chosen ? `Send to ${chosen.bot.name}, change bot` : "Pick a bot"}
            className="min-w-0 shrink flex-row items-center gap-1 rounded-full bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text
              numberOfLines={1}
              className={
                chosen
                  ? "min-w-0 shrink text-sm font-t3-medium text-foreground"
                  : "min-w-0 shrink text-sm text-foreground-muted"
              }
            >
              {botRoutePickerLabel(chosen?.bot.name ?? null, route.isPending)}
            </Text>
            <SymbolView
              name="chevron.down"
              size={12}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          </Pressable>
        </Menu>
        <ControlPill
          icon="arrow.up"
          accessibilityLabel={chosen ? `Send to ${chosen.bot.name}` : "Send"}
          variant="primary"
          disabled={!canSend}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
