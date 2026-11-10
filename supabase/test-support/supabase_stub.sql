-- 本地 PGlite 用的 Supabase 最小模拟：角色、auth/storage/realtime schema、平台默认权限
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator nologin noinherit;
grant anon, authenticated, service_role to postgres;
create schema auth; create schema storage; create schema extensions; create schema realtime;
grant usage on schema auth, storage, realtime, public to anon, authenticated, service_role;
-- 模拟 Supabase 平台默认权限（真实项目里 \ddp 可见）：public 新建对象默认 grant all 给三个角色
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}',
  is_anonymous boolean not null default false, email_confirmed_at timestamptz,
  phone text unique, phone_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
create function storage.filename(name text) returns text language sql immutable as $$ select (string_to_array(name,'/'))[array_length(string_to_array(name,'/'),1)] $$;
grant execute on function storage.foldername(text), storage.filename(text) to authenticated;
create table realtime.messages (id bigserial primary key, topic text not null, extension text not null default 'broadcast', payload jsonb);
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to anon, authenticated;
grant usage on sequence realtime.messages_id_seq to anon, authenticated;
create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
grant execute on function realtime.topic() to anon, authenticated;
create publication supabase_realtime;
