"use client";
import { useState, useEffect, useCallback } from "react";
import {
  listBlockedClients,
  unblockClient,
  getSession,
  onSessionChange,
  type BlockedClientRow,
} from "../data";
import { Button, ConfirmDialog, Skeleton, ErrorState } from "./common";
import { formatTime, errorMessage } from "../format";
export function BlockedList() {
  const [rows, setRows] = useState<BlockedClientRow[]>();
  const [error, setError] = useState<unknown>();
  const [confirm, setConfirm] = useState<BlockedClientRow>();
  const [suspended, setSuspended] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(() => {
    void Promise.all([listBlockedClients(), getSession()])
      .then(([r, s]) => {
        setRows(r);
        setSuspended(s?.store?.status === "suspended");
        setError(undefined);
      })
      .catch(setError);
  }, []);
  useEffect(() => {
    load();
    return onSessionChange(load);
  }, [load]);
  const close = useCallback(() => setConfirm(undefined), []);
  return (
    <main>
      <h1>拉黑列表</h1>
      <p>
        被拉黑的手机在到期前不能在本店下单。拉黑只能在接单画面的订单详情里「拒单并拉黑」。
      </p>
      {message && <p role="status">{message}</p>}
      {error ? (
        <ErrorState message={errorMessage(error)} retry={load} />
      ) : !rows ? (
        <Skeleton />
      ) : !rows.length ? (
        <div className="card empty">目前没有拉黑的手机</div>
      ) : (
        <div className="blocked-table" role="table" aria-label="拉黑记录">
          <div className="blocked-row blocked-head" role="row">
            {["类型", "原因", "来源订单", "时间（UTC+8）", "操作"].map(
              (text) => (
                <strong role="columnheader" key={text}>
                  {text}
                </strong>
              ),
            )}
          </div>
          {rows.map((r) => (
            <article className="card blocked-row" role="row" key={r.id}>
              <strong>{r.kind === "device" ? "手机" : "网络"}</strong>
              <p>原因：{r.reason || "—"}</p>
              <p>
                来源订单：
                {r.source_order
                  ? `${r.source_order.table_label} 桌第 ${r.source_order.seq_in_bill} 单`
                  : "—"}
              </p>
              <p>
                拉黑时间：{formatTime(r.created_at)}
                <br />
                到期时间：{formatTime(r.expires_at)}（UTC+8）
              </p>
              {!suspended && (
                <Button variant="secondary" onClick={() => setConfirm(r)}>
                  解除拉黑
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title="确定解除拉黑？"
          confirmText="确认解除"
          busy={busy}
          onClose={close}
          onConfirm={() => {
            setBusy(true);
            void unblockClient(confirm.id)
              .then(() => {
                setConfirm(undefined);
                setMessage("已解除拉黑");
                load();
              })
              .catch(() => setMessage("解除没有成功，请重试"))
              .finally(() => setBusy(false));
          }}
        >
          解除后这台手机可以重新在本店下单。
        </ConfirmDialog>
      )}
    </main>
  );
}
