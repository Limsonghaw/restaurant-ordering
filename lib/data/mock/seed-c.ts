import type { State } from "./seed";
export function extendSeedC(s: State): State {
  s.categories.push(
    {
      id: "seasonal",
      store_id: "store-0",
      name: "季节限定",
      sort_order: 40,
      hidden: false,
      deleted: false,
    },
    {
      id: "staff",
      store_id: "store-0",
      name: "员工餐",
      sort_order: 50,
      hidden: true,
      deleted: false,
    },
  );
  for (let n = 0; n < 2; n++)
    s.items.push({
      ...s.items[0],
      id: `staff-${n}`,
      category_id: "staff",
      name: `员工餐 ${n + 1}`,
      sort_order: n,
      hidden: false,
      deleted: false,
    });
  for (let n = 0; n < 2; n++)
    s.blocks.push({
      id: `seed-block-${n}`,
      store_id: "store-0",
      kind: "device",
      device_id: "seed-other-device",
      reason: "",
      source_order_id:
        s.bills[0].orders.find(
          (o) =>
            o.status === "cancelled" && o.device_id === "seed-other-device",
        )?.id ?? null,
      created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      expires_at: new Date(
        Date.now() + (n === 0 ? 5 : -1) * 86400000,
      ).toISOString(),
    });
  return s;
}
