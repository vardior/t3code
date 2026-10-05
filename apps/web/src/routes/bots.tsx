import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";

function BotsRoute() {
  const { bot } = Route.useSearch();
  return <BotsPage botId={bot} />;
}

export const Route = createFileRoute("/bots")({
  validateSearch: (raw: Record<string, unknown>): { bot?: string } =>
    typeof raw.bot === "string" && raw.bot.trim() ? { bot: raw.bot } : {},
  component: BotsRoute,
});
