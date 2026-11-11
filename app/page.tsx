import Link from "next/link";
import { routes } from "@/lib/routes";
export default function Home() {
  const isMock = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock";
  return (
    <main className="full-message">
      <h1>餐厅扫码点餐</h1>
      {isMock ? (
        <>
          <p className="muted">欢迎来到假数据预览</p>
          <Link className="button primary" href={routes.menu("demo-a1")}>
            进入示范茶餐室
          </Link>
        </>
      ) : (
        <p className="muted">请扫描桌上的二维码开始点餐</p>
      )}
      <Link className="button text" href={routes.store}>
        店家后台
      </Link>
    </main>
  );
}
