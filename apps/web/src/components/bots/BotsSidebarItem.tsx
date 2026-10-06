import { BotIcon } from "lucide-react";
import { useCallback } from "react";

import { useOpenBots } from "./useOpenBots";
import { SidebarUtilityItem } from "../sidebar/SidebarChrome";

export function BotsSidebarItem({
  closeMobileSidebar,
}: {
  readonly closeMobileSidebar: () => void;
}) {
  const openBots = useOpenBots();
  const handleClick = useCallback(() => {
    closeMobileSidebar();
    void openBots();
  }, [closeMobileSidebar, openBots]);

  return <SidebarUtilityItem icon={<BotIcon />} label="Bots" onClick={handleClick} />;
}
