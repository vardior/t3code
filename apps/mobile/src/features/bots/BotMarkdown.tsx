import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo } from "react";
import { Text as NativeText } from "react-native";
import { Markdown } from "react-native-nitro-markdown";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useWorkspaceEnvironmentIds } from "../../state/workspace";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  BOT_THREAD_LINK_ORIGIN,
  botMarkdownThreadLinks,
  botThreadLinkTarget,
} from "./botChat.logic";

export const BotMarkdown = memo(function BotMarkdown(props: {
  readonly text: string;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const knownEnvironmentIds = [props.environmentId, ...useWorkspaceEnvironmentIds()];
  const markdown = botMarkdownThreadLinks(props.text, knownEnvironmentIds);
  const onLinkPress = (href: string) => {
    const target = botThreadLinkTarget(href, knownEnvironmentIds);
    if (target) props.onOpenThread(target.threadId, target.environmentId);
    else if (!href.startsWith(`${BOT_THREAD_LINK_ORIGIN}/`) && !href.startsWith("t3-thread://"))
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
