import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUploadFromDb, saveUploadToDb } from "./db";

const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);

export const UPLOADS_DIR = IS_SERVERLESS
  ? path.join(os.tmpdir(), "splitstruk-uploads")
  : path.join(process.cwd(), "uploads");

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB for phone camera receipt photos
// Guard DB row payload size while keeping receipt/QRIS images persistent on Vercel/Turso
const MAX_DB_IMAGE_BYTES = 3 * 1024 * 1024;

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

  const filename = `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${detected.ext}`;

  // Always write to writable local/tmp disk cache so reads are instant
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  } catch {
    // Ignore read-only FS errors; DB storage below serves as primary fallback
  }

  // Persist in SQLite/Turso so shared /bill/[slug] links serve QRIS & receipts across serverless instances
  if (buffer.length <= MAX_DB_IMAGE_BYTES) {
    try {
      await saveUploadToDb(filename, detected.mime, buffer);
    } catch {
      // Non-fatal if disk write succeeded
    }
  }

  return {
    filename,
    url: `/api/uploads/${filename}`,
    buffer,
    mime: detected.mime,
  };
}

export async function readUploadedImage(
  filename: string
): Promise<{ mime: string; buffer: Buffer } | null> {
  const fullPath = path.join(UPLOADS_DIR, filename);
  if (fs.existsSync(fullPath)) {
    return {
      mime: getMimeFromFilename(filename),
      buffer: fs.readFileSync(fullPath),
    };
  }

  try {
    return await getUploadFromDb(filename);
  } catch {
    return null;
  }
}

export function isValidUploadFilename(filename: string): boolean {
  return /^(receipt|qris)-\d+-[a-f0-9]{8}\.(png|jpg|webp)$/.test(filename);
}

export function getMimeFromFilename(filename: string): string {
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
