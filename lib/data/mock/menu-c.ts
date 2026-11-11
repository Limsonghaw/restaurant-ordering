import { DataError, type ItemInput, type StoreMenu } from "../types";
import { delay, readState, saveState } from "./state";
import { sessionC } from "./auth-c";
import type { State } from "./seed";
export async function storeContext(write = false) {
  const session = await sessionC();
  if (!session) throw new DataError("UNAUTHENTICATED", "请先登录");
  if (!session.store) throw new DataError("FORBIDDEN", "没有权限");
  if (write && session.store.status === "suspended")
    throw new DataError("STORE_SUSPENDED", "店铺已被平台停用，请联系平台");
  return session.store.id;
}
async function mutate<T>(fn: (s: State, id: string) => T): Promise<T> {
  await delay();
  const id = await storeContext(true);
  const state = readState();
  const result = fn(state, id);
  try {
    saveState(state);
  } catch {
    throw new DataError("UPLOAD_FAILED", "保存空间不足，请移除图片后重试");
  }
  window.dispatchEvent(new Event("ro-mock:change"));
  return result;
}
function validate(value: string, max: number, field: string) {
  if (!value.trim() || value.length > max)
    throw new DataError(
      "VALIDATION_FAILED",
      `请填写${field === "name" ? "名称" : field}（最多 ${max} 字）`,
      { field },
    );
}
function category(s: State, store: string, id: string) {
  const c = s.categories.find(
    (c) => c.store_id === store && c.id === id && !c.deleted,
  );
  if (!c) throw new DataError("NOT_FOUND", "分类不存在");
  return c;
}
function item(s: State, store: string, id: string) {
  const i = s.items.find(
    (i) => i.store_id === store && i.id === id && !i.deleted,
  );
  if (!i) throw new DataError("NOT_FOUND", "菜品不存在");
  return i;
}
// M4 includes hidden rows; internal fields and device identifiers never leave this layer.
export async function getMenuForStore(): Promise<StoreMenu> {
  await delay();
  const id = await storeContext();
  const s = readState();
  return {
    categories: s.categories
      .filter((c) => c.store_id === id && !c.deleted)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({
        id: c.id,
        name: c.name,
        sort_order: c.sort_order,
        is_hidden: c.hidden,
        itemCount: s.items.filter(
          (i) => i.store_id === id && i.category_id === c.id && !i.deleted,
        ).length,
      })),
    items: s.items
      .filter((i) => i.store_id === id && !i.deleted)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({
        id: i.id,
        category_id: i.category_id,
        name: i.name,
        description: i.description,
        price_cents: i.price_cents,
        image_path: i.image_path,
        thumb_path: i.thumb_path,
        is_sold_out: i.is_sold_out,
        is_hidden: i.hidden,
        sort_order: i.sort_order,
      })),
  };
}
// M5
export const createCategory = (name: string) =>
  mutate((s, id) => {
    validate(name, 30, "name");
    if (
      s.categories.filter((c) => c.store_id === id && !c.deleted).length >= 50
    )
      throw new DataError("VALIDATION_FAILED", "最多 50 个分类");
    const c = {
      id: crypto.randomUUID(),
      store_id: id,
      name: name.trim(),
      sort_order:
        Math.max(
          -1,
          ...s.categories
            .filter((c) => c.store_id === id && !c.deleted)
            .map((c) => c.sort_order),
        ) + 1,
      hidden: false,
      deleted: false,
    };
    s.categories.push(c);
    return c.id;
  });
export const renameCategory = (id: string, name: string) =>
  mutate((s, store) => {
    validate(name, 30, "name");
    category(s, store, id).name = name.trim();
  });
export const setCategoryHidden = (id: string, hidden: boolean) =>
  mutate((s, store) => {
    category(s, store, id).hidden = hidden;
  });
// R6
export const deleteCategory = (id: string) =>
  mutate((s, store) => {
    const c = category(s, store, id);
    if (
      s.items.some(
        (i) => i.store_id === store && i.category_id === id && !i.deleted,
      )
    )
      throw new DataError(
        "CATEGORY_NOT_EMPTY",
        "请先移走或删除这个分类下的菜品",
      );
    c.deleted = true;
  });
function reorder(ids: string[], all: string[], max: number) {
  if (
    ids.length > max ||
    ids.length !== all.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !all.includes(id))
  )
    throw new DataError("VALIDATION_FAILED", "排序列表不正确");
}
// R3 / R4
export const reorderCategories = (ids: string[]) =>
  mutate((s, store) => {
    reorder(
      ids,
      s.categories
        .filter((c) => c.store_id === store && !c.deleted)
        .map((c) => c.id),
      50,
    );
    ids.forEach((id, n) => {
      category(s, store, id).sort_order = n;
    });
  });
