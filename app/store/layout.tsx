import { AccessGuard } from "@/lib/ui/access-c";
import { StoreShell } from "@/lib/ui/store-shell";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AccessGuard>
      <StoreShell>{children}</StoreShell>
    </AccessGuard>
  );
}
