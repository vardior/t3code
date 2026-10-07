import { BotIcon } from "lucide-react";
import { useCallback } from "react";

import { useOpenBots } from "./useOpenBots";
import { useBotsNeedsYouCount } from "./useEnvironmentBots";
import { SidebarUtilityItem } from "../sidebar/SidebarChrome";

export function BotsSidebarItem({
  closeMobileSidebar,
}: {
  readonly closeMobileSidebar: () => void;
}) {
  const openBots = useOpenBots();
  const count = useBotsNeedsYouCount();
  const handleClick = useCallback(() => {
    closeMobileSidebar();
    void openBots();
  }, [closeMobileSidebar, openBots]);

  return (
    <SidebarUtilityItem
      icon={<BotIcon />}
      label={count > 0 ? `Bots, ${count} need you` : "Bots"}
      count={count}
      onClick={handleClick}
    />
  );
}
