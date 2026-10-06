import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskId, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const insertCheckedTask = (
  sql: SqlClient.SqlClient,
  input: { id: string; next: string; checkCommand: string },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: input.id,
    title: input.id,
    prompt: "Act on the poll output.",
    enabled: 1,
    schedule_json: JSON.stringify({
      type: "interval",
      everyMs: 60_000,
      checkCommand: input.checkCommand,
    }),
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "agent",
    creation_source: "mcp",
    created_at: input.next,
    updated_at: input.next,
    next_run_at: input.next,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect(
  "a quiet check starts no turn, output wakes the agent with it appended, and a failing check is a failed run",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      yield* insertCheckedTask(sql, { id: "quiet", next: now, checkCommand: "true" });
      yield* insertCheckedTask(sql, {
        id: "broken",
        next: now,
        checkCommand: "echo cannot reach slack >&2; exit 3",
      });
      yield* insertCheckedTask(sql, {
        id: "news",
        next: "2026-09-09T12:00:00.500Z",
        checkCommand: "printf '%s\\n' '- Slack: two new mentions'",
      });
      yield* TestClock.setTime(Date.parse(now) + 1_000);

      const launchedPrompts = yield* Ref.make<ReadonlyArray<string>>([]);
      const newsLaunched = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer.pipe(Layer.provide(NodeServices.layer)),
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: (input) =>
                    Ref.update(launchedPrompts, (prompts) => [
                      ...prompts,
                      input.initialMessage?.text ?? "",
                    ]).pipe(
                      Effect.andThen(Deferred.succeed(newsLaunched, undefined)),
                      Effect.andThen(Effect.die(new Error("launch recorded"))),
                    ),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(newsLaunched);
        }),
      );

      assert.deepEqual(yield* Ref.get(launchedPrompts), [
        "Act on the poll output.\n\n- Slack: two new mentions",
      ]);
      const rows = yield* sql<{
        task_id: string;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count FROM scheduled_tasks`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      const quiet = byId.get("quiet");
      assert.equal(quiet?.last_run_status, "never");
      assert.equal(quiet?.run_count, 0);
      assert.isTrue((quiet?.next_run_at ?? "") > now);
      const broken = byId.get("broken");
      assert.equal(broken?.last_run_status, "failed");
      assert.equal(broken?.run_count, 1);
      assert.isTrue(broken?.last_run_error?.includes("exited 3: cannot reach slack") === true);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an edit that omits the check command keeps it, and null removes it", () =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    const input = yield* decodeUpsertInput({
      commandId: "checked-schedule",
      title: "Triage",
      prompt: "Act on the poll output.",
      enabled: true,
      schedule: { type: "interval", everyMs: 900_000 },
      checkCommand: "bin/cos-poll",
      projectId: "project-checked",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const created = yield* service.upsert(input);
    assert.equal(created.task.checkCommand, "bin/cos-poll");

    const { checkCommand: _omitted, ...withoutCheck } = input;
    const edited = yield* service.upsert({
      ...withoutCheck,
      id: created.task.id,
      title: "Renamed",
    });
    assert.equal(edited.task.checkCommand, "bin/cos-poll");
    assert.equal((yield* service.list()).tasks[0]?.checkCommand, "bin/cos-poll");

    const cleared = yield* service.upsert({ ...input, id: created.task.id, checkCommand: null });
    assert.isUndefined(cleared.task.checkCommand);
    assert.isUndefined((yield* service.list()).tasks[0]?.checkCommand);
  }).pipe(
    Effect.provide(
      ScheduledTaskService.layer.pipe(
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
      ),
    ),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("Run now starts the turn even when the check is quiet", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    yield* insertCheckedTask(sql, {
      id: "manual",
      next: "2026-09-10T12:00:00.000Z",
      checkCommand: "true",
    });
    yield* TestClock.setTime(Date.parse(now));
    const launchedPrompts = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* Effect.exit(service.runNow({ id: ScheduledTaskId.make("manual") }));
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Scheduler.layer,
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: (input) =>
                  Ref.update(launchedPrompts, (prompts) => [
                    ...prompts,
                    input.initialMessage?.text ?? "",
                  ]).pipe(Effect.andThen(Effect.die(new Error("launch recorded")))),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
            ),
          ),
        ),
      ),
    );
    assert.deepEqual(yield* Ref.get(launchedPrompts), ["Act on the poll output."]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
