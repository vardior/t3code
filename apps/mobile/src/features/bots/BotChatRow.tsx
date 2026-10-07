import type { VisibleBotChatItem } from "@t3tools/client-runtime/state/bot-chat-rows";
import {
  botChatRunStatusLabel,
  rewriteThreadLinks,
} from "@t3tools/client-runtime/state/bot-conversation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Pressable, Text as NativeText, View } from "react-native";
import { Markdown } from "react-native-nitro-markdown";

import { AppText as Text } from "../../components/AppText";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useWorkspaceEnvironmentIds } from "../../state/workspace";
import { botMarkdownThreadLinks, botThreadLinkTarget } from "./botChat.logic";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { ThreadMarkdownImage } from "../threads/ThreadMarkdownImage";

export const BotChatRow = memo(function BotChatRow(props: {
  readonly item: VisibleBotChatItem;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  const { item } = props;
  return (
    <View
      className={
        item.kind === "you"
          ? "max-w-[85%] self-end gap-2 rounded-2xl bg-subtle px-3.5 py-2"
          : "max-w-[85%] self-start rounded-2xl bg-card px-3.5 py-2"
      }
    >
      {item.kind === "you"
        ? item.imageIds.map((attachmentId) => (
            <ThreadMarkdownImage
              key={attachmentId}
              environmentId={props.environmentId}
              resource={{ _tag: "attachment", attachmentId }}
              alt={null}
              onPressPreview={props.onPreview}
            />
          ))
        : null}
      {item.text ? (
        <BotMarkdown
          text={item.text}
          environmentId={props.environmentId}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
      {item.kind === "you" ? (
        <OwnerMessageStatus
          item={item}
          environmentId={props.environmentId}
          threadId={props.threadId}
        />
      ) : null}
    </View>
  );
});

function OwnerMessageStatus(props: {
  readonly item: Extract<VisibleBotChatItem, { readonly kind: "you" }>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { item } = props;
  const label = botChatRunStatusLabel(item.runStatus);
  const cancelQueuedRun = useAtomCommand(
    threadEnvironment.cancelQueuedRun,
    "cancel queued message",
  );
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    if (cancelling || item.runId === null) return;
    setCancelling(true);
    try {
      await cancelQueuedRun({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId: item.runId },
      });
    } finally {
      setCancelling(false);
    }
  };
  if (label === null) return null;
  return (
    <View className="flex-row items-center gap-3">
      <Text
        className={
          item.runStatus === "failed"
            ? "text-xs text-danger-foreground"
            : "text-xs text-foreground-muted"
        }
      >
        {label}
      </Text>
      {item.runStatus === "queued" && item.runId !== null ? (
        <Pressable
          accessibilityRole="button"
          disabled={cancelling}
          onPress={() => void cancel()}
          className="py-2 disabled:opacity-50"
        >
          <Text className="text-xs text-primary-text">{cancelling ? "Cancelling…" : "Cancel"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const BotMarkdown = memo(function BotMarkdown(props: {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const knownEnvironmentIds = [props.environmentId, ...useWorkspaceEnvironmentIds()];
  const markdown = botMarkdownThreadLinks(
    rewriteThreadLinks(props.text, "https://t3.invalid"),
    knownEnvironmentIds,
  );
  const onLinkPress = (href: string) => {
    const target = botThreadLinkTarget(href, knownEnvironmentIds);
    if (target) props.onOpenThread(target.threadId, target.environmentId);
    else if (!href.startsWith("https://t3.invalid/") && !href.startsWith("t3-thread://"))
      void tryOpenExternalUrl(href, "markdown-link");
  };
  if (hasNativeSelectableMarkdownText()) {
    return (
      <SelectableMarkdownText
        markdown={markdown}
        onLinkPress={onLinkPress}
        textStyle={styles.nativeTextStyle}
      />
    );
  }
  return (
    <Markdown
      options={{ gfm: true }}
      theme={styles.theme}
      styles={styles.styles}
      renderers={{
        ...styles.renderers,
        link: ({ href, children }) => (
          <NativeText
            style={{ color: styles.nativeTextStyle.linkColor }}
            onPress={() => href && onLinkPress(href)}
          >
            {children}
          </NativeText>
        ),
      }}
    >
      {markdown}
    </Markdown>
  );
});
