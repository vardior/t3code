import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  answerBotMorningFinding,
  BotMorningMemory,
  botMorningLine,
  dismissBotMorning,
  EMPTY_BOT_MORNING_MEMORY,
  type BotMorningDecision,
} from "@t3tools/client-runtime/state/bot-conversation";
import {
  AuthOrchestrationOperateScope,
  botFindingDecisionMessage,
  CommandId,
  MessageId,
  type BotMorningFinding,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";

const STORAGE_KEY = "t3code.bot-morning";
const decodeMemory = Schema.decodeUnknownOption(Schema.fromJsonString(BotMorningMemory));

function useMorningMemory() {
  const [memory, setMemory] = useState<BotMorningMemory | null>(null);
  const latest = useRef(EMPTY_BOT_MORNING_MEMORY);
  useEffect(() => {
    let active = true;
    const load = (next: BotMorningMemory) => {
      if (!active) return;
      latest.current = next;
      setMemory(next);
    };
    SecureStore.getItemAsync(STORAGE_KEY).then(
      (raw) =>
        load(
          raw === null
            ? EMPTY_BOT_MORNING_MEMORY
            : Option.getOrElse(decodeMemory(raw), () => EMPTY_BOT_MORNING_MEMORY),
        ),
      () => load(EMPTY_BOT_MORNING_MEMORY),
    );
    return () => {
      active = false;
    };
  }, []);
  const save = useCallback((next: BotMorningMemory) => {
    latest.current = next;
    setMemory(next);
    void SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);
  return useMemo(
    () => ({
      memory,
      dismiss: (key: string) => save(dismissBotMorning(latest.current, key)),
      answer: (key: string, decision: BotMorningDecision | null) =>
        save(answerBotMorningFinding(latest.current, key, decision)),
    }),
    [memory, save],
  );
}

export function HomeMorningCards(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly environmentLabels: ReadonlyMap<string, string>;
  readonly onSelectBot: (environmentId: EnvironmentId, botId: string) => void;
}) {
  const { memory, dismiss, answer } = useMorningMemory();
  if (memory === null) return null;
  return props.environmentIds.map((environmentId) => (
    <HomeMorningCard
      key={environmentId}
      environmentId={environmentId}
      environmentLabel={
        props.environmentIds.length > 1 ? props.environmentLabels.get(environmentId) : undefined
      }
      memory={memory}
      onDismiss={dismiss}
      onAnswer={answer}
      onSelectBot={props.onSelectBot}
    />
  ));
}

function HomeMorningCard(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | undefined;
  readonly memory: BotMorningMemory;
  readonly onDismiss: (key: string) => void;
  readonly onAnswer: (key: string, decision: BotMorningDecision | null) => void;
  readonly onSelectBot: (environmentId: EnvironmentId, botId: string) => void;
}) {
  const { environmentId, onAnswer } = props;
  const morningAtom = serverEnvironment.bots.morning(environmentId);
  const result = useAtomValue(morningAtom);
  const list = useAtomValue(serverEnvironment.bots.list({ environmentId, input: {} }));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const refresh = () => appAtomRegistry.refresh(morningAtom);
      if (focusedBefore.current) refresh();
      focusedBefore.current = true;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => subscription.remove();
    }, [morningAtom]),
  );
  const bots = useMemo(
    () => new Map((list._tag === "Success" ? list.value.bots : []).map((bot) => [bot.id, bot])),
    [list],
  );
  const decide = useCallback(
    (finding: BotMorningFinding, decision: BotMorningDecision) => {
      const homeThreadId = bots.get(finding.botId)?.homeThreadId;
      if (homeThreadId === undefined) return;
      const key = `${environmentId}:${finding.id}`;
      onAnswer(key, decision);
      enqueueThreadOutboxMessage({
        environmentId,
        threadId: homeThreadId,
        messageId: MessageId.make(uuidv4()),
        commandId: CommandId.make(uuidv4()),
        text: botFindingDecisionMessage(finding, decision),
        attachments: [],
        dispatchMode: "queue",
        createdAt: new Date().toISOString(),
      }).catch(() => onAnswer(key, null));
    },
    [bots, environmentId, onAnswer],
  );
  const morning = result._tag === "Success" ? result.value : null;
  if (morning === null) return null;
  const dismissKey = `${environmentId}:${morning.awaySince}`;
  if (props.memory.dismissed.includes(dismissKey)) return null;
  return (
    <View className="mx-4 mb-4 rounded-2xl border border-border-subtle bg-subtle px-4 py-3">
      <View className="flex-row items-center gap-3">
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          className="min-w-0 flex-1 text-sm font-t3-medium text-foreground-muted"
        >
          While you were away{props.environmentLabel ? ` · ${props.environmentLabel}` : ""}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onDismiss(dismissKey)}
          className="p-2 active:opacity-70"
        >
          <Text className="text-sm text-primary-text">Dismiss</Text>
        </Pressable>
      </View>
      {morning.bots.map((bot) => (
        <Pressable
          key={bot.botId}
          accessibilityRole="button"
          accessibilityLabel={`${bot.name}, ${botMorningLine(bot)}`}
          onPress={() => props.onSelectBot(environmentId, bot.botId)}
          className="py-2 active:opacity-70"
        >
          <Text numberOfLines={1} className="text-base font-t3-medium text-foreground">
            {bot.name}
          </Text>
          <Text numberOfLines={2} className="text-sm text-foreground-muted">
            {botMorningLine(bot)}
          </Text>
        </Pressable>
      ))}
      {morning.findings.map((finding) => {
        const answer = props.memory.answered[`${environmentId}:${finding.id}`];
        return (
          <View key={finding.id} className="mt-2 border-t border-border-subtle pt-3">
            <Text className="text-xs text-foreground-muted">
              {bots.get(finding.botId)?.name ?? finding.botId} · {finding.kind}
            </Text>
            <Text className="text-sm text-foreground">{finding.what}</Text>
            {finding.fix ? (
              <Text className="text-xs text-foreground-muted">{finding.fix}</Text>
            ) : null}
            {answer !== undefined ? (
              <Text className="mt-2 text-sm text-foreground-muted">
                {answer === "accept" ? "Going ahead" : "Skipped"}
              </Text>
            ) : (
              <View className="mt-2 flex-row gap-2">
                <MaterialButton
                  label="Do it"
                  tone="primary"
                  disabled={!canOperate || !bots.has(finding.botId)}
                  onPress={() => decide(finding, "accept")}
                />
                <MaterialButton
                  label="Skip"
                  disabled={!canOperate || !bots.has(finding.botId)}
                  onPress={() => decide(finding, "skip")}
                />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
