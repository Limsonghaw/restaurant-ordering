import { getClient, storeContext } from "./me";
import { dataError } from "./pg-errors";

async function validate(file: File): Promise<"jpg" | "png" | "webp"> {
  if (file.size > 2 * 1024 * 1024) throw dataError("FILE_TOO_LARGE");
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpg = b[0] === 255 && b[1] === 216 && b[2] === 255;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v);
  const webp = String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP";
  if (jpg && file.type === "image/jpeg") return "jpg";
  if (png && file.type === "image/png") return "png";
  if (webp && file.type === "image/webp") return "webp";
  throw dataError("UNSUPPORTED_FILE_TYPE");
}
async function upload(path: string, file: File): Promise<void> {
  try {
    const { error } = await (await getClient()).storage.from("menu-images").upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw error;
  } catch {
    throw dataError("UPLOAD_FAILED");
  }
}
export async function uploadItemImage(file: File, onProgress: (n: number) => void): Promise<{ image_path: string; thumb_path: string }> {
  const ext = await validate(file);
  const store = await storeContext(true);
  const id = crypto.randomUUID();
  const image_path = `${store}/items/${id}.${ext}`;
  const thumb_path = `${store}/items/${id}_thumb.${ext}`;
  // Frontend supplies compressed images; the same validated bytes are a safe
  // thumbnail fallback until a separate thumbnail input is exposed by the UI.
  onProgress(0);
  await upload(image_path, file);
  onProgress(50);
  await upload(thumb_path, file);
  onProgress(100);
  return { image_path, thumb_path };
}
export async function uploadLogo(file: File): Promise<string> {
  const ext = await validate(file);
  const store = await storeContext(true);
  const path = `${store}/logo/${crypto.randomUUID()}.${ext}`;
  await upload(path, file);
  return path;
}
