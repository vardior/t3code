import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BotSummary,
  EnvironmentId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ArrowUpIcon, BotIcon } from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";

import { cn, newMessageId } from "../../lib/utils";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildBotChat,
  isBotWorking,
  rewriteThreadLinks,
  threadIdFromHref,
  type BotChatItem,
} from "./botConversation";

export function BotChat(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
}) {
  const thread = useEnvironmentThread(props.environmentId, props.bot.homeThreadId);
  const projection = Option.getOrNull(thread.data);
  const items = useMemo(
    () =>
      buildBotChat({
        bot: props.bot,
        messages: projection?.messages ?? [],
        turnItems: projection?.turnItems ?? [],
      }),
    [props.bot, projection?.messages, projection?.turnItems],
  );
  const working = isBotWorking(projection?.runs ?? []);
  const navigate = useNavigate();
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: props.environmentId, threadId },
    });

  const interceptThreadLinks = (event: MouseEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest("a");
    const threadId = anchor
      ? threadIdFromHref(anchor.href, window.location.origin, props.environmentId)
      : null;
    if (threadId === null) return;
    event.preventDefault();
    event.stopPropagation();
    openThread(threadId);
  };

  return (
    <section
      aria-label={`Conversation with ${props.bot.name}`}
      className="flex min-w-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto" onClickCapture={interceptThreadLinks}>
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-6">
          {projection === null ? (
            <p className="text-center text-muted-foreground text-sm">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm">
              Nothing between you and {props.bot.name} yet.
            </p>
          ) : null}
          {items.map((item) => (
            <ChatRow
              key={item.id}
              item={item}
              environmentId={props.environmentId}
              onOpenThread={openThread}
            />
          ))}
          {working ? (
            <div className="self-start rounded-2xl bg-muted px-3.5 py-2 text-muted-foreground text-sm">
              Working…
            </div>
          ) : null}
          <div key={`${items.length}:${working}`} ref={scrollIntoViewOnMount} />
        </div>
      </div>
      <BotComposer
        bot={props.bot}
        environmentId={props.environmentId}
        runtimeMode={projection?.thread.runtimeMode ?? null}
        interactionMode={projection?.thread.interactionMode ?? null}
      />
    </section>
  );
}

function ChatRow(props: {
  readonly item: BotChatItem;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  if (item.kind === "worker") {
    return (
      <button
        type="button"
        className="my-1 flex max-w-[85%] items-center gap-2 self-start rounded-full border border-border/70 px-3 py-1.5 text-left text-muted-foreground text-xs hover:bg-accent/60 hover:text-foreground"
        onClick={() => props.onOpenThread(item.threadId)}
      >
        <BotIcon className="size-3.5 shrink-0" />
        <span className="truncate">Started {item.title}</span>
        {item.status ? <span className="shrink-0 opacity-70">· {item.status}</span> : null}
      </button>
    );
  }
  const mine = item.kind === "you";
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm",
        mine ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted",
      )}
    >
      {mine ? (
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
      ) : (
        <ChatMarkdown
          cwd={undefined}
          environmentId={props.environmentId}
          text={rewriteThreadLinks(item.text, window.location.origin)}
        />
      )}
    </div>
  );
}

function BotComposer(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const ready = props.runtimeMode !== null && props.interactionMode !== null;

  const send = async () => {
    const message = text.trim();
    if (!message || sending || props.runtimeMode === null || props.interactionMode === null) return;
    setSending(true);
    const result = await startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.bot.homeThreadId,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
        dispatchMode: "queue",
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not send to ${props.bot.name}`,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <form
      className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        aria-label={`Message ${props.bot.name}`}
        className="flex-1"
        placeholder={`Message ${props.bot.name}`}
        rows={1}
        value={text}
        disabled={!ready}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Button
        aria-label="Send"
        disabled={!ready || sending || !text.trim()}
        size="icon"
        type="submit"
      >
        <ArrowUpIcon />
      </Button>
    </form>
  );
}

function scrollIntoViewOnMount(element: HTMLDivElement | null) {
  element?.scrollIntoView({ block: "end" });
}
