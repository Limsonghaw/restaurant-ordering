# 运维手册：在 Supabase SQL Editor 里紧急停店与恢复

- 适用时间：平台管理员的 TOTP（aal2）上线之前。0003 起管理员必须是 aal2 才能用管理页和 `admin_set_store_status`，TOTP 在 PR5 才做，所以这段时间出事只能用本手册。TOTP 上线后改用管理页，本手册只作备用。
- 依据：第二轮安全复查（rereview-2）§4 第 6 项、M-4。
- 本手册里的 SQL 已在本地 PGlite 测过（`supabase/tests/runbook_suspend.test.mjs`，会直接读取本文件里的 SQL 运行）。本地是超级用户，真实 Supabase 的 SQL Editor 用的是 `postgres` 角色，权限略有不同，第一次正式使用前请在 Preview 项目里完整走一遍。

## 0. 谁可以执行

1. 只有平台负责人（Song Haw）和他书面指定的人可以执行。名单写在内部事件记录里，人员变动时更新。
2. 执行人必须能进入生产项目的 SQL Editor。Supabase 组织里哪些角色能用 SQL Editor，以控制台 Team / Access control 页面实际为准；不要把这些角色给名单以外的人。
   - **Supabase 组织必须强制开启 MFA**（组织设置 → Security →「Require MFA to access organization」，只有组织 Owner 能开，由 Song Haw 本人设置；需要 Pro 及以上方案）。开启后没有两步验证的成员进不了任何项目，也就进不了 SQL Editor。见 `docs/launch-checklist-twilio.md`「Supabase 组织：强制 MFA」（rereview-3 低-3）。
   - 每次人员变动、以及每季度一次，核对组织成员名单与上面的书面名单一致。
3. 建议两个人一起做：一个人执行，另一个人对着第 1 步的查询结果核对店铺 id，再点 Run。
4. 每次执行都要写原因、操作人和事件编号（第 3、6 步的 SQL 里有位置）。审计日志 180 天后会被自动清理，所以同时在内部事件记录里留一份。

## 1. 先确认是哪家店

把下面 SQL 复制到 SQL Editor，替换尖括号里的内容后运行。不用的条件保持尖括号原样，不要改成空字符串（空字符串会匹配所有店）。

```sql
-- RUNBOOK:lookup  第 1 步：找店（只读）
select s.id as store_id, s.slug, s.name, s.status, s.status_reason, s.status_changed_at,
       m.user_id as owner_uid, u.email as owner_email, u.phone as owner_phone,
       (select max(o.created_at) from public.orders o where o.store_id = s.id) as last_order_at,
       (select count(*) from public.bills b where b.store_id = s.id and b.status = 'open') as open_bills
  from public.stores s
  left join public.store_members m on m.store_id = s.id and m.role = 'owner'
  left join auth.users u on u.id = m.user_id
 where s.slug = '<店铺 slug>'
    or s.name ilike '%' || '<店名关键字>' || '%'
    or u.email = lower('<店主邮箱>')
    or u.phone = '<店主手机，例如 60123456789>'
 order by s.created_at desc
 limit 20;
```

看结果：

- 只能有 1 行是你要找的店。核对店名、店主邮箱或手机号、最近下单时间。
- 记下 `store_id` 和 `owner_uid`，后面每一步都要用。
- `status` 已经是 `suspended`：说明已经停了，不用再做第 3 步。
- `open_bills` 大于 0：停用后店家不能结账，这些账单会一直挂着，恢复后才能继续。必要时先电话通知店家。

## 2. 停用前再看一眼

```sql
-- RUNBOOK:check  第 2 步：只读，确认当前状态
select id, name, status, status_reason, status_changed_at, is_accepting_orders
  from public.stores where id = '<店铺 id>';
```

结果应当是 1 行，`status = active`。

## 3. 停用

替换 `<店铺 id>`、`<原因>`（200 字以内，只给平台看，店家看不到）、`<操作人>`、`<事件编号>`，整段一起运行。这是一条语句，要么全部成功，要么什么都不改。

文本用 `$r$…$r$` 包住（dollar quoting，rereview-3 低-3）：只替换中间的尖括号，**保留两边的 `$r$`**；原因里有单引号（例如 `店主's 账号`）也不会报错。唯一的限制是文本里不能出现 `$r$` 这三个字符。审计 details 会自动记下当前数据库角色（`db_user` = current_user、`session_user`），和你填的操作人一起留痕。

```sql
-- RUNBOOK:suspend  第 3 步：停用店铺并写审计日志
with s as (
  update public.stores
     set status = 'suspended', status_reason = $r$<原因>$r$, status_changed_at = now()
   where id = '<店铺 id>' and status = 'active'
  returning id
)
insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
select s.id, null, 'admin', 'store.status', 'stores', s.id,
       jsonb_build_object('status', 'suspended', 'reason', $r$<原因>$r$, 'via', 'sql_editor',
                          'operator', $r$<操作人>$r$, 'ticket', $r$<事件编号>$r$,
                          'db_user', current_user, 'session_user', session_user)
  from s
returning store_id, action, details, created_at;
```

看结果：

- 返回 1 行：停用成功，审计日志也写好了。
- 返回 0 行：什么都没改。可能是 id 填错，或者店已经是停用状态。回到第 1 步重查。
- 报错 `value too long` 或 `check constraint`：原因超过 200 字，缩短后重跑。

