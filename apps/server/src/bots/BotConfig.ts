import { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const BotConfigFile = Schema.Struct({
  name: Schema.String,
  homeThreadId: ThreadId,
  triageThreadId: Schema.optional(ThreadId),
  dmRelayThreadId: Schema.optional(ThreadId),
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  dmRelayScheduledTaskId: Schema.optional(ScheduledTaskId),
  paused: Schema.optional(Schema.Boolean),
  pausedAt: Schema.optional(Schema.String),
  pausedUntil: Schema.optional(Schema.String),
  pausedScheduleIds: Schema.optional(Schema.Array(ScheduledTaskId)),
});
export type BotConfigFile = typeof BotConfigFile.Type;

export const decodeBotConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(BotConfigFile));
export const BOT_ID = /^[\w-][\w.-]*$/;

export const charterJob = (charter: string) => {
  const lines = charter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimStart().startsWith("job:"));
  if (start < 0) return null;
  const wrapped = lines.slice(start + 1);
  const end = wrapped.findIndex((line) => !/^\s+\S/.test(line));
  const job = [
    lines[start]!.trimStart().slice("job:".length),
    ...wrapped.slice(0, end < 0 ? undefined : end),
  ]
    .map((part) => part.trim())
    .join(" ")
    .trim();
  return job || null;
};

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

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), {
  space: 2,
});
const decodeJsonObject = Schema.decodeUnknownEffect(JsonObject);
const encodeJsonObject = Schema.encodeEffect(JsonObject);
const PAUSE_KEYS = new Set([
  "paused",
  "pausedAt",
  "pausedUntil",
  "pausedReason",
  "pausedScheduleIds",
]);

export const writeBotPauseFields = Effect.fn("writeBotPauseFields")(function* (
  configPath: string,
  fields: Record<string, unknown> | null,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const document = yield* decodeJsonObject(yield* fileSystem.readFileString(configPath));
  const next =
    fields === null
      ? Object.fromEntries(Object.entries(document).filter(([key]) => !PAUSE_KEYS.has(key)))
      : { ...document, ...fields };
  yield* writeFileStringAtomically({
    filePath: configPath,
    contents: `${yield* encodeJsonObject(next)}\n`,
  });
});
