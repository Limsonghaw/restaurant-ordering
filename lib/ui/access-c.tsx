"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getSession, onSessionChange, type Session } from "../data";
import { evaluateAccess, toAuthState } from "../auth/guard";
import { ErrorState, Skeleton } from "./common";
import { errorMessage } from "../format";
export function AccessGuard({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [ctx, setCtx] = useState<Session | null>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let live = true;
    const load = () =>
      void getSession()
        .then((s) => {
          if (live) setCtx(s);
        })
        .catch((e) => {
          if (live) setError(e);
        });
    load();
    let stop: (() => void) | undefined;
    try {
      stop = onSessionChange((s) => {
        if (live) setCtx(s);
      });
    } catch (e) {
      Promise.resolve().then(() => setError(e));
    }
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  const decision =
    ctx === undefined ? null : evaluateAccess(path, toAuthState(ctx));
  useEffect(() => {
    if (decision && !decision.allow) router.replace(decision.to);
  }, [decision, router]);
  if (error)
    return (
      <ErrorState
        message={errorMessage(error)}
        retry={() => location.reload()}
      />
    );
  if (!decision || !decision.allow) return <Skeleton />;
  return children;
}
