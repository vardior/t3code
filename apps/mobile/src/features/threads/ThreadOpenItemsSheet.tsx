import { useAtomValue } from "@effect/atom-react";
import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { groupOpenItems } from "@t3tools/client-runtime/state/open-items";
import type { EnvironmentId, OpenItem, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { BotMarkdown } from "../bots/BotMarkdown";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const NO_ITEMS: ReadonlyArray<OpenItem> = [];

type OpenItemsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
type OpenItemAction =
  | { readonly type: "answer"; readonly answer: string }
  | { readonly type: "drop" }
  | { readonly type: "reopen" };

export function ThreadOpenItemsSheet({ route }: StaticScreenProps<OpenItemsTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const threadRef = useMemo(
    () => scopeThreadRef(target.environmentId, target.threadId),
    [target.environmentId, target.threadId],
  );
  const shell = useThreadShell(threadRef);
  const groups = useMemo(() => groupOpenItems(shell?.openItems ?? NO_ITEMS), [shell?.openItems]);
  const canOperate = useAtomValue(
    serverEnvironment.answerOpenItem.permissionAtom(target.environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.answerOpenItem, "answer open item");
  const drop = useAtomCommand(serverEnvironment.dropOpenItem, "drop open item");
  const reopen = useAtomCommand(serverEnvironment.reopenOpenItem, "reopen open item");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [showResolved, setShowResolved] = useState(false);

  const act = async (item: OpenItem, action: OpenItemAction) => {
    if (busyRef.current || !canOperate) return false;
    busyRef.current = true;
    setBusyItemId(item.id);
    void Haptics.selectionAsync();
    const environmentId = target.environmentId;
    const input = { threadId: target.threadId, itemId: item.id };
    try {
      const result = await (action.type === "answer"
        ? answer({
            environmentId,
            input: { ...input, answer: action.answer, creationSource: "mobile" },
          })
        : action.type === "drop"
          ? drop({ environmentId, input: { ...input, creationSource: "mobile" } })
          : reopen({ environmentId, input: { ...input, creationSource: "mobile" } }));
      return result._tag === "Success";
    } finally {
      busyRef.current = false;
      setBusyItemId(null);
    }
  };

  const content = (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-4 px-5 pt-3"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {groups.open.length === 0 ? (
        <Text className="py-2 text-base text-foreground-muted">Nothing is waiting on you.</Text>
      ) : (
        groups.open.map((item) => (
          <OpenItemCard
            key={item.id}
            item={item}
            environmentId={target.environmentId}
            onOpenThread={(threadId, environmentId = target.environmentId) =>
              navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId }))
            }
            disabled={!canOperate || busyItemId !== null}
            onAct={(action) => act(item, action)}
          />
        ))
      )}
      {groups.resolved.length > 0 ? (
        <View className="gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showResolved }}
            onPress={() => setShowResolved((value) => !value)}
            className="flex-row items-center justify-between py-2 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-foreground-muted">
              Resolved ({groups.resolved.length})
            </Text>
            <Text className="text-sm text-primary-text">{showResolved ? "Hide" : "Show"}</Text>
          </Pressable>
          {showResolved
            ? groups.resolved.map((item) => (
                <View key={item.id} className="flex-row items-center gap-3 py-2">
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-base text-foreground-muted">
                      {item.title}
                    </Text>
                    <Text numberOfLines={1} className="text-sm text-foreground-muted">
                      {item.status === "answered"
                        ? item.answer
                          ? `Answered: ${item.answer}`
                          : "Answered"
                        : "Dropped"}
                    </Text>
                  </View>
                  <Button
                    label="Reopen"
                    tone="text"
                    disabled={!canOperate || busyItemId !== null}
                    onPress={() => void act(item, { type: "reopen" })}
                  />
                </View>
              ))
            : null}
        </View>
      ) : null}
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
            screenId="thread-open-items-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Open items"
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
      <AppBar sheet title="Open items" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}

function OpenItemCard(props: {
  readonly item: OpenItem;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly disabled: boolean;
  readonly onAct: (action: OpenItemAction) => Promise<boolean>;
}) {
  const { item } = props;
  const [reply, setReply] = useState("");
  const send = async () => {
    const answer = reply.trim();
    if (answer.length === 0) return;
    if (await props.onAct({ type: "answer", answer })) setReply("");
  };
  return (
    <View className="gap-3 rounded-[20px] border-continuous bg-card p-4">
      <View className="flex-row items-baseline gap-2">
        <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
          {item.title}
        </Text>
        <Text className="text-xs text-foreground-muted">{relativeTime(item.createdAt)}</Text>
      </View>
      {item.detail ? (
        <BotMarkdown
          text={item.detail}
          environmentId={props.environmentId}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
      {item.options && item.options.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {item.options.map((option) => {
            const recommended = option === item.recommended;
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityLabel={recommended ? `${option}, recommended` : option}
                accessibilityState={{ disabled: props.disabled }}
                disabled={props.disabled}
                onPress={() => void props.onAct({ type: "answer", answer: option })}
                className={
                  recommended
                    ? "min-h-10 justify-center rounded-full bg-primary px-4 active:opacity-70"
                    : "min-h-10 justify-center rounded-full border border-border px-4 active:opacity-70"
                }
              >
                <Text
                  className={
                    recommended
                      ? "font-t3-medium text-primary-foreground"
                      : "font-t3-medium text-foreground"
                  }
                >
                  {recommended ? `${option} · Recommended` : option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {item.defaultOnSilence ? (
        <Text className="text-sm text-foreground-muted">
          If you don't answer: {item.defaultOnSilence}
        </Text>
      ) : null}
      <TextInput
        accessibilityLabel={`Reply to ${item.title}`}
        value={reply}
        readOnly={props.disabled}
        onChangeText={setReply}
        onSubmitEditing={() => void send()}
        returnKeyType="send"
        maxLength={2000}
        placeholder="Reply…"
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-11 rounded-xl border border-border-subtle px-3 font-sans text-base text-foreground"
      />
      <View className="flex-row items-center justify-between">
        <Button
          label="Drop"
          tone="text"
          disabled={props.disabled}
          onPress={() => void props.onAct({ type: "drop" })}
        />
        <Button
          label="Send"
          tone="secondary"
          disabled={props.disabled || reply.trim().length === 0}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
