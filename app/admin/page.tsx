import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";
export default function Page() {
  redirect(routes.adminStores);
}
