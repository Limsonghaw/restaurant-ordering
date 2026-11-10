"use client";
import { useEffect, useRef, useState } from "react";
interface TurnstileAPI {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileAPI;
  }
}
let scriptPromise: Promise<void> | undefined;
function loadScript() {
  if (!scriptPromise)
    scriptPromise = new Promise((resolve, reject) => {
      if (window.turnstile) return resolve();
      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = undefined;
        script.remove();
        reject(new Error("验证加载失败"));
      };
      document.head.appendChild(script);
    });
  return scriptPromise;
}
// 调用方每次提交后改变 resetKey；组件仅传递令牌、失效和重置事件。
export function Captcha({
  onToken,
  onExpire,
  onReset,
  resetKey,
}: {
  onToken: (token: string) => void;
  onExpire: () => void;
  onReset?: () => void;
  resetKey: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onExpire, onReset });
  useEffect(() => {
    callbacks.current = { onToken, onExpire, onReset };
  });
  const [checked, setChecked] = useState(false);
  const key = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
  useEffect(() => {
    let cancelled = false;
    let widget: string | undefined;
    void Promise.resolve().then(() => {
      if (!cancelled) setChecked(false);
    });
    callbacks.current.onReset?.();
    if (key)
      void loadScript()
        .then(() => {
          if (!cancelled && container.current)
            widget = window.turnstile!.render(container.current, {
              sitekey: key,
              callback: (token: string) => callbacks.current.onToken(token),
              "expired-callback": () => callbacks.current.onExpire(),
              "error-callback": () => callbacks.current.onExpire(),
            });
        })
        .catch(() => callbacks.current.onExpire());
    return () => {
      cancelled = true;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [key, resetKey]);
  return key ? (
    <div ref={container} />
  ) : process.env.NEXT_PUBLIC_DATA_SOURCE !== "mock" ? (
    <p role="alert">验证组件未配置</p>
  ) : (
    <div className="captcha" key={resetKey}>
      <p>人机验证（假数据占位）</p>
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            setChecked(e.target.checked);
            if (e.target.checked)
              onToken(`mock-captcha-ok-${crypto.randomUUID()}`);
            else onExpire();
          }}
        />
        我不是机器人
      </label>
    </div>
  );
}
