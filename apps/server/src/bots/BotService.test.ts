import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BotService from "./BotService.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer);

const listBots = (input: { readonly baseDir: string; readonly env?: NodeJS.ProcessEnv }) =>
  Effect.gen(function* () {
    const service = yield* BotService.BotService;
    return yield* service.list();
  }).pipe(
    Effect.provide(
      BotService.layer.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir))),
    ),
    Effect.provideService(HostProcessEnvironment, input.env ?? {}),
  );

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
  message: { id: string; threadId: string; createdAt: string; senderThreadId?: string },
) => sql`
  INSERT INTO orchestration_v2_projection_messages (
    message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
  ) VALUES (
    ${message.id}, ${message.threadId}, NULL, NULL, 'user', 0,
    ${message.createdAt}, ${message.createdAt},
    ${toJson(message.senderThreadId ? { senderThreadId: message.senderThreadId } : {})}
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
        },
      ],
    });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
