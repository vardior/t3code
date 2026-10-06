import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useCallback } from "react";

import { SidebarUtilityItem } from "../sidebar/SidebarChrome";

export function BotsSidebarItem({
  closeMobileSidebar,
}: {
  readonly closeMobileSidebar: () => void;
}) {
  const navigate = useNavigate();
  const handleClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/bots" });
  }, [closeMobileSidebar, navigate]);

  return <SidebarUtilityItem icon={<BotIcon />} label="Bots" onClick={handleClick} />;
}
