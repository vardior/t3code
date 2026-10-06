import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

export function useOpenBots() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ to: "/bots", search: {} }), [navigate]);
}
