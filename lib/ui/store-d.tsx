"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DataError,
  listStoreBills,
  getStoreBill,
  markBillPaid,
  listStoreTables,
  createStoreTable,
  renameStoreTable,
  softDeleteStoreTable,
  rotateStoreTableQr,
  getStoreTableQrLinks,
  getStoreProfile,
  saveStoreProfile,
  getStoreHistory,
  getSession,
  type Store,
  type StoreBillDetail,
  type DiningTable,
  type StoreProfilePatch,
  type LiveOrder,
} from "../data";
import { formatMoney, formatTime } from "../format";
import {
  Button,
  Banner,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  Modal,
  TextField,
  Toggle,
  AmountDetails,
  FoodImage,
  OrderStatusLabel,
} from "./common";
import { useUnsavedChanges } from "./unsaved-c";
export function storePageMessage(error: unknown) {
  if (!(error instanceof DataError)) return "操作没有成功，请稍后再试";
  const text: Record<string, string> = {
    NETWORK: "网络出错，请检查网络后重试",
    UNAUTHENTICATED: "登录已过期，请重新登录",
    FORBIDDEN: "没有店铺操作权限",
    STORE_SUSPENDED: "店铺已被平台停用，请联系平台",
    NOT_FOUND: "记录不存在，请刷新后重试",
    NOT_IMPLEMENTED: "未实现",
    TABLE_LABEL_TAKEN: "这个桌号已存在",
    TABLE_HAS_OPEN_BILL: "这桌还有未结账单，请先结账",
    BILL_ALREADY_PAID: "这张账单已结账，请刷新列表",
    BILL_TOTAL_CHANGED: "账单金额已变化，请重新核对后结账",
  };
  return error.code === "RATE_LIMITED"
    ? `操作太频繁，请 ${error.retryAfterSeconds} 秒后再试`
    : (text[error.code] ?? error.message);
}
function useStoreResource<T>(fetcher: () => Promise<T>) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [suspended, setSuspended] = useState(false);
  const serial = useRef(0);
  const load = useCallback(() => {
    const id = ++serial.current;
    setLoading(true);
    void Promise.all([fetcher(), getSession()])
      .then(([v, s]) => {
        if (id !== serial.current) return;
        setValue(v);
        setSuspended(s?.store?.status === "suspended");
        setError(undefined);
      })
      .catch((e) => {
        if (id === serial.current) setError(e);
      })
      .finally(() => {
        if (id === serial.current) setLoading(false);
      });
  }, [fetcher]);
  useEffect(() => {
    const version = serial;
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) load();
    });
    window.addEventListener("ro-mock:change", load);
    window.addEventListener("storage", load);
    return () => {
      disposed = true;
      version.current++;
      window.removeEventListener("ro-mock:change", load);
      window.removeEventListener("storage", load);
    };
  }, [load]);
  return { value, error, loading, suspended, load };
}
function OrderCardD({ order }: { order: LiveOrder }) {
  return (
    <article className="card d-order">
      <div className="d-row">
        <strong>
          {order.dining_tables.label} 桌 · 第 {order.seq_in_bill} 单 · 设备 #
          {order.device_seq_in_bill}
        </strong>
        <OrderStatusLabel status={order.status} />
      </div>
      <p className="muted">{formatTime(order.created_at)}（马来西亚时间）</p>
      {order.order_items.map((l, i) => (
        <div key={i}>
          <p>
            {l.item_name} × {l.quantity}{" "}
            <span>{formatMoney(l.line_total_cents)}</span>
          </p>
          {l.note && <p className="muted">备注：{l.note}</p>}
        </div>
      ))}
      <p>小计 {formatMoney(order.subtotal_cents)}</p>
      {order.cancel_reason && (
        <p>
          取消原因：
          {
            {
              sold_out: "菜品售完",
              customer_request: "客人要求取消",
              duplicate: "重复下单",
              other: "其他",
            }[order.cancel_reason]
          }
        </p>
      )}
      {order.cancel_note && <p>店员说明：{order.cancel_note}</p>}
    </article>
  );
}
export function BillsPageD() {
  const [status, setStatus] = useState<"open" | "paid">("open"),
    [page, setPage] = useState(1);
  const [tableId, setTableId] = useState("");
  const [paidDate, setPaidDate] = useState("");
  const tables = useStoreResource(listStoreTables);
  const fetcher = useCallback(
    () =>
      listStoreBills(status, page, {
        table_id: tableId || undefined,
        paid_date: status === "paid" ? paidDate || undefined : undefined,
      }),
    [status, page, tableId, paidDate],
  );
  const r = useStoreResource(fetcher);
  const [detail, setDetail] = useState<StoreBillDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const selection = useRef(0);
  const close = useCallback(() => {
    if (!busy) {
      selection.current++;
      setDetail(undefined);
      setDetailLoading(false);
      setConfirm(false);
    }
  }, [busy]);
  const closeConfirm = useCallback(() => {
    if (!busy) setConfirm(false);
  }, [busy]);
  async function open(id: string) {
    const n = ++selection.current;
    setDetailLoading(true);
    setError(undefined);
    try {
      const v = await getStoreBill(id);
      if (selection.current === n) setDetail(v);
    } catch (e) {
      setError(e);
    } finally {
      if (selection.current === n) setDetailLoading(false);
    }
  }
  async function pay() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      await markBillPaid(detail.id, detail.total_cents);
      setConfirm(false);
      setDetail(undefined);
      setNotice("已结账，顾客令牌已失效");
      r.load();
    } catch (e) {
      setError(e);
      setConfirm(false);
      if (e instanceof DataError && String(e.code) === "BILL_TOTAL_CHANGED") {
        try {
          setDetail(await getStoreBill(detail.id));
        } catch (next) {
          setError(next);
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="d-page">
      <h1>账单</h1>
      <div className="actions">
        {(["open", "paid"] as const).map((s) => (
          <Button
            key={s}
            variant={status === s ? "primary" : "secondary"}
            onClick={() => {
              setStatus(s);
              setPage(1);
              setDetail(undefined);
            }}
          >
            {s === "open" ? "未结账" : "已结账"}
          </Button>
        ))}
      </div>
      <div className="actions">
        <label>
          桌号
          <select
            value={tableId}
            onChange={(e) => {
              setTableId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部桌号</option>
            {tables.value?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {status === "paid" && (
          <label>
            付款日期（马来西亚时间）
            <input
              type="date"
              value={paidDate}
              onChange={(e) => {
                setPaidDate(e.target.value);
                setPage(1);
              }}
            />
          </label>
        )}
      </div>
      {notice && <Banner tone="green">{notice}</Banner>}
      {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
      {r.error ? (
        <ErrorState message={storePageMessage(r.error)} retry={r.load} />
      ) : r.loading ? (
        <Skeleton />
      ) : (
        r.value && (
          <>
            {!r.value.bills.length ? (
              <EmptyState>
                目前没有{status === "open" ? "未结账" : "已结账"}账单
              </EmptyState>
            ) : (
              <div className="d-grid">
                {r.value.bills.map((b) => (
                  <article className="card" key={b.id}>
                    <h2>{b.table_label} 桌</h2>
                    <p>{formatTime(b.paid_at ?? b.opened_at)}</p>
                    <p>
                      {status === "open" ? "应收（预估）" : "实收"}{" "}
                      {formatMoney(b.total_cents)}
                    </p>
                    <Button variant="secondary" onClick={() => void open(b.id)}>
                      查看详情
                    </Button>
                  </article>
                ))}
              </div>
            )}
            <div className="actions">
              <Button
                variant="secondary"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>
              <span>
                第 {page} 页 · 共 {r.value.total} 条 · 每页 20 条
              </span>
              <Button
                variant="secondary"
                disabled={page * 20 >= r.value.total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </>
        )
      )}
      {detailLoading && (
        <Modal title="账单详情" onClose={close}>
          <Skeleton />
        </Modal>
      )}
      {detail && !detailLoading && !confirm && (
        <Modal title={`${detail.table_label} 桌 · 账单详情`} onClose={close}>
          {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
          <p>
            {detail.status === "paid" ? "已结账" : "未结账 · 以确认时金额为准"}
          </p>
          <AmountDetails amounts={detail} />
          {detail.orders.map((o) => (
            <OrderCardD key={o.id} order={o} />
          ))}
          {detail.status === "open" && !r.suspended && (
            <Button onClick={() => setConfirm(true)}>
              结账 {formatMoney(detail.total_cents)}
            </Button>
          )}
        </Modal>
      )}
      {detail && confirm && (
        <ConfirmDialog
          title="确认已收款并结账？"
          confirmText="确认结账"
          busy={busy}
          onClose={closeConfirm}
          onConfirm={() => void pay()}
        >
          <p>
            应收 {formatMoney(detail.total_cents)}
            。确认后清台，所有顾客账单令牌失效。
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}
export function TablesPageD() {
  const r = useStoreResource(listStoreTables);
  const [edit, setEdit] = useState<{ id?: string; label: string }>();
  const [pending, setPending] = useState<{
    kind: "delete" | "rotate";
    table: DiningTable;
  }>();
  const [links, setLinks] =
    useState<Awaited<ReturnType<typeof getStoreTableQrLinks>>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const closeEdit = useCallback(() => {
    if (!busy) setEdit(undefined);
  }, [busy]);
  const closeConfirm = useCallback(() => {
    if (!busy) setPending(undefined);
  }, [busy]);
  const closeLinks = useCallback(() => setLinks(undefined), []);
  async function mutate(fn: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setEdit(undefined);
      setPending(undefined);
      setLinks(undefined);
      setNotice(success);
      r.load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function qr(ids: string[]) {
    setBusy(true);
    setError(undefined);
    try {
      setLinks(await getStoreTableQrLinks(ids));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="d-page">
      <h1>桌号和二维码</h1>
      <p>重置桌码后旧二维码和该桌顾客令牌失效，请及时更换桌贴。</p>
      {notice && <Banner tone="green">{notice}</Banner>}
      {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
      <div className="actions">
        {!r.suspended && (
          <Button
            onClick={() => {
              setError(undefined);
              setEdit({ label: "" });
            }}
          >
            新增桌号
          </Button>
        )}
        <Button
          variant="secondary"
          busy={busy}
          disabled={!selected.length}
          onClick={() => void qr(selected)}
        >
          查看 / 打印所选桌码
        </Button>
      </div>
      {r.error ? (
        <ErrorState message={storePageMessage(r.error)} retry={r.load} />
      ) : r.loading ? (
        <Skeleton />
      ) : !r.value?.length ? (
        <EmptyState>还没有桌号，先新增一个桌号</EmptyState>
      ) : (
        <div className="d-grid">
          {r.value.map((t) => (
            <article className="card" key={t.id}>
              <label className="d-row">
                <input
                  type="checkbox"
                  checked={selected.includes(t.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, t.id]
                        : selected.filter((id) => id !== t.id),
                    )
                  }
                />
                <strong>{t.label} 桌</strong>
              </label>
              <p>
                {t.is_active ? "启用" : "停用"} · 桌码版本 {t.qr_version}
              </p>
              <div className="actions">
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() => void qr([t.id])}
                >
                  查看桌码
                </Button>
                {!r.suspended && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setError(undefined);
                        setEdit({ id: t.id, label: t.label });
                      }}
                    >
                      改名
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setPending({ kind: "rotate", table: t })}
                    >
                      重置桌码
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => setPending({ kind: "delete", table: t })}
                    >
                      删除
                    </Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {edit && (
        <Modal title={edit.id ? "修改桌号" : "新增桌号"} onClose={closeEdit}>
          {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mutate(
                () =>
                  edit.id
                    ? renameStoreTable(edit.id, edit.label)
                    : createStoreTable(edit.label),
                "桌号已保存",
              );
            }}
          >
            <TextField
              label="桌号"
              value={edit.label}
              maxLength={20}
              onChange={(label) => setEdit({ ...edit, label })}
            />
            <Button type="submit" busy={busy} disabled={!edit.label.trim()}>
              保存
            </Button>
          </form>
        </Modal>
      )}
      {pending && (
        <ConfirmDialog
          title={
            pending.kind === "delete"
              ? `删除 ${pending.table.label} 桌？`
              : `重置 ${pending.table.label} 桌的二维码？`
          }
          danger
          busy={busy}
          onClose={closeConfirm}
          onConfirm={() =>
            void mutate(
              () =>
                pending.kind === "delete"
                  ? softDeleteStoreTable(pending.table.id)
                  : rotateStoreTableQr(pending.table.id),
              pending.kind === "delete"
                ? "桌号已删除"
                : "桌码已重置，请更换桌贴",
            )
          }
        >
          <p>
            {pending.kind === "delete"
              ? "删除后二维码失效，历史账单保留。有未结账单时不能删除。"
              : "旧二维码将立即失效，该桌所有顾客需重新扫码。此操作不会结账。"}
          </p>
          {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
        </ConfirmDialog>
      )}
      {links && (
        <Modal title="桌号二维码" onClose={closeLinks}>
          <div className="d-print">
            <p>当前版本未安装二维码生成库，请复制链接；占位不可扫码。</p>
            <div className="d-print-grid">
              {links.map((l) => (
                <article key={l.table_id} className="card d-qr">
                  <h2>{l.label} 桌</h2>
                  <div className="d-qr-placeholder">
                    二维码占位
                    <br />
                    不可扫码
                  </div>
                  <a href={l.url}>{l.url}</a>
                </article>
              ))}
            </div>
          </div>
          <Button onClick={() => window.print()}>
            打印 / 保存为 PDF（A4 每页 4 个）
          </Button>
        </Modal>
      )}
    </main>
  );
}
const patchOf = (s: Store): StoreProfilePatch => ({
  name: s.name,
  logo_path: s.logo_path,
  address: s.address,
  opening_hours: s.opening_hours,
  is_accepting_orders: s.is_accepting_orders,
  service_charge_bp: s.service_charge_bp,
  sst_bp: s.sst_bp,
});
export function SettingsPageD() {
  const r = useStoreResource(getStoreProfile);
  const [draft, setDraft] = useState<StoreProfilePatch>();
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const storeId = useRef("");
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  const unsaved = useUnsavedChanges(dirty);
  useEffect(() => {
    if (r.value && (!draft || storeId.current !== r.value.id)) {
      storeId.current = r.value.id;
      const p = patchOf(r.value);
      void Promise.resolve().then(() => {
        setDraft(p);
        setSaved(JSON.stringify(p));
      });
    }
  }, [r.value, draft]);
  function change(p: StoreProfilePatch) {
    setDraft({ ...draft, ...p });
    setNotice("");
  }
  async function save() {
    if (busy || !draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await saveStoreProfile(draft);
      const p = patchOf(result);
      setDraft(p);
      setSaved(JSON.stringify(p));
      setNotice("店铺设置已保存");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const field =
    error instanceof DataError && error.code === "VALIDATION_FAILED"
      ? String(error.details.field)
      : "";
  return (
    <main className="d-page">
      <h1>店铺设置</h1>
      {notice && <Banner tone="green">{notice}</Banner>}
      {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
      {r.error ? (
        <ErrorState message={storePageMessage(r.error)} retry={r.load} />
      ) : !draft ? (
        <Skeleton />
      ) : (
        <form
          className="card d-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy || r.suspended}>
            <TextField
              label="店名"
              maxLength={50}
              value={draft.name ?? ""}
              onChange={(name) => change({ name })}
              error={field === "name" ? storePageMessage(error) : undefined}
            />
            <div className="logo">
              <FoodImage key={draft.logo_path} path={draft.logo_path ?? null} />
            </div>
            <TextField
              label="店铺图片路径（假数据 /mock/，留空用占位图）"
              maxLength={300}
              value={draft.logo_path ?? ""}
              onChange={(logo_path) => change({ logo_path: logo_path || null })}
              error={
                field === "logo_path" ? storePageMessage(error) : undefined
              }
            />
            <TextField
              label="地址"
              maxLength={200}
              value={draft.address ?? ""}
              error={field === "address" ? storePageMessage(error) : undefined}
              onChange={(address) => change({ address })}
            />
            <TextField
              label="营业时间"
              maxLength={200}
              value={draft.opening_hours ?? ""}
              error={
                field === "opening_hours" ? storePageMessage(error) : undefined
              }
              onChange={(opening_hours) => change({ opening_hours })}
            />
            <p className="muted">地址和营业时间都填写后，店铺资料即为完整。</p>
            <Toggle
              checked={draft.is_accepting_orders ?? false}
              onChange={(is_accepting_orders) =>
                change({ is_accepting_orders })
              }
            >
              营业中（接受新订单）
            </Toggle>
            {(
              [
                ["service_charge_bp", "服务费（0–2000 基点）"],
                ["sst_bp", "SST（0–1000 基点）"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={0}
                  max={key === "service_charge_bp" ? 2000 : 1000}
                  step={1}
                  required
                  value={Number.isNaN(draft[key]) ? "" : draft[key]}
                  onChange={(e) =>
                    change({
                      [key]:
                        e.target.value === "" ? NaN : Number(e.target.value),
                    })
                  }
                />
                {field === key && (
                  <span role="alert">{storePageMessage(error)}</span>
                )}
              </label>
            ))}
            <p className="muted">
              100 基点 = 1%。SST
              对小计加服务费计收。费率变更会影响未结账单，已结账金额保持不变。
            </p>
            <Button
              type="submit"
              busy={busy}
              disabled={!dirty || !draft.name?.trim()}
            >
              保存设置
            </Button>
          </fieldset>
        </form>
      )}
      {unsaved.dialog}
    </main>
  );
}
export function HistoryPageD() {
  const [date, setDate] = useState(() =>
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  );
  const fetcher = useCallback(() => getStoreHistory(date), [date]);
  const r = useStoreResource(fetcher);
  return (
    <main className="d-page">
      <h1>订单记录</h1>
      <label>
        日期（马来西亚时间）
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <Button variant="secondary" onClick={r.load}>
        刷新
      </Button>
      {r.error ? (
        <ErrorState message={storePageMessage(r.error)} retry={r.load} />
      ) : r.loading ? (
        <Skeleton />
      ) : (
        r.value && (
          <>
            <div className="d-grid d-stats">
              <article className="card">
                <h2>当日营业额</h2>
                <strong>{formatMoney(r.value.stats.revenue_cents)}</strong>
                <p>
                  按结账时间统计 · {r.value.stats.paid_bills.count} 张已结账单
                </p>
              </article>
              <article className="card">
                <h2>当前未付金额</h2>
                <strong>
                  {formatMoney(r.value.stats.open_bills.total_cents)}
                </strong>
                <p>
                  {r.value.stats.open_bills.count} 张未结账单 ·
                  实时金额，不受所选日期影响
                </p>
              </article>
              <article className="card">
                <h2>当日订单</h2>
                <strong>{r.value.stats.orders.count} 单</strong>
                <p>
                  已取消 {r.value.stats.orders.cancelled_count}{" "}
                  单（不计入订单数）
                </p>
              </article>
            </div>
            {!r.value.orders.length ? (
              <EmptyState>这一天没有订单记录</EmptyState>
            ) : (
              r.value.orders.map((o) => <OrderCardD key={o.id} order={o} />)
            )}
          </>
        )
      )}
    </main>
  );
}
