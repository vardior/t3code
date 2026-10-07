import {
  resolveBotListOrder,
  type PendingBotOrder,
} from "@t3tools/client-runtime/state/bot-conversation";
import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, type LayoutRectangle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { useAnimatedStyle } from "react-native-reanimated";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function SortableBotList(props: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<BotSummary>;
  readonly renderBot: (bot: BotSummary) => ReactNode;
}) {
  const [pendingOrder, setPendingOrder] = useState<PendingBotOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [drag, setDrag] = useState<{
    id: string;
    translation: number;
    version: string;
    rows: ReadonlyArray<LayoutRectangle>;
    from: number;
    to: number;
  } | null>(null);
  const layouts = useRef(new Map<string, LayoutRectangle>());
  const reorder = useAtomCommand(serverEnvironment.bots.reorder, "Reorder bots");
  const order = resolveBotListOrder(props.bots, pendingOrder, saving);
  const version = JSON.stringify(order);
  const byId = new Map(props.bots.map((bot) => [bot.id, bot]));
  const active = drag?.version === version ? drag : null;
  const save = async (id: string, to: number) => {
    const from = order.indexOf(id);
    if (busy.current || from < 0 || to < 0 || from === to) return;
    const names = [...order];
    names.splice(from, 1);
    names.splice(to, 0, id);
    busy.current = true;
    setSaving(true);
    setPendingOrder({ ids: names, source: props.bots });
    try {
      const result = await reorder({ environmentId: props.environmentId, input: { names } });
      if (result._tag === "Failure") setPendingOrder(null);
    } catch {
      setPendingOrder(null);
    } finally {
      setSaving(false);
      busy.current = false;
    }
  };
  const from = active ? order.indexOf(active.id) : -1;
  const to = active?.to ?? -1;
  const height = active?.rows[from]?.height ?? 0;
  return (
    <View>
      {order.map((id, index) => {
        const bot = byId.get(id);
        if (!bot) return null;
        const offset =
          active?.id === id
            ? active.translation
            : from < to && index > from && index <= to
              ? -height
              : from > to && index >= to && index < from
                ? height
                : 0;
        return (
          <View
            key={id}
            onLayout={({ nativeEvent }) => layouts.current.set(id, nativeEvent.layout)}
            style={{ zIndex: active?.id === id ? 1 : 0 }}
          >
            <SortableBotRow
              name={bot.name}
              disabled={saving}
              lifted={active?.id === id}
              offset={offset}
              canMoveUp={index > 0}
              canMoveDown={index < order.length - 1}
              onStart={() => {
                const rows = order.flatMap((name) => layouts.current.get(name) ?? []);
                if (rows.length !== order.length) return;
                setDrag({ id, translation: 0, version, rows, from: index, to: index });
              }}
              onMove={(translation) =>
                setDrag((current) =>
                  current?.id === id
                    ? {
                        ...current,
                        translation,
                        to: dropIndex(current.rows, current.from, translation),
                      }
                    : current,
                )
              }
              onEnd={(translation, cancelled) => {
                setDrag(null);
                if (!cancelled && active?.id === id)
                  void save(id, dropIndex(active.rows, active.from, translation));
              }}
              onStep={(direction) => void save(id, index + direction)}
            >
              {props.renderBot(bot)}
            </SortableBotRow>
          </View>
        );
      })}
    </View>
  );
}

function SortableBotRow(props: {
  readonly name: string;
  readonly disabled: boolean;
  readonly lifted: boolean;
  readonly offset: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onStart: () => void;
  readonly onMove: (translation: number) => void;
  readonly onEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: number) => void;
  readonly children: ReactNode;
}) {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  }, [props]);
  const disabled = props.disabled;
  const translation = useRef(0);
  const startDrag = useCallback(() => {
    translation.current = 0;
    latest.current.onStart();
  }, []);
  const updateDrag = useCallback((event: { translationY: number }) => {
    translation.current = event.translationY;
    latest.current.onMove(event.translationY);
  }, []);
  const finishDrag = useCallback((_: unknown, success: boolean) => {
    latest.current.onEnd(translation.current, !success);
  }, []);
  const gesture = useMemo(
    () =>
      createDragGesture()
        .enabled(!disabled)
        .activateAfterLongPress(300)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(startDrag)
        .onUpdate(updateDrag)
        .onFinalize(finishDrag),
    [disabled, startDrag, updateDrag, finishDrag],
  );
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: props.offset }] }));
  return (
    <GestureDetector gesture={gesture}>
      <Reanimated.View
        collapsable={false}
        style={style}
        className={props.lifted ? "bg-card rounded-lg shadow-md" : undefined}
        accessibilityLabel={`Reorder ${props.name}`}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: "Move up" }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (props.disabled) return;
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep(-1);
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep(1);
        }}
      >
        {props.children}
      </Reanimated.View>
    </GestureDetector>
  );
}

const createDragGesture = () => Gesture.Pan();

function dropIndex(rows: ReadonlyArray<LayoutRectangle>, from: number, translation: number) {
  const source = rows[from];
  if (!source) return from;
  const center = source.y + source.height / 2 + translation;
  let nearest = from;
  let distance = Infinity;
  rows.forEach((row, index) => {
    const delta = Math.abs(row.y + row.height / 2 - center);
    if (delta < distance) {
      nearest = index;
      distance = delta;
    }
  });
  return nearest;
}
