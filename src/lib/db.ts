import { createClient, type Client } from "@libsql/client";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateSplit } from "./split-math";
import type { BillData, SavedBillSummary } from "./types";

const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);

const DATA_DIR = IS_SERVERLESS
  ? path.join(os.tmpdir(), "splitstruk-data")
  : path.join(process.cwd(), "data");
const LOCAL_DB_PATH = path.join(DATA_DIR, "splitstruk.db");

declare global {
  var __splitstrukClient: Client | undefined;
  var __splitstrukInitPromise: Promise<void> | undefined;
}

function getClient(): Client {
  if (globalThis.__splitstrukClient) {
    return globalThis.__splitstrukClient;
  }

  const tursoUrl = (process.env.TURSO_DATABASE_URL || "").trim();
  const tursoToken = (process.env.TURSO_AUTH_TOKEN || "").trim() || undefined;

  if (tursoUrl) {
    globalThis.__splitstrukClient = createClient({
      url: tursoUrl,
      authToken: tursoToken,
    });
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    globalThis.__splitstrukClient = createClient({
      url: `file:${LOCAL_DB_PATH}`,
    });
  }

  return globalThis.__splitstrukClient;
}

async function ensureDb(): Promise<Client> {
  const client = getClient();
  if (!globalThis.__splitstrukInitPromise) {
    globalThis.__splitstrukInitPromise = (async () => {
      const isLocalFile = !(process.env.TURSO_DATABASE_URL || "").trim();
      if (isLocalFile) {
        await client.execute("PRAGMA journal_mode = WAL");
        await client.execute("PRAGMA busy_timeout = 5000");
      }

      await client.execute(`
        CREATE TABLE IF NOT EXISTS bills (
          slug TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          merchant_name TEXT NOT NULL DEFAULT '',
          bill_date TEXT NOT NULL,
          receipt_image_url TEXT DEFAULT NULL,
          tax_amount INTEGER NOT NULL DEFAULT 0,
          service_amount INTEGER NOT NULL DEFAULT 0,
          other_fee_amount INTEGER NOT NULL DEFAULT 0,
          discount_amount INTEGER NOT NULL DEFAULT 0,
          grand_total INTEGER NOT NULL DEFAULT 0,
          payment_info_json TEXT NOT NULL DEFAULT '{}',
          participants_json TEXT NOT NULL DEFAULT '[]',
          items_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      await client.execute(
        "CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at DESC)"
      );

      await client.execute(`
        CREATE TABLE IF NOT EXISTS uploads (
          filename TEXT PRIMARY KEY,
          mime TEXT NOT NULL,
          data_base64 TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    })().catch((err) => {
      globalThis.__splitstrukInitPromise = undefined;
      throw err;
    });
  }
  await globalThis.__splitstrukInitPromise;
  return client;
}

export function generateBillSlug(): string {
  return crypto.randomBytes(4).toString("hex");
}

function hydrateBillRow(row: Record<string, unknown>): BillData {
  return {
    slug: String(row.slug),
    title: String(row.title || ""),
    merchant_name: String(row.merchant_name || ""),
    bill_date: String(row.bill_date || ""),
    receipt_image_url: row.receipt_image_url
      ? String(row.receipt_image_url)
      : null,
    tax_amount: Number(row.tax_amount || 0),
    service_amount: Number(row.service_amount || 0),
    other_fee_amount: Number(row.other_fee_amount || 0),
    discount_amount: Number(row.discount_amount || 0),
    payment_info: JSON.parse(String(row.payment_info_json || "{}")),
    participants: JSON.parse(String(row.participants_json || "[]")),
    items: JSON.parse(String(row.items_json || "[]")),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

export async function saveBillRecord(bill: BillData): Promise<BillData> {
  const db = await ensureDb();
  const slug =
    bill.slug && /^[a-f0-9]{6,16}$/.test(bill.slug)
      ? bill.slug
      : generateBillSlug();
  const summary = calculateSplit(bill);

  await db.execute({
    sql: `
      INSERT INTO bills (
        slug, title, merchant_name, bill_date, receipt_image_url,
        tax_amount, service_amount, other_fee_amount, discount_amount, grand_total,
        payment_info_json, participants_json, items_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        merchant_name = excluded.merchant_name,
        bill_date = excluded.bill_date,
        receipt_image_url = excluded.receipt_image_url,
        tax_amount = excluded.tax_amount,
        service_amount = excluded.service_amount,
        other_fee_amount = excluded.other_fee_amount,
        discount_amount = excluded.discount_amount,
        grand_total = excluded.grand_total,
        payment_info_json = excluded.payment_info_json,
        participants_json = excluded.participants_json,
        items_json = excluded.items_json,
        updated_at = datetime('now')
    `,
    args: [
      slug,
      bill.title || bill.merchant_name || "Split Bill",
      bill.merchant_name || "",
      bill.bill_date,
      bill.receipt_image_url ?? null,
      Math.max(0, Math.round(bill.tax_amount)),
      Math.max(0, Math.round(bill.service_amount)),
      Math.max(0, Math.round(bill.other_fee_amount)),
      Math.max(0, Math.round(bill.discount_amount)),
      summary.grand_total,
      JSON.stringify(bill.payment_info),
      JSON.stringify(bill.participants),
      JSON.stringify(bill.items),
    ],
  });

  const saved = await getBillBySlug(slug);
  if (!saved) {
    throw new Error("Gagal membaca ulang data bill tersimpan.");
  }
  return saved;
}

export async function getBillBySlug(slug: string): Promise<BillData | null> {
  const db = await ensureDb();
  const result = await db.execute({
    sql: "SELECT * FROM bills WHERE slug = ? LIMIT 1",
    args: [slug],
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) return null;
  return hydrateBillRow(row);
}

export async function listRecentBills(limit = 30): Promise<SavedBillSummary[]> {
  const db = await ensureDb();
  const result = await db.execute({
    sql: `SELECT slug, title, merchant_name, bill_date, grand_total, participants_json, created_at
          FROM bills
          ORDER BY updated_at DESC
          LIMIT ?`,
    args: [limit],
  });

  return result.rows.map((raw) => {
    const r = raw as unknown as Record<string, unknown>;
    const participants = JSON.parse(String(r.participants_json || "[]")) as Array<{
      is_paid?: boolean;
    }>;
    return {
      slug: String(r.slug),
      title: String(r.title || ""),
      merchant_name: String(r.merchant_name || ""),
      bill_date: String(r.bill_date || ""),
      grand_total: Number(r.grand_total || 0),
      participant_count: participants.length,
      paid_count: participants.filter((p) => p.is_paid).length,
      created_at: String(r.created_at || ""),
    };
  });
}

export async function deleteBillBySlug(slug: string): Promise<boolean> {
  const db = await ensureDb();
  const res = await db.execute({
    sql: "DELETE FROM bills WHERE slug = ?",
    args: [slug],
  });
  return Number(res.rowsAffected) > 0;
}

export async function saveUploadToDb(
  filename: string,
  mime: string,
  buffer: Buffer
): Promise<void> {
  const db = await ensureDb();
  await db.execute({
    sql: `INSERT OR REPLACE INTO uploads (filename, mime, data_base64, created_at)
          VALUES (?, ?, ?, datetime('now'))`,
    args: [filename, mime, buffer.toString("base64")],
  });
}

export async function getUploadFromDb(
  filename: string
): Promise<{ mime: string; buffer: Buffer } | null> {
  const db = await ensureDb();
  const res = await db.execute({
    sql: "SELECT mime, data_base64 FROM uploads WHERE filename = ? LIMIT 1",
    args: [filename],
  });
  const row = res.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row || !row.data_base64) return null;
  return {
    mime: String(row.mime || "image/jpeg"),
    buffer: Buffer.from(String(row.data_base64), "base64"),
  };
}
