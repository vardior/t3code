import {
  BotError,
  BotSlackDm,
  ScheduledTaskId,
  ThreadId,
  type BotListResult,
  type BotSummary,
  type BotWorker,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const MAX_WORKERS_PER_BOT = 50;
const MAX_SLACK_DMS_PER_BOT = 200;

const BotConfigFile = Schema.Struct({
  name: Schema.String,
  homeThreadId: ThreadId,
  triageThreadId: Schema.optional(ThreadId),
  dmRelayThreadId: Schema.optional(ThreadId),
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  dmRelayScheduledTaskId: Schema.optional(ScheduledTaskId),
});

const decodeBotConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(BotConfigFile));
const decodeSlackDmLine = Schema.decodeUnknownOption(Schema.fromJsonString(BotSlackDm));

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
  }
>()("t3/bots/BotService") {}

export const layer = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const botsDir = (yield* HostProcessEnvironment).T3CODE_BOTS_DIR?.trim() || null;

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
        const ownThreadIds = new Set(
          [config.triageThreadId, config.dmRelayThreadId].filter((value) => value !== undefined),
        );
        const bot: BotSummary = {
          id,
          name: config.name,
          homeThreadId: config.homeThreadId,
          scheduledTaskIds: [config.scheduledTaskId, config.dmRelayScheduledTaskId].filter(
            (value) => value !== undefined,
          ),
          charter: yield* readCharter(botDir),
          workers: yield* listWorkers(config.homeThreadId, ownThreadIds),
          slackDms: yield* readSlackDms(botDir),
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
        if (botsDir === null) return { bots: [] };
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

    return BotService.of({ list });
  }),
);
