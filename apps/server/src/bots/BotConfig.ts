import { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

const BotConfigFile = Schema.Struct({
  name: Schema.String,
  homeThreadId: ThreadId,
  triageThreadId: Schema.optional(ThreadId),
  dmRelayThreadId: Schema.optional(ThreadId),
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  dmRelayScheduledTaskId: Schema.optional(ScheduledTaskId),
  paused: Schema.optional(Schema.Boolean),
  pausedUntil: Schema.optional(Schema.String),
  pausedScheduleIds: Schema.optional(Schema.Array(ScheduledTaskId)),
});
export type BotConfigFile = typeof BotConfigFile.Type;

export const decodeBotConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(BotConfigFile));
export const BOT_ID = /^[\w-][\w.-]*$/;

export const listedScheduleIds = (config: BotConfigFile) =>
  [config.scheduledTaskId, config.dmRelayScheduledTaskId].filter((value) => value !== undefined);

export const ownThreadIds = (config: BotConfigFile) =>
  [config.homeThreadId, config.triageThreadId, config.dmRelayThreadId].filter(
    (value) => value !== undefined,
  );

export const isPaused = (config: BotConfigFile, nowMs: number) =>
  config.paused === true ||
  (config.pausedUntil !== undefined && Date.parse(config.pausedUntil) > nowMs);

export class BotSchedulePauseTransition extends Context.Reference<boolean>(
  "t3/bots/BotSchedulePauseTransition",
  { defaultValue: () => false },
) {}
