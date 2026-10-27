import {
  CommandId,
  MessageId,
  OpenItemError,
  OpenItemId,
  type OpenItem,
  type OpenItemAnswerInput,
  type OpenItemContent,
  type OpenItemDropInput,
  type OpenItemPatch,
  type OpenItemReopenInput,
  type OpenItemResolvedStatus,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as BotService from "../bots/BotService.ts";
import { planOpenItemChange, type OpenItemChange } from "../orchestration-v2/OpenItems.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

const isOpenItemError = Schema.is(OpenItemError);

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

export class OpenItemService extends Context.Service<
  OpenItemService,
  {
    readonly add: (
      threadId: ThreadId,
      content: OpenItemContent,
    ) => Effect.Effect<OpenItem, OpenItemError>;
    readonly update: (
      threadId: ThreadId,
      itemId: OpenItemId,
      patch: OpenItemPatch,
    ) => Effect.Effect<OpenItem, OpenItemError>;
    readonly resolve: (
      threadId: ThreadId,
      itemId: OpenItemId,
      resolution: { readonly status: OpenItemResolvedStatus; readonly answer?: string | undefined },
    ) => Effect.Effect<OpenItem, OpenItemError>;
    readonly answer: (input: OpenItemAnswerInput) => Effect.Effect<OpenItem, OpenItemError>;
    readonly drop: (input: OpenItemDropInput) => Effect.Effect<OpenItem, OpenItemError>;
    readonly reopen: (input: OpenItemReopenInput) => Effect.Effect<OpenItem, OpenItemError>;
    readonly list: (
      threadId: ThreadId,
      options: { readonly includeResolved: boolean },
    ) => Effect.Effect<ReadonlyArray<OpenItem>, OpenItemError>;
  }
>()("t3/openItems/OpenItemService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const bots = yield* BotService.BotService;

  const readThread = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.mapError((cause) => new OpenItemError({ reason: "thread_unavailable", cause })),
      Effect.filterOrFail(
        (thread) => thread !== null,
        () => new OpenItemError({ reason: "thread_unavailable" }),
      ),
    );

  const apply = Effect.fn("OpenItemService.apply")(function* (
    threadId: ThreadId,
    change: OpenItemChange,
    command: (commandId: CommandId) => OrchestrationV2ServerCommand,
  ) {
    const thread = yield* readThread(threadId);
    const plan = planOpenItemChange(thread, change, DateTime.formatIso(yield* DateTime.now));
    if (!plan.ok) return yield* new OpenItemError({ reason: plan.reason });
    yield* orchestrator
      .dispatch(command(CommandId.make(`open-item:${yield* randomUuidV4}`)))
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "OrchestratorDispatchError" && isOpenItemError(cause.cause)
            ? cause.cause
            : new OpenItemError({ reason: "rejected", cause }),
        ),
      );
    const items = (yield* readThread(threadId)).openItems ?? [];
    const item = items.find((candidate) => candidate.id === change.itemId);
    return item ?? (yield* new OpenItemError({ reason: "not_found" }));
  });

  const notifyOwner = (threadId: ThreadId, item: OpenItem) =>
    Effect.gen(function* () {
      if (!(yield* bots.isHomeThread(threadId))) return;
      yield* bots.notifyOwner(threadId, {
        title: clip(item.title, 80),
        body: clip(item.detail ?? item.title, 300),
      });
    }).pipe(
      Effect.catchTags({
        BotError: (error) =>
          Effect.logDebug("Open item added without an owner notification", {
            threadId,
            message: error.message,
          }),
      }),
    );

  const add = Effect.fn("OpenItemService.add")(function* (
    threadId: ThreadId,
    content: OpenItemContent,
  ) {
    const alreadyOpen = ((yield* readThread(threadId)).openItems ?? []).find(
      (item) => item.status === "open" && item.title === content.title,
    );
    if (alreadyOpen !== undefined) return alreadyOpen;
    const itemId = OpenItemId.make(`item-${yield* randomUuidV4}`);
    const item = yield* apply(threadId, { type: "add", itemId, content }, (commandId) => ({
      type: "thread.open-item.add",
      commandId,
      threadId,
      itemId,
      content,
    }));
    yield* notifyOwner(threadId, item);
    return item;
  });

  const update = Effect.fn("OpenItemService.update")(function* (
    threadId: ThreadId,
    itemId: OpenItemId,
    patch: OpenItemPatch,
  ) {
    return yield* apply(threadId, { type: "update", itemId, patch }, (commandId) => ({
      type: "thread.open-item.update",
      commandId,
      threadId,
      itemId,
      patch,
    }));
  });

  const resolve = Effect.fn("OpenItemService.resolve")(function* (
    threadId: ThreadId,
    itemId: OpenItemId,
    resolution: { readonly status: OpenItemResolvedStatus; readonly answer?: string | undefined },
  ) {
    return yield* apply(threadId, { type: "resolve", itemId, ...resolution }, (commandId) => ({
      type: "thread.open-item.resolve",
      commandId,
      threadId,
      itemId,
      status: resolution.status,
      ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
    }));
  });

  const ownerReply = Effect.fn("OpenItemService.ownerReply")(function* (
    input: OpenItemReopenInput,
    text: (item: OpenItem) => string,
  ) {
    const thread = yield* readThread(input.threadId);
    const existing = (thread.openItems ?? []).find((item) => item.id === input.itemId);
    if (existing === undefined) return yield* new OpenItemError({ reason: "not_found" });
    return {
      messageId: MessageId.make(`open-item-reply:${yield* randomUuidV4}`),
      text: text(existing),
      creationSource: input.creationSource ?? "web",
    };
  });

  const ownerResolve = Effect.fn("OpenItemService.ownerResolve")(function* (
    input: OpenItemDropInput,
    resolution: { readonly status: OpenItemResolvedStatus; readonly answer?: string | undefined },
    text: (item: OpenItem) => string,
  ) {
    const reply = yield* ownerReply(input, text);
    return yield* apply(
      input.threadId,
      { type: "resolve", itemId: input.itemId, ...resolution },
      (commandId) => ({
        type: "thread.open-item.resolve",
        commandId,
        threadId: input.threadId,
        itemId: input.itemId,
        status: resolution.status,
        ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
        reply,
      }),
    );
  });

  const answer = Effect.fn("OpenItemService.answer")(function* (input: OpenItemAnswerInput) {
    return yield* ownerResolve(
      input,
      { status: "answered", answer: input.answer },
      (item) => `Re: ${item.title}: ${input.answer}`,
    );
  });

  const drop = Effect.fn("OpenItemService.drop")(function* (input: OpenItemDropInput) {
    return yield* ownerResolve(input, { status: "dropped" }, (item) => `Dropped: ${item.title}`);
  });

  const reopen = Effect.fn("OpenItemService.reopen")(function* (input: OpenItemReopenInput) {
    const reply = yield* ownerReply(input, (item) => `Reopened: ${item.title}`);
    return yield* apply(input.threadId, { type: "reopen", itemId: input.itemId }, (commandId) => ({
      type: "thread.open-item.reopen",
      commandId,
      threadId: input.threadId,
      itemId: input.itemId,
      reply,
    }));
  });

  const list = Effect.fn("OpenItemService.list")(function* (
    threadId: ThreadId,
    options: { readonly includeResolved: boolean },
  ) {
    const items = (yield* readThread(threadId)).openItems ?? [];
    return options.includeResolved ? items : items.filter((item) => item.status === "open");
  });

  return OpenItemService.of({ add, update, resolve, answer, drop, reopen, list });
});

export const layer = Layer.effect(OpenItemService, make);
