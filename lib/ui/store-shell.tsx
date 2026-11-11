"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  getSession,
  onSessionChange,
  signOut,
  type Session,
  type StoreStatus,
} from "../data";
import { errorMessage } from "../format";
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
  const load = useCallback(() => {
    void getSession()
      .then((s) => {
        setSession(s);
        setError(undefined);
      })
      .catch(setError);
  }, []);
  useEffect(() => {
    load();
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onSessionChange(setSession);
    } catch (e) {
      void Promise.resolve().then(() => setError(e));
    }
    return () => unsubscribe?.();
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
          <ErrorState message={errorMessage(error)} retry={load} />
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
            {children}
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
