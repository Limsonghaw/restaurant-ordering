import type * as Mock from "../mock/menu-c";
import type { ItemInput, StoreMenu } from "../types";
import { getClient, storeContext } from "./me";
import { dataError, result } from "./pg-errors";
import { uploadItemImage as uploadImage, uploadLogo as uploadStoreLogo } from "./images";

const categoryColumns = "id,name,sort_order,is_hidden";
const itemColumns = "id,category_id,name,description,price_cents,image_path,thumb_path,is_sold_out,is_hidden,sort_order";
export const getMenuForStore: typeof Mock.getMenuForStore = async () => {
  const store = await storeContext();
  const client = (await getClient());
  const [categories, items] = await Promise.all([
    result<Omit<StoreMenu["categories"][number], "itemCount">[]>(client.from("categories").select(categoryColumns).eq("store_id", store).is("deleted_at", null).order("sort_order").order("id")),
    result<StoreMenu["items"]>(client.from("items").select(itemColumns).eq("store_id", store).is("deleted_at", null).order("sort_order").order("id")),
  ]);
  return { categories: categories.map(c => ({ ...c, itemCount: items.filter(i => i.category_id === c.id).length })), items };
};
async function insertRow(table: "categories" | "items", values: Record<string, unknown>): Promise<string> {
  const store = await storeContext(true);
  const client = (await getClient());
  let query = client.from(table).select("sort_order").eq("store_id", store).is("deleted_at", null);
  if (table === "items") query = query.eq("category_id", values.category_id);
  const rows = await result<{ sort_order: number }[]>(query.order("sort_order", { ascending: false }).limit(1));
  const row = await result<{ id: string }>(client.from(table).insert({ ...values, store_id: store, sort_order: (rows[0]?.sort_order ?? 0) + 10 }).select("id").single());
  return row.id;
}
async function updateRow(table: "categories" | "items", id: string, values: Record<string, unknown>): Promise<void> {
  const store = await storeContext(true);
  const rows = await result<{ id: string }[]>((await getClient()).from(table).update(values).eq("store_id", store).eq("id", id).is("deleted_at", null).select("id"));
  if (!rows.length) throw dataError("NOT_FOUND");
}
function name(value: string, max: number): string {
  if (!value.trim() || value.length > max) throw dataError("VALIDATION_FAILED");
  return value.trim();
}
function itemInput(input: ItemInput): Record<string, unknown> {
  if (input.description.length > 300 || !Number.isInteger(input.price_cents) || input.price_cents < 0 || input.price_cents > 999999)
    throw dataError("VALIDATION_FAILED");
  return { name: name(input.name, 40), category_id: input.category_id, description: input.description,
    price_cents: input.price_cents, image_path: input.image_path, thumb_path: input.thumb_path,
    is_sold_out: input.is_sold_out, is_hidden: input.is_hidden };
}
export const createCategory: typeof Mock.createCategory = async value => insertRow("categories", { name: name(value, 30) });
export const renameCategory: typeof Mock.renameCategory = async (id, value) => updateRow("categories", id, { name: name(value, 30) });
export const setCategoryHidden: typeof Mock.setCategoryHidden = async (id, value) => updateRow("categories", id, { is_hidden: value });
export const deleteCategory: typeof Mock.deleteCategory = async id => { await result((await getClient()).rpc("delete_category", { p_category_id: id })); };
function validateOrder(ids: string[], max: number) {
  if (!ids.length || ids.length > max || new Set(ids).size !== ids.length || ids.some(id => !id)) throw dataError("VALIDATION_FAILED");
}
export const reorderCategories: typeof Mock.reorderCategories = async ids => {
  validateOrder(ids, 50);
  await result((await getClient()).rpc("reorder_categories", { p_ids: ids }));
};
export const reorderItems: typeof Mock.reorderItems = async (category, ids) => {
  validateOrder(ids, 500);
  await result((await getClient()).rpc("reorder_items", { p_category_id: category, p_ids: ids }));
};
export const createItem: typeof Mock.createItem = async input => insertRow("items", itemInput(input));
export const updateItem: typeof Mock.updateItem = async (id, input) => updateRow("items", id, itemInput(input));
export const setItemSoldOut: typeof Mock.setItemSoldOut = async (id, value) => updateRow("items", id, { is_sold_out: value });
export const setItemHidden: typeof Mock.setItemHidden = async (id, value) => updateRow("items", id, { is_hidden: value });
export const deleteItem: typeof Mock.deleteItem = async id => { await result((await getClient()).rpc("soft_delete_item", { p_item_id: id })); };
export const uploadItemImage: typeof Mock.uploadItemImage = uploadImage;
export const uploadLogo: typeof Mock.uploadLogo = uploadStoreLogo;
