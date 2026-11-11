"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { CancelReason, LiveOrder, OrderStatus } from "../data";
import { malaysiaDay } from "../data/live-rules";
import { cancelLabels, formatTime, orderLabels } from "../format";
import { routes } from "../routes";
import {
  Button,
  ConfirmDialog,
  Money,
  OrderStatusLabel,
  Skeleton,
  TextField,
} from "./common";
import { useReception } from "./live-provider";
const columns = ["new", "accepted", "served"] as const;
export function LiveBoard() {
  const live = useReception();
  const [tab, setTab] = useState<OrderStatus>("new");
  const [now, setNow] = useState(0);
  const [cancel, setCancel] = useState<LiveOrder | null>(null);
  const [reason, setReason] = useState<CancelReason | "">("");
  const [note, setNote] = useState("");
  const close = useCallback(() => setCancel(null), []);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 60000);
    return () => clearInterval(timer);
  }, []);
  const { start, end } = malaysiaDay(now || undefined);
  const group = (status: OrderStatus) =>
    live.orders
      .filter(
        (o) =>
          o.status === status &&
          (status !== "served" ||
            (o.served_at &&
              Date.parse(o.served_at) >= start &&
              Date.parse(o.served_at) < end)),
      )
      .sort((a, b) =>
        status === "served"
          ? b.served_at!.localeCompare(a.served_at!)
          : a.created_at.localeCompare(b.created_at),
      );
  const readonly = live.store?.status === "suspended";
  return (
    <main className="live-page">
      <header className="live-topbar">
        <h1>{live.store?.name ?? "接单画面"}</h1>
        <Button
          variant="secondary"
          role="switch"
          aria-checked={live.store?.is_accepting_orders ?? false}
          disabled={!live.store || readonly || live.switchBusy}
          onClick={live.toggleAccepting}
        >
          {live.store?.is_accepting_orders ? "接单中" : "暂停接单"}
        </Button>
        <span
          className={
            live.connection === "connected" ? "connection-ok" : "error-text"
          }
        >
          {live.connection === "connected"
            ? "已连接"
            : live.connection === "reconnecting"
              ? "重连中"
              : "已断线"}
        </span>
        <span>提示音：{live.sound ? "已开启" : "已暂停"}</span>
        <Button
          variant="secondary"
          onClick={live.testSound}
          disabled={!live.started}
        >
          试听
        </Button>
        <span>亮屏：{live.wake ? "已开启" : "不支持"}</span>
        <Link href={routes.store}>后台导航</Link>
      </header>
      {!live.started && (
        <div
          className="live-start"
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-title"
        >
          <section className="card">
            <h2 id="start-title">点一下开始接单，开启提示音和保持亮屏</h2>
            <Button large onClick={live.start}>
              开始接单
            </Button>
            <p className="muted">请确认手机没有静音、音量已调高</p>
          </section>
        </div>
      )}
      {live.loading && (
        <>
          <p role="status">正在加载订单…</p>
          <Skeleton />
        </>
      )}
      {live.started && !live.loading && (
        <>
          <div className="live-tabs" role="tablist" aria-label="订单状态">
            {columns.map((status) => (
              <Button
                key={status}
                role="tab"
                aria-selected={tab === status}
                variant={tab === status ? "primary" : "secondary"}
                onClick={() => setTab(status)}
              >
                {orderLabels[status]}（{group(status).length}）
              </Button>
            ))}
          </div>
          <div className="live-columns">
            {columns.map((status) => (
              <section
                key={status}
                className={`live-column ${tab === status ? "selected" : ""}`}
                aria-label={orderLabels[status]}
              >
                <h2>
                  {orderLabels[status]}
                  {status === "served" && " · 今日"}{" "}
                  <span className="live-count">{group(status).length}</span>
                </h2>
                {group(status).length === 0 && (
                  <p className="muted">
                    {status === "new"
                      ? "暂时没有新订单，有新订单时会响提示音"
                      : "暂无订单"}
                  </p>
                )}
                {group(status).map((order) => (
                  <article
                    className={`card live-order ${status === "new" ? "live-new" : ""}`}
                    key={order.id}
                  >
                    <div className="order-title">
                      <h3>{order.dining_tables.label}</h3>
                      <OrderStatusLabel status={order.status} />
                    </div>
                    <p>
                      第 {order.seq_in_bill} 单 · 设备 #
                      {order.device_seq_in_bill}
                    </p>
                    <p className="muted">
                      {formatTime(order.created_at)} · 已过{" "}
                      {Math.max(
                        0,
                        Math.floor(
                          (now - Date.parse(order.created_at)) / 60000,
                        ),
                      )}{" "}
                      分钟
                    </p>
                    <ul>
                      {order.order_items.map((line, i) => (
                        <li key={i}>
                          <strong>
                            {line.quantity} × {line.item_name}
                          </strong>
                          {line.note && (
                            <p className="live-note">备注：{line.note}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p>
                      该单小计 <Money cents={order.subtotal_cents} />
                    </p>
                    {!readonly && status !== "served" && (
                      <div className="live-actions">
                        <Button
                          large
                          busy={live.busy.includes(order.id)}
                          onClick={() =>
                            void live.change(order, {
                              to: status === "new" ? "accepted" : "served",
                              expected: order.status,
                            })
                          }
                        >
                          {status === "new" ? "接单" : "已上菜"}
                        </Button>
                        <Button
                          large
                          variant="secondary"
                          disabled={live.busy.includes(order.id)}
                          onClick={() => {
                            setCancel(order);
                            setReason("");
                            setNote("");
                          }}
                        >
                          取消订单
                        </Button>
                      </div>
                    )}
                  </article>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
      {cancel && (
        <ConfirmDialog
          title="取消订单"
          danger
          confirmText="确认取消订单"
          disabled={!reason || readonly}
          busy={live.busy.includes(cancel.id)}
          onClose={close}
          onConfirm={() => {
            if (reason)
              void live
                .change(cancel, {
                  to: "cancelled",
                  expected: cancel.status,
                  cancel_reason: reason,
                  cancel_note: note,
                })
                .then((success) => {
                  if (success) close();
                });
          }}
        >
          <p>
            {cancel.dining_tables.label} 桌第 {cancel.seq_in_bill} 单
          </p>
          <fieldset className="live-reasons">
            <legend>请选择取消原因（必选）</legend>
            {Object.entries(cancelLabels).map(([key, label]) => (
              <label key={key}>
                <input
                  type="radio"
                  name="cancel-reason"
                  value={key}
                  checked={reason === key}
                  onChange={() => setReason(key as CancelReason)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {reason === "other" && (
            <TextField
              label="取消说明（选填）"
              value={note}
              onChange={setNote}
              maxLength={200}
              multiline
            />
          )}
        </ConfirmDialog>
      )}
    </main>
  );
}
