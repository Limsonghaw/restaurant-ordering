"use client";
import { useEffect, useState } from "react";
import {
  configureLiveMock,
  getLiveMockSettings,
  runLiveMockAction,
  runMockAction,
  type LiveMockAction,
  type LiveMockSettings,
} from "../data";
import { Button, Toggle } from "./common";
export function MockPanelB() {
  const [settings, setSettings] = useState<LiveMockSettings>();
  const [error, setError] = useState("");
  useEffect(() => {
    void getLiveMockSettings()
      .then(setSettings)
      .catch(() => setError("无法读取接单模拟项"));
  }, []);
  async function configure(patch: Partial<LiveMockSettings>) {
    await configureLiveMock(patch);
    setSettings(await getLiveMockSettings());
  }
  async function act(action: LiveMockAction) {
    try {
      await runLiveMockAction(action);
      setSettings(await getLiveMockSettings());
    } catch {
      setError("模拟操作失败，请重试");
    }
  }
  return (
    <fieldset className="panel-fields">
      <legend>接单画面</legend>
      {error}
      {(
        [
          ["new", "模拟新订单"],
          ["three", "连续来 3 单"],
          ["disconnect", "模拟断线"],
          ["reconnect", "模拟重连"],
          ["missed", "断线期间产生 2 张新订单"],
          ["other", "其他设备接单（推送）"],
          ["other_silent", "其他设备接单（不推送事件）"],
          ["paid", "模拟这桌已结账（首张已接单订单）"],
        ] as [LiveMockAction, string][]
      ).map(([key, label]) => (
        <Button key={key} variant="secondary" onClick={() => void act(key)}>
          {label}
        </Button>
      ))}
      {settings && (
        <>
          <Toggle
            checked={settings.hold}
            onChange={(hold) => void configure({ hold })}
          >
            保持断线（重连一直失败）
          </Toggle>
          <Button
            variant="secondary"
            onClick={() => void configure({ fail_status: true })}
          >
            下一次改状态失败（NETWORK）
          </Button>
          <Toggle
            checked={settings.expired}
            onChange={(expired) => void configure({ expired })}
          >
            模拟登录过期
          </Toggle>
          <Toggle
            checked={settings.no_wake}
            onChange={(no_wake) => void configure({ no_wake })}
          >
            模拟浏览器不支持保持亮屏
          </Toggle>
          <Toggle
            checked={settings.sound_paused}
            onChange={(sound_paused) => void configure({ sound_paused })}
          >
            模拟提示音被浏览器暂停
          </Toggle>
          <label>
            断线判定阈值
            <select
              value={settings.threshold_ms}
              onChange={(e) =>
                void configure({ threshold_ms: Number(e.target.value) })
              }
            >
              <option value={120000}>2 分钟（默认）</option>
              <option value={10000}>10 秒（仅测试用）</option>
            </select>
          </label>
          <Button
            variant="secondary"
            onClick={() => void runMockAction("suspend", "demo-a1")}
          >
            切换店铺停用（共用假身份）
          </Button>
        </>
      )}
    </fieldset>
  );
}
