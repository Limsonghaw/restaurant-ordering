"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import {
  authMockAction,
  getAuthMockSnapshot,
  blocksMockAction,
  type AuthMockSnapshot,
} from "../data";
export function MockPanelC() {
  const [now, setNow] = useState(0);
  const [origin, setOrigin] = useState("");
  const [snapshot, setSnapshot] = useState<AuthMockSnapshot>();
  const [message, setMessage] = useState("");
  function load() {
    void getAuthMockSnapshot()
      .then((s) => {
        setSnapshot(s);
        setNow(Date.now());
        setOrigin(location.origin);
      })
      .catch(() => setMessage("无法读取模拟身份"));
  }
  useEffect(load, []);
  async function action(name: string, value = "") {
    try {
      await authMockAction(name, value);
      load();
      setMessage("已设置");
    } catch {
      setMessage("操作失败");
    }
  }
  return (
    <section className="panel-fields">
      <h3>身份</h3>
      <select
        aria-label="切换模拟身份"
        value={
          snapshot?.identity === "auth-admin" && snapshot.aal === "aal1"
            ? "auth-admin-aal1"
            : (snapshot?.identity ?? "anonymous")
        }
        onChange={(e) =>
          void action("identity", e.target.value.replace("auth-", ""))
        }
      >
        {[
          ["anonymous", "未登录"],
          ["auth-owner", "店家（正常）"],
          ["auth-new", "店家（资料未填）"],
          ["auth-nopw", "未设密码店家"],
          ["auth-nostore", "已验证但没有店铺"],
          ["auth-disabled", "已停用店家"],
          ["auth-admin", "平台管理员（aal2）"],
          ["auth-admin-aal1", "平台管理员（aal1）"],
        ].map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
      <button onClick={() => void action("profile")}>
        给当前店铺填上地址和营业时间
      </button>
      <h3>模拟邮箱</h3>
      {snapshot?.mails.map((m) => (
        <article key={m.id}>
          <p>
            {m.recipient} · {m.type} ·{" "}
            {new Date(m.created_at).toLocaleString("zh-Hans", {
              timeZone: "Asia/Kuala_Lumpur",
            })}{" "}
            · {m.used ? "已用" : m.expires_at < now ? "已过期" : "未用"}
          </p>
          <Link
            href={`/auth/confirm?token_hash=${encodeURIComponent(m.id)}&type=email&next=${encodeURIComponent(origin + m.next)}`}
          >
            打开确认链接
          </Link>
          <button onClick={() => void action("expire-mail", m.id)}>
            让链接过期
          </button>
          <button onClick={() => void action("use-mail", m.id)}>
            标为已用
          </button>
        </article>
      ))}
      <button
        onClick={() => setMessage("最近一次假短信验证码：123456（仅假数据用）")}
      >
        显示最近一次假短信验证码
      </button>
      <h3>认证出错</h3>
      {[
        [
          "send",
          "发送",
          [
            "RATE_LIMITED",
            "SMS_SEND_FAILED",
            "PHONE_NOT_SUPPORTED",
            "CAPTCHA_FAILED",
          ],
        ],
        [
          "login",
          "登录",
          [
            "EMAIL_NOT_CONFIRMED",
            "PHONE_NOT_CONFIRMED",
            "RATE_LIMITED",
            "CAPTCHA_FAILED",
          ],
        ],
        ["verify", "验证码校验", ["RATE_LIMITED"]],
        [
          "password",
          "setPassword",
          ["WEAK_PASSWORD", "FORBIDDEN", "UNSUPPORTED_MEDIA_TYPE"],
        ],
      ].map(([op, label, codes]) => (
        <label key={String(op)}>
          下一次{label}
          <select
            aria-label={`下一次${label}`}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) void action(`fail:${op}`, e.target.value);
              e.target.value = "";
            }}
          >
            <option value="">选择错误</option>
            {(codes as string[]).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      ))}
      <button onClick={() => void action("expire-sms")}>
        让当前短信验证码过期
      </button>
      <button onClick={() => void action("expire-verification")}>
        让验证超过 5 分钟
      </button>
      <button onClick={() => void action("cleanup")}>
        清理 24 小时未验证账号
      </button>
      <h3>拉黑</h3>
      <button
        onClick={() =>
          void blocksMockAction(false).then(() =>
            setMessage("已拉黑当前模拟设备"),
          )
        }
      >
        把当前模拟设备拉黑 7 天
      </button>
      <button
        onClick={() =>
          void blocksMockAction(true).then(() => setMessage("所有拉黑已过期"))
        }
      >
        让所有拉黑过期
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