审计日志的 `actor_type` 是 `admin`，店家读不到这一行（H-1），所以原因不会泄露给店家。

## 4. 验证已经生效

整段运行。它会临时建一个只在本次连接里存在的小函数，用顾客和店主的身份各试一次，所有试写都会自动撤销，不会改任何数据。

```sql
-- RUNBOOK:verify  第 4 步：验证（不会改数据）
create or replace function pg_temp.try_sql(p_sql text, p_as_uid uuid default null) returns text
language plpgsql as $$
declare v_res text;
begin
  begin
    if p_as_uid is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', p_as_uid, 'role', 'authenticated')::text, true);
      set local role authenticated;
    end if;
    execute p_sql;
    v_res := '可以执行';
    raise exception 'RUNBOOK_UNDO';   -- 不管成功与否，都撤销这次试验
  exception when others then
    if sqlerrm <> 'RUNBOOK_UNDO' then v_res := '被拦住：' || sqlerrm; end if;
  end;
  return v_res;
end $$;

select s.name, s.status,
       pg_temp.try_sql(format('select public.customer_get_menu(%L, %L, %s)', t.store_id, t.id, t.qr_version)) as customer_menu,
       pg_temp.try_sql(format('select private.resolve_table(%L, %L, %s, %L)', t.store_id, t.id, t.qr_version, 'order')) as customer_order,
       pg_temp.try_sql(format('select 1 / count(*) from public.stores where id = %L', s.id), '<店主 uid>') as owner_read,
       pg_temp.try_sql(format('update public.stores set is_accepting_orders = is_accepting_orders where id = %L', s.id), '<店主 uid>') as owner_write
  from public.stores s
  left join public.dining_tables t on t.store_id = s.id and t.deleted_at is null and t.is_active
 where s.id = '<店铺 id>'
 order by t.sort_order nulls last
 limit 1;
```

停用后应当看到：

| 列 | 应当是 | 意思 |
|---|---|---|
| status | suspended | 已停用 |
| customer_menu | 被拦住：STORE_SUSPENDED | 顾客扫码看不到菜单 |
| customer_order | 被拦住：STORE_SUSPENDED | 顾客不能下单（下单接口用的就是这道检查） |
| owner_read | 可以执行 | 店家还能登录查看（只读） |
| owner_write | 被拦住：STORE_SUSPENDED | 店家不能改任何东西 |

- 如果 `customer_menu` 是空的：这家店没有可用的桌子，顾客端本来就进不来，只看其他三列。
- 如果 `owner_read` / `owner_write` 报 `permission denied to set role`：说明当前角色不能切换身份，改用 SQL Editor 自带的角色切换（以控制台实际页面为准）或只看前两列。
- 再用手机实际扫一次这家店的桌码，应当看到「店铺暂停服务」类提示；店家后台应当显示「店铺已被平台停用，请联系平台」。

## 5. 通知

- 通知店家时只说「店铺已被平台停用，请联系平台」，不要转述内部原因，除非负责人决定告知。
- 在内部事件记录里写：时间（UTC+8）、店铺 id、原因、操作人、第 4 步结果截图。

## 6. 恢复

替换后整段运行（文本同样保留两边的 `$r$`）：

```sql
-- RUNBOOK:restore  第 6 步：恢复店铺并写审计日志
with s as (
  update public.stores
     set status = 'active', status_reason = null, status_changed_at = now()
   where id = '<店铺 id>' and status = 'suspended'
  returning id
)
insert into public.audit_logs (store_id, actor_user_id, actor_type, action, entity, entity_id, details)
select s.id, null, 'admin', 'store.status', 'stores', s.id,
       jsonb_build_object('status', 'active', 'reason', $r$<恢复原因>$r$, 'via', 'sql_editor',
                          'operator', $r$<操作人>$r$, 'ticket', $r$<事件编号>$r$,
                          'db_user', current_user, 'session_user', session_user)
  from s
returning store_id, action, details, created_at;
```

- 返回 1 行：已恢复。再跑一次第 4 步，应当看到 `customer_menu`、`customer_order`、`owner_write` 都是「可以执行」（`customer_order` 如果显示 STORE_CLOSED，是店家自己关了「营业中」，属正常）。
- 返回 0 行：店本来就不是停用状态，或 id 填错。

## 7. 回滚（做错了怎么办）

1. 停错了店：立刻对这家店执行第 6 步恢复，`<恢复原因>` 写「误操作回滚」，事件编号写同一个；然后回到第 1 步找对的店再停。
2. 恢复错了：对这家店重新执行第 3 步。
3. 不要删除或修改 audit_logs 里的记录，误操作和回滚都要留痕。
4. 第 3、6 步每次只改一家店（按 id），不要改成按名字或批量 `update`。
5. 第 1、2、4 步不会改数据，可以随时重跑。

## 8. 停用期间的影响

- 顾客：看不到菜单、不能下单、查进度也会报 STORE_SUSPENDED；已经拿到的账单页会显示错误提示。
- 店家：可以登录、查看订单和账单、看统计和拉黑列表；不能接单、改状态、结账、改菜单和资料。未结账单会一直挂着，恢复后再处理。
- 菜品图片：图片桶是公开的，知道 URL 仍能打开图片（已知限制，见设计文档 §7）。
