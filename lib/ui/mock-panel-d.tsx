"use client";
import { useState } from "react";
import { storeMockActionD, type StoreMockActionD } from "../data";
import { Button } from "./common";
import { storePageMessage } from "./store-d";
export function MockPanelD() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: StoreMockActionD) {
    setBusy(true);
    try {
      await storeMockActionD(action);
      setMessage("账单和订单记录场景已更新");
    } catch (e) {
      setMessage(storePageMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>账单 / 订单记录（PR-D）</h3>
      {(
        [
          ["empty", "清空本店账单和订单"],
          ["many_bills", "增加 45 张已结账单（分页）"],
          ["restore", "恢复本店种子账单"],
        ] as const
      ).map(([a, label]) => (
        <Button
          key={a}
          variant="secondary"
          busy={busy}
          onClick={() => void run(a)}
        >
          {label}
        </Button>
      ))}
      <p role="status">{message}</p>
    </section>
  );
}
