import { Suspense } from "react";
import { AuthPage } from "@/lib/ui/auth-c";
export default function Page() {
  return (
    <Suspense fallback={<p>正在加载…</p>}>
      <AuthPage mode="set-password" />
    </Suspense>
  );
}
