import * as Schema from "effect/Schema";

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
  charter: Schema.NullOr(Schema.String),
  workers: Schema.Array(BotWorker),
  slackDms: Schema.Array(BotSlackDm),
});
export type BotSummary = typeof BotSummary.Type;

export const BotListInput = Schema.Struct({});
export type BotListInput = typeof BotListInput.Type;

export const BotListResult = Schema.Struct({
  bots: Schema.Array(BotSummary),
});
export type BotListResult = typeof BotListResult.Type;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
