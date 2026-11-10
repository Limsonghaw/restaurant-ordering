import { LiveProvider } from "@/lib/ui/live-provider";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <LiveProvider>{children}</LiveProvider>;
}
