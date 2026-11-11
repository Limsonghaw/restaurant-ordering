"use client";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DataError,
  getTableMenu,
  imageUrl,
  getTableBill,
  quoteCart,
  placeOrder,
  type CartItem,
  type CartQuote,
  type MenuItem,
  type TableMenu,
  type TableBill,
  type BillGoneReason,
} from "../data";
import { addCartLine, readCart, writeCart } from "../cart";
import {
  errorMessage,
  formatMoney,
  formatTime,
  goneMessages,
  cancelLabels,
} from "../format";
import { routes } from "../routes";
import {
  useCountdown,
  AmountDetails,
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FoodImage,
  FullPageMessage,
  Modal,
  Money,
  OrderStatusLabel,
  Skeleton,
  Stepper,
  TextField,
  Toast,
} from "./common";
import { Captcha } from "./captcha";
export function logoUrl(path: string | null) {
  return path && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)
    ? (imageUrl(path) ?? "/mock/logo.svg")
    : "/mock/logo.svg";
}
function Header({
  menu,
  code,
  cart,
}: {
  menu: TableMenu;
  code: string;
  cart?: boolean;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {cart ? (
          <Link href={routes.menu(code)}>← 返回菜单</Link>
        ) : (
          <Image
            width={46}
            height={46}
            unoptimized
            className="logo"
            src={logoUrl(menu.store.logo_path)}
            alt=""
          />
        )}
        <div className="brand">
          <h1>{cart ? "购物车" : menu.store.name}</h1>
          {!cart && <small>好好吃饭，慢慢享用</small>}
        </div>
        <span className="table-chip">{menu.table.label} 桌</span>
        {!cart && <Link href={routes.orders(code)}>我的订单</Link>}
      </div>
    </header>
  );
}
function Fatal({ error }: { error: unknown }) {
  if (
    error instanceof DataError &&
    ["TABLE_INVALID", "STORE_SUSPENDED"].includes(error.code)
  )
    return <FullPageMessage>{errorMessage(error)}</FullPageMessage>;
  return null;
}
function useCart(code: string) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => {
      setCart(readCart(code));
      setReady(true);
    });
  }, [code]);
  const update = useCallback(
    (items: CartItem[]) => {
      writeCart(code, items);
      setCart(items);
    },
    [code],
  );
  return { cart, update, ready };
}
function useQuote(code: string, cart: CartItem[], ready: boolean) {
  const [value, setValue] = useState<CartQuote>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++serial.current;
    setBusy(true);
    try {
      const q = await quoteCart(code, cart);
      if (id === serial.current) {
        setValue(q);
        setError(undefined);
      }
      return q;
    } catch (e) {
      if (id === serial.current) setError(e);
      return undefined;
    } finally {
      if (id === serial.current) setBusy(false);
    }
  }, [code, cart]);
  useEffect(() => {
    const requestSerial = serial;
    if (ready) void Promise.resolve().then(refresh);
    return () => {
      requestSerial.current++;
    };
  }, [refresh, ready]);
  return { value, error, busy, refresh };
}
export function MenuPage({ code }: { code: string }) {
  const [menu, setMenu] = useState<TableMenu>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState("cat-0");
  const [detail, setDetail] = useState<MenuItem>();
  const [toast, setToast] = useState("");
  const [remove, setRemove] = useState<number>();
  const { cart, update, ready } = useCart(code);
  const quote = useQuote(code, cart, ready);
  const seconds = useCountdown(error);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMenu(await getTableMenu(code));
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [code]);
  useEffect(() => {
    void Promise.resolve().then(load);
    const listener = () => {
      void load();
    };
    window.addEventListener("ro-mock:change", listener);
    window.addEventListener("storage", listener);
    return () => {
      window.removeEventListener("ro-mock:change", listener);
      window.removeEventListener("storage", listener);
    };
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (!menu) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-155px 0px -55% 0px", threshold: 0 },
    );
    document
      .querySelectorAll(".category-section")
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [menu, search]);
  const closeDetail = useCallback(() => setDetail(undefined), []);
  const closeRemove = useCallback(() => setRemove(undefined), []);
  function add(item: MenuItem, quantity = 1, note = "") {
    const next = addCartLine(cart, {
      item_id: item.id,
      quantity,
      note,
      unit_price_cents: item.price_cents,
    });
    if (!next) {
      setToast("购物车已满");
      return;
    }
    update(next);
    setDetail(undefined);
    setToast("已加入购物车");
  }
  if (
    error instanceof DataError &&
    ["TABLE_INVALID", "STORE_SUSPENDED"].includes(error.code)
  )
    return <Fatal error={error} />;
  if (loading && !menu)
    return (
      <main className="content">
        <Skeleton />
      </main>
    );
  if (!menu)
    return (
      <ErrorState
        message={
          seconds ? `操作太频繁，请 ${seconds} 秒后再试` : errorMessage(error)
        }
        retry={() => {
          if (!seconds) void load();
        }}
      />
    );
  const visible = menu.items.filter((i) => i.name.includes(search));
  const full =
    cart.length >= 30 || cart.reduce((n, i) => n + i.quantity, 0) >= 200;
  return (
    <>
      <Header menu={menu} code={code} />
      <main className="content">
        {!menu.store.is_accepting_orders && <Banner>暂停接单</Banner>}
        <div className="search">
          <input
            aria-label="搜索菜品"
            placeholder="搜索菜品"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="secondary" onClick={() => setSearch("")}>
            清除
          </Button>
        </div>
        {!menu.items.length ? (
          <EmptyState>店家还在准备菜单，请向店员点餐</EmptyState>
        ) : !visible.length ? (
          <EmptyState
            action={<Button onClick={() => setSearch("")}>清除搜索</Button>}
          >
            没有找到“{search}”相关的菜品
          </EmptyState>
        ) : (
          <div className="menu-layout">
            <nav className="categories" aria-label="菜品分类">
              {menu.categories.map((c) => (
                <a
                  key={c.id}
                  href={`#${c.id}`}
                  className={active === c.id ? "active" : ""}
                  onClick={() => setActive(c.id)}
                >
                  {c.name}
                </a>
              ))}
            </nav>
            <div className="menu-sections">
              {menu.categories.map((category) => {
                const items = visible.filter(
                  (i) => i.category_id === category.id,
                );
                return items.length ? (
                  <section
                    key={category.id}
                    id={category.id}
                    className="category-section"
                  >
                    <h2>{category.name}</h2>
                    <div className="menu-grid">
                      {items.map((item) => {
                        const index = cart.findIndex(
                          (i) => i.item_id === item.id && !i.note,
                        );
                        const quantity = index >= 0 ? cart[index].quantity : 0;
                        return (
                          <article
                            key={item.id}
                            className={`card menu-card ${item.is_sold_out ? "sold-out" : ""}`}
                          >
                            <div className="card-copy">
                              <button
                                className="card-open"
                                onClick={() => setDetail(item)}
                              >
                                <h3>{item.name}</h3>
                                <p className="description">
                                  {item.description}
                                </p>
                              </button>
                              <div className="price-row">
                                <Money cents={item.price_cents} />
                                {item.is_sold_out ? (
                                  <span>已售完</span>
                                ) : quantity ? (
                                  <Stepper
                                    min={0}
                                    max={full ? quantity : 99}
                                    value={quantity}
                                    disabled={!menu.store.is_accepting_orders}
                                    onChange={(n) => {
                                      if (!n) setRemove(index);
                                      else if (n > quantity) add(item);
                                      else
                                        update(
                                          cart.map((l, i) =>
                                            i === index
                                              ? { ...l, quantity: n }
                                              : l,
                                          ),
                                        );
                                    }}
                                  />
                                ) : (
                                  <Button
                                    aria-label={`添加${item.name}`}
                                    disabled={
                                      !menu.store.is_accepting_orders || full
                                    }
                                    onClick={() => add(item)}
                                  >
                                    ＋
                                  </Button>
                                )}
                              </div>
                            </div>
                            <button
                              className="card-open"
                              style={{ width: "auto" }}
                              aria-label={`查看${item.name}`}
                              onClick={() => setDetail(item)}
                            >
                              <FoodImage path={item.thumb_path} />
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ) : null;
              })}
            </div>
          </div>
        )}
        {full && <Banner>购物车已满</Banner>}
        {Boolean(quote.error) && (
          <Banner
            tone="red"
            action={
              <Button variant="text" onClick={() => void quote.refresh()}>
                重试
              </Button>
            }
          >
            {errorMessage(quote.error)}
          </Banner>
        )}
      </main>
      {cart.length > 0 && (
        <div className="bottom-bar">
          <div
            className="bottom-inner"
            key={cart.map((i) => i.quantity).join(",")}
          >
            <div className="pulse">
              <small>共 {quote.value?.item_count ?? "…"} 件</small>
              <p>
                {quote.value && (
                  <Money
                    cents={
                      quote.value.estimated_total_cents ??
                      quote.value.subtotal_cents
                    }
                  />
                )}
              </p>
            </div>
            {menu.store.is_accepting_orders ? (
              <Link
                className={`button primary ${quote.busy || quote.error ? "disabled-link" : ""}`}
                aria-disabled={quote.busy || Boolean(quote.error)}
                href={routes.cart(code)}
              >
                去下单
              </Link>
            ) : (
              <Button disabled>暂停接单</Button>
            )}
          </div>
        </div>
      )}
      {detail && (
        <ItemDetail
          code={code}
          item={detail}
          disabled={
            !menu.store.is_accepting_orders || detail.is_sold_out || full
          }
          onClose={closeDetail}
          onAdd={add}
        />
      )}
      {remove !== undefined && (
        <ConfirmDialog
          title="把这道菜移出购物车？"
          danger
          onClose={closeRemove}
          onConfirm={() => {
            update(cart.filter((_, i) => i !== remove));
            closeRemove();
          }}
        />
      )}
      <Toast>{toast}</Toast>
    </>
  );
}
function ItemDetail({
  code,
  item,
  disabled,
  onClose,
  onAdd,
}: {
  code: string;
  item: MenuItem;
  disabled: boolean;
  onClose: () => void;
  onAdd: (item: MenuItem, quantity: number, note: string) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [q, setQ] = useState<CartQuote>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (live) setQ(undefined);
    });
    void quoteCart(code, [
      { item_id: item.id, quantity, note, unit_price_cents: item.price_cents },
    ])
      .then((v) => {
        if (live) {
          setQ(v);
          setError(undefined);
        }
      })
      .catch((e) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [code, item, quantity, note]);
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="detail">
        <FoodImage path={item.image_path} />
        <p>{item.description}</p>
        <Money cents={item.price_cents} />
        <div className="price-row">
          <span>数量</span>
          <Stepper value={quantity} onChange={setQuantity} />
        </div>
        <TextField
          label="菜品备注"
          placeholder="例如：少辣、不要葱"
          multiline
          maxLength={50}
          value={note}
          onChange={setNote}
        />
        {Boolean(error) && <Banner tone="red">{errorMessage(error)}</Banner>}
        <Button
          disabled={disabled || !q || Boolean(error)}
          onClick={() => onAdd(item, quantity, note)}
        >
          加入购物车 ·{" "}
          {q ? formatMoney(q.lines[0].line_total_cents) : "正在试算…"}
        </Button>
      </div>
    </Modal>
  );
}
export function CartPage({ code }: { code: string }) {
  const router = useRouter();
  const { cart, update, ready } = useCart(code);
  const quote = useQuote(code, cart, ready);
  const [menu, setMenu] = useState<TableMenu>();
  const [error, setError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState(false);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [clear, setClear] = useState(false);
  const [remove, setRemove] = useState<number>();
  const [editing, setEditing] = useState<number>();
  const request = useRef("");
  const locked = useRef(false);
  const seconds = useCountdown(error);
  const lastCart = useRef(cart);
  const loadMenu = useCallback(() => {
    void getTableMenu(code).then(setMenu).catch(setError);
  }, [code]);
  useEffect(() => {
    loadMenu();
    window.addEventListener("ro-mock:change", loadMenu);
    window.addEventListener("storage", loadMenu);
    return () => {
      window.removeEventListener("ro-mock:change", loadMenu);
      window.removeEventListener("storage", loadMenu);
    };
  }, [loadMenu]);
  useEffect(() => {
    if (lastCart.current !== cart) {
      request.current = "";
      lastCart.current = cart;
      setError((current: unknown) =>
        current instanceof DataError && current.code === "PRICE_CHANGED"
          ? current
          : undefined,
      );
      setConfirm(false);
      setCaptcha(false);
    }
  }, [cart]);
  const closeConfirm = useCallback(() => {
    if (!locked.current) {
      setConfirm(false);
      setCaptcha(false);
    }
  }, []);
  const closeClear = useCallback(() => setClear(false), []);
  const closeRemove = useCallback(() => setRemove(undefined), []);
  const q = quote.value;
  const effectiveError = error || quote.error;
  function reconcile(value: CartQuote) {
    if (value.price_changes.length) {
      update(
        cart.map((line) => {
          const change = value.price_changes.find(
            (c) => c.item_id === line.item_id,
          );
          return change
            ? { ...line, unit_price_cents: change.current_unit_price_cents }
            : line;
        }),
      );
      setError(new DataError("PRICE_CHANGED", "价格已更新，请确认后再下单"));
      return false;
    }
    return value.can_order;
  }
  async function submit(token?: string) {
    if (locked.current || seconds) return;
    locked.current = true;
    setBusy(true);
    try {
      const latest = await quoteCart(code, cart);
      if (!reconcile(latest)) {
        setConfirm(false);
        await quote.refresh();
        return;
      }
      if (!request.current) request.current = crypto.randomUUID();
      await placeOrder(code, {
        client_request_id: request.current,
        items: cart,
        ...(token ? { captcha_token: token } : {}),
      });
      update([]);
      sessionStorage.setItem("ro-order-success", "1");
      router.push(routes.orders(code));
    } catch (e) {
      setError(e);
      if (e instanceof DataError) {
        if (e.code === "CAPTCHA_REQUIRED" || e.code === "CAPTCHA_FAILED") {
          setCaptcha(true);
          setConfirm(true);
        } else if (e.code === "IDEMPOTENCY_KEY_REUSED") request.current = "";
        else if (["PRICE_CHANGED", "ITEM_UNAVAILABLE"].includes(e.code)) {
          const fresh = await quote.refresh();
          if (fresh) reconcile(fresh);
          setConfirm(false);
        } else setConfirm(false);
      }
    } finally {
      locked.current = false;
      setBusy(false);
      setCaptchaReset((n) => n + 1);
    }
  }
  async function prepare() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const latest = await quoteCart(code, cart);
      if (reconcile(latest)) {
        setError(undefined);
        setConfirm(true);
      }
      await quote.refresh();
    } catch (e) {
      setError(e);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  if (
    effectiveError instanceof DataError &&
    ["TABLE_INVALID", "STORE_SUSPENDED"].includes(effectiveError.code)
  )
    return <Fatal error={effectiveError} />;
  if (!menu)
    return effectiveError ? (
      <ErrorState
        message={errorMessage(effectiveError)}
        retry={() => {
          loadMenu();
          void quote.refresh();
        }}
      />
    ) : (
      <main className="content narrow">
        <Skeleton />
      </main>
    );
  const blocked =
    effectiveError instanceof DataError &&
    ["DEVICE_BLOCKED", "STORE_CLOSED", "ORDER_LIMIT_EXCEEDED"].includes(
      effectiveError.code,
    );
  const limit =
    q?.limit_exceeded ||
    (error instanceof DataError && error.code === "ORDER_LIMIT_EXCEEDED");
  const message = seconds
    ? `下单太频繁，请 ${seconds} 秒后再试`
    : error instanceof DataError && error.code === "NETWORK"
      ? "下单没有成功，购物车已保留，请重试"
      : effectiveError
        ? errorMessage(effectiveError)
        : "";
  return (
    <>
      <Header menu={menu} code={code} cart />
      <main className="content narrow">
        {message && (
          <Banner
            tone="red"
            action={
              effectiveError instanceof DataError &&
              effectiveError.code === "NETWORK" ? (
                <Button onClick={() => void submit()} busy={busy}>
                  重试
                </Button>
              ) : undefined
            }
          >
            {message}
          </Banner>
        )}
        {(!menu.store.is_accepting_orders || (q && !q.is_accepting_orders)) && (
          <Banner>暂停接单</Banner>
        )}
        {!cart.length && ready ? (
          <EmptyState
            action={
              <Link className="button primary" href={routes.menu(code)}>
                去看菜单
              </Link>
            }
          >
            购物车是空的
          </EmptyState>
        ) : (
          <>
            {!q ? (
              quote.error ? (
                <ErrorState
                  message={errorMessage(quote.error)}
                  retry={() => void quote.refresh()}
                />
              ) : (
                <Skeleton />
              )
            ) : (
              <>
                {q.unavailable.length > 0 && (
                  <Banner
                    tone="red"
                    action={
                      <Button
                        variant="text"
                        onClick={() =>
                          update(
                            cart.filter(
                              (l) =>
                                !q.unavailable.some(
                                  (u) => u.item_id === l.item_id,
                                ),
                            ),
                          )
                        }
                      >
                        移除售完菜品
                      </Button>
                    }
                  >
                    有菜品刚售完，请移除后再下单
                  </Banner>
                )}
                {q.price_changes.length > 0 && (
                  <Banner
                    action={
                      <Button variant="text" onClick={() => reconcile(q)}>
                        确认新价格
                      </Button>
                    }
                  >
                    价格已更新，请确认后再下单
                  </Banner>
                )}
                {cart.map((line, index) => {
                  const quoted = q.lines[index];
                  const unavailable = q.unavailable.find(
                    (i) => i.item_id === line.item_id,
                  );
                  return (
                    <article className="card" key={`${line.item_id}-${index}`}>
                      <div className="order-title">
                        <h3>{quoted?.item_name}</h3>
                        {quoted && <Money cents={quoted.line_total_cents} />}
                      </div>
                      <p className="muted">
                        单价{" "}
                        {formatMoney(
                          quoted?.unit_price_cents ?? line.unit_price_cents,
                        )}
                      </p>
                      {unavailable && (
                        <p className="error-text">
                          {unavailable.reason === "sold_out"
                            ? "已售完"
                            : "已下架"}
                        </p>
                      )}
                      <div className="price-row">
                        <Button
                          variant="text"
                          onClick={() =>
                            setEditing(editing === index ? undefined : index)
                          }
                        >
                          {line.note ? "修改备注" : "添加备注"}
                        </Button>
                        <Stepper
                          min={0}
                          max={
                            cart.reduce((n, l) => n + l.quantity, 0) >= 200
                              ? line.quantity
                              : 99
                          }
                          value={line.quantity}
                          disabled={busy}
                          onChange={(n) => {
                            if (!n) setRemove(index);
                            else
                              update(
                                cart.map((l, i) =>
                                  i === index ? { ...l, quantity: n } : l,
                                ),
                              );
                          }}
                        />
                      </div>
                      {line.note && editing !== index && (
                        <p className="muted">备注：{line.note}</p>
                      )}
                      {editing === index && (
                        <TextField
                          label="菜品备注"
                          multiline
                          maxLength={50}
                          value={line.note}
                          onChange={(note) =>
                            update(
                              cart.map((l, i) =>
                                i === index ? { ...l, note } : l,
                              ),
                            )
                          }
                        />
                      )}
                    </article>
                  );
                })}
                <Button
                  variant="text"
                  onClick={() => setClear(true)}
                  disabled={busy}
                >
                  清空购物车
                </Button>
                <section className="card">
                  <p>共 {q.item_count} 件</p>
                  <AmountDetails
                    quote={q}
                    subtotalOnly={Boolean(limit)}
                    hint={
                      limit
                        ? "单张订单最多 RM 3,000（或 200 件），请分开下单"
                        : `本单预估 ${formatMoney(q.estimated_total_cents ?? 0)}，以结账金额为准`
                    }
                  />
                </section>
                <p className="muted">下单后请到柜台付款</p>
              </>
            )}
          </>
        )}
      </main>
      {cart.length > 0 && (
        <div className="bottom-bar">
          <div className="bottom-inner">
            <Button
              large
              busy={busy}
              busyText="正在下单…"
              disabled={
                !q?.can_order ||
                quote.busy ||
                Boolean(quote.error) ||
                Boolean(blocked) ||
                seconds > 0
              }
              onClick={() => void prepare()}
            >
              确认下单 ·{" "}
              {q
                ? formatMoney(q.estimated_total_cents ?? q.subtotal_cents)
                : "正在试算…"}
            </Button>
          </div>
        </div>
      )}
      {confirm && (
        <Modal
          title={`确认下单到 ${menu.table.label} 桌？`}
          onClose={closeConfirm}
        >
          <p>
            共 {q?.item_count} 件 · {formatMoney(q?.estimated_total_cents ?? 0)}
          </p>
          {captcha && (
            <>
              <Banner>
                {error instanceof DataError && error.code === "CAPTCHA_FAILED"
                  ? errorMessage(error)
                  : "请先完成人机验证"}
              </Banner>
              <Captcha
                action="place_order"
                key={captchaReset}
                resetKey={captchaReset}
                onToken={(token) => void submit(token)}
                onExpire={() =>
                  setError(
                    new DataError(
                      "CAPTCHA_FAILED",
                      "人机验证没有通过，请再试一次",
                    ),
                  )
                }
              />
            </>
          )}
          <div className="actions">
            <Button variant="secondary" disabled={busy} onClick={closeConfirm}>
              再看看
            </Button>
            <Button
              busy={busy}
              busyText="正在下单…"
              disabled={captcha}
              onClick={() => void submit()}
            >
              确认下单
            </Button>
          </div>
        </Modal>
      )}
      {clear && (
        <ConfirmDialog
          title="清空购物车？"
          danger
          onClose={closeClear}
          onConfirm={() => {
            update([]);
            closeClear();
          }}
        />
      )}
      {remove !== undefined && (
        <ConfirmDialog
          title="把这道菜移出购物车？"
          danger
          onClose={closeRemove}
          onConfirm={() => {
            update(cart.filter((_, i) => i !== remove));
            closeRemove();
          }}
        />
      )}
    </>
  );
}
export function OrdersPage({ code }: { code: string }) {
  const [value, setValue] = useState<TableBill>();
  const [error, setError] = useState<unknown>();
  const [warning, setWarning] = useState(false);
  const [gone, setGone] = useState<BillGoneReason>();
  const [toast, setToast] = useState("");
  const [revision, setRevision] = useState(0);
  const seconds = useCountdown(error);
  useEffect(() => {
    if (sessionStorage.getItem("ro-order-success")) {
      void Promise.resolve().then(() => setToast("已下单，请等候店员确认"));
      sessionStorage.removeItem("ro-order-success");
      const timer = setTimeout(() => setToast(""), 3500);
      return () => clearTimeout(timer);
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let last: TableBill | undefined;
    async function refresh() {
      if (stopped || disposed || running || document.hidden) return;
      running = true;
      try {
        const next = await getTableBill(code);
        if (disposed) return;
        last = next;
        setValue(next);
        setError(undefined);
        setWarning(false);
        if (next.poll_after_ms && !document.hidden)
          timer = setTimeout(() => void refresh(), next.poll_after_ms);
      } catch (e) {
        if (disposed) return;
        if (e instanceof DataError && e.status === 410) {
          stopped = true;
          setGone(e.details.reason as BillGoneReason);
        } else if (e instanceof DataError && e.code === "BILL_TOKEN_INVALID") {
          setValue({
            view: "table",
            table_in_use: true,
            bill: null,
            orders: [],
            poll_after_ms: null,
          });
        } else if (
          e instanceof DataError &&
          ["TABLE_INVALID", "STORE_SUSPENDED"].includes(e.code)
        ) {
          stopped = true;
          setError(e);
        } else {
          if (last) setWarning(true);
          else setError(e);
          if (!document.hidden)
            timer = setTimeout(
              () => void refresh(),
              e instanceof DataError && e.code === "RATE_LIMITED"
                ? e.retryAfterSeconds * 1000
                : 10000,
            );
        }
      } finally {
        running = false;
      }
    }
    function visibility() {
      clearTimeout(timer);
      if (!document.hidden) void refresh();
    }
    function changed() {
      clearTimeout(timer);
      if (!stopped) void refresh();
    }
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("ro-mock:change", changed);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("ro-mock:change", changed);
    };
  }, [code, revision]);
  if (gone)
    return (
      <FullPageMessage
        action={
          gone === "qr_rotated" ? undefined : (
            <Link className="button primary" href={routes.menu(code)}>
              {gone === "bill_paid" ? "重新扫码再点一单" : "回到菜单"}
            </Link>
          )
        }
      >
        {goneMessages[gone]}
      </FullPageMessage>
    );
  if (
    error instanceof DataError &&
    ["TABLE_INVALID", "STORE_SUSPENDED"].includes(error.code)
  )
    return <Fatal error={error} />;
  if (!value)
    return error ? (
      <ErrorState
        message={
          seconds ? `操作太频繁，请 ${seconds} 秒后再试` : errorMessage(error)
        }
        retry={() => {
          if (!seconds) setRevision((n) => n + 1);
        }}
      />
    ) : (
      <main className="content narrow">
        <Skeleton />
      </main>
    );
  if (value.view === "table")
    return (
      <main className="content narrow">
        <EmptyState
          action={
            <Link className="button primary" href={routes.menu(code)}>
              去点餐
            </Link>
          }
        >
          这台手机在这桌还没有订单
          {value.table_in_use && (
            <small style={{ display: "block" }}>
              同桌其他人下的单不会显示在这里
            </small>
          )}
        </EmptyState>
      </main>
    );
  const latest = value.orders.find((o) => o.status !== "cancelled");
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <h1>{value.store.name}</h1>
            <small>我的订单</small>
          </div>
          <span className="table-chip">{value.table.label} 桌</span>
        </div>
      </header>
      <main className="content narrow">
        {!value.store.is_accepting_orders && <Banner>暂停接单</Banner>}
        {warning && (
          <p className="muted" role="status">
            暂时无法更新状态，正在重试
          </p>
        )}
        <small>这里只显示这台手机下的订单</small>
        <h2 className="status-heading">
          {latest
            ? {
                new: "等候店员确认",
                accepted: "店员已接单，正在准备",
                served: "菜已上齐",
                cancelled: "",
              }[latest.status]
            : "订单已取消"}
        </h2>
        {value.orders.map((order) => (
          <article className="card" key={order.id}>
            <div className="order-title">
              <h3>第 {order.seq_in_bill} 单</h3>
              <OrderStatusLabel status={order.status} />
            </div>
            <small>{formatTime(order.created_at)}</small>
            {order.lines.map((line, i) => (
              <div className="order-line" key={i}>
                <div>
                  {line.quantity} × {line.item_name}
                  {line.note && <p className="muted">备注：{line.note}</p>}
                </div>
                <Money cents={line.line_total_cents} />
              </div>
            ))}
            {order.status === "cancelled" && (
              <p>
                已取消：
                {order.cancel_reason
                  ? cancelLabels[order.cancel_reason]
                  : "其他"}
              </p>
            )}
            <div
              className={`price-row ${order.status === "cancelled" ? "cancelled-amount" : ""}`}
            >
              <span>该单金额</span>
              <Money cents={order.subtotal_cents} />
            </div>
          </article>
        ))}
        <section className="card">
          <h2>我的订单金额（预估）</h2>
          <AmountDetails amounts={value.bill} />
          <p className="muted">整桌金额以店员结账为准，请到柜台付款</p>
        </section>
      </main>
      <div className="bottom-bar">
        <div className="bottom-inner">
          <Link className="button primary" href={routes.menu(code)}>
            继续加点
          </Link>
        </div>
      </div>
      <Toast>{toast}</Toast>
    </>
  );
}
