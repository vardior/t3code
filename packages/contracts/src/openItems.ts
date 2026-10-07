import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, OpenItemId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OPEN_ITEM_MAX_OPEN_PER_THREAD = 20;
export const OPEN_ITEM_MAX_RESOLVED_PER_THREAD = 10;
export const OPEN_ITEM_MAX_OPTIONS = 4;

export const OpenItemTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(140));
export const OpenItemDetail = TrimmedNonEmptyString.check(Schema.isMaxLength(600));
export const OpenItemOption = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export const OpenItemOptions = Schema.Array(OpenItemOption).check(
  Schema.isMaxLength(OPEN_ITEM_MAX_OPTIONS),
);
export const OpenItemDefaultOnSilence = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const OpenItemAnswer = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

export const OpenItemStatus = Schema.Literals(["open", "answered", "dropped"]);
export type OpenItemStatus = typeof OpenItemStatus.Type;

export const OpenItemResolvedStatus = Schema.Literals(["answered", "dropped"]);
export type OpenItemResolvedStatus = typeof OpenItemResolvedStatus.Type;

const recommendedIsAnOption = Schema.makeFilter(
  (item: {
    readonly options?: ReadonlyArray<string> | undefined;
    readonly recommended?: string | null | undefined;
  }) =>
    item.recommended == null ||
    (item.options ?? []).includes(item.recommended) ||
    "recommended must be one of options.",
);

export const OpenItemContent = Schema.Struct({
  title: OpenItemTitle,
  detail: Schema.optional(OpenItemDetail),
  options: Schema.optional(OpenItemOptions),
  recommended: Schema.optional(OpenItemOption),
  defaultOnSilence: Schema.optional(OpenItemDefaultOnSilence),
}).check(recommendedIsAnOption);
export type OpenItemContent = typeof OpenItemContent.Type;

export const OpenItem = Schema.Struct({
  id: OpenItemId,
  threadId: ThreadId,
  title: OpenItemTitle,
  detail: Schema.optional(OpenItemDetail),
  options: Schema.optional(OpenItemOptions),
  recommended: Schema.optional(OpenItemOption),
  defaultOnSilence: Schema.optional(OpenItemDefaultOnSilence),
  status: OpenItemStatus,
  answer: Schema.optional(OpenItemAnswer),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type OpenItem = typeof OpenItem.Type;

export const OpenItemPatch = Schema.Struct({
  title: Schema.optional(OpenItemTitle),
  detail: Schema.optional(Schema.NullOr(OpenItemDetail)),
  options: Schema.optional(Schema.NullOr(OpenItemOptions)),
  recommended: Schema.optional(Schema.NullOr(OpenItemOption)),
  defaultOnSilence: Schema.optional(Schema.NullOr(OpenItemDefaultOnSilence)),
});
export type OpenItemPatch = typeof OpenItemPatch.Type;

export const OpenItemMcpAddResult = Schema.Struct({ itemId: OpenItemId });
export type OpenItemMcpAddResult = typeof OpenItemMcpAddResult.Type;

export const OpenItemMcpUpdateInput = Schema.Struct({
  itemId: OpenItemId,
  ...OpenItemPatch.fields,
});
export type OpenItemMcpUpdateInput = typeof OpenItemMcpUpdateInput.Type;

export const OpenItemMcpResolveInput = Schema.Struct({
  itemId: OpenItemId,
  status: OpenItemResolvedStatus,
  answer: Schema.optional(OpenItemAnswer),
});
export type OpenItemMcpResolveInput = typeof OpenItemMcpResolveInput.Type;

export const OpenItemMcpItemResult = Schema.Struct({ item: OpenItem });
export type OpenItemMcpItemResult = typeof OpenItemMcpItemResult.Type;

export const OpenItemMcpListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  includeResolved: Schema.optional(Schema.Boolean),
});
export type OpenItemMcpListInput = typeof OpenItemMcpListInput.Type;

export const OpenItemMcpListResult = Schema.Struct({ items: Schema.Array(OpenItem) });
export type OpenItemMcpListResult = typeof OpenItemMcpListResult.Type;

const OPEN_ITEM_FAILURE_MESSAGES = {
  thread_unavailable: "The thread is missing, archived, or deleted.",
  not_found: "That open item no longer exists.",
  not_open: "That open item is already resolved.",
  not_resolved: "That open item is still open.",
  too_many_open: `A thread can hold at most ${OPEN_ITEM_MAX_OPEN_PER_THREAD} open items. Resolve some before adding more.`,
  invalid_recommended: "recommended must be one of options.",
  rejected: "The open item could not be changed. Try again.",
} as const;

export const OpenItemFailureReason = Schema.Literals(
  Object.keys(OPEN_ITEM_FAILURE_MESSAGES) as Array<keyof typeof OPEN_ITEM_FAILURE_MESSAGES>,
);
export type OpenItemFailureReason = typeof OpenItemFailureReason.Type;

export class OpenItemError extends Schema.TaggedError<OpenItemError>()("OpenItemError", {
  reason: OpenItemFailureReason,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return OPEN_ITEM_FAILURE_MESSAGES[this.reason];
  }
}

const OpenItemTarget = { threadId: ThreadId, itemId: OpenItemId };

export const OpenItemAnswerInput = Schema.Struct({
  ...OpenItemTarget,
  answer: OpenItemAnswer,
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
});
export type OpenItemAnswerInput = typeof OpenItemAnswerInput.Type;

export const OpenItemDropInput = Schema.Struct(OpenItemTarget);
export type OpenItemDropInput = typeof OpenItemDropInput.Type;

export const OpenItemReopenInput = Schema.Struct(OpenItemTarget);
export type OpenItemReopenInput = typeof OpenItemReopenInput.Type;

export const OPEN_ITEM_WS_METHODS = {
  openItemsAnswer: "openItems.answer",
  openItemsDrop: "openItems.drop",
  openItemsReopen: "openItems.reopen",
} as const;

const openItemError = Schema.Union([OpenItemError, EnvironmentAuthorizationError]);

export const OpenItemsRpcGroup = RpcGroup.make(
  Rpc.make(OPEN_ITEM_WS_METHODS.openItemsAnswer, {
    payload: OpenItemAnswerInput,
    success: OpenItem,
    error: openItemError,
  }),
  Rpc.make(OPEN_ITEM_WS_METHODS.openItemsDrop, {
    payload: OpenItemDropInput,
    success: OpenItem,
    error: openItemError,
  }),
  Rpc.make(OPEN_ITEM_WS_METHODS.openItemsReopen, {
    payload: OpenItemReopenInput,
    success: OpenItem,
    error: openItemError,
  }),
);
