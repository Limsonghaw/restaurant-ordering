"use client";
import { useCallback, useState } from "react";
import type { LiveOrder } from "../data";
import { formatTime } from "../format";
import {
  Button,
  ConfirmDialog,
  Modal,
  Money,
  OrderStatusLabel,
} from "./common";
import { useReception } from "./live-provider";

export function LiveOrderDetail({ order }: { order: LiveOrder }) {
  const live = useReception();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    setConfirm(false);
  }, []);
  const back = useCallback(() => setConfirm(false), []);
  const current = live.orders.find((value) => value.id === order.id) ?? order;
  const canBlock =
    live.started &&
    live.store?.status !== "suspended" &&
    (current.status === "new" || current.status === "accepted");
  const busy = live.busy.includes(order.id);
  return (
    <>
      <Button
        variant="text"
        onClick={() => setOpen(true)}
        aria-label={`${order.dining_tables.label} 桌第 ${order.seq_in_bill} 单详情`}
      >
        查看订单详情
      </Button>
      {open && (
        <Modal
          title={`${current.dining_tables.label} 桌第 ${current.seq_in_bill} 单`}
          onClose={close}
        >
          <OrderStatusLabel status={current.status} />
          <p>
            设备 #{current.device_seq_in_bill} ·{" "}
            {formatTime(current.created_at)}
          </p>
          <ul>
            {current.order_items.map((line, index) => (
              <li key={index}>
                <p>
                  {line.quantity} × {line.item_name} · 单价{" "}
                  <Money cents={line.unit_price_cents} /> · 金额{" "}
                  <Money cents={line.line_total_cents} />
                </p>
                {line.note && <p className="live-note">备注：{line.note}</p>}
              </li>
            ))}
          </ul>
          <p>
            该单小计 <Money cents={current.subtotal_cents} />
          </p>
          {canBlock && (
            <Button
              variant="text"
              className="error-text"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              拒单并拉黑
            </Button>
          )}
        </Modal>
      )}
      {open && confirm && canBlock && (
        <ConfirmDialog
          title="拒单并拉黑这台手机？"
          danger
          confirmText="拒单并拉黑"
          busy={busy}
          onClose={back}
          onConfirm={() => {
            void live.block(current).then((success) => {
              if (success) close();
            });
          }}
        >
          <p>
            这张订单会被取消，这台手机 7
            天内不能在本店下单，可以在「拉黑列表」解除。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
