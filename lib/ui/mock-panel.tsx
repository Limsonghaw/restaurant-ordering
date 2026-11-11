"use client";
import { MockPanelC } from "./mock-panel-c";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  configureMock,
  getMockSnapshot,
  isMock,
  runMockAction,
  type MockAction,
  type MockSettings,
  type MockSnapshot,
} from "../data";
import { routes } from "../routes";
import { Button, Modal, Toggle } from "./common";
import { MockPanelB } from "./mock-panel-b";
import { orderScenariosA, scenarioLabelsA } from "./mock-panel-a";
export function MockPanel() {
  const path = usePathname();
  let code = "demo-a1";
  if (isMock && path.startsWith("/t/")) {
    try {
      code = decodeURIComponent(path.split("/")[2]);
    } catch {
      code = "";
    }
  }
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<MockSnapshot>();
  const [error, setError] = useState("");
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (open)
      void getMockSnapshot()
        .then(setSnapshot)
        .catch(() => setError("无法读取假数据"));
  }, [open]);
  async function configure(patch: Partial<MockSettings>) {
    await configureMock(patch);
    setSnapshot(await getMockSnapshot());
  }
  async function action(action: MockAction) {
    await runMockAction(action, code);
    setSnapshot(await getMockSnapshot());
    if (action === "reset") location.reload();
  }
  if (!isMock) return null;
  return (
    <>
      <button className="mock-trigger" onClick={() => setOpen(true)}>
        假数据
      </button>
      {open && (
        <Modal title="开发用模拟控制面板" onClose={close}>
          {error}
          {snapshot && (
            <div className="panel-fields">
              <p>{snapshot.identity}</p>
              <label>
                网络延迟
                <select
                  value={snapshot.settings.slow ? "slow" : "normal"}
                  onChange={(e) =>
                    void configure({ slow: e.target.value === "slow" })
                  }
                >
                  <option value="normal">正常</option>
                  <option value="slow">慢（3 秒）</option>
                </select>
              </label>
              <Button
                variant="secondary"
                onClick={() => void configure({ fail_next: true })}
              >
                下一次请求失败（NETWORK）
              </Button>
              <label>
                下一次下单返回
                <select
                  value={snapshot.settings.next_order}
                  onChange={(e) =>
                    void configure({ next_order: e.target.value })
                  }
                >
                  {orderScenariosA.map((s) => (
                    <option key={s} value={s}>
                      {scenarioLabelsA[s] ?? s}
                    </option>
                  ))}
                </select>
              </label>
              <Toggle
                checked={snapshot.settings.captcha_fail}
                onChange={(v) => void configure({ captcha_fail: v })}
              >
                下一次人机验证失败
              </Toggle>
              <Toggle
                checked={snapshot.settings.auto_progress}
                onChange={(v) => void configure({ auto_progress: v })}
              >
                订单状态自动推进（20 秒 / 40 秒）
              </Toggle>
              {(
                [
                  ["paid", "店家结账"],
                  ["rotate", "重置当前桌桌码"],
                  ["expire", "让本机令牌过期"],
                  ["switch_device", "切换为另一台手机"],
                  ["suspend", "切换店 A 停用状态"],
                  ["reset", "重置全部假数据"],
                ] as [MockAction, string][]
              ).map(([key, label]) => (
                <Button
                  key={key}
                  variant="secondary"
                  onClick={() => void action(key)}
                >
                  {label}
                </Button>
              ))}
              <MockPanelC />
              <MockPanelB />
              <h3>演示入口</h3>
              <div className="demo-links">
                {snapshot.demo_codes.map((c) => (
                  <Link key={c} href={routes.menu(c)} onClick={close}>
                    {c}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
