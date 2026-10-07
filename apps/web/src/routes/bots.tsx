import { createFileRoute, redirect } from "@tanstack/react-router";

import { parseBotsSearch } from "../components/bots/botNavigation";
import { BotsPage } from "../components/bots/BotsPage";

function BotsRoute() {
  const { bot, env } = Route.useSearch();
  return <BotsPage botId={bot} environmentId={env} />;
}

export const Route = createFileRoute("/bots")({
  validateSearch: parseBotsSearch,
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: BotsRoute,
});
