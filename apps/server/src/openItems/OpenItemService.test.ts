import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  OpenItemError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { RelayOwnerNotification } from "@t3tools/contracts/relay";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BotService from "../bots/BotService.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as OpenItemService from "./OpenItemService.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-open-items-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by open item tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const notifications: Array<{ threadId: ThreadId | undefined; input: RelayOwnerNotification }> = [];
const homeThreadId = ThreadId.make("open-items-bot-home");

const layerOrchestration = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

const layerBots = Layer.mock(BotService.BotService)({
  isHomeThread: (threadId) => Effect.succeed(threadId === homeThreadId),
  notifyOwner: (threadId, input) =>
    Effect.sync(() => {
      notifications.push({ threadId, input });
      return { runId: "run" as never };
    }),
});

const layerTest = OpenItemService.layer.pipe(
  Layer.provide(layerBots),
  Layer.provideMerge(layerOrchestration),
);

const layerOwnerDropsFirst = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    Orchestrator.OrchestratorV2.of({
      ...orchestrator,
      dispatch: (command) =>
        command.type === "thread.open-item.resolve"
          ? orchestrator
              .dispatch({
                type: "thread.open-item.resolve",
                commandId: CommandId.make(`${command.commandId}:owner`),
                threadId: command.threadId,
                itemId: command.itemId,
                status: "dropped",
              })
              .pipe(Effect.andThen(orchestrator.dispatch(command)))
          : orchestrator.dispatch(command),
    }),
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("open-items-project"),
      title: "Open items",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
    }),
  );

it.layer(layerTest)("OpenItemService", (it) => {
  it.effect("adds, updates, and lists items, notifying the owner of a bot thread", () =>
    Effect.gen(function* () {
      const openItems = yield* OpenItemService.OpenItemService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread(homeThreadId);

      const added = yield* openItems.add(homeThreadId, {
        title: "Merge the release branch?",
        detail: "CI is green.",
        options: ["Merge", "Wait"],
        recommended: "Merge",
        defaultOnSilence: "I will wait until Monday.",
      });
      assert.equal(added.status, "open");
      assert.deepEqual(notifications.at(-1), {
        threadId: homeThreadId,
        input: { title: "Merge the release branch?", body: "CI is green." },
      });

      const updated = yield* openItems.update(homeThreadId, added.id, {
        detail: null,
        recommended: "Wait",
      });
      assert.equal(updated.recommended, "Wait");
      assert.isUndefined(updated.detail);

      const shell = yield* orchestrator.getThreadShell(homeThreadId);
      assert.deepEqual(shell?.openItems, [updated]);
      assert.deepEqual(yield* openItems.list(homeThreadId, { includeResolved: false }), [updated]);

      const rejected = yield* openItems
        .update(homeThreadId, added.id, { options: ["Merge"] })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, OpenItemError);
      assert.equal(rejected.reason, "invalid_recommended");
    }),
  );

  it.effect("returns the open item with the same title instead of adding a duplicate", () =>
    Effect.gen(function* () {
      const openItems = yield* OpenItemService.OpenItemService;
      yield* createThread(homeThreadId);
      const notified = notifications.length;

      const first = yield* openItems.add(homeThreadId, { title: "Rotate the deploy key?" });
      const retried = yield* openItems.add(homeThreadId, { title: "Rotate the deploy key?" });
      assert.equal(retried.id, first.id);
      assert.equal(notifications.length, notified + 1);
      assert.lengthOf(
        (yield* openItems.list(homeThreadId, { includeResolved: false })).filter(
          (item) => item.title === "Rotate the deploy key?",
        ),
        1,
      );

      yield* openItems.resolve(homeThreadId, first.id, { status: "dropped" });
      const askedAgain = yield* openItems.add(homeThreadId, { title: "Rotate the deploy key?" });
      assert.notEqual(askedAgain.id, first.id);
    }),
  );

  it.effect("reports why the orchestrator rejected a change that lost a race", () =>
    Effect.gen(function* () {
      const openItems = yield* OpenItemService.OpenItemService;
      const threadId = ThreadId.make("open-items-race-thread");
      yield* createThread(threadId);
      const item = yield* openItems.add(threadId, { title: "Ship it?" });

      const racing = yield* OpenItemService.OpenItemService.pipe(
        Effect.provide(
          Layer.fresh(OpenItemService.layer).pipe(
            Layer.provide(layerOwnerDropsFirst),
            Layer.provide(layerBots),
          ),
        ),
      );
      const rejected = yield* racing
        .resolve(threadId, item.id, { status: "answered", answer: "Yes" })
        .pipe(Effect.flip);
      assert.equal(rejected.reason, "not_open");
      assert.equal(rejected.message, "That open item is already resolved.");
    }),
  );

  it.effect("tells the agent when the owner answers, drops or reopens, not when it resolves", () =>
    Effect.gen(function* () {
      const openItems = yield* OpenItemService.OpenItemService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("open-items-plain-thread");
      yield* createThread(threadId);
      const notified = notifications.length;

      const question = yield* openItems.add(threadId, {
        title: "Which region?",
        options: ["us-east", "eu-west"],
      });
      const chore = yield* openItems.add(threadId, { title: "Rotate the token" });
      assert.equal(notifications.length, notified);

      const answered = yield* openItems.answer({
        threadId,
        itemId: question.id,
        answer: "eu-west",
        creationSource: "mobile",
      });
      assert.equal(answered.status, "answered");
      assert.equal(answered.answer, "eu-west");
      assert.isNotNull(answered.resolvedAt);

      const afterAnswer = yield* orchestrator.getThreadProjection(threadId);
      const replies = afterAnswer.messages.filter((message) => message.role === "user");
      assert.deepEqual(
        replies.map((message) => ({
          text: message.text,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
        })),
        [{ text: "Re: Which region?: eu-west", createdBy: "user", creationSource: "mobile" }],
      );
      assert.lengthOf(afterAnswer.runs, 1);
      assert.equal(afterAnswer.runs[0]?.userMessageId, replies[0]?.id);

      const again = yield* openItems
        .answer({ threadId, itemId: question.id, answer: "us-east" })
        .pipe(Effect.flip);
      assert.equal(again.reason, "not_open");

      const dropped = yield* openItems.drop({ threadId, itemId: chore.id });
      assert.equal(dropped.status, "dropped");
      assert.isUndefined(dropped.answer);

      const reopened = yield* openItems.reopen({ threadId, itemId: question.id });
      assert.equal(reopened.status, "open");
      assert.isUndefined(reopened.answer);
      assert.isNull(reopened.resolvedAt);

      const agentResolved = yield* openItems.resolve(threadId, question.id, {
        status: "answered",
        answer: "Found it in the runbook: eu-west.",
      });
      assert.equal(agentResolved.answer, "Found it in the runbook: eu-west.");

      const final = yield* orchestrator.getThreadProjection(threadId);
      assert.sameDeepMembers(
        final.messages
          .filter((message) => message.role === "user")
          .map((message) => [message.text, message.creationSource]),
        [
          ["Re: Which region?: eu-west", "mobile"],
          ["Dropped: Rotate the token", "web"],
          ["Reopened: Which region?", "web"],
        ],
      );
      assert.deepEqual(
        (yield* openItems.list(threadId, { includeResolved: true })).map((item) => [
          item.title,
          item.status,
        ]),
        [
          ["Which region?", "answered"],
          ["Rotate the token", "dropped"],
        ],
      );
      assert.deepEqual(yield* openItems.list(threadId, { includeResolved: false }), []);
    }),
  );
});
