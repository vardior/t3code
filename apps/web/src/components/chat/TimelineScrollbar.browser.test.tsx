import "~/index.css";

import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { TimelineScrollbar } from "./TimelineScrollbar";

function Timeline() {
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
  return (
    <div className="relative h-[200px] w-[300px]">
      <div ref={setScrollNode} data-testid="scroller" className="h-full overflow-y-auto">
        <div data-testid="content" className="h-[100px]" />
      </div>
      <TimelineScrollbar scrollNode={scrollNode} onNavigate={() => {}} />
    </div>
  );
}

describe("TimelineScrollbar", () => {
  it("appears once content outgrows the viewport after a hidden first paint", async () => {
    await using screen = await render(<Timeline />);
    const track = screen.container.querySelector<HTMLElement>("[data-timeline-scrollbar]");
    await expect.element(screen.getByTestId("content")).toBeInTheDocument();
    expect(track).not.toBeNull();
    await expect.element(track!).not.toBeVisible();

    screen.getByTestId("content").element().style.height = "2000px";

    await expect.element(track!).toBeVisible();
  });
});
