import { createFileRoute } from "@tanstack/react-router";

import { parseBotsSidebarSearch } from "../components/bots/botNavigation";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: parseBotsSidebarSearch,
  component: () => null,
});
