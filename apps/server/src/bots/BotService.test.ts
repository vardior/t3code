import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { BotSummary, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as BotService from "./BotService.ts";

const decodeBot = Schema.decodeUnknownEffect(BotSummary);

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer);

const scheduledTasksLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ),
  ),
);

const withBots = <A, E, R>(
  input: { readonly baseDir: string; readonly env?: NodeJS.ProcessEnv },
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(
      BotService.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
        Layer.provideMerge(scheduledTasksLayer),
      ),
    ),
    Effect.provideService(HostProcessEnvironment, input.env ?? {}),
  );

const listBots = (input: { readonly baseDir: string; readonly env?: NodeJS.ProcessEnv }) =>
  withBots(
    input,
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      return yield* service.list();
    }),
  );

const insertSchedule = (
  sql: SqlClient.SqlClient,
  schedule: { id: string; threadId: string | null; enabled: boolean; createdAt: string },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: schedule.id,
    title: schedule.id,
    prompt: "Wake up.",
    enabled: schedule.enabled ? 1 : 0,
    schedule_json: JSON.stringify({ type: "interval", everyMs: 900_000 }),
    project_id: "project-1",
    thread_id: schedule.threadId,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "agent",
    creation_source: "mcp",
    created_at: schedule.createdAt,
    updated_at: schedule.createdAt,
    next_run_at: schedule.enabled ? "2026-10-01T01:00:00.000Z" : null,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;

const insertThread = (
  sql: SqlClient.SqlClient,
  thread: { id: string; createdAt: string; parentThreadId?: string; deletedAt?: string },
) => sql`
  INSERT INTO orchestration_v2_projection_threads (
    thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
    created_at, updated_at, deleted_at, payload_json
  ) VALUES (
    ${thread.id}, 'project-1', ${`Title ${thread.id}`}, 'codex', 'full-access', 'default',
    ${thread.createdAt}, ${thread.createdAt}, ${thread.deletedAt ?? null},
    ${toJson({
      lineage: {
        parentThreadId: thread.parentThreadId ?? null,
        relationshipToParent: thread.parentThreadId ? "subagent" : null,
        rootThreadId: thread.parentThreadId ?? thread.id,
      },
    })}
  )
`;

const insertMessage = (
  sql: SqlClient.SqlClient,
  message: {
    id: string;
    threadId: string;
    createdAt: string;
    senderThreadId?: string;
    runId?: string;
    role?: string;
    streaming?: boolean;
    text?: string;
  },
) => sql`
  INSERT INTO orchestration_v2_projection_messages (
    message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
  ) VALUES (
    ${message.id}, ${message.threadId}, ${message.runId ?? null}, NULL,
    ${message.role ?? "user"}, ${message.streaming ? 1 : 0},
    ${message.createdAt}, ${message.createdAt},
    ${toJson({ text: message.text ?? "", createdBy: "user", senderThreadId: message.senderThreadId })}
  )
`;

const insertRun = (
  sql: SqlClient.SqlClient,
  run: { id: string; threadId: string; ordinal: number; status: string },
) => sql`
  INSERT INTO orchestration_v2_projection_runs (
    run_id, thread_id, ordinal, provider, status, requested_at, payload_json
  ) VALUES (
    ${run.id}, ${run.threadId}, ${run.ordinal}, 'codex', ${run.status},
    '2026-10-01T00:00:00.000Z', '{}'
  )
`;

it.effect(
  "treats a missing default bots directory as empty but a missing configured one as an error",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-home-" });
      expect(yield* listBots({ baseDir })).toEqual({ bots: [] });
      const configured = yield* listBots({
        baseDir,
        env: { T3CODE_BOTS_DIR: path.join(baseDir, "elsewhere") },
      }).pipe(Effect.flip);
      expect(configured._tag).toBe("BotError");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("lists bots with their charter and the worker threads their home thread spawned", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-home-" });
    const root = path.join(baseDir, "bots");
    yield* fs.makeDirectory(root);

    yield* fs.makeDirectory(path.join(root, "helper"));
    yield* fs.writeFileString(
      path.join(root, "helper", "bot.json"),
      toJson({
        name: "Helper",
        homeThreadId: "home",
        triageThreadId: "triage",
        scheduledTaskId: "task-1",
        unknownField: 1,
      }),
    );
    yield* fs.writeFileString(path.join(root, "helper", "charter.md"), "Be helpful.\n");
    yield* fs.writeFileString(
      path.join(root, "helper", "dm-log.jsonl"),
      [
        toJson({ ts: "1.0", text: "Any news?", at: "2026-10-01T00:08:00Z", acked: true }),
        "not json",
        "",
      ].join("\n"),
    );
    yield* fs.makeDirectory(path.join(root, "broken"));
    yield* fs.writeFileString(path.join(root, "broken", "bot.json"), "{");
    yield* fs.makeDirectory(path.join(root, "notes"));

    yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
    yield* insertThread(sql, { id: "triage", createdAt: "2026-10-01T00:01:00.000Z" });
    yield* insertMessage(sql, {
      id: "m-triage",
      threadId: "triage",
      createdAt: "2026-10-01T00:01:00.000Z",
      senderThreadId: "home",
    });
    yield* insertThread(sql, { id: "launched", createdAt: "2026-10-01T00:03:00.000Z" });
    yield* insertMessage(sql, {
      id: "m-launched",
      threadId: "launched",
      createdAt: "2026-10-01T00:03:00.000Z",
      senderThreadId: "home",
    });
    yield* insertRun(sql, { id: "r1", threadId: "launched", ordinal: 1, status: "completed" });
    yield* insertRun(sql, { id: "r2", threadId: "launched", ordinal: 2, status: "running" });
    yield* insertThread(sql, {
      id: "subagent",
      createdAt: "2026-10-01T00:02:00.000Z",
      parentThreadId: "home",
    });
    yield* insertThread(sql, { id: "messaged-later", createdAt: "2026-10-01T00:04:00.000Z" });
    yield* insertMessage(sql, {
      id: "m-later-1",
      threadId: "messaged-later",
      createdAt: "2026-10-01T00:04:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "m-later-2",
      threadId: "messaged-later",
      createdAt: "2026-10-01T00:05:00.000Z",
      senderThreadId: "home",
    });
    yield* insertThread(sql, {
      id: "deleted",
      createdAt: "2026-10-01T00:06:00.000Z",
      parentThreadId: "home",
      deletedAt: "2026-10-01T00:07:00.000Z",
    });

    expect(yield* listBots({ baseDir })).toEqual({
      bots: [
        {
          id: "helper",
          name: "Helper",
          homeThreadId: "home",
          scheduledTaskIds: ["task-1"],
          paused: false,
          charter: "Be helpful.",
          workers: [
            {
              threadId: "subagent",
              title: "Title subagent",
              createdAt: "2026-10-01T00:02:00.000Z",
              status: null,
            },
            {
              threadId: "launched",
              title: "Title launched",
              createdAt: "2026-10-01T00:03:00.000Z",
              status: "running",
            },
          ],
          slackDms: [{ text: "Any news?", at: "2026-10-01T00:08:00Z" }],
          lastReply: null,
        },
      ],
    });
    const homeMatches = yield* withBots(
      { baseDir },
      Effect.gen(function* () {
        const bots = yield* BotService.BotService;
        return [
          yield* bots.isHomeThread(ThreadId.make("home")),
          yield* bots.isHomeThread(ThreadId.make("triage")),
        ];
      }),
    );
    expect(homeMatches).toEqual([true, false]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "pausing a bot turns off every schedule that wakes it, and resuming turns back on only those",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-home-" });
      const botDir = path.join(baseDir, "bots", "helper");
      yield* fs.makeDirectory(botDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(botDir, "bot.json"),
        toJson({
          name: "Helper",
          homeThreadId: "home",
          triageThreadId: "triage",
          scheduledTaskId: "listed",
          intervalMs: 900_000,
        }),
      );
      yield* insertSchedule(sql, {
        id: "listed",
        threadId: "triage",
        enabled: true,
        createdAt: "2026-10-01T00:03:00.000Z",
      });
      yield* insertSchedule(sql, {
        id: "bound",
        threadId: "home",
        enabled: true,
        createdAt: "2026-10-01T00:01:00.000Z",
      });
      yield* insertSchedule(sql, {
        id: "already-off",
        threadId: "home",
        enabled: false,
        createdAt: "2026-10-01T00:02:00.000Z",
      });
      yield* insertSchedule(sql, {
        id: "unrelated",
        threadId: "elsewhere",
        enabled: true,
        createdAt: "2026-10-01T00:00:00.000Z",
      });

      const readConfig = fs
        .readFileString(path.join(botDir, "bot.json"))
        .pipe(Effect.map((text): unknown => JSON.parse(text)));

      yield* withBots(
        { baseDir },
        Effect.gen(function* () {
          const bots = yield* BotService.BotService;
          const schedules = yield* ScheduledTaskService.ScheduledTaskService;
          const enabledById = schedules
            .list()
            .pipe(
              Effect.map(({ tasks }) =>
                Object.fromEntries(tasks.map((task) => [task.id, task.enabled])),
              ),
            );
          const helper = bots.list().pipe(Effect.map(({ bots }) => bots[0]));

          expect((yield* helper)?.scheduledTaskIds).toEqual(["listed", "bound", "already-off"]);
          expect((yield* helper)?.paused).toBe(false);

          yield* bots.setPaused({ botId: "helper", paused: true });
          yield* bots.setPaused({ botId: "helper", paused: true });
          expect((yield* helper)?.paused).toBe(true);
          expect(yield* enabledById).toEqual({
            listed: false,
            bound: false,
            "already-off": false,
            unrelated: true,
          });
          expect(yield* readConfig).toMatchObject({
            intervalMs: 900_000,
            paused: true,
            pausedScheduleIds: ["listed", "bound"],
          });

          yield* bots.setPaused({ botId: "helper", paused: false });
          expect((yield* helper)?.paused).toBe(false);
          expect(yield* enabledById).toEqual({
            listed: true,
            bound: true,
            "already-off": false,
            unrelated: true,
          });
          expect(yield* readConfig).toEqual({
            name: "Helper",
            homeThreadId: "home",
            triageThreadId: "triage",
            scheduledTaskId: "listed",
            intervalMs: 900_000,
          });

          yield* schedules.setEnabled({ id: ScheduledTaskId.make("listed"), enabled: false });
          yield* fs.writeFileString(
            path.join(botDir, "bot.json"),
            toJson({
              name: "Helper",
              homeThreadId: "home",
              scheduledTaskId: "listed",
              pausedUntil: "2999-01-01T00:00:00Z",
              pausedReason: "Paused by its parent",
            }),
          );
          expect((yield* helper)?.paused).toBe(true);
          yield* bots.setPaused({ botId: "helper", paused: false });
          expect((yield* enabledById).listed).toBe(true);
          expect(yield* readConfig).toEqual({
            name: "Helper",
            homeThreadId: "home",
            scheduledTaskId: "listed",
          });

          const escaped = yield* bots
            .setPaused({ botId: "../helper", paused: true })
            .pipe(Effect.flip);
          expect(escaped.message).toBe("Unknown bot ../helper");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("previews only the latest settled final assistant reply, as bounded plain text", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bots-preview-" });
    const botDir = path.join(baseDir, "bots", "helper");
    yield* fs.makeDirectory(botDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(botDir, "bot.json"),
      toJson({ name: "Helper", homeThreadId: "home" }),
    );
    yield* insertThread(sql, { id: "home", createdAt: "2026-10-01T00:00:00.000Z" });
    const readReply = listBots({ baseDir }).pipe(Effect.map((result) => result.bots[0]!.lastReply));
    expect(yield* readReply).toBeNull();
    yield* insertRun(sql, { id: "settled", threadId: "home", ordinal: 1, status: "completed" });
    yield* insertMessage(sql, {
      id: "question",
      threadId: "home",
      runId: "settled",
      createdAt: "2026-10-01T00:01:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "intermediate",
      threadId: "home",
      runId: "settled",
      role: "assistant",
      text: "I am investigating.",
      createdAt: "2026-10-01T00:02:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "final",
      threadId: "home",
      runId: "settled",
      role: "assistant",
      text: "## Done\n\n**Fixed** the [issue](https://example.com) with `code`.\n- Ready to ship.",
      createdAt: "2026-10-01T00:03:00.000Z",
    });
    const finalReply = {
      text: "Done Fixed the issue with code. Ready to ship.",
      at: "2026-10-01T00:03:00.000Z",
    };
    expect(yield* readReply).toEqual(finalReply);
    yield* insertRun(sql, { id: "active", threadId: "home", ordinal: 2, status: "running" });
    yield* insertMessage(sql, {
      id: "active-question",
      threadId: "home",
      runId: "active",
      createdAt: "2026-10-01T00:04:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "active-intermediate",
      threadId: "home",
      runId: "active",
      role: "assistant",
      text: "Still investigating.",
      createdAt: "2026-10-01T00:05:00.000Z",
    });
    yield* insertMessage(sql, {
      id: "streaming",
      threadId: "home",
      runId: "settled",
      role: "assistant",
      streaming: true,
      text: "Partial output",
      createdAt: "2026-10-01T00:06:00.000Z",
    });
    expect(yield* readReply).toEqual(finalReply);
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'active'`;
    yield* insertMessage(sql, {
      id: "long-final",
      threadId: "home",
      runId: "active",
      role: "assistant",
      text: `**${"word ".repeat(60)}**`,
      createdAt: "2026-10-01T00:07:00.000Z",
    });
    const preview = yield* readReply;
    expect(preview).toEqual({ text: `${"word ".repeat(39)}word…`, at: "2026-10-01T00:07:00.000Z" });
    expect(preview!.text).toHaveLength(200);
    const { lastReply: _, ...oldBot } = (yield* listBots({ baseDir })).bots[0]!;
    expect((yield* decodeBot(oldBot)).lastReply).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
