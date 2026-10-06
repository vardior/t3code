import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type BotSummary,
  type EnvironmentId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduledTask,
  type ThreadId,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ArrowUpIcon, BotIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ClipboardEvent,
  type MouseEvent,
} from "react";

import { useComposerDraftStore } from "../../composerDraftStore";

import { useAssetUrls } from "../../assets/assetUrls";
import { newMessageId, randomUUID } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { readFileAsDataUrl } from "../ChatView.logic";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildBotChat,
  botConversationStatus,
  rewriteThreadLinks,
  threadIdFromHref,
  type BotChatItem,
} from "@t3tools/client-runtime/state/bot-conversation";

export function BotChat(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly onRunSettled: () => void;
}) {
  const thread = useEnvironmentThread(props.environmentId, props.bot.homeThreadId);
  const projection = Option.getOrNull(thread.data);
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const items = useMemo(
    () =>
      buildBotChat({
        bot: props.bot,
        messages: projection?.messages ?? [],
        runs: projection?.runs ?? [],
        turnItems: projection?.turnItems ?? [],
      }),
    [props.bot, projection?.messages, projection?.runs, projection?.turnItems],
  );
  const status = useMemo(
    () => (projection === null ? { kind: "idle" as const } : botConversationStatus(projection)),
    [projection],
  );
  const working = status.kind === "working";
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      await interruptTurn({
        environmentId: props.environmentId,
        input: { threadId: props.bot.homeThreadId },
      });
    } finally {
      setStopping(false);
    }
  };
  const onRunSettled = useEffectEvent(props.onRunSettled);
  useEffect(() => {
    if (!working) onRunSettled();
  }, [working]);
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
              schedules={tasksQuery.data?.tasks ?? []}
              botName={props.bot.name}
            />
          ))}
          {working ? (
            <div className="self-start rounded-2xl bg-muted px-3.5 py-2 text-muted-foreground text-sm">
              <span>Working…</span>
              <Button size="sm" variant="ghost" disabled={stopping} onClick={() => void stop()}>
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            </div>
          ) : null}
          {status.kind === "needs-attention" ? (
            <div className="self-start rounded-2xl bg-muted px-3.5 py-2 text-sm">
              <p>{status.request === "approval" ? "Needs your approval" : "Needs your input"}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openThread(props.bot.homeThreadId)}
              >
                {status.request === "approval" ? "Review approval in thread" : "Answer in thread"}
              </Button>
            </div>
          ) : status.kind === "failed" ? (
            <div className="self-start rounded-2xl bg-muted px-3.5 py-2 text-sm">
              <p>Run failed{status.error ? `: ${status.error}` : "."}</p>
              <p>Send your message again to retry, or open the thread for details.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openThread(props.bot.homeThreadId)}
              >
                Retry in thread
              </Button>
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
  readonly schedules: ReadonlyArray<ScheduledTask>;
  readonly botName: string;
}) {
  const { item } = props;
  if (item.kind === "worker") {
    return (
      <WorkerChip
        item={item}
        environmentId={props.environmentId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  if (item.kind === "wake") {
    return (
      <WakeRow
        item={item}
        environmentId={props.environmentId}
        schedules={props.schedules}
        botName={props.botName}
      />
    );
  }
  if (item.kind === "you") {
    return <YourMessage item={item} environmentId={props.environmentId} />;
  }
  if (item.kind === "compaction") {
    return (
      <div className="my-2 flex items-center gap-3 text-muted-foreground text-xs">
        <span className="h-px flex-1 bg-border" />
        <span>{item.text}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return (
    <div className="max-w-[85%] self-start rounded-2xl bg-muted px-3.5 py-2 text-sm">
      <BotMarkdown text={item.text} environmentId={props.environmentId} />
    </div>
  );
}

function BotMarkdown(props: { readonly text: string; readonly environmentId: EnvironmentId }) {
  return (
    <ChatMarkdown
      cwd={undefined}
      environmentId={props.environmentId}
      text={rewriteThreadLinks(props.text, window.location.origin)}
    />
  );
}

function YourMessage(props: {
  readonly item: Extract<BotChatItem, { readonly kind: "you" }>;
  readonly environmentId: EnvironmentId;
}) {
  const { item } = props;
  const resources = useMemo(
    () => item.imageIds.map((attachmentId) => ({ _tag: "attachment" as const, attachmentId })),
    [item.imageIds],
  );
  const imageUrls = useAssetUrls(props.environmentId, resources);
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
      {imageUrls.map((url, index) =>
        url ? (
          <a key={item.imageIds[index]} href={url} target="_blank" rel="noreferrer">
            <img alt="" className="max-h-64 rounded-2xl" src={url} />
          </a>
        ) : null,
      )}
      {item.text ? (
        <p className="whitespace-pre-wrap break-words rounded-2xl bg-primary px-3.5 py-2 text-primary-foreground text-sm">
          {item.text}
        </p>
      ) : null}
    </div>
  );
}

function WakeRow(props: {
  readonly item: Extract<BotChatItem, { readonly kind: "wake" }>;
  readonly environmentId: EnvironmentId;
  readonly schedules: ReadonlyArray<ScheduledTask>;
  readonly botName: string;
}) {
  const { item } = props;
  const sender = useThreadShell(
    item.senderThreadId ? scopeThreadRef(props.environmentId, item.senderThreadId) : null,
  );
  const scheduleTitle = props.schedules.find((task) => task.id === item.scheduledTaskId)?.title;
  const botPrefix = `bot ${props.botName} `;
  const scheduleName = scheduleTitle?.startsWith(botPrefix)
    ? scheduleTitle.slice(botPrefix.length)
    : scheduleTitle;
  const from =
    sender?.title ?? scheduleName ?? (item.scheduledTaskId ? "a scheduled task" : "another thread");
  const replyPreview =
    item.reply
      ?.split("\n")
      .find((line) => line.trim())
      ?.replace(/[*`#>]/g, "") ?? "no reply yet";
  return (
    <details className="group max-w-[85%] self-start text-muted-foreground text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-border/70 px-3 py-1.5 hover:bg-accent/60 hover:text-foreground">
        <span className="shrink-0">From {from}</span>
        <span className="truncate opacity-70">· {replyPreview}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <div className="rounded-2xl border border-border/70 px-3.5 py-2">
          <BotMarkdown text={item.text} environmentId={props.environmentId} />
        </div>
        {item.reply ? (
          <div className="rounded-2xl bg-muted px-3.5 py-2 text-foreground text-sm">
            <BotMarkdown text={item.reply} environmentId={props.environmentId} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function WorkerChip(props: {
  readonly item: Extract<BotChatItem, { readonly kind: "worker" }>;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const shell = useThreadShell(scopeThreadRef(props.environmentId, item.threadId));
  const status = shell?.latestRun?.status ?? item.status;
  return (
    <button
      type="button"
      className="my-1 flex max-w-[85%] items-center gap-2 self-start rounded-full border border-border/70 px-3 py-1.5 text-left text-muted-foreground text-xs hover:bg-accent/60 hover:text-foreground"
      onClick={() => props.onOpenThread(item.threadId)}
    >
      <BotIcon className="size-3.5 shrink-0" />
      <span className="truncate">Started {shell?.title ?? item.title}</span>
      {status ? <span className="shrink-0 opacity-70">· {status}</span> : null}
    </button>
  );
}

function BotComposer(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
}) {
  const draftTarget = useMemo(
    () => scopeThreadRef(props.environmentId, props.bot.homeThreadId),
    [props.environmentId, props.bot.homeThreadId],
  );
  const text = useComposerDraftStore((store) => store.getComposerDraft(draftTarget)?.prompt ?? "");
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setText = (value: string) => setPrompt(draftTarget, value);
  const [images, setImages] = useState<
    ReadonlyArray<{ readonly key: string; readonly upload: UploadChatImageAttachment }>
  >([]);
  const [sending, setSending] = useState(false);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const ready = props.runtimeMode !== null && props.interactionMode !== null;
  const canSend = ready && !sending && (text.trim() !== "" || images.length > 0);

  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();
    const fitting = files.filter((file) => file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (fitting.length < files.length) {
      toastManager.add({
        type: "error",
        title: "Image too large",
        description: `Images can be up to ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 1024 / 1024} MiB each.`,
      });
    }
    void Promise.all(
      fitting.map(async (file) => ({
        key: randomUUID(),
        upload: {
          type: "image" as const,
          name: file.name || "image.png",
          mimeType: file.type,
          sizeBytes: file.size,
          dataUrl: await readFileAsDataUrl(file),
        },
      })),
    ).then(
      (pasted) => setImages((current) => [...current, ...pasted]),
      (error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not read the pasted image",
          description: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const send = async () => {
    const message = text.trim();
    if (!canSend || props.runtimeMode === null || props.interactionMode === null) return;
    const sentText = text;
    const sentImageKeys = new Set(images.map((image) => image.key));
    setSending(true);
    const result = await startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.bot.homeThreadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: message,
          attachments: images.map((image) => image.upload),
        },
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
        dispatchMode: "queue",
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      if (useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt === sentText) {
        setPrompt(draftTarget, "");
      }
      setImages((current) => current.filter((image) => !sentImageKeys.has(image.key)));
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
      <div className="flex flex-1 flex-col gap-2">
        {images.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {images.map(({ key, upload }) => (
              <div key={key} className="relative">
                <img
                  alt={upload.name}
                  className="size-16 rounded-lg object-cover"
                  src={upload.dataUrl}
                />
                <Button
                  aria-label={`Remove ${upload.name}`}
                  className="absolute -top-2 -right-2"
                  size="icon-xs"
                  variant="secondary"
                  onClick={() =>
                    setImages((current) => current.filter((image) => image.key !== key))
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <Textarea
          aria-label={`Message ${props.bot.name}`}
          placeholder={`Message ${props.bot.name}`}
          rows={1}
          value={text}
          disabled={!ready}
          onChange={(event) => setText(event.target.value)}
          onPaste={pasteImages}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </div>
      <Button aria-label="Send" disabled={!canSend} size="icon" type="submit">
        <ArrowUpIcon />
      </Button>
    </form>
  );
}

function scrollIntoViewOnMount(element: HTMLDivElement | null) {
  element?.scrollIntoView({ block: "end" });
}
