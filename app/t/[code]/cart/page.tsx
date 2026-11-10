import { CartPage } from "@/lib/ui/customer";
export default async function Page({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <CartPage code={code} />;
}
