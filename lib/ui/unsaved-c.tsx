"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "./common";
/** beforeunload uses the browser's mandatory native wording. Internal links use our confirmation. */
export function useUnsavedChanges(dirty: boolean) {
  const router = useRouter();
  const [pending, setPending] = useState<{ run: () => void }>();
  const bypass = useRef(false);
  const dirtyRef = useRef(dirty);
  const request = useCallback((run: () => void) => {
    if (dirtyRef.current) setPending({ run });
    else run();
  }, []);
  useEffect(() => {
    dirtyRef.current = dirty;
    if (!dirty) {
      bypass.current = false;
      return;
    }
    const before = (e: BeforeUnloadEvent) => {
      if (!bypass.current) e.preventDefault();
    };
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (
        !a ||
        a.target === "_blank" ||
        a.href === location.href ||
        e.ctrlKey ||
        e.metaKey ||
        bypass.current
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      setPending({ run: () => router.push(a.href) });
    };
    // Navigation API intercepts history traversal before Next changes the route.
    const navigation = (window as Window & { navigation?: EventTarget })
      .navigation;
    const navigate = (raw: Event) => {
      const e = raw as Event & {
        navigationType: string;
        destination: { url: string; sameDocument: boolean };
      };
      if (e.navigationType !== "traverse" || !e.cancelable || bypass.current)
        return;
      e.preventDefault();
      setPending({ run: () => router.push(e.destination.url) });
    };
    window.addEventListener("beforeunload", before);
    document.addEventListener("click", click, true);
    navigation?.addEventListener("navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("click", click, true);
      navigation?.removeEventListener("navigate", navigate);
    };
  }, [dirty, router]);
  const close = useCallback(() => setPending(undefined), []);
  const dialog = pending ? (
    <ConfirmDialog
      title="有修改还没保存，确定离开？"
      confirmText="离开"
      backText="继续编辑"
      onClose={close}
      onConfirm={() => {
        bypass.current = true;
        setPending(undefined);
        pending.run();
      }}
    />
  ) : null;
  return { request, dialog };
}
