export const routes = {
  menu: (code: string) => `/t/${encodeURIComponent(code)}`,
  cart: (code: string) => `/t/${encodeURIComponent(code)}/cart`,
  orders: (code: string) => `/t/${encodeURIComponent(code)}/orders`,
  login: "/login",
  register: "/register",
  forgotPassword: "/forgot-password",
  verify: "/verify",
  confirm: "/auth/confirm",
  setPassword: "/set-password",
  resetPassword: "/reset-password",
  store: "/store",
  admin: "/admin",
};
export const storeNavigation = [
  ["接单画面", "/store/live"],
  ["账单", "/store/bills"],
  ["菜单管理", "/store/menu"],
  ["桌号和二维码", "/store/tables"],
  ["店铺设置", "/store/settings"],
  ["订单记录", "/store/history"],
  ["拉黑列表", "/store/blocked"],
] as const;
