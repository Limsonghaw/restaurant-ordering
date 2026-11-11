"use client";
import Image from "next/image";
import { useUnsavedChanges } from "./unsaved-c";
import { useCallback, useEffect, useState, type DragEvent } from "react";
import {
  getMenuForStore,
  imageUrl,
  getSession,
  onSessionChange,
  createCategory,
  renameCategory,
  deleteCategory,
  setCategoryHidden,
  reorderCategories,
  createItem,
  updateItem,
  deleteItem,
  setItemHidden,
  setItemSoldOut,
  reorderItems,
  uploadItemImage,
  DataError,
  type StoreMenu,
  type ManagedItem,
  type ItemInput,
} from "../data";
import { formatMoney, parseMoneyInput, errorMessage } from "../format";
import {
  Button,
  Modal,
  ConfirmDialog,
  Skeleton,
  ErrorState,
  Toggle,
} from "./common";
const blank = (category_id: string): ItemInput => ({
  name: "",
  category_id,
  description: "",
  price_cents: 0,
  image_path: null,
  thumb_path: null,
  is_sold_out: false,
  is_hidden: false,
});
export function MenuManagement() {
  // 最终以后端校验为准。
  const [menu, setMenu] = useState<StoreMenu>();
  const [loadError, setLoadError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const [nonempty, setNonempty] = useState(false);
  const closeNonempty = useCallback(() => setNonempty(false), []);
  const [suspended, setSuspended] = useState(false);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<{ id?: string; name: string }>();
  const [editing, setEditing] = useState<{ id?: string; input: ItemInput }>();
  const [price, setPrice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    text: string;
    run: () => Promise<unknown>;
  }>();
  const [drag, setDrag] = useState<{
    kind: "category" | "item";
    id: string;
    category?: string;
  }>();
  const load = useCallback(() => {
    return Promise.all([getMenuForStore(), getSession()])
      .then(([m, s]) => {
        setMenu(m);
        setSuspended(s?.store?.status === "suspended");
        setLoadError(undefined);
      })
      .catch(setLoadError);
  }, []);
  useEffect(() => {
    load();
    return onSessionChange(() => load());
  }, [load]);
  const { request: requestLeave, dialog: unsavedDialog } =
    useUnsavedChanges(dirty);
  const closeEditor = useCallback(
    () =>
      requestLeave(() => {
        setEditing(undefined);
        setCategory(undefined);
        setDirty(false);
        setFields({});
      }),
    [requestLeave],
  );
  const closeConfirm = useCallback(() => setConfirm(undefined), []);
  async function action(run: () => Promise<unknown>, success = "已保存") {
    setBusy(true);
    try {
      await run();
      setMessage(success);
      await load();
      return true;
    } catch (e) {
      if (e instanceof DataError && e.code === "STORE_SUSPENDED") {
        setSuspended(true);
        setMessage("店铺已被平台停用，请联系平台");
      } else if (e instanceof DataError && e.code === "CATEGORY_NOT_EMPTY")
        setNonempty(true);
      else setMessage("操作没有成功，请重试");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function toggle(
    kind: "category" | "sold-out" | "item",
    id: string,
    value: boolean,
  ) {
    const previous = menu;
    setMenu((m) =>
      m
        ? kind === "category"
          ? {
              ...m,
              categories: m.categories.map((c) =>
                c.id === id ? { ...c, is_hidden: value } : c,
              ),
            }
          : {
              ...m,
              items: m.items.map((i) =>
                i.id === id
                  ? {
                      ...i,
                      [kind === "item" ? "is_hidden" : "is_sold_out"]: value,
                    }
                  : i,
              ),
            }
        : m,
    );
    const run =
      kind === "category"
        ? () => setCategoryHidden(id, value)
        : kind === "item"
          ? () => setItemHidden(id, value)
          : () => setItemSoldOut(id, value);
    const message =
      kind === "category"
        ? value
          ? "已隐藏分类，顾客看不到这个分类和其中的菜品"
          : "已取消隐藏"
        : kind === "item"
          ? value
            ? "已隐藏，顾客看不到这道菜"
            : "已取消隐藏"
          : value
            ? "已标记售完"
            : "已恢复供应";
    if (!(await action(run, message))) setMenu(previous);
  }
  function openItem(
    item?: ManagedItem,
    categoryId = menu?.categories[0]?.id ?? "",
  ) {
    setFields({});
    setEditing(
      item
        ? {
            id: item.id,
            input: {
              name: item.name,
              category_id: item.category_id,
              description: item.description,
              price_cents: item.price_cents,
              image_path: item.image_path,
              thumb_path: item.thumb_path,
              is_sold_out: item.is_sold_out,
              is_hidden: item.is_hidden,
            },
          }
        : { input: blank(categoryId) },
    );
    setPrice(item ? formatMoney(item.price_cents).slice(3) : "");
    setDirty(false);
    setProgress(0);
  }
  function change(patch: Partial<ItemInput>) {
    setEditing((e) => (e ? { ...e, input: { ...e.input, ...patch } } : e));
    setDirty(true);
  }
  async function saveItem() {
    if (!editing) return;
    const input = editing.input;
    const cents = parseMoneyInput(price);
    const errors: Record<string, string> = {};
    if (!input.name.trim()) errors.name = "请填写菜名";
    else if (input.name.length > 40) errors.name = "菜名最多 40 字";
    if (!input.category_id) errors.category_id = "请选择分类";
    if (cents === null) errors.price = "价格格式不正确";
    if (input.description.length > 300) errors.description = "介绍最多 300 字";
    setFields(errors);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const data = { ...input, price_cents: cents! };
      if (editing.id) await updateItem(editing.id, data);
      else await createItem(data);
      setEditing(undefined);
      setDirty(false);
      setMessage("已保存");
      await load();
    } catch (e) {
      if (e instanceof DataError && e.details.field)
        setFields({ [String(e.details.field)]: e.message });
      setMessage("保存没有成功，请重试");
    } finally {
      setBusy(false);
    }
  }
  function removeItem(item: Pick<ManagedItem, "id" | "name">) {
    setConfirm({
      title: `确定删除「${item.name}」？`,
      text: "删除后顾客看不到这道菜，后台也不再显示；已下过单的历史记录不受影响。只是暂时不卖可以用「售完」或「隐藏」。",
      run: async () => {
        await deleteItem(item.id);
        setEditing(undefined);
        setDirty(false);
      },
    });
  }
  async function upload(file?: File) {
    if (!file) return;
    setUploading(true);
    setProgress(0);
    try {
      const paths = await uploadItemImage(file, setProgress);
      change(paths);
      setFields((f) => ({ ...f, image: "" }));
    } catch (e) {
      setFields((f) => ({
        ...f,
        image: e instanceof DataError ? e.message : "上传失败，请重试",
      }));
    } finally {
      setUploading(false);
    }
  }
  function move(ids: string[], id: string, offset: number) {
    const at = ids.indexOf(id),
      to = at + offset;
    if (at < 0 || to < 0 || to >= ids.length) return ids;
    const next = [...ids];
    [next[at], next[to]] = [next[to], next[at]];
    return next;
  }
  function drop(
    e: DragEvent,
    id: string,
    kind: "category" | "item",
    categoryId?: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    if (
      !menu ||
      !drag ||
      drag.kind !== kind ||
      drag.id === id ||
      drag.category !== categoryId
    )
      return;
    const ids =
      kind === "category"
        ? menu.categories.map((c) => c.id)
        : menu.items
            .filter((i) => i.category_id === categoryId)
            .map((i) => i.id);
    const from = ids.indexOf(drag.id),
      to = ids.indexOf(id);
    ids.splice(from, 1);
    ids.splice(to, 0, drag.id);
    void action(
      () =>
        kind === "category"
          ? reorderCategories(ids)
          : reorderItems(categoryId!, ids),
      "顺序已保存",
    );
    setDrag(undefined);
  }
  if (loadError)
    return <ErrorState message={errorMessage(loadError)} retry={load} />;
  if (!menu) return <Skeleton />;
  return (
    <main>
      {unsavedDialog}
      {nonempty && (
        <Modal title="请先移走或删除这个分类下的菜品" onClose={closeNonempty}>
          <Button onClick={closeNonempty}>知道了</Button>
        </Modal>
      )}
      <header className="management-header">
        <h1>菜单管理</h1>
        {!suspended && (
          <div className="actions">
            <Button
              onClick={() => {
                setCategory({ name: "" });
                setDirty(false);
                setFields({});
              }}
            >
              新增分类
            </Button>
            <Button
              disabled={!menu.categories.length}
              onClick={() => openItem()}
            >
              新增菜品
            </Button>
          </div>
        )}
      </header>
      {message && <p role="status">{message}</p>}
      {!menu.categories.length && (
        <div className="card empty">
          还没有菜单，先新增一个分类，例如「主食」
        </div>
      )}
      <div className="management-grid">
        <nav aria-label="分类" className="category-nav">
          {menu.categories.map((c) => (
            <a key={c.id} href={`#category-${c.id}`}>
              {c.name}（{c.itemCount}）{c.is_hidden ? " · 已隐藏" : ""}
            </a>
          ))}
        </nav>
        <div>
          {menu.categories.map((c, index) => {
            const items = menu.items.filter((i) => i.category_id === c.id);
            return (
              <details
                open
                key={c.id}
                id={`category-${c.id}`}
                className={`card category-card ${c.is_hidden ? "is-hidden" : ""}`}
                draggable={!suspended && !busy}
                onDragStart={(e) => {
                  if (e.target === e.currentTarget)
                    setDrag({ kind: "category", id: c.id });
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e, c.id, "category")}
              >
                <summary
                  draggable={!suspended && !busy}
                  onDragStart={() => setDrag({ kind: "category", id: c.id })}
                >
                  <strong>{c.name}</strong>（{c.itemCount} 道）
                  {c.is_hidden && <span>已隐藏</span>}
                </summary>
                <div className="row-actions">
                  <Toggle
                    checked={c.is_hidden}
                    disabled={suspended || busy}
                    onChange={(v) => void toggle("category", c.id, v)}
                  >
                    隐藏分类
                  </Toggle>
                  {!suspended && (
                    <>
                      <Button
                        variant="text"
                        onClick={() => {
                          setCategory({ id: c.id, name: c.name });
                          setDirty(false);
                          setFields({});
                        }}
                      >
                        编辑分类
                      </Button>
                      <Button
                        variant="text"
                        onClick={() => {
                          if (c.itemCount) setNonempty(true);
                          else
                            setConfirm({
                              title: `确定删除分类「${c.name}」？`,
                              text: "",
                              run: () => deleteCategory(c.id),
                            });
                        }}
                      >
                        删除分类
                      </Button>
                      <Button
                        variant="text"
                        disabled={busy || index === 0}
                        onClick={() =>
                          void action(() =>
                            reorderCategories(
                              move(
                                menu.categories.map((c) => c.id),
                                c.id,
                                -1,
                              ),
                            ),
                          )
                        }
                      >
                        上移
                      </Button>
                      <Button
                        variant="text"
                        disabled={busy || index === menu.categories.length - 1}
                        onClick={() =>
                          void action(() =>
                            reorderCategories(
                              move(
                                menu.categories.map((c) => c.id),
                                c.id,
                                1,
                              ),
                            ),
                          )
                        }
                      >
                        下移
                      </Button>
                    </>
                  )}
                </div>
                {!items.length && (
                  <p>
                    这个分类还没有菜品{" "}
                    {!suspended && (
                      <Button
                        variant="text"
                        onClick={() => openItem(undefined, c.id)}
                      >
                        新增菜品
                      </Button>
                    )}
                  </p>
                )}
                {items.map((item, n) => (
                  <article
                    key={item.id}
                    className={`menu-admin-row ${item.is_hidden ? "is-hidden" : ""}`}
                    draggable={!suspended && !busy}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      setDrag({ kind: "item", id: item.id, category: c.id });
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => drop(e, item.id, "item", c.id)}
                  >
                    <div className="menu-admin-title">
                      {imageUrl(item.thumb_path) ? (
                        <Image
                          unoptimized
                          loading="eager"
                          width={64}
                          height={64}
                          className="admin-thumb"
                          src={imageUrl(item.thumb_path)!}
                          alt=""
                        />
                      ) : (
                        <span className="admin-thumb muted">无图</span>
                      )}
                      <div>
                        <strong>{item.name}</strong>
                        <p>
                          {formatMoney(item.price_cents)}{" "}
                          {item.is_hidden && " · 已隐藏"}
                        </p>
                      </div>
                    </div>
                    <div className="row-actions">
                      <Toggle
                        disabled={suspended || busy}
                        checked={item.is_sold_out}
                        onChange={(v) => void toggle("sold-out", item.id, v)}
                      >
                        售完
                      </Toggle>
                      <Toggle
                        disabled={suspended || busy}
                        checked={item.is_hidden}
                        onChange={(v) => void toggle("item", item.id, v)}
                      >
                        隐藏
                      </Toggle>
                      {!suspended && (
                        <>
                          <Button variant="text" onClick={() => openItem(item)}>
                            编辑
                          </Button>
                          <Button
                            variant="text"
                            disabled={busy || n === 0}
                            onClick={() =>
                              void action(() =>
                                reorderItems(
                                  c.id,
                                  move(
                                    items.map((i) => i.id),
                                    item.id,
                                    -1,
                                  ),
                                ),
                              )
                            }
                          >
                            上移
                          </Button>
                          <Button
                            variant="text"
                            disabled={busy || n === items.length - 1}
                            onClick={() =>
                              void action(() =>
                                reorderItems(
                                  c.id,
                                  move(
                                    items.map((i) => i.id),
                                    item.id,
                                    1,
                                  ),
                                ),
                              )
                            }
                          >
                            下移
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => removeItem(item)}
                          >
                            删除
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </details>
            );
          })}
        </div>
      </div>
      {category && !suspended && (
        <Modal
          title={category.id ? "编辑分类" : "新增分类"}
          onClose={closeEditor}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!category.name.trim() || category.name.length > 30) {
                setFields({ name: "请填写分类名（最多 30 字）" });
                return;
              }
              void action(() =>
                category.id
                  ? renameCategory(category.id, category.name)
                  : createCategory(category.name),
              ).then((ok) => {
                if (ok) {
                  setCategory(undefined);
                  setDirty(false);
                }
              });
            }}
          >
            <label>
              分类名
              <input
                maxLength={30}
                value={category.name}
                onChange={(e) => {
                  setCategory({ ...category, name: e.target.value });
                  setDirty(true);
                }}
              />
            </label>
            <p className="field-error">{fields.name}</p>
            <Button busy={busy} type="submit">
              保存
            </Button>
            <Button variant="secondary" type="button" onClick={closeEditor}>
              取消
            </Button>
          </form>
        </Modal>
      )}
      {editing && !suspended && (
        <div className="item-editor">
          <Modal
            title={editing.id ? "编辑菜品" : "新增菜品"}
            onClose={closeEditor}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveItem();
              }}
            >
              <label>
                名称
                <input
                  maxLength={40}
                  value={editing.input.name}
                  onChange={(e) => change({ name: e.target.value })}
                />
                <span className="field-error">{fields.name}</span>
              </label>
              <label>
                分类
                <select
                  value={editing.input.category_id}
                  onChange={(e) => change({ category_id: e.target.value })}
                >
                  <option value="">请选择分类</option>
                  {menu.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span className="field-error">{fields.category_id}</span>
              </label>
              <label>
                价格（RM）
                <input
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => {
                    setPrice(e.target.value);
                    setDirty(true);
                  }}
                />
                <span className="field-error">{fields.price}</span>
              </label>
              <label>
                图片
                <span className="button secondary">
                  {fields.image ? "重新上传" : "上传 / 更换图片"}
                </span>
                <input
                  className="upload-input"
                  aria-label="图片"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploading}
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
              </label>
              <p>JPG、PNG 或 WebP，最大 2 MB</p>
              {progress > 0 && <progress value={progress} max={100} />}
              <p className="field-error">{fields.image}</p>
              {editing.input.thumb_path && (
                <>
                  <Image
                    unoptimized
                    loading="eager"
                    width={160}
                    height={160}
                    className="admin-preview"
                    src={editing.input.thumb_path}
                    alt="菜品预览"
                  />
                  <Button
                    variant="text"
                    type="button"
                    onClick={() =>
                      change({ image_path: null, thumb_path: null })
                    }
                  >
                    移除图片
                  </Button>
                </>
              )}
              <label>
                介绍
                <textarea
                  maxLength={300}
                  value={editing.input.description}
                  onChange={(e) => change({ description: e.target.value })}
                />
                <span className="field-error">{fields.description}</span>
              </label>
              <Toggle
                checked={editing.input.is_sold_out}
                onChange={(v) => change({ is_sold_out: v })}
              >
                售完
              </Toggle>
              <Toggle
                checked={editing.input.is_hidden}
                onChange={(v) => change({ is_hidden: v })}
              >
                隐藏
              </Toggle>
              <div className="editor-footer">
                <Button type="submit" busy={busy} disabled={uploading}>
                  保存
                </Button>
                <Button type="button" variant="secondary" onClick={closeEditor}>
                  取消
                </Button>
                {editing.id && (
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() =>
                      removeItem({ id: editing.id!, name: editing.input.name })
                    }
                  >
                    删除菜品
                  </Button>
                )}
              </div>
            </form>
          </Modal>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          danger
          confirmText="确认删除"
          backText="取消"
          busy={busy}
          onClose={closeConfirm}
          onConfirm={() =>
            void action(confirm.run, "已删除").then((ok) => {
              if (ok) setConfirm(undefined);
            })
          }
        >
          {confirm.text}
        </ConfirmDialog>
      )}
    </main>
  );
}
