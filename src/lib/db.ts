import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calculateSplit } from "./split-math";
import type { BillData, SavedBillSummary } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "splitstruk.db");
const SCHEMA_VERSION = 1;

declare global {
  var __splitstrukDb: DatabaseSync | undefined;
  var __splitstrukSchemaVersion: number | undefined;
}

function createSchema(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

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
    );

    CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at DESC);
  `);
}

export function getDb(): DatabaseSync {
  if (!globalThis.__splitstrukDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    globalThis.__splitstrukDb = new DatabaseSync(DB_PATH);
  }
  if (globalThis.__splitstrukSchemaVersion !== SCHEMA_VERSION) {
    createSchema(globalThis.__splitstrukDb);
    globalThis.__splitstrukSchemaVersion = SCHEMA_VERSION;
  }
  return globalThis.__splitstrukDb;
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
    receipt_image_url: row.receipt_image_url ? String(row.receipt_image_url) : null,
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

export function saveBillRecord(bill: BillData): BillData {
  const db = getDb();
  const slug = bill.slug && /^[a-f0-9]{6,16}$/.test(bill.slug) ? bill.slug : generateBillSlug();
  const summary = calculateSplit(bill);

  db.prepare(
    `
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
    `
  ).run(
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
    JSON.stringify(bill.items)
  );

  return getBillBySlug(slug)!;
}

export function getBillBySlug(slug: string): BillData | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM bills WHERE slug = ?")
    .get(slug);
  if (!row) return null;
  return hydrateBillRow(row);
}

export function listRecentBills(limit = 30): SavedBillSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT slug, title, merchant_name, bill_date, grand_total, participants_json, created_at
       FROM bills
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => {
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

export function deleteBillBySlug(slug: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM bills WHERE slug = ?").run(slug);
  return Number(res.changes) > 0;
}
