import { notFound } from "next/navigation";
import { storeNavigation } from "@/lib/routes";
export default async function Page({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const { page } = await params;
  const entry = storeNavigation.find(([, path]) => path === `/store/${page}`);
  if (!entry) notFound();
  return (
    <main>
      <h1>{entry[0]}</h1>
      <div className="card empty">这个页面还在开发中</div>
    </main>
  );
}
