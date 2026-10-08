import type { BotRouteResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { BotService } from "./BotService.ts";

const noSuggestion: BotRouteResult = { botId: null };

export class BotRouter extends Context.Service<
  BotRouter,
  {
    readonly route: (text: string) => Effect.Effect<BotRouteResult>;
  }
>()("t3/bots/BotRouter") {}

export const layer = Layer.effect(
  BotRouter,
  Effect.gen(function* () {
    const bots = yield* BotService;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const { cwd } = yield* ServerConfig;

    const route = Effect.fn("BotRouter.route")(
      function* (text: string) {
        const message = text.trim();
        if (message.length === 0) return noSuggestion;
        const jobs = yield* bots.listJobs();
        if (jobs.length === 0) return noSuggestion;
        const settings = yield* serverSettings.getSettings;
        const { botId } = yield* textGeneration.generateBotRoute({
          cwd,
          message,
          bots: jobs,
          modelSelection: settings.textGenerationModelSelection,
        });
        return jobs.some((bot) => bot.id === botId) ? { botId } : noSuggestion;
      },
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Bot routing failed", { cause }).pipe(Effect.as(noSuggestion)),
      ),
    );

    return BotRouter.of({ route });
  }),
);
