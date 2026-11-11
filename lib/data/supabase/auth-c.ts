import { DataError } from "../types";
import type * as Mock from "../mock/auth-c";
const unavailable = async () => { throw new DataError("NOT_IMPLEMENTED", "未实现"); };
export const sendSignUpOtp: typeof Mock.sendSignUpOtp = unavailable;
export const requestPasswordReset: typeof Mock.requestPasswordReset = unavailable;
export const confirmEmailLink: typeof Mock.confirmEmailLink = unavailable;
export const verifySmsOtp: typeof Mock.verifySmsOtp = unavailable;
export const signInWithPassword: typeof Mock.signInWithPassword = unavailable;
export const setPassword: typeof Mock.setPassword = unavailable;
export const signOut: typeof Mock.signOut = unavailable;
export const ensureMyStore: typeof Mock.ensureMyStore = unavailable;
export const getAuthMockSnapshot: typeof Mock.getAuthMockSnapshot = unavailable;
export const authMockAction: typeof Mock.authMockAction = unavailable;
// A6 real implementation (backend PR2 only):
// fetch('/api/auth/set-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password }) });
// A1/A4/A8 signInWithOtp, A2 signInWithPassword, A3 signOut,
// A5 verifyOtp({ token_hash, type }), A7 verifyOtp({ phone, token, type: 'sms' }), R14 ensure_my_store.

