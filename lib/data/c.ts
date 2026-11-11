import * as mock_auth_c from "./mock/auth-c";
import * as real_auth_c from "./supabase/auth-c";
export const {
  sendSignUpOtp,
  requestPasswordReset,
  confirmEmailLink,
  verifySmsOtp,
  signInWithPassword,
  setPassword,
  signOut,
  ensureMyStore,
  getAuthMockSnapshot,
  authMockAction,
} = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock" ? mock_auth_c : real_auth_c;
import * as mock_menu_c from "./mock/menu-c";
import * as real_menu_c from "./supabase/menu-c";
export const {
  getMenuForStore,
  createCategory,
  renameCategory,
  setCategoryHidden,
  deleteCategory,
  reorderCategories,
  reorderItems,
  createItem,
  updateItem,
  setItemSoldOut,
  setItemHidden,
  deleteItem,
  uploadItemImage,
  uploadLogo,
} = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock" ? mock_menu_c : real_menu_c;
import * as mock_blocks_c from "./mock/blocks-c";
import * as real_blocks_c from "./supabase/blocks-c";
export const {
  listBlockedClients,
  unblockClient,
  blockClientFromOrder,
  blocksMockAction,
} =
  process.env.NEXT_PUBLIC_DATA_SOURCE === "mock"
    ? mock_blocks_c
    : real_blocks_c;
