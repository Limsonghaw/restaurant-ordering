"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DataError,
  fetchOrdersUpdatedSince,
  getLiveMockSettings,
  configureLiveMock,
  getSession,
  getStoreStatus,
  isMock,
  listLiveOrders,
  listServedToday,
  setAcceptingOrders,
  subscribeStoreOrders,
  updateOrderStatus,
  type LiveOrder,
  type LiveStoreStatus,
  type OrderConnection,
  type OrderStatusChange,
} from "../data";
import { mergeLiveOrders, reconnectDelay } from "../data/live-rules";
import { errorMessage } from "../format";
import { routes } from "../routes";
import { Banner, Button, ConfirmDialog, Toast } from "./common";
import { StoreShell } from "./store-shell";
interface Reception {
  started: boolean;
  loading: boolean;
  error: string;
  orders: LiveOrder[];
  store?: LiveStoreStatus;
  connection: OrderConnection;
  sound: boolean;
  wake: boolean;
  busy: string[];
  switchBusy: boolean;
  start: () => void;
  reload: () => void;
  testSound: () => void;
  toggleAccepting: () => void;
  change: (order: LiveOrder, change: OrderStatusChange) => Promise<boolean>;
}
const Context = createContext<Reception | null>(null);
export function useReception() {
  return useContext(Context)!;
}
export function LiveProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [store, setStore] = useState<LiveStoreStatus>();
  const [connection, setConnection] = useState<OrderConnection>("disconnected");
  const [sound, setSound] = useState(false);
  const [wake, setWake] = useState(false);
  const [wakeDismissed, setWakeDismissed] = useState(false);
  const [expired, setExpired] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const [pauseConfirm, setPauseConfirm] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const orderRef = useRef<LiveOrder[]>([]);
  const busyRef = useRef(new Set<string>());
  const reconnectRef = useRef<() => void>(() => {});
  const reloadRef = useRef<() => void>(() => {});
  const mock = useRef({
    no_wake: false,
    sound_paused: false,
    threshold_ms: 120000,
  });
  const play = useCallback(() => {
    const ctx = audio.current;
    if (!ctx || ctx.state !== "running" || mock.current.sound_paused) {
      setSound(false);
      return;
    }
    try {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.14, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.45);
      setSound(true);
    } catch {
      setSound(false);
    }
  }, []);
  const unlock = useCallback(() => {
    try {
      if (!audio.current) {
        audio.current = new AudioContext();
        audio.current.onstatechange = () =>
          setSound(
            audio.current?.state === "running" && !mock.current.sound_paused,
          );
      }
      mock.current.sound_paused = false;
      if (isMock)
        void configureLiveMock({ sound_paused: false }).catch(() => {});
      void audio.current
        .resume()
        .then(play)
        .catch(() => setSound(false));
    } catch {
      setSound(false);
    }
  }, [play]);
  const requestWake = useCallback(async () => {
    if (mock.current.no_wake || !navigator.wakeLock) {
      setWake(false);
      return;
    }
    if (wakeLock.current && !wakeLock.current.released) {
      setWake(true);
      return;
    }
    try {
      const lock = await navigator.wakeLock.request("screen");
      wakeLock.current = lock;
      setWake(true);
      lock.addEventListener("release", () => setWake(false));
    } catch {
      setWake(false);
    }
  }, []);
  const ingest = useCallback(
    (incoming: LiveOrder[]) => {
      const previous = orderRef.current;
      const fresh = incoming.filter(
        (o) => o.status === "new" && !previous.some((p) => p.id === o.id),
      );
      orderRef.current = mergeLiveOrders(previous, incoming);
      setOrders(orderRef.current);
      if (fresh.length) play();
      return fresh.length;
    },
    [play],
  );
  const report = useCallback((e: unknown) => {
    if (e instanceof DataError && e.code === "UNAUTHENTICATED")
      setExpired(true);
    else setError(errorMessage(e));
  }, []);
  useEffect(() => {
    if (!isMock) return;
    let alive = true;
    const sync = () => {
      void getLiveMockSettings()
        .then((settings) => {
          if (!alive) return;
          mock.current = settings;
          if (settings.sound_paused) {
            setSound(false);
            void audio.current?.suspend().catch(() => {});
          }
          if (settings.no_wake) {
            setWake(false);
            void wakeLock.current?.release().catch(() => {});
          }
          if (settings.expired) setExpired(true);
          else setExpired(false);
        })
        .catch(report);
    };
    sync();
    window.addEventListener("ro-mock:live", sync);
    window.addEventListener("storage", sync);
    return () => {
      alive = false;
      window.removeEventListener("ro-mock:live", sync);
      window.removeEventListener("storage", sync);
    };
  }, [report]);
  useEffect(() => {
    if (!started) return;
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disconnectedAt = 0;
    let status: OrderConnection = "disconnected";
    let storeId = "";
    let pulling = false;
    let queuedPull = false;
    async function pull() {
      if (pulling) {
        queuedPull = true;
        return;
      }
      pulling = true;
      try {
        const max = Math.max(
          0,
          ...orderRef.current.map((o) => Date.parse(o.updated_at)),
        );
        const [updates, currentStore] = await Promise.all([
          fetchOrdersUpdatedSince(
            new Date(Math.max(0, max - 30000)).toISOString(),
          ),
          getStoreStatus(),
        ]);
        if (!alive) return;
        const count = ingest(updates);
        setStore(currentStore);
        setError("");
        if (disconnectedAt && count)
          setNotice(`断线期间收到 ${count} 张新订单`);
      } catch (e) {
        if (alive) report(e);
      } finally {
        pulling = false;
        if (queuedPull && alive) {
          queuedPull = false;
          void pull();
        }
      }
    }
    function connect() {
      clearTimeout(timer);
      unsubscribe?.();
      if (!alive || !storeId) return;
      try {
        unsubscribe = subscribeStoreOrders(storeId, {
          onInsert: (o) => {
            if (alive) ingest([o]);
          },
          onUpdate: (o) => {
            if (alive) ingest([o]);
          },
          onConnectionChange: (value) => {
            if (!alive) return;
            if (value === "connected") {
              const wasDisconnected = disconnectedAt > 0;
              clearTimeout(timer);
              attempt = 0;
              status = value;
              setConnection(value);
              setOverdue(false);
              if (wasDisconnected) setNotice("已重新连接");
              void pull().then(() => {
                disconnectedAt = 0;
              });
            } else lost();
          },
        });
      } catch (e) {
        report(e);
        lost();
      }
    }
    function lost() {
      if (!alive) return;
      if (!disconnectedAt) disconnectedAt = Date.now();
      status = "reconnecting";
      setConnection("reconnecting");
      clearTimeout(timer);
      const wait = reconnectDelay(attempt++);
      timer = setTimeout(connect, wait);
    }
    async function load() {
      setLoading(true);
      try {
        const session = await getSession();
        if (!session) throw new DataError("UNAUTHENTICATED", "登录已过期");
        if (!session.store)
          throw new DataError("FORBIDDEN", "没有店铺访问权限");
        const [live, served, currentStore] = await Promise.all([
          listLiveOrders(),
          listServedToday(),
          getStoreStatus(),
        ]);
        if (!alive) return;
        storeId = session.store.id;
        ingest([...live, ...served]);
        setStore(currentStore);
        setError("");
        setExpired(false);
        connect();
      } catch (e) {
        if (alive) report(e);
      } finally {
        if (alive) setLoading(false);
      }
    }
    reconnectRef.current = connect;
    reloadRef.current = () => {
      void load();
    };
    void load();
    const offline = () => lost();
    const online = () => {
      connect();
      void pull();
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      setSound(
        audio.current?.state === "running" && !mock.current.sound_paused,
      );
      void requestWake();
      void pull();
    };
    const changedStore = () => {
      void getStoreStatus()
        .then((s) => {
          if (alive) setStore(s);
        })
        .catch(report);
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    window.addEventListener("ro-mock:change", changedStore);
    document.addEventListener("visibilitychange", visible);
    const silent = setInterval(() => {
      if (status === "connected") void pull();
    }, 60000);
    const threshold = setInterval(() => {
      if (disconnectedAt)
        setOverdue(Date.now() - disconnectedAt >= mock.current.threshold_ms);
    }, 500);
    const repeat = setInterval(() => {
      if (orderRef.current.some((o) => o.status === "new")) play();
    }, 10000);
    return () => {
      alive = false;
      unsubscribe?.();
      clearTimeout(timer);
      clearInterval(silent);
      clearInterval(threshold);
      clearInterval(repeat);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      window.removeEventListener("ro-mock:change", changedStore);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [started, ingest, play, report, requestWake]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!toast || retry) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast, retry]);
  const newCount = orders.filter((o) => o.status === "new").length;
  useEffect(() => {
    if (!started) return;
    const original = document.title;
    document.title = `${overdue ? "【已断线】" : ""}${newCount ? `(${newCount}) 新订单` : "餐厅扫码点餐"}`;
    return () => {
      document.title = original;
    };
  }, [started, newCount, overdue, pathname]);
  useEffect(
    () => () => {
      void audio.current?.close().catch(() => {});
      void wakeLock.current?.release().catch(() => {});
    },
    [],
  );
  async function change(
    order: LiveOrder,
    value: OrderStatusChange,
  ): Promise<boolean> {
    if (busyRef.current.has(order.id)) return false;
    busyRef.current.add(order.id);
    setBusy([...busyRef.current]);
    setRetry(null);
    try {
      const result = await updateOrderStatus(order.id, value);
      ingest([result]);
      setToast(
        value.to === "served"
          ? `${order.dining_tables.label} 桌第 ${order.seq_in_bill} 单已上菜`
          : "操作成功",
      );
      return true;
    } catch (e) {
      if (
        e instanceof DataError &&
        [
          "ORDER_STATUS_CONFLICT",
          "INVALID_STATUS_TRANSITION",
          "ORDER_BILL_CLOSED",
        ].includes(e.code)
      ) {
        setToast(
          e.code === "ORDER_BILL_CLOSED"
            ? "这桌已结账，不能取消订单"
            : "这张订单已被处理",
        );
        try {
          ingest(await fetchOrdersUpdatedSince(new Date(0).toISOString()));
        } catch (error) {
          report(error);
        }
      } else if (e instanceof DataError && e.code === "UNAUTHENTICATED")
        report(e);
      else if (e instanceof DataError && e.code === "STORE_SUSPENDED") {
        setStore((s) => (s ? { ...s, status: "suspended" } : s));
      } else {
        setToast("操作没有成功，请重试");
        setRetry(() => () => {
          void change(order, value);
        });
      }
      return false;
    } finally {
      busyRef.current.delete(order.id);
      setBusy([...busyRef.current]);
    }
  }
  async function accepting(value: boolean) {
    setSwitchBusy(true);
    try {
      setStore(await setAcceptingOrders(value));
      setPauseConfirm(false);
    } catch (e) {
      report(e);
    } finally {
      setSwitchBusy(false);
    }
  }
  const banners = (
    <>
      {started && connection !== "connected" && (
        <Banner
          tone="red"
          action={
            <>
              <Button
                variant="secondary"
                onClick={() => reconnectRef.current()}
              >
                立即重连
              </Button>
              {overdue && (
                <Button variant="secondary" onClick={() => location.reload()}>
                  刷新页面
                </Button>
              )}
            </>
          }
        >
          连接已中断，正在重新连接，期间可能收不到新订单
        </Banner>
      )}
      {expired && (
        <Banner
          tone="red"
          action={
            <Link href={routes.login} prefetch={false}>
              重新登录
            </Link>
          }
        >
          登录已过期，请重新登录，否则收不到新订单
        </Banner>
      )}
      {started && !sound && (
        <Banner
          action={
            <Button variant="secondary" onClick={unlock}>
              重新开启
            </Button>
          }
        >
          提示音已暂停，点这里重新开启
        </Banner>
      )}
      {started && !wake && !wakeDismissed && (
        <Banner
          action={
            <Button variant="secondary" onClick={() => setWakeDismissed(true)}>
              知道了
            </Button>
          }
        >
          这台设备的浏览器不能自动保持亮屏。请到系统设置把自动锁屏改为「永不」，并一直接着充电器。
        </Banner>
      )}
      {store && !store.is_accepting_orders && (
        <Banner>目前暂停接单，顾客只能看菜单，不能下单</Banner>
      )}
      {notice && (
        <Banner tone="green">
          已重新连接{notice !== "已重新连接" && ` · ${notice}`}
        </Banner>
      )}
      {error && started && (
        <Banner
          tone="red"
          action={
            <Button variant="secondary" onClick={() => reloadRef.current()}>
              重试
            </Button>
          }
        >
          {error}
        </Banner>
      )}
    </>
  );
  return (
    <Context.Provider
      value={{
        started,
        loading,
        error,
        orders,
        store,
        connection,
        sound,
        wake,
        busy,
        switchBusy,
        start: () => {
          unlock();
          void requestWake();
          setStarted(true);
        },
        reload: () => reloadRef.current(),
        testSound: unlock,
        toggleAccepting: () => {
          if (switchBusy || store?.status === "suspended") return;
          if (store?.is_accepting_orders) setPauseConfirm(true);
          else void accepting(true);
        },
        change,
      }}
    >
      <StoreShell
        banners={banners}
        newOrderCount={newCount}
        storeStatus={store?.status}
      >
        {children}
      </StoreShell>
      {pauseConfirm && (
        <ConfirmDialog
          title="关闭后顾客不能下单，确定暂停接单？"
          busy={switchBusy}
          onConfirm={() => void accepting(false)}
          onClose={() => setPauseConfirm(false)}
        />
      )}
      {toast && (
        <Toast>
          {toast}
          {retry && (
            <Button variant="secondary" onClick={retry}>
              重试
            </Button>
          )}
        </Toast>
      )}
    </Context.Provider>
  );
}
