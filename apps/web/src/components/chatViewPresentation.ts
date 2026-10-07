import type { ReactNode } from "react";

import type { TimelineEntry } from "../session-logic";

export interface ChatViewPresentation {
  readonly header: ReactNode;
  readonly timelineEntries: (entries: ReadonlyArray<TimelineEntry>) => ReadonlyArray<TimelineEntry>;
  readonly workingLabel: string | null;
}
