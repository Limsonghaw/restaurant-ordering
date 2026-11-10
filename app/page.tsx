import Link from "next/link";
import { routes } from "@/lib/routes";
export default function Home() {
  return (
    <main className="full-message">
      <h1>餐厅扫码点餐</h1>
      <p className="muted">欢迎来到假数据预览</p>
      <Link className="button primary" href={routes.menu("demo-a1")}>
        进入示范茶餐室
      </Link>
      <Link className="button text" href={routes.store}>
        店家后台
      </Link>
    </main>
  );
}
