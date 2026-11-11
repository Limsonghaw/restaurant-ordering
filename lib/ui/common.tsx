"use client";
import Image from "next/image";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  DataError,
  imageUrl,
  type BillAmounts,
  type CartQuote,
  type OrderStatus,
} from "../data";
import { countdownRemaining, formatMoney, orderLabels } from "../format";
export function Button({
  busy,
  busyText = "请稍候…",
  variant = "primary",
  large,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  busyText?: string;
  variant?: "primary" | "secondary" | "danger" | "text";
  large?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className={`button ${variant} ${large ? "large" : ""} ${props.className ?? ""}`}
    >
      {busy ? busyText : children}
    </button>
  );
}
export function Banner({
  children,
  tone = "yellow",
  action,
}: {
  children: ReactNode;
  tone?: "red" | "yellow" | "green";
  action?: ReactNode;
}) {
  return (
    <div role="status" className={`banner ${tone}`}>
      {children}
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement;
    dialog.showModal();
    const closeOnBackdrop = (event: MouseEvent) => {
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }
    };
    dialog.addEventListener("click", closeOnBackdrop);
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <Button variant="text" aria-label="关闭" onClick={onClose}>
          ×
        </Button>
      </header>
      {children}
    </dialog>
  );
}
export function ConfirmDialog({
  title,
  children,
  confirmText = "确认",
  backText = "返回",
  danger,
  disabled,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  confirmText?: string;
  backText?: string;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <div className="actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {backText}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          disabled={disabled}
          busy={busy}
          onClick={onConfirm}
        >
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}
export function Skeleton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="loading" role="status" aria-label="正在加载">
      <p>正在加载…</p>
      {show && [0, 1, 2].map((n) => <div className="skeleton" key={n} />)}
    </div>
  );
}
export function EmptyState({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <EmptyState action={<Button onClick={retry}>重试</Button>}>
      {message}
    </EmptyState>
  );
}
export function FullPageMessage({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <main className="full-message">
      <p>{children}</p>
      {action}
    </main>
  );
}
export function Toast({ children }: { children: ReactNode }) {
  return children ? (
    <div className="toast" role="status">
      {children}
    </div>
  ) : null;
}
export function Stepper({
  value,
  onChange,
  disabled,
  max = 99,
  min = 1,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  max?: number;
  min?: number;
}) {
  return (
    <div className="stepper">
      <Button
        variant="secondary"
        aria-label="减少数量"
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </Button>
      <output aria-label="数量">{value}</output>
      <Button
        variant="secondary"
        aria-label="增加数量"
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
      >
        ＋
      </Button>
    </div>
  );
}
export function Money({ cents }: { cents: number }) {
  return <span className="money">{formatMoney(cents)}</span>;
}
export function AmountDetails({
  amounts,
  quote,
  subtotalOnly,
  hint,
  estimated = true,
}: {
  amounts?: BillAmounts;
  quote?: CartQuote;
  subtotalOnly?: boolean;
  hint?: string;
  estimated?: boolean;
}) {
  const rows: [string, number | null | undefined][] = [
    ["小计", amounts?.subtotal_cents ?? quote?.subtotal_cents],
    [
      "服务费",
      amounts?.service_charge_cents ?? quote?.estimated_service_charge_cents,
    ],
    ["SST", amounts?.sst_cents ?? quote?.estimated_sst_cents],
    ["总计", amounts?.total_cents ?? quote?.estimated_total_cents],
  ];
  return (
    <div className="amounts">
      {rows
        .filter(([label, value]) =>
          subtotalOnly ? label === "小计" : label === "总计" || Boolean(value),
        )
        .map(([label, value]) => (
          <div key={label} className={label === "总计" ? "total" : ""}>
            <span>
              {label}
              {estimated && label !== "小计" ? "（预估）" : ""}
            </span>
            <Money cents={value ?? 0} />
          </div>
        ))}
      {hint && <p className="muted">{hint}</p>}
    </div>
  );
}
export function FoodImage({
  path,
  alt = "",
}: {
  path: string | null;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = imageUrl(path);
  return (
    <div className="food-image">
      {src && !failed ? (
        <Image
          width={400}
          height={400}
          unoptimized
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-label="暂无图片">茶 · 餐</span>
      )}
    </div>
  );
}
// 最终以后端校验为准。
export function TextField({
  label,
  value,
  onChange,
  maxLength,
  multiline,
  error,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  multiline?: boolean;
  error?: string;
  placeholder?: string;
}) {
  const id = useId();
  const props = {
    id,
    value,
    maxLength,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
    "aria-invalid": Boolean(error),
    "aria-describedby": `${id}-help`,
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} />}
      <small id={`${id}-help`} className={error ? "error-text" : "muted"}>
        {error || `${value.length}/${maxLength}`}
      </small>
    </div>
  );
}
export function Toggle({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}
export function OrderStatusLabel({ status }: { status: OrderStatus }) {
  return <span className={`status ${status}`}>{orderLabels[status]}</span>;
}

export function useCountdown(error: unknown) {
  const [deadline, setDeadline] = useState(0);
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (error instanceof DataError && error.code === "RATE_LIMITED")
      void Promise.resolve().then(() =>
        setDeadline(Date.now() + error.retryAfterSeconds * 1000),
      );
  }, [error]);
  useEffect(() => {
    if (!deadline) return;
    const tick = () => setRemaining(countdownRemaining(deadline));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);
  return remaining;
}

export function RateLimitNotice({
  error,
  label = "操作太频繁",
}: {
  error: unknown;
  label?: string;
}) {
  const seconds = useCountdown(error);
  return seconds ? (
    <Banner>
      {label}，请 {seconds} 秒后再试
    </Banner>
  ) : null;
}
