import { createFileRoute } from "@tanstack/react-router";

import { parseBotsSearch } from "../components/bots/botNavigation";
import { BotsPage } from "../components/bots/BotsPage";

function BotsRoute() {
  const { bot, env } = Route.useSearch();
  return <BotsPage botId={bot} environmentId={env} />;
}

export const Route = createFileRoute("/bots")({
  validateSearch: parseBotsSearch,
  component: BotsRoute,
});
