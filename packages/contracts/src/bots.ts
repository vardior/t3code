import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";

import { IsoDateTime, ScheduledTaskId, ThreadId } from "./baseSchemas.ts";

export const BotWorker = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  createdAt: IsoDateTime,
  status: Schema.NullOr(Schema.String),
});
export type BotWorker = typeof BotWorker.Type;

export const BotSlackDm = Schema.Struct({
  text: Schema.String,
  at: IsoDateTime,
});
export type BotSlackDm = typeof BotSlackDm.Type;

export const BotSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  homeThreadId: ThreadId,
  scheduledTaskIds: Schema.Array(ScheduledTaskId),
  paused: Schema.Boolean,
  pausedUntil: Schema.optionalKey(IsoDateTime),
  homeThreadMissing: Schema.optionalKey(Schema.Boolean),
  homeThreadArchived: Schema.optionalKey(Schema.Boolean),
  homeThreadQueueHeld: Schema.optionalKey(Schema.Boolean),
  lastReply: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ text: Schema.String, at: IsoDateTime })),
  ),
});
export type BotSummary = typeof BotSummary.Type;

export const BotDetail = Schema.Struct({
  charter: Schema.NullOr(Schema.String),
  workers: Schema.Array(BotWorker),
  slackDms: Schema.Array(BotSlackDm),
});
export type BotDetail = typeof BotDetail.Type;

export const BotGetInput = Schema.Struct({ botId: Schema.String });
export type BotGetInput = typeof BotGetInput.Type;

export const BotListInput = Schema.Struct({});
export type BotListInput = typeof BotListInput.Type;

export const BotListResult = Schema.Struct({
  bots: Schema.Array(BotSummary),
});
export type BotListResult = typeof BotListResult.Type;

export const BotSetPausedInput = Schema.Struct({
  botId: Schema.String,
  paused: Schema.Boolean,
});
export type BotSetPausedInput = typeof BotSetPausedInput.Type;

export const BotSetPausedResult = Schema.Struct({});
export type BotSetPausedResult = typeof BotSetPausedResult.Type;

export const BotReorderInput = Schema.Struct({ names: Schema.Array(Schema.String) });
export type BotReorderInput = typeof BotReorderInput.Type;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const BOT_WS_METHODS = {
  botsList: "bots.list",
  botsGet: "bots.get",
  botsSetPaused: "bots.setPaused",
  botsReorder: "bots.reorder",
  botsSubscribeChanges: "bots.subscribeChanges",
} as const;

export const BotsRpcGroup = RpcGroup.make(
  Rpc.make(BOT_WS_METHODS.botsSubscribeChanges, {
    payload: BotListInput,
    success: Schema.Struct({}),
    error: Schema.Union([BotError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make(BOT_WS_METHODS.botsGet, {
    payload: BotGetInput,
    success: BotDetail,
    error: Schema.Union([BotError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOT_WS_METHODS.botsList, {
    payload: BotListInput,
    success: BotListResult,
    error: Schema.Union([BotError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOT_WS_METHODS.botsReorder, {
    payload: BotReorderInput,
    success: Schema.Struct({}),
    error: Schema.Union([BotError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOT_WS_METHODS.botsSetPaused, {
    payload: BotSetPausedInput,
    success: BotSetPausedResult,
    error: Schema.Union([BotError, EnvironmentAuthorizationError]),
  }),
);

export const BOT_RPC_REQUIRED_SCOPES = {
  [BOT_WS_METHODS.botsList]: AuthOrchestrationReadScope,
  [BOT_WS_METHODS.botsSubscribeChanges]: AuthOrchestrationReadScope,
  [BOT_WS_METHODS.botsGet]: AuthOrchestrationReadScope,
  [BOT_WS_METHODS.botsSetPaused]: AuthOrchestrationOperateScope,
  [BOT_WS_METHODS.botsReorder]: AuthOrchestrationOperateScope,
} satisfies Record<RpcGroup.Rpcs<typeof BotsRpcGroup>["_tag"], AuthEnvironmentScope>;
