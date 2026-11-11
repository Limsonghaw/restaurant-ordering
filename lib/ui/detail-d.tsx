"use client";
import { useSyncExternalStore, type ReactNode } from "react";
import { Button, Modal } from "./common";
const subscribe = (notify: () => void) => {
  const query = window.matchMedia("(min-width: 768px)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
export function BillDetailD({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const wide = useSyncExternalStore(
    subscribe,
    () => window.matchMedia("(min-width: 768px)").matches,
    () => false,
  );
  return wide ? (
    <aside className="card d-bill-detail" aria-label={title}>
      <header className="d-row">
        <h2>{title}</h2>
        <Button variant="text" onClick={onClose}>
          关闭
        </Button>
      </header>
      {children}
    </aside>
  ) : (
    <Modal title={title} onClose={onClose}>
      {children}
    </Modal>
  );
}
