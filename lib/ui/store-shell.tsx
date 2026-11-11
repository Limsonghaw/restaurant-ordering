"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getSession,
  onSessionChange,
  signOut,
  type Session,
  type StoreStatus,
} from "../data";
import { liveErrorMessage } from "./live-errors";
import { storeNavigation, routes } from "../routes";
import { Banner, ErrorState, Modal, Skeleton } from "./common";
export function StoreShell({
  children,
  banners,
  newOrderCount,
  storeStatus,
}: {
  children: ReactNode;
  banners?: ReactNode;
  newOrderCount?: number;
  storeStatus?: StoreStatus;
}) {
  const path = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState<unknown>();
  const [more, setMore] = useState(false);
  const close = useCallback(() => setMore(false), []);
  const sessionVersion = useRef(0);
  const load = useCallback(() => {
    const version = ++sessionVersion.current;
    void getSession()
      .then((s) => {
        if (version !== sessionVersion.current) return;
        setSession(s);
        setError(undefined);
      })
      .catch((e) => {
        if (version === sessionVersion.current) setError(e);
      });
  }, []);
  useEffect(() => {
    const version = sessionVersion;
    load();
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onSessionChange((s) => {
        sessionVersion.current++;
        setSession(s);
        setError(undefined);
      });
    } catch (e) {
      void Promise.resolve().then(() => setError(e));
    }
    return () => {
      version.current++;
      unsubscribe?.();
    };
  }, [load]);
  const logout = () =>
    void signOut()
      .then(() => router.replace(routes.login))
      .catch(setError);
  const nav = (entry: readonly [string, string], i: number) => (
    <Link
      className={path === entry[1] ? "active" : ""}
      key={entry[1]}
      href={entry[1]}
    >
      {entry[0]}
      {i === 0 && <span className="badge-slot">{newOrderCount || ""}</span>}
    </Link>
  );
  return (
    <>
      <aside className="store-sidebar">
        <h1>茶餐 · 店家</h1>
        <p className="muted">{session?.store?.name ?? "店家后台"}</p>
        <nav aria-label="后台导航">
          {storeNavigation.map(nav)}
          <button onClick={logout}>退出登录</button>
        </nav>
      </aside>
      <div className="store-main">
        {error ? (
          <ErrorState message={liveErrorMessage(error)} retry={load} />
        ) : session === undefined ? (
          <Skeleton />
        ) : (
          <>
            <div aria-label="店铺提示">
              {(storeStatus ?? session?.store?.status) === "suspended" && (
                <Banner tone="red">店铺已被平台停用，请联系平台</Banner>
              )}
              {session?.store && !session.store.is_profile_complete && (
                <Banner tone="yellow">
                  还没填店铺资料，先去店铺设置填写店名、地址和营业时间{" "}
                  <Link href={routes.storeSettings}>去店铺设置</Link>
                </Banner>
              )}
              {banners}
            </div>
            {/* Remount all page state when identity, store or write access changes. */}
            <Fragment
              key={JSON.stringify([
                session?.user_id,
                session?.store?.id,
                session?.store?.status,
              ])}
            >
              {children}
            </Fragment>
          </>
        )}
      </div>
      <nav className="store-mobile" aria-label="后台导航">
        {storeNavigation
          .slice(0, 3)
          .map((entry, i) => nav([["接单", "账单", "菜单"][i], entry[1]], i))}
        <button onClick={() => setMore(true)}>更多</button>
      </nav>
      {more && (
        <Modal title="更多" onClose={close}>
          <nav className="store-more">
            <button onClick={logout}>退出登录</button>
            {storeNavigation.slice(3).map((entry) => (
              <Link key={entry[1]} href={entry[1]} onClick={close}>
                {entry[0]}
              </Link>
            ))}
          </nav>
        </Modal>
      )}
    </>
  );
}
