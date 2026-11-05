import { useEffect, useRef, type PointerEvent } from "react";
import { observeResize } from "~/lib/observeResize";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";

const MIN_THUMB_HEIGHT = 40;

interface ThumbGeometry {
  readonly top: number;
  readonly height: number;
  readonly scrollPerPixel: number;
}

function measureThumb(scrollNode: HTMLElement, trackHeight: number): ThumbGeometry | null {
  const { scrollHeight, clientHeight, scrollTop } = scrollNode;
  const scrollRange = scrollHeight - clientHeight;
  if (scrollRange <= 1 || trackHeight <= 0) return null;
  const height = Math.min(
    trackHeight,
    Math.max(MIN_THUMB_HEIGHT, (clientHeight / scrollHeight) * trackHeight),
  );
  const travel = trackHeight - height;
  return {
    top: travel * Math.min(1, Math.max(0, scrollTop / scrollRange)),
    height,
    scrollPerPixel: travel > 0 ? scrollRange / travel : 0,
  };
}

export function TimelineScrollbar(props: {
  readonly scrollNode: HTMLElement | null;
  readonly onNavigate: (releasesFollow: boolean) => void;
}) {
  const { scrollNode } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerY: number;
    scrollTop: number;
    scrollPerPixel: number;
    releasedFollow: boolean;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the list's native scroll onto the thumb and forwards wheel input back to it
  useEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!scrollNode || !track || !thumb) return;
    const paint = () => {
      const geometry = measureThumb(scrollNode, track.clientHeight);
      track.hidden = geometry === null;
      if (!geometry) return;
      thumb.style.height = `${geometry.height}px`;
      thumb.style.transform = `translateY(${geometry.top}px)`;
    };
    paint();
    scrollNode.addEventListener("scroll", paint, { passive: true });
    const forwardWheel = (event: WheelEvent) => forwardWheelToTimeline(event, scrollNode);
    track.addEventListener("wheel", forwardWheel, { passive: false });
    const observed = [scrollNode, track, ...Array.from(scrollNode.children)];
    const stopObserving = observeResize(observed, paint);
    return () => {
      scrollNode.removeEventListener("scroll", paint);
      track.removeEventListener("wheel", forwardWheel);
      stopObserving();
    };
  }, [scrollNode]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!scrollNode || !track || event.button !== 0) return;
    const geometry = measureThumb(scrollNode, track.clientHeight);
    if (!geometry) return;
    event.preventDefault();
    let releasedFollow = false;
    if (event.target !== thumbRef.current) {
      const pointerOffset = event.clientY - track.getBoundingClientRect().top;
      const targetScrollTop = (pointerOffset - geometry.height / 2) * geometry.scrollPerPixel;
      releasedFollow = targetScrollTop < scrollNode.scrollTop;
      props.onNavigate(releasedFollow);
      scrollNode.scrollTo({ top: targetScrollTop, behavior: "instant" });
    }
    track.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerY: event.clientY,
      scrollTop: scrollNode.scrollTop,
      scrollPerPixel: geometry.scrollPerPixel,
      releasedFollow,
    };
  };

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!scrollNode || !start) return;
    const targetScrollTop =
      start.scrollTop + (event.clientY - start.pointerY) * start.scrollPerPixel;
    if (!start.releasedFollow && targetScrollTop < scrollNode.scrollTop) {
      start.releasedFollow = true;
      props.onNavigate(true);
    }
    scrollNode.scrollTo({ top: targetScrollTop, behavior: "instant" });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      data-timeline-scrollbar=""
      className="group/scrollbar pointer-events-auto absolute top-2 bottom-2 -right-5 w-3 cursor-default touch-none"
      onPointerDown={startDrag}
      onPointerMove={drag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <div
        ref={thumbRef}
        className="absolute inset-x-0.5 top-0 rounded-full bg-foreground/20 transition-[background-color,inset] duration-100 group-hover/scrollbar:inset-x-0 group-hover/scrollbar:bg-foreground/35 group-active/scrollbar:bg-foreground/45"
      />
    </div>
  );
}
