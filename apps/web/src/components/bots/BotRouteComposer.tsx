import {
  BOT_ROUTE_DEBOUNCE_MS,
  botRouteEnvironment,
  botRouteKey,
  botRoutePickerLabel,
  botRouteText,
  findRoutedBot,
  heldBotRouteSuggestion,
} from "@t3tools/client-runtime/state/bot-conversation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { newMessageId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useBotsData } from "./BotsDataProvider";

type BotChoice = { readonly environmentId: EnvironmentId; readonly botId: string };

export function BotRouteComposer() {
  const { bots } = useBotsData();
  const { environments } = useEnvironments();
  const showEnvironmentLabels = new Set(bots.map((entry) => entry.environmentId)).size > 1;
  const navigate = useNavigate();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<BotChoice | null>(null);
  const [heldBotId, setHeldBotId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const routeEnvironmentId = botRouteEnvironment(bots);
  const routeText = botRouteText(useDebouncedValue(text, BOT_ROUTE_DEBOUNCE_MS));
  const route = useEnvironmentQuery(
    routeEnvironmentId === null || routeText === null || picked !== null
      ? null
      : serverEnvironment.bots.route({
          environmentId: routeEnvironmentId,
          input: { text: routeText },
        }),
  );
  const suggestedBotId = heldBotRouteSuggestion({ routeText, routed: route.data, heldBotId });
  if (suggestedBotId !== heldBotId) setHeldBotId(suggestedBotId);
  const suggested =
    routeEnvironmentId === null || suggestedBotId === null
      ? null
      : { environmentId: routeEnvironmentId, botId: suggestedBotId };

  const chosen = findRoutedBot(bots, picked ?? suggested);
  const canOperate = useEnvironmentScope(
    chosen?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const message = text.trim();
  const canSend = chosen !== null && canOperate && message.length > 0 && !sending;

  const send = async () => {
    if (chosen === null || !canSend) return;
    const { environmentId, bot } = chosen;
    const shell = appAtomRegistry
      .get(environmentThreadShells.environmentThreadIndexAtom(environmentId))
      .get(bot.homeThreadId);
    if (shell === undefined) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not message ${bot.name}`,
          description: "Its home thread is not loaded yet. Open the bot and try again.",
        }),
      );
      return;
    }
    setSending(true);
    const result = await startTurn({
      environmentId,
      input: {
        threadId: bot.homeThreadId,
        message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: "start",
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not message ${bot.name}`,
            description: failure instanceof Error ? failure.message : String(failure),
          }),
        );
      }
      return;
    }
    setText("");
    setPicked(null);
    setHeldBotId(null);
    void navigate({ to: "/bots", search: { env: environmentId, bot: bot.id } });
  };

  return (
    <form
      className="flex w-full max-w-xl flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        aria-label="Message a bot"
        placeholder="Tell a bot…"
        value={text}
        maxLength={8_000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="secondary" />}
            className="min-w-0 max-w-full"
            aria-label={chosen ? `Send to ${chosen.bot.name}, change bot` : "Pick a bot"}
          >
            <span className="truncate">
              {botRoutePickerLabel(chosen?.bot.name ?? null, route.isPending)}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={chosen ? botRouteKey(chosen) : ""}
              onValueChange={(value) => {
                const entry = bots.find((candidate) => botRouteKey(candidate) === value);
                if (entry) setPicked({ environmentId: entry.environmentId, botId: entry.bot.id });
              }}
            >
              {bots.map((entry) => (
                <DropdownMenuRadioItem
                  key={botRouteKey(entry)}
                  value={botRouteKey(entry)}
                  closeOnClick
                >
                  <span>
                    {entry.bot.name}
                    {showEnvironmentLabels
                      ? ` · ${environments.find((environment) => environment.environmentId === entry.environmentId)?.label ?? entry.environmentId}`
                      : ""}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="submit"
          size="icon-sm"
          disabled={!canSend}
          aria-label={chosen ? `Send to ${chosen.bot.name}` : "Send"}
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </form>
  );
}
