-- =====================================================================
-- 0005_purge_resend_boundary.sql  第三轮复查（rereview-3）低-4 / L-2：清理任务与 A8 重发的边界
-- 依据：/workspace/security-reviews/restaurant-ordering-design-rereview-3.md §2.2 第 6 点、低-4
-- 不改 0001–0004 的任何一行：这里只 create or replace private.purge_unverified_users()
--   （签名、security definer、search_path、属主和授权都不变；pg_cron 任务沿用 0003 注册的 purge-unverified-users）。
--
-- 问题：A8 重发（再调一次 signInWithOtp）不刷新 auth.users.created_at，0003 只按 created_at < now()-24h 删除，
--       用户在第 23 小时 59 分重发、收到的新链接，可能几分钟后就因为账号被删而失效（体验问题，不是安全问题）。
-- 修复：按「最后一次发确认」计时，并保留 25 小时下限：
--   ① coalesce(confirmation_sent_at, created_at) 早于 24 小时前：最后一次发出的确认链接 / 验证码也已放弃；
--   ② created_at 早于 25 小时前：短信注册如果不写 confirmation_sent_at（需确认，清单第 20 项），
--      至少退回到报告建议的 25 小时阈值，不会在第 24 小时整点误删刚重发的账号。
-- 只删「两个 confirmed_at 都为空」的账号，与 0003 相同；已验证的老账号不受影响。
-- =====================================================================
create or replace function private.purge_unverified_users() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from auth.users u
   where u.email_confirmed_at is null and u.phone_confirmed_at is null
     and u.created_at < now() - interval '25 hours'
     and coalesce(u.confirmation_sent_at, u.created_at) < now() - interval '24 hours';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 授权与 0003 相同：只有属主（postgres）和 pg_cron 能执行；create or replace 不会改变已有授权，这里再显式收回一次
revoke execute on function private.purge_unverified_users() from public, anon, authenticated, service_role, customer_api;
