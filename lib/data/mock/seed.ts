import { extendSeedC } from "./seed-c";
import type {
  MenuItem,
  Category,
  Store,
  Order,
  BillGoneReason,
  MockSettings,
} from "../types";
export interface InternalOrder extends Order {
  device_id: string;
  device_seq_in_bill: number;
  cancel_note: string | null;
  auto_progress: boolean;
}
export interface InternalBill {
  id: string;
  table_id: string;
  status: "open" | "paid";
  opened_at: string;
  orders: InternalOrder[];
}
export interface Token {
  table_id: string;
  bill_id: string;
  device_id: string;
  token: string;
  expires_at: number;
  reason?: BillGoneReason;
}
export interface State {
  stores: Store[];
  categories: (Category & {
    store_id: string;
    hidden: boolean;
    deleted: boolean;
  })[];
  tables: {
    id: string;
    label: string;
    store_id: string;
    code: string;
    original_code: string;
    rotations: number;
    active: boolean;
  }[];
  items: (MenuItem & { store_id: string; hidden: boolean; deleted: boolean })[];
  bills: InternalBill[];
  tokens: Token[];
  device_id: string;
  device_counter?: number;
  blocks: {
    id: string;
    store_id: string;
    kind: "device" | "ip";
    device_id: string;
    reason: string;
    source_order_id: string | null;
    created_at: string;
    expires_at: string;
  }[];
  requests: Record<
    string,
    { payload: string; order_id: string; bill_id: string }
  >;
  settings: MockSettings;
}
export const categoryNames = ["招牌饭面", "小食", "饮料", "甜品"];
export function seed(): State {
  const now = new Date().toISOString();
  const stores: Store[] = [
    "示范茶餐室",
    "零费率小馆",
    "暂停接单小店",
    "已停用的店",
  ].map((name, i) => ({
    id: `store-${i}`,
    slug: `demo-${i}`,
    name,
    logo_path: "/mock/logo.svg",
    status: i === 3 ? "suspended" : "active",
    status_changed_at: null,
    is_accepting_orders: i !== 2,
    is_profile_complete: true,
    address: "示范街 18 号",
    opening_hours: "每日 08:00–22:00",
    currency: "MYR",
    locale: "zh-Hans",
    timezone: "Asia/Kuala_Lumpur",
    service_charge_bp: i === 1 ? 0 : 1000,
    sst_bp: i === 1 ? 0 : 600,
    cash_rounding: false,
    require_first_order_approval: false,
    max_order_cents: 300000,
    require_captcha: false,
    created_at: now,
    updated_at: now,
  }));
  const categories = stores.flatMap((store, index) =>
    categoryNames.slice(0, index === 1 ? 2 : 4).map((name, i) => ({
      id: index === 0 ? `cat-${i}` : `${store.id}-cat-${i}`,
      name,
      sort_order: i * 10,
      store_id: store.id,
      hidden: false,
      deleted: false,
    })),
  );
  const dayStart = Date.parse(
    `${new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}T00:00:00+08:00`,
  );
  const tables = [
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `a${i + 1}`,
      label: `A${i + 1}`,
      store_id: "store-0",
      code: `demo-a${i + 1}`,
      original_code: `demo-a${i + 1}`,
      rotations: 0,
      active: i !== 8,
    })),
    ...["b1", "paused", "suspended"].map((key, i) => ({
      id: key,
      label: i === 0 ? "B1" : "1",
      store_id: `store-${i + 1}`,
      code: `demo-${key}`,
      original_code: `demo-${key}`,
      rotations: 0,
      active: true,
    })),
  ];
  const names = [
    "招牌海南鸡饭",
    "干炒牛河",
    "叉烧云吞面",
    "双人海鲜拼盘",
    "香脆炸鸡翅",
    "咖喱鱼蛋",
    "手工春卷",
    "招牌酥脆黄金豆腐配秘制香辣酱与时令蔬菜",
    "南洋奶茶",
    "冰柠檬茶",
    "白咖啡",
    "薏米水",
    "椰香西米露",
    "红豆冰",
    "芒果布丁",
    "传统咖椰吐司",
    "隐藏菜品",
    "已删除菜品",
  ];
  const items: State["items"] = stores.flatMap((store, s) =>
    names.slice(0, s === 1 ? 4 : s > 1 ? 8 : 18).map((name, i) => ({
      id: `${store.id}-item-${i}`,
      store_id: store.id,
      category_id: `${s === 0 ? "" : `${store.id}-`}cat-${s === 1 ? Math.floor(i / 2) : Math.min(3, Math.floor(i / 4))}`,
      name,
      description:
        i === 7
          ? "每日新鲜制作，外酥里嫩，配搭主厨调制酱汁。".repeat(8)
          : "新鲜食材，用心烹调，一份熟悉的南洋滋味。",
      price_cents: [
        1250, 1490, 1280, 12800, 890, 690, 590, 990, 390, 490, 590, 390, 690,
        790, 890, 490,
      ][i % 16],
      image_path:
        i % 4 === 0
          ? "/mock/dish.svg"
          : i % 4 === 1
            ? "/mock/missing.svg"
            : null,
      thumb_path:
        i % 4 === 0
          ? "/mock/dish.svg"
          : i % 4 === 1
            ? "/mock/missing.svg"
            : null,
      is_sold_out: i === 5 || i === 13,
      hidden: i === 16,
      deleted: i === 17,
      sort_order: i * 10,
    })),
  );
  const makeOrder = (i: number, store = "store-0"): InternalOrder => {
    const item = items.find((x) => x.store_id === store)!;
    return {
      id: `${store}-order-${i}`,
      seq_in_bill: i + 1,
      status: (
        ["served", "accepted", "new", "cancelled", "new", "cancelled"] as const
      )[i % 6],
      subtotal_cents: item.price_cents,
      item_count: 1,
      created_at: new Date(
        Math.max(dayStart, Date.now() - (6 - i) * 60000),
      ).toISOString(),
      cancel_reason: i === 3 ? "other" : i === 5 ? "sold_out" : null,
      lines: [
        {
          item_name: item.name,
          unit_price_cents: item.price_cents,
          quantity: 1,
          line_total_cents: item.price_cents,
          note: i === 1 ? "少辣，不要葱，酱汁分开放，谢谢。" : "",
        },
      ],
      device_id: i < 4 ? "demo-device-1" : "seed-other-device",
      device_seq_in_bill: i < 4 ? 1 : 2,
      cancel_note: i === 3 ? "顾客不应看到这段店员说明" : null,
      auto_progress: false,
    };
  };
  const bills: InternalBill[] = [
    {
      id: "bill-a1",
      table_id: "a1",
      status: "open",
      opened_at: now,
      orders: Array.from({ length: 6 }, (_, i) => makeOrder(i)),
    },
    {
      id: "bill-b1",
      table_id: "b1",
      status: "open",
      opened_at: now,
      orders: [makeOrder(0, "store-1")],
    },
  ];
  return extendSeedC({
    stores,
    categories,
    tables,
    items,
    bills,
    tokens: bills.flatMap((b) =>
      [...new Set(b.orders.map((o) => o.device_id))].map((device_id) => ({
        table_id: b.table_id,
        bill_id: b.id,
        device_id,
        token: `mock-${b.id}-${device_id}`,
        expires_at: Date.now() + 43200000,
      })),
    ),
    device_id: "demo-device-1",
    blocks: [],
    requests: {},
    settings: {
      slow: false,
      fail_next: false,
      next_order: "",
      captcha_fail: false,
      auto_progress: false,
    },
  });
}
