-- 第二轮复查测试用的补充桩（在 supabase_stub.sql 之后加载；PR1 的 supabase_stub.sql 不改）
-- 模拟真实 Supabase：auth.users 归 supabase_auth_admin 所有、有 encrypted_password / raw_app_meta_data / created_at；auth.jwt()
create role supabase_auth_admin nologin noinherit;
alter table auth.users add column encrypted_password varchar(255),
  add column raw_app_meta_data jsonb default '{}', add column created_at timestamptz not null default now();
alter table auth.users owner to supabase_auth_admin;
grant usage on schema auth to supabase_auth_admin;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
-- 0004（L-1）用到 auth.sessions：只放测试需要的列；属主 supabase_auth_admin（与真实 Supabase 一致）
create table auth.sessions (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now());
alter table auth.sessions owner to supabase_auth_admin;
-- rereview-3 低-4（0005）：真实 auth.users 有 confirmation_sent_at（GoTrue 每次发确认邮件 / 验证码时写入）
alter table auth.users add column confirmation_sent_at timestamptz;
