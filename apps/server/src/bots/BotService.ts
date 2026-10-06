import {
  BotError,
  BotSlackDm,
  ScheduledTaskId,
  ThreadId,
  type BotListResult,
  type BotSetPausedInput,
  type BotSetPausedResult,
  type BotSummary,
  type BotWorker,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";

const MAX_WORKERS_PER_BOT = 50;
const MAX_SLACK_DMS_PER_BOT = 200;
const MAX_REPLY_PREVIEW_LENGTH = 200;

const replyPreview = (text: string) => {
  const plainText = text
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<([^>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plainText.length > MAX_REPLY_PREVIEW_LENGTH
    ? `${plainText.slice(0, MAX_REPLY_PREVIEW_LENGTH - 1).trimEnd()}…`
    : plainText;
};

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
type BotConfigFile = typeof BotConfigFile.Type;

const decodeBotConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(BotConfigFile));
const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeSlackDmLine = Schema.decodeUnknownOption(Schema.fromJsonString(BotSlackDm));
const PAUSE_KEYS = new Set(["paused", "pausedUntil", "pausedReason", "pausedScheduleIds"]);
const isBotError = Schema.is(BotError);
const BOT_ID = /^[\w-][\w.-]*$/;

const listedScheduleIds = (config: BotConfigFile) =>
  [config.scheduledTaskId, config.dmRelayScheduledTaskId].filter((value) => value !== undefined);

const ownThreadIds = (config: BotConfigFile) =>
  [config.homeThreadId, config.triageThreadId, config.dmRelayThreadId].filter(
    (value) => value !== undefined,
  );

const isPaused = (config: BotConfigFile, nowMs: number) =>
  config.paused === true ||
  (config.pausedUntil !== undefined && Date.parse(config.pausedUntil) > nowMs);

interface WorkerRow {
  readonly thread_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly status: string | null;
}

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: () => Effect.Effect<BotListResult, BotError>;
    readonly isHomeThread: (threadId: ThreadId) => Effect.Effect<boolean, BotError>;
    readonly setPaused: (input: BotSetPausedInput) => Effect.Effect<BotSetPausedResult, BotError>;
  }
>()("t3/bots/BotService") {}

export const layer = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scheduledTasks = yield* ScheduledTaskService;
    const configuredBotsDir = (yield* HostProcessEnvironment).T3CODE_BOTS_DIR?.trim() || null;
    const botsDir = configuredBotsDir ?? path.join((yield* ServerConfig).baseDir, "bots");

    const listWorkers = (homeThreadId: ThreadId, ownThreadIds: ReadonlySet<string>) =>
      sql<WorkerRow>`
        SELECT thread_id, title, created_at, status FROM (
          SELECT
            t.thread_id,
            t.title,
            t.created_at,
            (
              SELECT r.status FROM orchestration_v2_projection_runs r
              WHERE r.thread_id = t.thread_id
              ORDER BY r.ordinal DESC LIMIT 1
            ) AS status
          FROM orchestration_v2_projection_threads t
          WHERE t.deleted_at IS NULL
            AND t.thread_id <> ${homeThreadId}
            AND (
              json_extract(t.payload_json, '$.lineage.parentThreadId') = ${homeThreadId}
              OR (
                SELECT json_extract(m.payload_json, '$.senderThreadId')
                FROM orchestration_v2_projection_messages m
                WHERE m.thread_id = t.thread_id
                ORDER BY m.created_at, m.message_id LIMIT 1
              ) = ${homeThreadId}
            )
          ORDER BY t.created_at DESC
          LIMIT ${MAX_WORKERS_PER_BOT + ownThreadIds.size}
        ) ORDER BY created_at
      `.pipe(
        Effect.map((rows): BotWorker[] =>
          rows
            .filter((row) => !ownThreadIds.has(row.thread_id))
            .map((row) => ({
              threadId: ThreadId.make(row.thread_id),
              title: row.title,
              createdAt: row.created_at,
              status: row.status,
            })),
        ),
      );

    const readLastReply = (homeThreadId: ThreadId) =>
      sql<{ readonly text: string; readonly at: string }>`
        SELECT json_extract(m.payload_json, '$.text') AS text, m.created_at AS at
        FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = ${homeThreadId}
          AND m.role = 'assistant' AND m.streaming = 0 AND m.run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.run_id = m.run_id
              AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
          )
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_messages incoming
            WHERE incoming.run_id = m.run_id AND incoming.role = 'user'
              AND NOT (
                json_extract(incoming.payload_json, '$.createdBy') IS 'agent'
                AND (
                  json_extract(incoming.payload_json, '$.senderThreadId') IS ${homeThreadId}
                  OR json_extract(incoming.payload_json, '$.creationSource') IS 'server'
                )
                AND json_extract(incoming.payload_json, '$.text') IS '/compact'
              )
          )
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT 1
      `.pipe(
        Effect.map((rows) => {
          const reply = rows[0];
          return reply ? { text: replyPreview(reply.text), at: reply.at } : null;
        }),
      );

    const scheduleIdsFor = (config: BotConfigFile) =>
      sql<{ readonly task_id: string }>`
        SELECT task_id FROM scheduled_tasks
        WHERE thread_id IN ${sql.in(ownThreadIds(config))}
        ORDER BY created_at
      `.pipe(
        Effect.map((rows) => [
          ...new Set([
            ...listedScheduleIds(config),
            ...rows.map((row) => ScheduledTaskId.make(row.task_id)),
          ]),
        ]),
      );

    const readCharter = (botDir: string) =>
      fileSystem.readFileString(path.join(botDir, "charter.md")).pipe(
        Effect.map((text) => text.trim() || null),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    const readSlackDms = (botDir: string) =>
      fileSystem.readFileString(path.join(botDir, "dm-log.jsonl")).pipe(
        Effect.map((text) =>
          text
            .split("\n")
            .flatMap((line) => Option.toArray(decodeSlackDmLine(line)))
            .slice(-MAX_SLACK_DMS_PER_BOT),
        ),
        Effect.catchCause(() => Effect.succeed([])),
      );

    const readBot = (id: string, botDir: string) =>
      Effect.gen(function* () {
        const raw = yield* fileSystem.readFileString(path.join(botDir, "bot.json"));
        const config = yield* decodeBotConfig(raw);
        const sideThreadIds = new Set(
          [config.triageThreadId, config.dmRelayThreadId].filter((value) => value !== undefined),
        );
        const bot: BotSummary = {
          id,
          name: config.name,
          homeThreadId: config.homeThreadId,
          scheduledTaskIds: yield* scheduleIdsFor(config),
          paused: isPaused(config, yield* Clock.currentTimeMillis),
          charter: yield* readCharter(botDir),
          workers: yield* listWorkers(config.homeThreadId, sideThreadIds),
          slackDms: yield* readSlackDms(botDir),
          lastReply: yield* readLastReply(config.homeThreadId),
        };
        return Option.some(bot);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Skipping unreadable bot", { id, cause }).pipe(
            Effect.as(Option.none<BotSummary>()),
          ),
        ),
      );

    const list = () =>
      Effect.gen(function* () {
        if (configuredBotsDir === null) {
          const exists = yield* fileSystem
            .exists(botsDir)
            .pipe(Effect.catchCause(() => Effect.succeed(false)));
          if (!exists) return { bots: [] };
        }
        const entries = yield* fileSystem
          .readDirectory(botsDir)
          .pipe(
            Effect.mapError(
              (cause) => new BotError({ message: `Cannot read bots directory ${botsDir}`, cause }),
            ),
          );
        const bots = yield* Effect.forEach(
          entries.toSorted(),
          (id) => {
            const botDir = path.join(botsDir, id);
            return fileSystem.exists(path.join(botDir, "bot.json")).pipe(
              Effect.catchCause(() => Effect.succeed(false)),
              Effect.flatMap((exists) =>
                exists ? readBot(id, botDir) : Effect.succeed(Option.none<BotSummary>()),
              ),
            );
          },
          { concurrency: 4 },
        );
        return { bots: bots.flatMap((bot) => Option.toArray(bot)) };
      });

    const isHomeThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        if (configuredBotsDir === null && !(yield* fileSystem.exists(botsDir))) return false;
        const entries = yield* fileSystem.readDirectory(botsDir);
        for (const id of entries) {
          if (!BOT_ID.test(id)) continue;
          const raw = yield* fileSystem
            .readFileString(path.join(botsDir, id, "bot.json"))
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (raw === null) continue;
          const config = yield* decodeBotConfig(raw).pipe(
            Effect.catchCause(() => Effect.succeed(null)),
          );
          if (config?.homeThreadId === threadId) return true;
        }
        return false;
      }).pipe(
        Effect.mapError(
          (cause) => new BotError({ message: `Cannot read bots directory ${botsDir}`, cause }),
        ),
      );

    const setScheduleIdsEnabled = (ids: ReadonlyArray<ScheduledTaskId>, enabled: boolean) =>
      Effect.forEach(ids, (id) => scheduledTasks.setEnabled({ id, enabled }), { discard: true });

    const setPaused = (input: BotSetPausedInput) =>
      Effect.gen(function* () {
        if (!BOT_ID.test(input.botId)) {
          return yield* new BotError({ message: `Unknown bot ${input.botId}` });
        }
        const configPath = path.join(botsDir, input.botId, "bot.json");
        const raw = yield* fileSystem.readFileString(configPath);
        const config = yield* decodeBotConfig(raw);
        const document = yield* decodeJsonObject(raw);
        const writeConfig = (next: Record<string, unknown>) =>
          writeFileStringAtomically({
            filePath: configPath,
            contents: `${JSON.stringify(next, null, 2)}\n`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );

        if (input.paused) {
          if (config.paused === true) return {};
          const botScheduleIds = new Set(yield* scheduleIdsFor(config));
          const { tasks } = yield* scheduledTasks.list();
          const enabledIds = tasks
            .filter((task) => task.enabled && botScheduleIds.has(task.id))
            .map((task) => task.id);
          yield* writeConfig({
            ...document,
            paused: true,
            pausedReason: "Paused from the Bots view",
            pausedScheduleIds: enabledIds,
          });
          yield* setScheduleIdsEnabled(enabledIds, false);
          return {};
        }

        if (!isPaused(config, yield* Clock.currentTimeMillis)) return {};
        const { tasks } = yield* scheduledTasks.list();
        const existingIds = new Set(tasks.map((task) => task.id));
        const resumeIds = (config.pausedScheduleIds ?? listedScheduleIds(config)).filter((id) =>
          existingIds.has(id),
        );
        yield* setScheduleIdsEnabled(resumeIds, true);
        yield* writeConfig(
          Object.fromEntries(Object.entries(document).filter(([key]) => !PAUSE_KEYS.has(key))),
        );
        return {};
      }).pipe(
        Effect.mapError((cause) =>
          isBotError(cause)
            ? cause
            : new BotError({
                message: `Cannot ${input.paused ? "pause" : "resume"} bot ${input.botId}`,
                cause,
              }),
        ),
      );

    return BotService.of({ list, isHomeThread, setPaused });
  }),
);
