import type { BillAmounts } from "../types";
// 仅 mock 计价；真实版由后端返回，页面不能依赖此规则。
export function calculateAmounts(
  subtotal_cents: number,
  service_charge_bp: number,
  sst_bp: number,
): BillAmounts {
  const service_charge_cents = Math.round(
    (subtotal_cents * service_charge_bp) / 10000,
  );
  const sst_cents = Math.round(
    ((subtotal_cents + service_charge_cents) * sst_bp) / 10000,
  );
  return {
    subtotal_cents,
    service_charge_cents,
    sst_cents,
    rounding_cents: 0,
    total_cents: subtotal_cents + service_charge_cents + sst_cents,
  };
}