export const reorderItems = (category_id: string, ids: string[]) =>
  mutate((s, store) => {
    category(s, store, category_id);
    reorder(
      ids,
      s.items
        .filter(
          (i) =>
            i.store_id === store && i.category_id === category_id && !i.deleted,
        )
        .map((i) => i.id),
      500,
    );
    ids.forEach((id, n) => {
      item(s, store, id).sort_order = n;
    });
  });
function validateInput(s: State, store: string, input: ItemInput) {
  validate(input.name, 40, "name");
  category(s, store, input.category_id);
  if (input.description.length > 300)
    throw new DataError("VALIDATION_FAILED", "介绍最多 300 字", {
      field: "description",
    });
  if (
    !Number.isInteger(input.price_cents) ||
    input.price_cents < 0 ||
    input.price_cents > 999999
  )
    throw new DataError("VALIDATION_FAILED", "价格格式不正确", {
      field: "price",
    });
  for (const path of [input.image_path, input.thumb_path])
    if (
      path &&
      !path.startsWith("/mock/") &&
      !path.startsWith("data:image/webp;base64,")
    )
      throw new DataError("VALIDATION_FAILED", "图片格式不正确", {
        field: "image",
      });
}
// M6
export const createItem = (input: ItemInput) =>
  mutate((s, store) => {
    validateInput(s, store, input);
    if (s.items.filter((i) => i.store_id === store && !i.deleted).length >= 500)
      throw new DataError("VALIDATION_FAILED", "最多 500 道菜");
    const id = crypto.randomUUID();
    s.items.push({
      ...input,
      id,
      store_id: store,
      hidden: input.is_hidden,
      deleted: false,
      sort_order:
        Math.max(
          -1,
          ...s.items
            .filter(
              (i) =>
                i.store_id === store &&
                i.category_id === input.category_id &&
                !i.deleted,
            )
            .map((i) => i.sort_order),
        ) + 1,
    });
    return id;
  });
export const updateItem = (id: string, input: ItemInput) =>
  mutate((s, store) => {
    validateInput(s, store, input);
    Object.assign(item(s, store, id), input, { hidden: input.is_hidden });
  });
export const setItemSoldOut = (id: string, value: boolean) =>
  mutate((s, store) => {
    item(s, store, id).is_sold_out = value;
  });
export const setItemHidden = (id: string, value: boolean) =>
  mutate((s, store) => {
    item(s, store, id).hidden = value;
  });
// R5 soft_delete_item; historical order snapshots remain untouched.
export const deleteItem = (id: string) =>
  mutate((s, store) => {
    Object.assign(item(s, store, id), {
      deleted: true,
      deleted_at: new Date().toISOString(),
    });
  });
// M7 Storage: {store_id}/items/{uuid}.webp and {uuid}_thumb.webp.
export async function uploadItemImage(
  file: File,
  onProgress: (n: number) => void,
) {
  await delay();
  await storeContext(true);
  if (file.size > 2 * 1024 * 1024)
    throw new DataError("FILE_TOO_LARGE", "图片不能超过 2 MB");
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const webp =
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!jpg && !png && !webp)
    throw new DataError(
      "UNSUPPORTED_FILE_TYPE",
      "只支持 JPG、PNG 或 WebP 图片",
    );
  onProgress(15);
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const render = (thumb: boolean) => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1200 / Math.max(bitmap!.width, bitmap!.height));
      canvas.width = thumb ? 400 : Math.round(bitmap!.width * scale);
      canvas.height = thumb ? 400 : Math.round(bitmap!.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error();
      if (thumb) {
        const side = Math.min(bitmap!.width, bitmap!.height);
        ctx.drawImage(
          bitmap!,
          (bitmap!.width - side) / 2,
          (bitmap!.height - side) / 2,
          side,
          side,
          0,
          0,
          400,
          400,
        );
      } else ctx.drawImage(bitmap!, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/webp", 0.82);
      if (!url.startsWith("data:image/webp;")) throw Error();
      return url;
    };
    onProgress(60);
    const result = { image_path: render(false), thumb_path: render(true) };
    const probe = "ro-mock:upload-probe";
    localStorage.setItem(probe, JSON.stringify(result));
    localStorage.removeItem(probe);
    onProgress(100);
    return result;
  } catch {
    throw new DataError("UPLOAD_FAILED", "上传失败，请重试");
  } finally {
    bitmap?.close();
  }
}

export async function uploadLogo(file: File): Promise<string> {
  const { image_path } = await uploadItemImage(file, () => {});
  return image_path;
}
