import { createContext, useContext, type ReactNode } from "react";

import { useEnvironmentBots } from "./useEnvironmentBots";

const BotsDataContext = createContext<ReturnType<typeof useEnvironmentBots> | null>(null);

export function BotsDataProvider({ children }: { readonly children: ReactNode }) {
  const data = useEnvironmentBots();
  return <BotsDataContext value={data}>{children}</BotsDataContext>;
}

export function useBotsData() {
  const data = useContext(BotsDataContext);
  if (data === null) throw new Error("Bots data requires BotsDataProvider");
  return data;
}
