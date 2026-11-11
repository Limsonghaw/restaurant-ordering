import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  upload: vi.fn(),
  bucket: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({
    rpc: fake.rpc,
    from: fake.from,
    storage: { from: fake.bucket },
  })),
}));
import * as menu from "../lib/data/supabase/menu-c";
import * as blocks from "../lib/data/supabase/blocks-c";
import * as store from "../lib/data/supabase/store";
import * as tables from "../lib/data/supabase/tables";
import { getMyContext, storeContext } from "../lib/data/supabase/me";
import { uploadLogo } from "../lib/data/supabase/images";
import type { ItemInput } from "../lib/data/types";

const storeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let status = "active";
let rpcData: unknown;
let rpcError: null | { code: string; message: string };
function query(data: unknown, error: unknown = null) {
  const q: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const key of [
    "select",
    "eq",
    "is",
    "order",
    "limit",
    "insert",
    "update",
    "single",
    "maybeSingle",
  ])
    q[key] = vi.fn(() => q);
  q.then = vi.fn((resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data, error })),
  );
  return q;
}
const input: ItemInput = {
  category_id: "cat",
  name: "Soup",
  description: "",
  price_cents: 100,
  image_path: null,
  thumb_path: null,
  is_hidden: false,
  is_sold_out: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  status = "active";
  rpcData = null;
  rpcError = null;
  fake.rpc.mockImplementation((name: string) =>
    Promise.resolve(
      name === "get_my_context"
        ? { data: { store: { id: storeId, status } }, error: null }
        : { data: rpcData, error: rpcError },
    ),
  );
  fake.bucket.mockReturnValue({ upload: fake.upload });
  fake.upload.mockResolvedValue({ data: {}, error: null });
});
describe("merchant reads and writes", () => {
  it("reads context and fails closed for missing store / identity", async () => {
    expect((await getMyContext()).store?.id).toBe(storeId);
    fake.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(getMyContext()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    fake.rpc.mockResolvedValueOnce({ data: { store: null }, error: null });
    await expect(storeContext()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("reads hidden menu rows, counts items, requests stable database ordering", async () => {
    status = "suspended";
    const c = query([
      { id: "c", name: "hidden", is_hidden: true, sort_order: 10 },
    ]);
    const i = query([
      { id: "i", category_id: "c", sort_order: 20, is_hidden: true },
    ]);
    fake.from.mockReturnValueOnce(c).mockReturnValueOnce(i);
    const data = await menu.getMenuForStore();
    expect(data.categories[0]).toMatchObject({
      is_hidden: true,
      itemCount: 1,
      sort_order: 10,
    });
    expect(data.items[0].sort_order).toBe(20);
    for (const q of [c, i]) {
      expect(q.eq).toHaveBeenCalledWith("store_id", storeId);
      expect(q.is).toHaveBeenCalledWith("deleted_at", null);
      expect(q.order).toHaveBeenCalledWith("sort_order");
      expect(q.order).toHaveBeenCalledWith("id");
    }
  });
  it("reads explicit store fields and filters write columns", async () => {
    const q = query({ id: storeId });
    fake.from.mockReturnValueOnce(q);
    expect(await store.getStore()).toEqual({ id: storeId });
    expect(q.select).toHaveBeenCalledWith(store.STORE_COLUMNS);
    const write = query([{ id: storeId }]);
    fake.from.mockReturnValueOnce(write);
    await store.updateStore({
      name: "Restaurant",
      status_reason: "private",
      status: "active",
    } as Parameters<typeof store.updateStore>[0]);
    expect(write.update).toHaveBeenCalledWith({ name: "Restaurant" });
    expect(write.eq).toHaveBeenCalledWith("id", storeId);
    fake.from.mockReturnValueOnce(write);
    await store.setAcceptingOrders(false);
    expect(write.update).toHaveBeenLastCalledWith({
      is_accepting_orders: false,
    });
  });
  it("creates category / item with next sort_order in steps of ten", async () => {
    for (const [create, table, values] of [
      [() => menu.createCategory(" Tea "), "categories", { name: "Tea" }],
      [() => menu.createItem(input), "items", input],
    ] as const) {
      const previous = query([{ sort_order: 20 }]);
      const write = query({ id: "new" });
      fake.from.mockReturnValueOnce(previous).mockReturnValueOnce(write);
      expect(await create()).toBe("new");
      expect(fake.from).toHaveBeenCalledWith(table);
      expect(write.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          ...values,
          store_id: storeId,
          sort_order: 30,
        }),
      );
    }
  });
  it("updates menu fields only within this store and detects missing rows", async () => {
    const actions = [
      [() => menu.renameCategory("id", "new"), { name: "new" }],
      [() => menu.setCategoryHidden("id", true), { is_hidden: true }],
      [() => menu.updateItem("id", input), input],
      [() => menu.setItemSoldOut("id", true), { is_sold_out: true }],
      [() => menu.setItemHidden("id", true), { is_hidden: true }],
    ] as const;
    for (const [call, values] of actions) {
      const q = query([{ id: "id" }]);
      fake.from.mockReturnValueOnce(q);
      await call();
      expect(q.update).toHaveBeenCalledWith(values);
      expect(q.eq).toHaveBeenCalledWith("store_id", storeId);
      expect(q.eq).toHaveBeenCalledWith("id", "id");
      expect(q.is).toHaveBeenCalledWith("deleted_at", null);
    }
    fake.from.mockReturnValueOnce(query([]));
    await expect(menu.setItemHidden("foreign", false)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("rejects invalid inputs and suspended writes", async () => {
    await expect(menu.createCategory(" ")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      menu.createItem({ ...input, price_cents: -1 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(menu.reorderCategories(["a", "a"])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    status = "suspended";
    for (const call of [
      () => menu.createCategory("x"),
      () => menu.updateItem("i", input),
      () => store.setAcceptingOrders(true),
      () => tables.createTable("1"),
    ])
      await expect(call()).rejects.toMatchObject({ code: "STORE_SUSPENDED" });
    expect(fake.from).not.toHaveBeenCalled();
  });
  it("lists, creates and edits tables without allowing QR version mutation", async () => {
    const read = query([{ id: "t", sort_order: 20 }]);
    fake.from.mockReturnValueOnce(read);
    expect(await tables.listTables()).toEqual([{ id: "t", sort_order: 20 }]);
    expect(read.is).toHaveBeenCalledWith("deleted_at", null);
    const write = query({ id: "new" });
    fake.from.mockReturnValueOnce(read).mockReturnValueOnce(write);
    expect(await tables.createTable(" A1 ")).toBe("new");
    expect(write.insert).toHaveBeenCalledWith({
      store_id: storeId,
      label: "A1",
      sort_order: 30,
    });
    const update = query([{ id: "t" }]);
    fake.from.mockReturnValueOnce(update);
    await tables.updateTable("t", { label: "A2", qr_version: 55 } as Parameters<
      typeof tables.updateTable
    >[1]);
    expect(update.update).toHaveBeenCalledWith({ label: "A2" });
    expect(update.eq).toHaveBeenCalledWith("store_id", storeId);
    fake.from.mockReturnValueOnce(
      query([], {
        code: "23505",
        message: 'duplicate constraint "dining_tables_store_label_uq"',
      }),
    );
    await expect(
      tables.updateTable("t", { label: "used" }),
    ).rejects.toMatchObject({ code: "TABLE_LABEL_TAKEN" });
  });
});
describe("transactional RPCs", () => {
  it.each([
    [
      () => menu.reorderCategories(["b", "a"]),
      "reorder_categories",
      { p_ids: ["b", "a"] },
    ],
    [
      () => menu.reorderItems("c", ["b", "a"]),
      "reorder_items",
      { p_category_id: "c", p_ids: ["b", "a"] },
    ],
    [() => menu.deleteItem("i"), "soft_delete_item", { p_item_id: "i" }],
    [() => menu.deleteCategory("c"), "delete_category", { p_category_id: "c" }],
    [() => tables.deleteTable("t"), "soft_delete_table", { p_table_id: "t" }],
    [() => tables.rotateTableQr("t"), "rotate_table_qr", { p_table_id: "t" }],
  ])("uses RPC %s", async (call, name, args) => {
    await call();
    expect(fake.rpc).toHaveBeenCalledWith(name, args);
  });
  it.each([
    [() => menu.deleteCategory("c"), "CATEGORY_NOT_EMPTY"],
    [() => tables.deleteTable("t"), "TABLE_HAS_OPEN_BILL"],
    [() => menu.reorderCategories(["a"]), "STORE_SUSPENDED"],
    [() => tables.rotateTableQr("t"), "NOT_FOUND"],
    [() => blocks.unblockClient("foreign"), "NOT_FOUND"],
  ])("maps RPC rejection", async (call, code) => {
    rpcError = { code: "P0001", message: code };
    await expect(call()).rejects.toMatchObject({ code });
  });
  it("lists blocks via RPC and strips internal hash fields", async () => {
    rpcData = [
      {
        id: "b",
        kind: "device",
        source_order: { id: "o", value_hash: "secret" },
        value_hash: "secret",
      },
    ];
    const rows = await blocks.listBlockedClients();
    expect(fake.rpc).toHaveBeenCalledWith("list_blocked_clients", {
      p_include_expired: false,
    });
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
  it("unblocks by record id and adapts numeric R9 count to the existing boolean signature", async () => {
    rpcData = { id: "b", unblocked: true };
    expect(await blocks.unblockClient("b")).toEqual(rpcData);
    expect(fake.rpc).toHaveBeenCalledWith("unblock_client", {
      p_block_id: "b",
    });
    for (const count of [0, 1, 2]) {
      rpcData = { blocked: count, cancelled: false, expires_at: "ignored" };
      expect(await blocks.blockClientFromOrder("o")).toEqual({
        blocked: count > 0,
        cancelled: false,
      });
    }
    expect(fake.rpc).toHaveBeenLastCalledWith("block_client_from_order", {
      p_order_id: "o",
      p_cancel: true,
      p_include_ip: false,
      p_days: 7,
    });
    await expect(blocks.blocksMockAction(true)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });
});
describe("Storage validation", () => {
  const bytes = {
    "image/jpeg": [255, 216, 255],
    "image/png": [137, 80, 78, 71, 13, 10, 26, 10],
    "image/webp": [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80],
  };
  it.each(Object.entries(bytes))(
    "uploads validated %s under this store",
    async (type, data) => {
      const file = new File([new Uint8Array(data)], "unsafe.svg", { type });
      const progress = vi.fn();
      const paths = await menu.uploadItemImage(file, progress);
      expect(paths.image_path).toMatch(
        new RegExp(`^${storeId}/items/[0-9a-f-]{36}\\.(jpg|png|webp)$`),
      );
      expect(paths.thumb_path).toMatch(/_thumb\.(jpg|png|webp)$/);
      expect(fake.bucket).toHaveBeenCalledWith("menu-images");
      expect(fake.upload).toHaveBeenCalledWith(paths.image_path, file, {
        contentType: type,
        upsert: false,
      });
      expect(progress.mock.calls.flat()).toEqual([0, 50, 100]);
      expect(await uploadLogo(file)).toMatch(new RegExp(`^${storeId}/logo/`));
    },
  );
  it("rejects oversize, MIME spoofing and bad magic before any upload", async () => {
    await expect(
      menu.uploadItemImage(
        new File([new Uint8Array(2097153)], "a.jpg", { type: "image/jpeg" }),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    for (const file of [
      new File(["html"], "a.png", { type: "image/png" }),
      new File([new Uint8Array(bytes["image/png"])], "a.jpg", {
        type: "image/jpeg",
      }),
      new File(["svg"], "a.svg", { type: "image/svg+xml" }),
    ])
      await expect(uploadLogo(file)).rejects.toMatchObject({
        code: "UNSUPPORTED_FILE_TYPE",
      });
    expect(fake.upload).not.toHaveBeenCalled();
  });
  it("accepts exactly 2 MB and hides storage failure details", async () => {
    const content = new Uint8Array(2097152);
    content.set(bytes["image/jpeg"]);
    const file = new File([content], "a.jpg", { type: "image/jpeg" });
    expect(await uploadLogo(file)).toContain("/logo/");
    fake.upload.mockResolvedValueOnce({
      error: { message: "private storage URL" },
    });
    await expect(uploadLogo(file)).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      message: "上传失败，请重试",
    });
    status = "suspended";
    await expect(uploadLogo(file)).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
  });
});
