import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  rewriteThreadLinks,
  threadIdFromHref,
  type BotChatItem,
} from "@t3tools/client-runtime/state/bot-conversation";
import type { EnvironmentId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, Text as NativeText, View } from "react-native";
import { Markdown } from "react-native-nitro-markdown";

import { AppText as Text } from "../../components/AppText";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useThreadShell } from "../../state/entities";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { ThreadMarkdownImage } from "../threads/ThreadMarkdownImage";

export function BotChatRow(props: {
  readonly item: BotChatItem;
  readonly botName: string;
  readonly environmentId: EnvironmentId;
  readonly schedules: ReadonlyArray<ScheduledTask>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  const { item } = props;
  if (item.kind === "worker")
    return (
      <WorkerRow
        item={item}
        environmentId={props.environmentId}
        onOpenThread={props.onOpenThread}
      />
    );
  if (item.kind === "wake") return <WakeRow {...props} item={item} />;
  if (item.kind === "compaction")
    return <Text className="py-3 text-center text-xs text-foreground-muted">{item.text}</Text>;
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
              alt="Image"
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
    </View>
  );
}

function WorkerRow(props: {
  readonly item: Extract<BotChatItem, { readonly kind: "worker" }>;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.item.threadId));
  const title = shell?.title ?? props.item.title;
  const status = shell?.latestRun?.status ?? props.item.status;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
      onPress={() => props.onOpenThread(props.item.threadId)}
      className="max-w-[85%] self-start rounded-full border border-border-subtle px-3 py-2 active:opacity-70"
    >
      <Text className="text-xs text-foreground-muted">
        Started {title}
        {status ? ` · ${status}` : ""}
      </Text>
    </Pressable>
  );
}

function WakeRow(props: {
  readonly item: Extract<BotChatItem, { readonly kind: "wake" }>;
  readonly botName: string;
  readonly environmentId: EnvironmentId;
  readonly schedules: ReadonlyArray<ScheduledTask>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sender = useThreadShell(
    props.item.senderThreadId
      ? scopeThreadRef(props.environmentId, props.item.senderThreadId)
      : null,
  );
  const title = props.schedules.find((task) => task.id === props.item.scheduledTaskId)?.title;
  const prefix = `bot ${props.botName} `;
  const schedule = title?.startsWith(prefix) ? title.slice(prefix.length) : title;
  const from =
    sender?.title ??
    schedule ??
    (props.item.scheduledTaskId ? "a scheduled task" : "another thread");
  const preview =
    props.item.reply
      ?.split("\n")
      .find((line) => line.trim())
      ?.replace(/[*`#>]/g, "") ?? "no reply yet";
  return (
    <View className="max-w-[85%] self-start gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="rounded-full border border-border-subtle px-3 py-2 active:opacity-70"
      >
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          From {from} · {preview}
        </Text>
      </Pressable>
      {expanded ? (
        <>
          <View className="rounded-2xl border border-border-subtle px-3.5 py-2">
            <BotMarkdown
              text={props.item.text}
              environmentId={props.environmentId}
              onOpenThread={props.onOpenThread}
            />
          </View>
          {props.item.reply ? (
            <View className="rounded-2xl bg-card px-3.5 py-2">
              <BotMarkdown
                text={props.item.reply}
                environmentId={props.environmentId}
                onOpenThread={props.onOpenThread}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function BotMarkdown(props: {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const markdown = rewriteThreadLinks(props.text, "https://t3.invalid");
  const onLinkPress = (href: string) => {
    const threadId = threadIdFromHref(href, "https://t3.invalid", props.environmentId);
    if (threadId) props.onOpenThread(threadId);
    else void tryOpenExternalUrl(href, "markdown-link");
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
}
