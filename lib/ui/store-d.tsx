"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DataError,
  setStoreTableActive,
  signOut,
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
  onSessionChange,
  type Store,
  type StoreBillDetail,
  type DiningTable,
  type StoreProfilePatch,
  type LiveOrder,
} from "../data";
import { BillDetailD } from "./detail-d";
import { QrCardD, QrPrintD, TableDownloadD } from "./qr-d";
import {
  percentToBp,
  bpToPercent,
  pauseMessage,
  needsClosingConfirmation,
  disableTableMessage,
  resetTableMessage,
  resetTableNotice,
  unservedCount,
  unservedMessage,
  paymentFailure,
  malaysiaToday,
  adjacentDay,
  validHistoryDate,
} from "./store-d-helpers";
import { routes } from "../routes";
import { useRouter } from "next/navigation";
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
    NOT_IMPLEMENTED: "此功能即将开放",
    TABLE_LABEL_TAKEN: "这个桌号已存在",
    TABLE_HAS_OPEN_BILL: "这张桌子还有未结账单，结账后才能删除",
    BILL_ALREADY_PAID: "这桌已经结账",
    BILL_TOTAL_CHANGED: "账单金额已变化，请重新核对后结账",
  };
  return error.code === "RATE_LIMITED"
    ? `操作太频繁，请 ${error.retryAfterSeconds} 秒后再试`
    : Object.hasOwn(text, error.code)
      ? text[error.code]
      : "操作没有成功，请稍后再试";
}
function useStoreResource<T>(fetcher: () => Promise<T>) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [suspended, setSuspended] = useState(false);
  const serial = useRef(0);
  const accessVersion = useRef(0);
  const accessKey = useRef("");
  const load = useCallback(() => {
    const id = ++serial.current;
    setLoading(true);
    void Promise.all([fetcher(), getSession()])
      .then(([v, s]) => {
        if (id !== serial.current) return;
        accessKey.current = JSON.stringify([
          s?.user_id,
          s?.store?.id,
          s?.store?.status,
        ]);
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
    const version = accessVersion;
    let active = true;
    const unsubscribe = onSessionChange((s) => {
      if (!active) return;
      const key = JSON.stringify([s?.user_id, s?.store?.id, s?.store?.status]);
      if (accessKey.current === "") {
        accessKey.current = key;
        setSuspended(s?.store?.status === "suspended");
      } else if (key !== accessKey.current) {
        accessKey.current = key;
        accessVersion.current++;
        load();
        setSuspended(s?.store?.status === "suspended");
      }
    });
    return () => {
      active = false;
      version.current++;
      unsubscribe();
    };
  }, [load]);
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
  return { value, error, loading, suspended, load, accessVersion };
}
function OrderCardD({ order }: { order: LiveOrder }) {
  return (
    <article
      className={`card d-order${order.status === "cancelled" ? " d-cancelled" : ""}`}
    >
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
            <span className="d-order-money">
              {formatMoney(l.line_total_cents)}
            </span>
          </p>
          {l.note && <p className="muted">备注：{l.note}</p>}
        </div>
      ))}
      <p className="d-order-money">小计 {formatMoney(order.subtotal_cents)}</p>
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
  const [paidDate, setPaidDate] = useState(malaysiaToday);
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
    const access = r.accessVersion.current;
    setDetailLoading(true);
    setNotice("");
    setDetail(undefined);
    setError(undefined);
    try {
      const v = await getStoreBill(id);
      if (selection.current === n && access === r.accessVersion.current)
        setDetail(v);
    } catch (e) {
      if (selection.current === n && access === r.accessVersion.current)
        setError(e);
    } finally {
      if (selection.current === n) setDetailLoading(false);
    }
  }
  async function pay() {
    if (!detail || busy || r.suspended) return;
    const access = r.accessVersion.current;
    setBusy(true);
    try {
      await markBillPaid(detail.id, detail.total_cents);
      if (access !== r.accessVersion.current) return;
      setConfirm(false);
      setDetail(undefined);
      setNotice("已标记付款，这桌已清桌");
      r.load();
    } catch (e) {
      if (access !== r.accessVersion.current) return;
      const failure = paymentFailure(e);
      setNotice(failure.message);
      setError(undefined);
      if (failure.close) {
        setConfirm(false);
        setDetail(undefined);
        selection.current++;
        r.load();
      } else if (
        e instanceof DataError &&
        String(e.code) === "BILL_TOTAL_CHANGED"
      ) {
        try {
          const refreshed = await getStoreBill(detail.id);
          if (access !== r.accessVersion.current) return;
          setDetail(refreshed);
          setNotice(
            `这桌金额已变化，新的总计是 ${formatMoney(refreshed.total_cents)}，请再确认`,
          );
          setConfirm(true);
        } catch {
          if (access !== r.accessVersion.current) return;
          setNotice("");
          setError(new Error("refresh failed"));
          setConfirm(false);
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="d-page d-bills">
      <h1>账单</h1>
      <div className="actions">
        {(["open", "paid"] as const).map((s) => (
          <Button
            key={s}
            variant={status === s ? "primary" : "secondary"}
            onClick={() => {
              selection.current++;
              setError(undefined);
              setConfirm(false);
              setStatus(s);
              setPage(1);
              setDetail(undefined);
            }}
          >
            {s === "open" ? "未付款" : "今天已付款"}
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
      {notice && (
        <Banner tone={notice === "这桌已经结账" ? "yellow" : "green"}>
          {notice}
        </Banner>
      )}
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
                {status === "open"
                  ? "目前没有待付款的桌子"
                  : "今天还没有已付款账单"}
              </EmptyState>
            ) : (
              <div className="d-grid">
                {r.value.bills.map((b) => (
                  <article className="card" key={b.id}>
                    <h2>{b.table_label} 桌</h2>
                    <p>{formatTime(b.paid_at ?? b.opened_at)}</p>
                    <p>
                      {b.order_count !== undefined && `${b.order_count} 单 · `}
                      {b.status === "open" ? "未付款" : "已付款"}
                    </p>
                    {!!b.unserved_count && (
                      <p>还有 {b.unserved_count} 单未上菜</p>
                    )}
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
      {!detail && !detailLoading && (
        <div className="d-bill-placeholder">选择左侧账单查看详情</div>
      )}
      {detailLoading && (
        <BillDetailD title="账单详情" onClose={close}>
          <Skeleton />
        </BillDetailD>
      )}
      {detail && !detailLoading && !confirm && (
        <BillDetailD
          title={`${detail.table_label} 桌 · 账单详情`}
          onClose={close}
        >
          {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
          <p>
            {detail.status === "paid" ? "已结账" : "未结账 · 以确认时金额为准"}
          </p>
          <AmountDetails
            amounts={detail}
            estimated={detail.status === "open"}
          />
          {detail.orders.map((o) => (
            <OrderCardD key={o.id} order={o} />
          ))}
          {detail.status === "open" && !r.suspended && (
            <Button
              onClick={() => {
                setNotice("");
                setConfirm(true);
              }}
            >
              标记已付款并清桌
            </Button>
          )}
        </BillDetailD>
      )}
      {detail && confirm && !r.suspended && (
        <ConfirmDialog
          title={`确认 ${detail.table_label} 桌已付款 ${formatMoney(detail.total_cents)}？`}
          confirmText="确认已付款"
          busy={busy}
          onClose={closeConfirm}
          onConfirm={() => void pay()}
        >
          <p>
            确认 {detail.table_label} 桌已付款 {formatMoney(detail.total_cents)}
            ？标记后账单结清，这桌恢复空桌，下一位客人扫码会开新账单。
          </p>
          {unservedMessage(unservedCount(detail.orders)) && (
            <Banner tone="yellow">
              {unservedMessage(unservedCount(detail.orders))}
            </Banner>
          )}
          {notice && <Banner tone="yellow">{notice}</Banner>}
        </ConfirmDialog>
      )}
    </main>
  );
}
export function TablesPageD() {
  const r = useStoreResource(listStoreTables);
  const profile = useStoreResource(getStoreProfile);
  const [edit, setEdit] = useState<{ id?: string; label: string }>();
  const [pending, setPending] = useState<{
    kind: "delete" | "rotate" | "disable";
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
    if (busy || r.suspended) return;
    const access = r.accessVersion.current;
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      if (access !== r.accessVersion.current) return;
      setEdit(undefined);
      setPending(undefined);
      setNotice(success);
      r.load();
    } catch (e) {
      if (access === r.accessVersion.current) setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function qr(ids: string[]) {
    const access = r.accessVersion.current;
    setBusy(true);
    setError(undefined);
    try {
      const links = await getStoreTableQrLinks(ids);
      if (access === r.accessVersion.current) setLinks(links);
    } catch (e) {
      if (access === r.accessVersion.current) setError(e);
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
            新增桌子
          </Button>
        )}
        <Button
          variant="secondary"
          busy={busy}
          disabled={!selected.length}
          onClick={() => void qr(selected)}
        >
          批量下载二维码
        </Button>
      </div>
      {r.error ? (
        <ErrorState message={storePageMessage(r.error)} retry={r.load} />
      ) : r.loading ? (
        <Skeleton />
      ) : !r.value?.length ? (
        <EmptyState>还没有桌子，新增第一张桌子后就能打印二维码</EmptyState>
      ) : (
        <div className="d-tables">
          <label className="d-row">
            <input
              type="checkbox"
              checked={
                !!r.value.length &&
                r.value.every((t) => selected.includes(t.id))
              }
              onChange={(e) =>
                setSelected(e.target.checked ? r.value!.map((t) => t.id) : [])
              }
            />
            全选
          </label>
          <table className="d-responsive-table">
            <thead>
              <tr>
                <th>选择 / 桌号</th>
                <th>启用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {r.value.map((t) => (
                <tr key={t.id}>
                  <td>
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
                  </td>
                  <td>
                    <Toggle
                      checked={t.is_active}
                      disabled={busy || r.suspended}
                      onChange={(active) =>
                        active
                          ? void mutate(
                              () => setStoreTableActive(t.id, true),
                              "已启用桌子",
                            )
                          : setPending({ kind: "disable", table: t })
                      }
                    >
                      {t.is_active ? "启用" : "停用"}
                    </Toggle>
                  </td>
                  <td>
                    <div className="actions">
                      <Button
                        variant="secondary"
                        busy={busy}
                        onClick={() => void qr([t.id])}
                      >
                        查看二维码
                      </Button>
                      <TableDownloadD id={t.id} onError={setError} />
                      {!r.suspended && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setError(undefined);
                              setEdit({ id: t.id, label: t.label });
                            }}
                          >
                            编辑
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setPending({ kind: "rotate", table: t })
                            }
                          >
                            重置桌码
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() =>
                              setPending({ kind: "delete", table: t })
                            }
                          >
                            删除
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Modal title={edit.id ? "修改桌号" : "新增桌子"} onClose={closeEdit}>
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
            <fieldset disabled={busy || r.suspended}>
              <TextField
                label="桌号"
                value={edit.label}
                maxLength={20}
                onChange={(label) => setEdit({ ...edit, label })}
              />
              {!r.suspended && (
                <Button type="submit" busy={busy} disabled={!edit.label.trim()}>
                  保存
                </Button>
              )}
            </fieldset>
          </form>
        </Modal>
      )}
      {pending && !r.suspended && (
        <ConfirmDialog
          title={
            pending.kind === "delete"
              ? `删除 ${pending.table.label} 桌？`
              : pending.kind === "disable"
                ? `停用 ${pending.table.label} 桌？`
                : `重置 ${pending.table.label} 桌的二维码？`
          }
          danger
          busy={busy}
          onClose={closeConfirm}
          confirmText={pending.kind === "rotate" ? "确认重置" : "确认"}
          backText="取消"
          onConfirm={() => {
            const { kind, table } = pending;
            void mutate(
              async () => {
                if (kind === "delete") await softDeleteStoreTable(table.id);
                else if (kind === "disable")
                  await setStoreTableActive(table.id, false);
                else {
                  const access = r.accessVersion.current;
                  await rotateStoreTableQr(table.id);
                  if (access !== r.accessVersion.current) return;
                  const links = await getStoreTableQrLinks([table.id]);
                  if (access === r.accessVersion.current) setLinks(links);
                }
              },
              kind === "delete"
                ? "桌号已删除"
                : kind === "disable"
                  ? "已停用桌子"
                  : resetTableNotice(table.label),
            );
          }}
        >
          <p>
            {pending.kind === "delete"
              ? "删除后这张桌子的二维码将失效，确定删除？"
              : pending.kind === "disable"
                ? disableTableMessage
                : resetTableMessage(pending.table.label)}
          </p>
          {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
        </ConfirmDialog>
      )}
      {links && (
        <QrPrintD links={links} storeName={profile.value?.name ?? ""} />
      )}
      {links && (
        <Modal title="桌号二维码" onClose={closeLinks}>
          {notice && <Banner tone="green">{notice}</Banner>}
          <div className="d-grid">
            {links.map((l) => (
              <QrCardD
                key={l.table_id}
                link={l}
                storeName={profile.value?.name ?? ""}
                download
              />
            ))}
          </div>
          <Button disabled={!profile.value} onClick={() => window.print()}>
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
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pause, setPause] = useState(false);
  const closePause = useCallback(() => setPause(false), []);
  const [rates, setRates] = useState({ service_charge_bp: "", sst_bp: "" });
  const [rateErrors, setRateErrors] = useState<Record<string, string>>({});
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
        setRates({
          service_charge_bp: bpToPercent(p.service_charge_bp ?? 0),
          sst_bp: bpToPercent(p.sst_bp ?? 0),
        });
        setSaved(JSON.stringify(p));
        if (!r.value?.is_profile_complete)
          requestAnimationFrame(() => {
            const inputs =
              formRef.current?.querySelectorAll<HTMLInputElement>(
                ".field input",
              );
            [inputs?.[0], inputs?.[2], inputs?.[3]]
              .find((input) => input && !input.value.trim())
              ?.focus();
          });
      });
    }
  }, [r.value, draft]);
  function change(p: StoreProfilePatch) {
    setDraft({ ...draft, ...p });
    setNotice("");
  }
  async function save() {
    if (busy || !draft || r.suspended) return;
    const access = r.accessVersion.current;
    const errors: Record<string, string> = {};
    const service = percentToBp(rates.service_charge_bp, 20),
      sst = percentToBp(rates.sst_bp, 10);
    if (service === undefined)
      errors.service_charge_bp = "服务费要在 0–20% 之间";
    if (sst === undefined) errors.sst_bp = "SST 要在 0–10% 之间";
    setRateErrors(errors);
    if (Object.keys(errors).length) return;
    if (!draft.name?.trim()) {
      setError(
        new DataError("VALIDATION_FAILED", "请填写店名", { field: "name" }),
      );
      formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await saveStoreProfile({
        ...draft,
        service_charge_bp: service,
        sst_bp: sst,
      });
      if (access !== r.accessVersion.current) return;
      const p = patchOf(result);
      setDraft(p);
      setSaved(JSON.stringify(p));
      setNotice("已保存");
    } catch (e) {
      if (access === r.accessVersion.current) setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function saveAccepting(is_accepting_orders: boolean) {
    if (busy || r.suspended || !draft) return;
    const access = r.accessVersion.current;
    setBusy(true);
    setError(undefined);
    try {
      await saveStoreProfile({ is_accepting_orders });
      if (access !== r.accessVersion.current) return;
      setDraft((current) => ({ ...current, is_accepting_orders }));
      setSaved((current) =>
        JSON.stringify({ ...JSON.parse(current), is_accepting_orders }),
      );
      setNotice("营业状态已保存");
    } catch (e) {
      if (access === r.accessVersion.current) setError(e);
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
      {r.value && !r.value.is_profile_complete && (
        <Banner tone="yellow">
          先填写店名、地址和营业时间，顾客扫码时会看到店名
        </Banner>
      )}
      {notice && <Banner tone="green">{notice}</Banner>}
      {!!error && <Banner tone="red">{storePageMessage(error)}</Banner>}
      {r.error ? (
        <ErrorState message={storePageMessage(r.error)} retry={r.load} />
      ) : !draft ? (
        <Skeleton />
      ) : (
        <form
          ref={formRef}
          noValidate
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
              onChange={(is_accepting_orders) => {
                if (needsClosingConfirmation(is_accepting_orders))
                  setPause(true);
                else void saveAccepting(is_accepting_orders);
              }}
            >
              接受下单
            </Toggle>
            {(
              [
                ["service_charge_bp", "服务费 %（0–20）"],
                ["sst_bp", "SST %（0–10）"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={0}
                  max={key === "service_charge_bp" ? 20 : 10}
                  step="0.01"
                  required
                  value={rates[key]}
                  onChange={(e) => {
                    setRates({ ...rates, [key]: e.target.value });
                    change({
                      [key]:
                        percentToBp(
                          e.target.value,
                          key === "service_charge_bp" ? 20 : 10,
                        ) ?? NaN,
                    });
                  }}
                />
                {rateErrors[key] && <span role="alert">{rateErrors[key]}</span>}
                {field === key && (
                  <span role="alert">{storePageMessage(error)}</span>
                )}
              </label>
            ))}
            <p className="muted">
              填 0 即不收，顾客和账单上就不显示这一项；SST 按小计加服务费计算
            </p>
            {!r.suspended && (
              <div className="d-settings-save">
                <Button type="submit" busy={busy} disabled={!dirty}>
                  保存
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      )}
      <Button
        variant="secondary"
        onClick={() =>
          unsaved.request(() => {
            void signOut()
              .then(() => router.replace(routes.login))
              .catch(setError);
          })
        }
      >
        退出登录
      </Button>
      {pause && !r.suspended && (
        <ConfirmDialog
          title={pauseMessage}
          backText="取消"
          onClose={closePause}
          onConfirm={() => {
            void saveAccepting(false);
            setPause(false);
          }}
        />
      )}
      {unsaved.dialog}
    </main>
  );
}
export function HistoryPageD() {
  const today = malaysiaToday();
  const [date, setDate] = useState(malaysiaToday);
  const [order, setOrder] = useState<LiveOrder>();
  const closeOrder = useCallback(() => setOrder(undefined), []);
  const fetcher = useCallback(() => getStoreHistory(date), [date]);
  const r = useStoreResource(fetcher);
  return (
    <main className="d-page">
      <h1>订单记录</h1>
      {order && (
        <div className="d-history-drawer">
          <Modal title="订单明细" onClose={closeOrder}>
            <OrderCardD order={order} />
          </Modal>
        </div>
      )}
      <div className="actions">
        <Button
          variant="secondary"
          onClick={() => {
            setDate(adjacentDay(date, -1));
            setOrder(undefined);
          }}
        >
          ← 前一天
        </Button>
        <label>
          日期（马来西亚时间）
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => {
              if (validHistoryDate(e.target.value, today)) {
                setDate(e.target.value);
                setOrder(undefined);
              }
            }}
          />
        </label>
        <Button
          variant="secondary"
          disabled={date >= today}
          onClick={() => {
            setDate(adjacentDay(date, 1));
            setOrder(undefined);
          }}
        >
          后一天 →
        </Button>
        <Button variant="secondary" onClick={r.load}>
          刷新
        </Button>
      </div>
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
                  小计 {formatMoney(r.value.stats.paid_bills.subtotal_cents)} ·
                  服务费{" "}
                  {formatMoney(r.value.stats.paid_bills.service_charge_cents)} ·
                  SST {formatMoney(r.value.stats.paid_bills.sst_cents)}
                </p>
                <p>
                  按结账时间统计 · {r.value.stats.paid_bills.count} 张已结账单
                </p>
              </article>
              <article className="card">
                <h2>未结清金额（实时）</h2>
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
              <EmptyState>这天没有订单</EmptyState>
            ) : (
              <table className="d-responsive-table d-history-list">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>桌号</th>
                    <th>金额</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {r.value.orders.map((o) => (
                    <tr key={o.id}>
                      <td>{formatTime(o.created_at)}</td>
                      <td>{o.dining_tables.label} 桌</td>
                      <td
                        className={o.status === "cancelled" ? "d-strike" : ""}
                      >
                        {formatMoney(o.subtotal_cents)}
                      </td>
                      <td>
                        <OrderStatusLabel status={o.status} />
                      </td>
                      <td>
                        <Button variant="secondary" onClick={() => setOrder(o)}>
                          查看明细
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )
      )}
    </main>
  );
}
