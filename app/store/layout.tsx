import { AccessGuard } from "@/lib/ui/access-c";
import { LiveProvider } from "@/lib/ui/live-provider";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AccessGuard>
      <LiveProvider>{children}</LiveProvider>
    </AccessGuard>
  );
}
