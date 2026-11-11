import { AccessGuard } from "@/lib/ui/access-c";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AccessGuard>{children}</AccessGuard>;
}
