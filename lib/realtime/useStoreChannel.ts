"use client";
import { useEffect, useState, useRef } from "react";
import {
  listLiveOrders,
  fetchOrdersUpdatedSince,
  subscribeStoreOrders,
} from "../data/live";
import { mergeLiveOrders, reconnectDelay } from "../data/live-rules";
import type { LiveOrder, OrderConnection } from "../data/types";

// The controller owns effects so lifecycle behavior is testable without a DOM renderer.
export function createStoreChannel(
  storeId: string,
  notify: (orders: LiveOrder[], connection: OrderConnection) => void,
  report: (error: unknown) => void = () => {},
) {
  let stopped = false,
    orders: LiveOrder[] = [],
    connection: OrderConnection = "reconnecting";
  let watermark = Date.now(),
    initialized = false,
    attempt = 0;
  let stopSubscription = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;
  let audio: AudioContext | undefined;
  let enabled = false;
  const emit = () => {
    if (!stopped) notify(orders, connection);
  };
  const merge = (rows: LiveOrder[]) => {
    if (stopped) return;
    orders = mergeLiveOrders(orders, rows);
    for (const row of rows) {
      const time = Date.parse(row.updated_at);
      if (Number.isFinite(time))
        watermark = initialized ? Math.max(watermark, time) : time;
      initialized = true;
    }
    emit();
  };
  const pull = async () => {
    try {
      merge(
        await fetchOrdersUpdatedSince(
          new Date(watermark - 30000).toISOString(),
        ),
      );
    } catch (error) {
      if (!stopped) report(error);
    }
  };
  const connect = () => {
    if (stopped) return;
    stopSubscription();
    stopSubscription = subscribeStoreOrders(storeId, {
      onInsert: (order) => merge([order]),
      onUpdate: (order) => merge([order]),
      onConnectionChange: (status) => {
        if (stopped) return;
        connection = status;
        if (status === "connected") {
          clearTimeout(retry);
          retry = undefined;
          attempt = 0;
          void pull();
        } else if (!retry) {
          connection = "reconnecting";
          retry = setTimeout(() => {
            retry = undefined;
            connect();
          }, reconnectDelay(attempt++));
        }
        emit();
      },
    });
  };
  const visibility = () => {
    if (document.visibilityState === "visible") void pull();
  };
  document.addEventListener("visibilitychange", visibility);
  const poll = setInterval(() => void pull(), 60000);
  const bell = setInterval(() => {
    if (
      !enabled ||
      audio?.state !== "running" ||
      !orders.some((o) => o.status === "new")
    )
      return;
    try {
      const oscillator = audio.createOscillator(),
        gain = audio.createGain();
      oscillator.frequency.setValueAtTime(880, audio.currentTime);
      gain.gain.setValueAtTime(0.1, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.3);
    } catch (error) {
      report(error);
    }
  }, 10000);
  connect();
  void listLiveOrders()
    .then(merge)
    .catch((error) => {
      if (!stopped) report(error);
    });
  return {
    refresh: pull,
    async enableSound() {
      if (stopped) return false;
      try {
        audio ??= new AudioContext();
        await audio.resume();
        enabled = !stopped && audio.state === "running";
        return enabled;
      } catch {
        return false;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      enabled = false;
      stopSubscription();
      clearTimeout(retry);
      clearInterval(poll);
      clearInterval(bell);
      document.removeEventListener("visibilitychange", visibility);
      void audio?.close().catch(() => {});
    },
  };
}
export function useStoreChannel(storeId: string) {
  const [state, setState] = useState<{
    storeId: string;
    orders: LiveOrder[];
    connection: OrderConnection;
  }>({ storeId, orders: [], connection: "disconnected" });
  const [sound, setSound] = useState({ storeId, enabled: false });
  const [failure, setFailure] = useState<{ storeId: string; error: unknown }>({
    storeId,
    error: null,
  });
  const controller = useRef<ReturnType<typeof createStoreChannel> | null>(null);
  useEffect(() => {
    const channel = createStoreChannel(
      storeId,
      (orders, connection) => setState({ storeId, orders, connection }),
      (error) => setFailure({ storeId, error }),
    );
    controller.current = channel;
    queueMicrotask(() => {
      if (controller.current === channel) {
        setSound({ storeId, enabled: false });
        setFailure({ storeId, error: null });
      }
    });
    return () => {
      channel.stop();
      controller.current = null;
    };
  }, [storeId]);
  return {
    orders: state.storeId === storeId ? state.orders : [],
    connection:
      state.storeId === storeId
        ? state.connection
        : ("reconnecting" as OrderConnection),
    error: failure.storeId === storeId ? failure.error : null,
    soundEnabled: sound.storeId === storeId && sound.enabled,
    enableSound: async () => {
      const current = controller.current;
      const enabled = (await current?.enableSound()) ?? false;
      if (current === controller.current) setSound({ storeId, enabled });
    },
    refresh: () => controller.current?.refresh(),
  };
}
