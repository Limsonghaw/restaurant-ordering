export { normalizePhone } from "../validation/phone";
export const validPassword = (p: string) =>
  p.length >= 8 && p.length <= 72 && /[a-zA-Z]/.test(p) && /[0-9]/.test(p);
