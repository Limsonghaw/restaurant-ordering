import { StoreShell } from "@/lib/ui/store-shell";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <StoreShell>{children}</StoreShell>;
}
