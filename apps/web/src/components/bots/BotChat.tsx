import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type BotSummary,
  type EnvironmentId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ArrowUpIcon, BotIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { useComposerDraftStore, type ComposerImageAttachment } from "../../composerDraftStore";
import { newMessageId, randomUUID } from "../../lib/utils";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  useEnvironmentThread,
  refreshEnvironmentThread,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { attachmentUploadBlockReason } from "../../lib/attachmentUploadState";
import ChatMarkdown from "../ChatMarkdown";
import { readFileAsDataUrl } from "../ChatView.logic";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { createBotChatProjector } from "@t3tools/client-runtime/state/bot-chat-rows";
import {
  botChatHistoryStart,
  botChatRunStatusLabel,
  botConversationStatus,
  botWakeSenderLabel,
  isBotQueueHeld,
  rewriteThreadLinks,
  shouldLoadEarlierBotChatHistory,
  threadIdFromHref,
  type BotChatItem,
} from "@t3tools/client-runtime/state/bot-conversation";

const EMPTY_IMAGES: ReadonlyArray<ComposerImageAttachment> = [];

export function BotChat(props: {
  readonly bot: BotSummary;
  readonly environmentId: EnvironmentId;
  readonly onRunSettled: () => void;
}) {
  const detail = useEnvironmentQuery(
    serverEnvironment.bots.get({
      environmentId: props.environmentId,
      input: { botId: props.bot.id },
    }),
  );
  const thread = useEnvironmentThread(props.environmentId, props.bot.homeThreadId);
  const projection = Option.getOrNull(thread.data);
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const scrollContainer = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const earlierScroll = useRef<{ height: number; top: number } | null>(null);
  const loadEarlier = useCallback(() => {
    const container = scrollContainer.current;
    if (container)
      earlierScroll.current = { height: container.scrollHeight, top: container.scrollTop };
    void loadEarlierHistory({
      environmentId: props.environmentId,
      input: { threadId: props.bot.homeThreadId },
    });
  }, [loadEarlierHistory, props.environmentId, props.bot.homeThreadId]);
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const projectChat = useMemo(() => createBotChatProjector(), []);
  const threadError = Option.getOrNull(thread.error);
  const homeThreadArchived =
    projection !== null
      ? projection.thread.archivedAt !== null
      : props.bot.homeThreadArchived === true;
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive);
  const [unarchiving, setUnarchiving] = useState(false);
  const unarchive = async () => {
    if (unarchiving) return;
    setUnarchiving(true);
    try {
      await unarchiveThread({
        environmentId: props.environmentId,
        input: { threadId: props.bot.homeThreadId },
      });
      props.onRunSettled();
    } finally {
      setUnarchiving(false);
    }
  };
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const connectionReason =
    presentation?.connection.phase === "connected"
      ? null
      : presentation === null
        ? "Environment unavailable. Reconnect to message this bot."
        : `${connectionStatusText(presentation.connection)} Reconnect to message this bot.`;
  const disabledReason =
    connectionReason ??
    (thread.status === "deleted"
      ? "This bot's home thread is missing"
      : homeThreadArchived
        ? "Home thread archived"
        : threadError !== null
          ? "Could not load this bot’s home thread"
          : projection === null
            ? "Loading this bot’s home thread…"
            : null);
  const items = useMemo(
    () =>
      projectChat({
        bot: props.bot,
        detail: detail.data,
        since: botChatHistoryStart(projection?.messages ?? [], thread.history.hasMoreHistory),
        messages: projection?.messages ?? [],
        runs: projection?.runs ?? [],
        turnItems: projection?.turnItems ?? [],
      }),
    [
      projectChat,
      props.bot,
      detail.data,
      thread.history.hasMoreHistory,
      projection?.messages,
      projection?.runs,
      projection?.turnItems,
    ],
  );
  const autoHistory = useRef({ pages: 0, cursor: null as string | null });
  const hasOwnerMessage = items.some((item) => item.kind === "you");
  const canLoadHistory = projection !== null && thread.status !== "deleted";
  useEffect(() => {
    if (
      !canLoadHistory ||
      !shouldLoadEarlierBotChatHistory({
        hasOwnerMessage,
        history: thread.history,
        autoLoadedPages: autoHistory.current.pages,
      }) ||
      autoHistory.current.cursor === thread.history.historyCursor
    )
      return;
    autoHistory.current.cursor = thread.history.historyCursor;
    autoHistory.current.pages += 1;
    loadEarlier();
  }, [canLoadHistory, hasOwnerMessage, thread.history, loadEarlier]);
  const status = useMemo(
    () => (projection === null ? { kind: "idle" as const } : botConversationStatus(projection)),
    [projection],
  );
  const working = status.kind === "working";
  const queueHeld = isBotQueueHeld(projection?.runs ?? []);
  const resumeQueue = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const [resuming, setResuming] = useState(false);
  const resume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await resumeQueue({
        environmentId: props.environmentId,
        input: { threadId: props.bot.homeThreadId },
      });
      props.onRunSettled();
    } finally {
      setResuming(false);
    }
  };
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
  useLayoutEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;
    const earlier = earlierScroll.current;
    if (earlier) {
      container.scrollTop = earlier.top + container.scrollHeight - earlier.height;
      if (!thread.history.loading) earlierScroll.current = null;
    } else if (followEnd.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [thread.history.loading]);
  useEffect(() => {
    const content = scrollContent.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const container = scrollContainer.current;
      if (container && followEnd.current && earlierScroll.current === null) {
        container.scrollTop = container.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const latestReply = items.findLast((item) => item.kind === "bot");
  const statusAnnouncement =
    disabledReason !== null
      ? disabledReason
      : status.kind === "working"
        ? `${props.bot.name} is working.`
        : status.kind === "needs-attention"
          ? status.request === "approval"
            ? "Needs your approval."
            : "Needs your input."
          : status.kind === "failed"
            ? "Run failed."
            : status.kind === "stopped"
              ? "Stopped."
              : queueHeld
                ? "Queue held."
                : `${props.bot.name} is ready.`;
  const onRunSettled = useEffectEvent(() => {
    props.onRunSettled();
    detail.refresh();
  });
  useEffect(() => {
    if (!working) onRunSettled();
  }, [working]);
  const navigate = useNavigate();
  const openThread = useCallback(
    (threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: props.environmentId, threadId },
      }),
    [navigate, props.environmentId],
  );

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
      <div
        ref={scrollContainer}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        onClickCapture={interceptThreadLinks}
        onScroll={(event) => {
          const container = event.currentTarget;
          followEnd.current =
            container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        }}
      >
        <div ref={scrollContent} className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-6">
          {thread.history.hasMoreHistory || thread.history.error !== null ? (
            <div className="flex flex-col items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={thread.history.loading}
                onClick={loadEarlier}
              >
                {thread.history.loading
                  ? "Loading earlier turns…"
                  : thread.history.error
                    ? "Retry loading earlier turns"
                    : "Load earlier turns"}
              </Button>
              {thread.history.error !== null ? (
                <p role="status" className="text-center text-muted-foreground text-xs">
                  {thread.history.error}
                </p>
              ) : null}
            </div>
          ) : null}
          {disabledReason !== null ? (
            <div
              role="status"
              className="flex flex-col items-center gap-2 text-sm text-muted-foreground"
            >
              <p>{disabledReason}</p>
              {homeThreadArchived && thread.status !== "deleted" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={unarchiving}
                  onClick={() => void unarchive()}
                >
                  {unarchiving ? "Unarchiving…" : "Unarchive"}
                </Button>
              ) : null}
              {threadError !== null && thread.status !== "deleted" ? (
                <>
                  <p>{threadError}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      refreshEnvironmentThread(props.environmentId, props.bot.homeThreadId)
                    }
                  >
                    Retry
                  </Button>
                </>
              ) : null}
            </div>
          ) : projection === null ? (
            <p className="text-center text-muted-foreground text-sm">Loading…</p>
          ) : items.length === 0 && !thread.history.hasMoreHistory && !thread.history.loading ? (
            <p className="text-center text-muted-foreground text-sm">
              Nothing between you and {props.bot.name} yet.
            </p>
          ) : null}
          {items.map((item) => (
            <ChatRow
              key={item.id}
              item={item}
              environmentId={props.environmentId}
              threadId={props.bot.homeThreadId}
              onOpenThread={openThread}
              scheduleTitle={
                item.kind === "wake"
                  ? (tasksQuery.data?.tasks.find((task) => task.id === item.scheduledTaskId)
                      ?.title ?? null)
                  : null
              }
              botName={props.bot.name}
            />
          ))}
          {working && !homeThreadArchived ? (
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
              <p>Open the thread for details.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openThread(props.bot.homeThreadId)}
              >
                Open thread
              </Button>
            </div>
          ) : status.kind === "stopped" ? (
            <div className="self-start rounded-2xl bg-muted px-3.5 py-2 text-muted-foreground text-sm">
              Stopped
            </div>
          ) : null}
          {queueHeld ? (
            <div role="status" className="self-start rounded-2xl bg-muted px-3.5 py-2 text-sm">
              <span>Queue held</span>
              <Button
                size="sm"
                variant="outline"
                disabled={resuming || disabledReason !== null}
                onClick={() => void resume()}
              >
                {resuming ? "Resuming…" : "Resume"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="false">
        <span>{statusAnnouncement}</span>
        {latestReply ? <span key={latestReply.id}>{props.bot.name} replied.</span> : null}
      </div>
      <BotComposer
        bot={props.bot}
        environmentId={props.environmentId}
        disabledReason={disabledReason}
        runtimeMode={projection?.thread.runtimeMode ?? null}
        interactionMode={projection?.thread.interactionMode ?? null}
      />
    </section>
  );
}

const ChatRow = memo(function ChatRow(props: {
  readonly item: BotChatItem;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly scheduleTitle: string | null;
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
        scheduleTitle={props.scheduleTitle}
        botName={props.botName}
      />
    );
  }
  if (item.kind === "you") {
    return (
      <YourMessage item={item} environmentId={props.environmentId} threadId={props.threadId} />
    );
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
});

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
  readonly threadId: ThreadId;
}) {
  const { item } = props;
  const label = botChatRunStatusLabel(item.runStatus);
  const cancelQueuedRun = useAtomCommand(threadEnvironment.cancelQueuedRun);
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
  const resources = useMemo(
    () => item.imageIds.map((attachmentId) => ({ _tag: "attachment" as const, attachmentId })),
    [item.imageIds],
  );
  const imageUrls = useAssetUrls(props.environmentId, resources);
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
      {imageUrls.map((url, index) =>
        url ? (
          <a
            key={item.imageIds[index]}
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open attached image ${index + 1}`}
          >
            <img alt="" className="max-h-64 rounded-2xl" src={url} />
          </a>
        ) : null,
      )}
      {item.text ? (
        <p className="whitespace-pre-wrap break-words rounded-2xl bg-primary px-3.5 py-2 text-primary-foreground text-sm">
          {item.text}
        </p>
      ) : null}
      {label ? (
        <div className="flex items-center gap-2 text-xs">
          <span
            className={item.runStatus === "failed" ? "text-destructive" : "text-muted-foreground"}
          >
            {label}
          </span>
          {item.runStatus === "queued" && item.runId !== null ? (
            <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const WakeRow = memo(function WakeRow(props: {
  readonly item: Extract<BotChatItem, { readonly kind: "wake" }>;
  readonly environmentId: EnvironmentId;
  readonly scheduleTitle: string | null;
  readonly botName: string;
}) {
  const { item } = props;
  const [expanded, setExpanded] = useState(false);
  const sender = useThreadShell(
    item.senderThreadId ? scopeThreadRef(props.environmentId, item.senderThreadId) : null,
  );
  const from = botWakeSenderLabel({
    senderTitle: sender?.title ?? null,
    scheduleTitle: props.scheduleTitle,
    botName: props.botName,
    scheduled: item.scheduledTaskId !== null,
  });
  const replyPreview =
    botChatRunStatusLabel(item.runStatus) ??
    item.reply
      ?.split("\n")
      .find((line) => line.trim())
      ?.replace(/[*`#>]/g, "") ??
    "no reply yet";
  return (
    <details
      className="group min-w-0 max-w-[85%] self-start text-muted-foreground text-xs"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-border/70 px-3 py-1.5 hover:bg-accent/60 hover:text-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <span className="shrink-0">From</span>
          <span className="truncate">{from}</span>
        </span>
        <span
          className={
            item.runStatus === "failed" ? "truncate text-destructive" : "truncate opacity-70"
          }
        >
          · {replyPreview}
        </span>
      </summary>
      {expanded ? (
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
      ) : null}
    </details>
  );
});

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
  readonly disabledReason: string | null;
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
  const images = useComposerDraftStore(
    (store) => store.getComposerDraft(draftTarget)?.images ?? EMPTY_IMAGES,
  );
  const serverConfig = useServerConfigs().get(props.environmentId);
  const supportsUploads = serverConfig?.environment.capabilities.attachmentUploads === true;
  const uploadsByImageId = useAttachmentUploadStore((store) => store.uploadsByImageId);
  const uploadReason = supportsUploads
    ? attachmentUploadBlockReason({
        imageIds: images.map((image) => image.id),
        uploadsByImageId,
        environmentId: props.environmentId,
      })
    : null;
  useEffect(() => {
    if (!supportsUploads) return;
    for (const image of images)
      startAttachmentUpload({ environmentId: props.environmentId, image, draftTarget });
  }, [draftTarget, images, props.environmentId, supportsUploads]);
  const removeImage = (image: ComposerImageAttachment) => {
    releaseAttachmentUpload(image.id);
    useComposerDraftStore.getState().removeImage(draftTarget, image.id);
  };
  const [sending, setSending] = useState(false);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const ready =
    props.disabledReason === null &&
    serverConfig !== undefined &&
    props.runtimeMode !== null &&
    props.interactionMode !== null;
  const canSend =
    ready && !sending && uploadReason === null && (text.trim() !== "" || images.length > 0);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageFiles = (files: Iterable<File>) =>
    Array.from(files).filter((file) => file.type.startsWith("image/"));
  const addImages = (files: ReadonlyArray<File>) => {
    const fitting = files.filter((file) => file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (fitting.length < files.length) {
      toastManager.add({
        type: "error",
        title: "Image too large",
        description: `Images can be up to ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 1024 / 1024} MiB each.`,
      });
    }
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(draftTarget);
    const available = Math.max(
      0,
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
        (current?.images.length ?? 0) -
        (current?.files.length ?? 0),
    );
    if (fitting.length > available)
      toastManager.add({
        type: "error",
        title: "Too many images",
        description: `Attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
      });
    const accepted = fitting.slice(0, available).map((file) => ({
      type: "image" as const,
      id: randomUUID(),
      name: file.name || "image.png",
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    store.addImages(draftTarget, accepted, { allowDuplicates: true });
    void Promise.all(
      accepted.map(async (image) => ({
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    )
      .then((serialized) => {
        const latest = useComposerDraftStore.getState();
        const draft = latest.getComposerDraft(draftTarget);
        const ids = new Set(draft?.images.map((image) => image.id));
        return latest.syncPersistedAttachments(draftTarget, [
          ...(draft?.persistedAttachments ?? []),
          ...serialized.filter((image) => ids.has(image.id)),
        ]);
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not save images",
          description: String(error),
        }),
      );
  };

  const send = async () => {
    const message = text.trim();
    if (!canSend || props.runtimeMode === null || props.interactionMode === null) return;
    const sentText = text;
    setSending(true);
    try {
      let attachments;
      if (supportsUploads) {
        for (const image of images)
          startAttachmentUpload({ environmentId: props.environmentId, image, draftTarget });
        await awaitAttachmentUploads(images.map((image) => image.id));
        attachments = getUploadedAttachments({ environmentId: props.environmentId, images });
        if (attachments === null) throw new Error("Retry or remove failed uploads before sending.");
      } else {
        attachments = await Promise.all(
          images.map(async (image) => ({
            type: "image" as const,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
          })),
        );
      }
      const result = await startTurn({
        environmentId: props.environmentId,
        input: {
          threadId: props.bot.homeThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: message,
            attachments,
          },
          runtimeMode: props.runtimeMode,
          interactionMode: props.interactionMode,
          dispatchMode: "queue",
        },
      });
      if (result._tag === "Success") {
        if (useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt === sentText) {
          setPrompt(draftTarget, "");
        }
        const store = useComposerDraftStore.getState();
        for (const image of images) store.removeImage(draftTarget, image.id);
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
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not send to ${props.bot.name}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pb-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (ready && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = imageFiles(event.dataTransfer.files);
        if (!ready || files.length === 0) return;
        event.preventDefault();
        addImages(files);
      }}
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = imageFiles(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          addImages(files);
        }}
      />
      <Button
        aria-label="Attach images"
        disabled={!ready}
        size="icon"
        type="button"
        variant="ghost"
        onClick={() => imageInputRef.current?.click()}
      >
        <PaperclipIcon />
      </Button>
      <div className="flex flex-1 flex-col gap-2">
        {props.disabledReason || uploadReason ? (
          <p role="status" className="text-sm text-muted-foreground">
            {props.disabledReason ?? uploadReason}
          </p>
        ) : null}
        {images.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {images.map((image) => (
              <div key={image.id} className="relative">
                <img
                  alt={image.name}
                  className="size-16 rounded-lg object-cover"
                  src={image.previewUrl}
                />
                {supportsUploads && uploadsByImageId[image.id]?.status === "failed" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      retryAttachmentUpload({
                        environmentId: props.environmentId,
                        image,
                        draftTarget,
                      })
                    }
                  >
                    Retry upload
                  </Button>
                ) : null}
                <Button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  className="absolute -top-2 -right-2"
                  size="icon-xs"
                  variant="secondary"
                  onClick={() => removeImage(image)}
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
          onPaste={(event) => {
            const files = imageFiles(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            addImages(files);
          }}
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
