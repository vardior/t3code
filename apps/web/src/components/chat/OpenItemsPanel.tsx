import { useAtomValue } from "@effect/atom-react";
import { groupOpenItems } from "@t3tools/client-runtime/state/open-items";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { OpenItem, ScopedThreadRef } from "@t3tools/contracts";
import { useMemo, useRef, useState, type FormEvent } from "react";

import { useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";

const NO_ITEMS: ReadonlyArray<OpenItem> = [];

type OpenItemAction =
  | { readonly type: "answer"; readonly answer: string }
  | { readonly type: "drop" }
  | { readonly type: "reopen" };

function useOpenItemAction(threadRef: ScopedThreadRef, item: OpenItem) {
  const options = { reportFailure: false } as const;
  const answer = useAtomCommand(serverEnvironment.answerOpenItem, options);
  const drop = useAtomCommand(serverEnvironment.dropOpenItem, options);
  const reopen = useAtomCommand(serverEnvironment.reopenOpenItem, options);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = async (action: OpenItemAction) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const target = { threadId: threadRef.threadId, itemId: item.id };
    const environmentId = threadRef.environmentId;
    const result = await (
      action.type === "answer"
        ? answer({
            environmentId,
            input: { ...target, answer: action.answer, creationSource: "web" },
          })
        : action.type === "drop"
          ? drop({ environmentId, input: target })
          : reopen({ environmentId, input: target })
    ).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The open item could not be changed.");
    }
    return false;
  };
  return { run, busy, error };
}

export function OpenItemsPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const items = shell?.openItems ?? NO_ITEMS;
  const groups = useMemo(() => groupOpenItems(items), [items]);
  const canOperate = useAtomValue(
    serverEnvironment.answerOpenItem.permissionAtom(threadRef.environmentId),
  );
  const [showResolved, setShowResolved] = useState(false);
  return (
    <ScrollArea scrollFade className="h-full min-h-0">
      <div className="flex flex-col gap-3 p-3">
        {groups.open.length === 0 ? (
          <p className="px-1 py-2 text-muted-foreground text-sm">Nothing is waiting on you.</p>
        ) : (
          groups.open.map((item) => (
            <OpenItemCard
              key={item.id}
              threadRef={threadRef}
              item={item}
              cwd={shell?.worktreePath ?? undefined}
              canOperate={canOperate}
            />
          ))
        )}
        {groups.resolved.length > 0 ? (
          <section className="flex flex-col gap-1">
            <CollapsibleSectionHeader
              expanded={showResolved}
              onClick={() => setShowResolved((value) => !value)}
              accessory={
                <span className="text-muted-foreground text-xs">{groups.resolved.length}</span>
              }
            >
              Resolved
            </CollapsibleSectionHeader>
            {showResolved
              ? groups.resolved.map((item) => (
                  <ResolvedOpenItemRow
                    key={item.id}
                    threadRef={threadRef}
                    item={item}
                    canOperate={canOperate}
                  />
                ))
              : null}
          </section>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function OpenItemCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly item: OpenItem;
  readonly cwd: string | undefined;
  readonly canOperate: boolean;
}) {
  const { item } = props;
  const action = useOpenItemAction(props.threadRef, item);
  const [reply, setReply] = useState("");
  const disabled = !props.canOperate || action.busy;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = reply.trim();
    if (answer.length === 0) return;
    if (await action.run({ type: "answer", answer })) setReply("");
  };
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-3"
      data-open-item={item.id}
    >
      <header className="flex min-w-0 items-baseline gap-2">
        <h3 className="min-w-0 flex-1 font-medium text-foreground text-sm">{item.title}</h3>
        <span className="shrink-0 text-muted-foreground text-xs">
          {formatRelativeTimeLabel(item.createdAt)}
        </span>
      </header>
      {item.detail ? (
        <ChatMarkdown
          text={item.detail}
          cwd={props.cwd}
          threadRef={props.threadRef}
          className="text-muted-foreground text-sm"
        />
      ) : null}
      {item.options && item.options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((option) => {
            const recommended = option === item.recommended;
            return (
              <Button
                key={option}
                size="xs"
                variant={recommended ? "default" : "outline"}
                disabled={disabled}
                aria-label={recommended ? `${option} (recommended)` : option}
                title={recommended ? "Recommended" : undefined}
                onClick={() => void action.run({ type: "answer", answer: option })}
              >
                {option}
                {recommended ? <span className="opacity-70">· Recommended</span> : null}
              </Button>
            );
          })}
        </div>
      ) : null}
      {item.defaultOnSilence ? (
        <p className="text-muted-foreground text-xs">
          If you don't answer: {item.defaultOnSilence}
        </p>
      ) : null}
      <form className="flex min-w-0 items-center gap-1.5" onSubmit={(event) => void submit(event)}>
        <Input
          className="min-w-0 flex-1"
          size="sm"
          value={reply}
          placeholder="Reply…"
          aria-label={`Reply to ${item.title}`}
          disabled={disabled}
          maxLength={2000}
          onChange={(event) => setReply(event.target.value)}
        />
        <Button type="submit" size="xs" variant="secondary" disabled={disabled || !reply.trim()}>
          Send
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => void action.run({ type: "drop" })}
        >
          Drop
        </Button>
      </form>
      {action.error ? <p className="text-destructive-foreground text-xs">{action.error}</p> : null}
    </article>
  );
}

function ResolvedOpenItemRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly item: OpenItem;
  readonly canOperate: boolean;
}) {
  const { item } = props;
  const action = useOpenItemAction(props.threadRef, item);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">{item.title}</span>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!props.canOperate || action.busy}
          onClick={() => void action.run({ type: "reopen" })}
        >
          Reopen
        </Button>
      </div>
      <span className="truncate text-muted-foreground/80 text-xs">
        {item.status === "answered"
          ? item.answer
            ? `Answered: ${item.answer}`
            : "Answered"
          : "Dropped"}
      </span>
      {action.error ? <p className="text-destructive-foreground text-xs">{action.error}</p> : null}
    </div>
  );
}
