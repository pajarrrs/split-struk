import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB for phone camera receipt photos

export function detectImageType(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

export async function saveUploadedImage(
  file: File,
  prefix: "receipt" | "qris"
): Promise<{ url: string; filename: string; buffer: Buffer; mime: string }> {
  if (file.size === 0) {
    throw new Error("File gambar kosong.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Ukuran gambar maksimal 8MB.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detected = detectImageType(buffer);
  if (!detected) {
    throw new Error("Format file harus JPG, PNG, atau WEBP.");
  }

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${detected.ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);

  return {
    filename,
    url: `/api/uploads/${filename}`,
    buffer,
    mime: detected.mime,
  };
}

export function isValidUploadFilename(filename: string): boolean {
  return /^(receipt|qris)-\d+-[a-f0-9]{8}\.(png|jpg|webp)$/.test(filename);
}

export function getMimeFromFilename(filename: string): string {
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
