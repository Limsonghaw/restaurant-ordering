-- pgTAP：真实 Supabase 角色下的执行身份（L-N7）。本地 PGlite 跑不了，在 `supabase start` 后执行：
--   supabase test db          （CLI 会运行 supabase/tests/database/*.test.sql）
-- 覆盖：supabase_auth_admin 写 auth.users 时触发器能建店、首次验证清空密码、hook 的执行权限、
--       customer_api 登录角色、pg_cron 定时任务已注册、legacy 角色切换已撤销。
-- PR1b 补强（rereview-2 L-8、M-3、L-1、H-1）：customer_api 连接数与两个超时、purge 不删已验证账号、
--       INSERT 时已验证也擦密码、首次验证删除已有会话、店家读不到 stores.status_reason。crypt / gen_salt 写全 extensions.
-- rereview-3 低-6：H-1 再补两条（店家读不到 blocked_clients.value_hash、不能直接 delete 拉黑记录），共 25 条。
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- 1. GoTrue 的真实身份插入未验证用户（带密码，模拟抢注）
set local role supabase_auth_admin;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
        'pgtap-victim@example.com', extensions.crypt('attacker-pass', extensions.gen_salt('bf')), '{"store_name":"pgTAP 店"}', '{"provider":"email"}', now(), now());
-- L-1：模拟一条已有会话（正常不会出现；auth.sessions 的必填列以真实项目为准，需确认）
insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', now(), now());
reset role;
select is((select count(*)::int from public.store_members where user_id = '11111111-1111-4111-8111-111111111111'), 0, '未验证不建店');

-- 2. 以 supabase_auth_admin 验证 → 建店 + 清空密码
set local role supabase_auth_admin;
update auth.users set email_confirmed_at = now() where id = '11111111-1111-4111-8111-111111111111';
reset role;
select is((select count(*)::int from public.store_members where user_id = '11111111-1111-4111-8111-111111111111'), 1, 'supabase_auth_admin 验证后触发器建店');
select is((select coalesce(encrypted_password, '') from auth.users where id = '11111111-1111-4111-8111-111111111111'), '', '首次验证清空注册时的密码');
select is((select password_set_at from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'), null, 'password_set_at 为空');
select is((select count(*)::int from auth.sessions where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'L-1 首次验证删除该用户已有会话');

-- 3. 已验证后设密码 → 记录 password_set_at
set local role supabase_auth_admin;
update auth.users set encrypted_password = extensions.crypt('owner-pass-1', extensions.gen_salt('bf')) where id = '11111111-1111-4111-8111-111111111111';
reset role;
select isnt((select password_set_at from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'), null, '设密码后记录 password_set_at');

-- 4. hook 权限
select ok(has_function_privilege('supabase_auth_admin', 'private.hook_before_user_created(jsonb)', 'execute'), 'supabase_auth_admin 能执行 hook');
select ok(not has_function_privilege('anon', 'private.hook_before_user_created(jsonb)', 'execute'), 'anon 不能执行 hook');
select ok(not has_function_privilege('authenticated', 'private.hook_before_user_created(jsonb)', 'execute'), 'authenticated 不能执行 hook');
set local role supabase_auth_admin;
select is(private.hook_before_user_created('{"user":{"phone":"6591234567"}}') -> 'error' ->> 'message', 'PHONE_NOT_SUPPORTED', 'hook 拒绝非马来西亚号码');
reset role;

-- 5. customer_api 登录角色
select ok((select rolcanlogin from pg_roles where rolname = 'customer_api'), 'customer_api 可登录');
select ok(not pg_has_role('authenticator', 'customer_api', 'member'), 'authenticator 不能切换到 customer_api');
select ok(not has_table_privilege('customer_api', 'auth.users', 'select'), 'customer_api 读不了 auth.users');

select is((select rolconnlimit from pg_roles where rolname = 'customer_api'), 20, 'L-8 customer_api connection limit 20');
select ok((select rolconfig from pg_roles where rolname = 'customer_api') @> array['statement_timeout=3s'], 'L-8 customer_api statement_timeout=3s');
select ok((select rolconfig from pg_roles where rolname = 'customer_api') @> array['idle_in_transaction_session_timeout=5s'], 'L-8 customer_api idle_in_transaction_session_timeout=5s');

-- 5b. M-3：INSERT 时已验证（自动确认被误开）也擦密码；provisioned_by = 'ops' 的运维账号除外
set local role supabase_auth_admin;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
        'pgtap-autoconfirm@example.com', extensions.crypt('attacker-pass', extensions.gen_salt('bf')), now(), '{"provider":"email"}', now(), now());
reset role;
select is((select coalesce(encrypted_password, '') from auth.users where id = '22222222-2222-4222-8222-222222222222'), '', 'M-3 插入即验证也擦密码');
select is((select password_set_at from public.profiles where user_id = '22222222-2222-4222-8222-222222222222'), null, 'M-3 插入即验证不记 password_set_at');

-- 5c. H-1：店家读不到停用原因
select ok(not has_column_privilege('authenticated', 'public.stores', 'status_reason', 'select'), 'H-1 authenticated 不能 select stores.status_reason');
select ok(not has_column_privilege('authenticated', 'public.blocked_clients', 'value_hash', 'select'), 'H-1 店家不能读 value_hash');
select ok(not has_table_privilege('authenticated', 'public.blocked_clients', 'delete'), 'H-1 店家不能直接 delete 拉黑');

-- 5d. L-8：purge 只删超过 24 小时仍未验证的账号，不删已验证的老账号
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '33333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated', 'pgtap-old-unverified@example.com', now() - interval '2 days', now());
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated', '60123456789', now() - interval '2 days', now() - interval '2 days', now());
select private.purge_unverified_users();
select is((select count(*)::int from auth.users where id = '33333333-3333-4333-8333-333333333333'), 0, 'L-8 purge 删除 24 小时前的未验证账号');
select is((select count(*)::int from auth.users where id = '44444444-4444-4444-8444-444444444444'), 1, 'L-8 purge 不删已验证的老账号');

-- 6. 定时任务
select isnt_empty($$ select 1 from cron.job where jobname = 'purge-unverified-users' and schedule = '17 * * * *' $$, 'pg_cron 已注册 purge-unverified-users');

-- 7. 清理函数能删 auth.users（postgres 身份）
select lives_ok($$ select private.purge_unverified_users() $$, 'purge_unverified_users 在真实环境可执行');

select * from finish();
rollback;
