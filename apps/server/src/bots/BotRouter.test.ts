import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as BotRouter from "./BotRouter.ts";
import * as BotService from "./BotService.ts";

const jobs = [
  { id: "omni-triager", job: "Keep omni healthy on GKE, namespace omni." },
  { id: "t3code-fork", job: "Own the daily Alpha app and bots harness." },
];
const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "haiku" };

const route = (
  text: string,
  generateBotRoute: TextGeneration.TextGeneration["Service"]["generateBotRoute"],
) =>
  Effect.flatMap(BotRouter.BotRouter, (router) => router.route(text)).pipe(
    Effect.provide(
      BotRouter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(BotService.BotService)({ listJobs: () => Effect.succeed(jobs) }),
            Layer.mock(TextGeneration.TextGeneration)({ generateBotRoute }),
            ServerConfig.layerTest("/work", { prefix: "t3-bot-router-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            ServerSettings.layerTest({ textGenerationModelSelection: modelSelection }),
          ),
        ),
      ),
    ),
  );

it.effect("suggests the bot the model picks from the listed jobs", () =>
  Effect.gen(function* () {
    const inputs: Array<TextGeneration.BotRouteGenerationInput> = [];
    const result = yield* route("  omni pods are crashing again ", (input) => {
      inputs.push(input);
      return Effect.succeed({ botId: "omni-triager" });
    });
    expect(result).toEqual({ botId: "omni-triager" });
    expect(inputs).toMatchObject([
      { cwd: "/work", message: "omni pods are crashing again", bots: jobs, modelSelection },
    ]);
  }),
);

it.effect("drops a bot id that is not one of the listed bots", () =>
  Effect.gen(function* () {
    expect(yield* route("deploy omni", () => Effect.succeed({ botId: "omni" }))).toEqual({
      botId: null,
    });
    expect(yield* route("hello", () => Effect.succeed({ botId: null }))).toEqual({ botId: null });
  }),
);

it.effect("falls back to no suggestion when generation fails", () =>
  Effect.gen(function* () {
    const result = yield* route("omni pods are crashing", () =>
      Effect.fail(new TextGenerationError({ operation: "generateBotRoute", detail: "down" })),
    );
    expect(result).toEqual({ botId: null });
  }),
);
