import { getTodayIsoDate } from "./split-math";
import type { ParsedReceiptResult } from "./types";

const NOISE_PATTERNS = [
  /^(jl\.|jalan|telp|tel|phone|hp|wa|npwp|ig:|instagram|www\.|http)/i,
  /(terima\s*kasih|thank\s*you|selamat\s*datang|welcome|struk|invoice|receipt|kasir|cashier|order\s*no|table|meja|guest|pax|poinku|stamp|lucky|member|point|poin|call\s*center|layanan\s*konsumen|kritik|saran|pt\.\s*indomarco|pt\.\s*sumber\s*alfaria)/i,
  /^(tunai|cash|debit|credit|kredit|qris|gopay|ovo|dana|bca|mandiri|bni|bri|change|kembali|kembalian|bayar|payment|paid|total\s*item|qty|item\s*count|id\s*poinku|cek\s*poin|dpp|non\s*tunai|e-wallet|shopeepay)/i,
  /^[-=_*#.\s]{3,}$/,
];

const SECTION_END_PATTERNS = [
  /\b(harga\s*jual|sub\s*total|subtotal|grand\s*total|total\s*bayar|total\s*belanja|total\s*harga|net\s*sales|jumlah\s*bayar)\b/i,
  /^\s*total\s*[:=\s]/i,
];

const POST_TOTAL_STOP_PATTERNS = [
  /\b(tunai|cash|kembali|kembalian|change|anda\s*hemat|total\s*hemat|dpp\s*=|ppn\s*dibebaskan|id\s*poinku)\b/i,
];

function parseIdrToken(raw: string): number {
  let cleaned = raw
    .replace(/rp\.?/gi, "")
    .replace(/[()\s]/g, "")
    .replace(/^-/, "");

  // Handle trailing decimals like 25.000,00 or 25,000.00
  if (/[.,]\d{2}$/.test(cleaned) && cleaned.length > 5) {
    cleaned = cleaned.slice(0, -3);
  }
  const digits = cleaned.replace(/[^\d]/g, "");
  const num = parseInt(digits, 10);
  if (!Number.isFinite(num) || num <= 0 || num > 50000000) return 0;
  return num;
}

function extractReceiptDate(rawText: string): string {
  // Match DD.MM.YY or DD/MM/YY or DD-MM-YYYY
  const m = rawText.match(/\b(\d{2})[./-](\d{2})[./-](\d{2,4})\b/);
  if (!m) return getTodayIsoDate();
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  let yyyy = Number(m[3]);
  if (yyyy < 100) yyyy += 2000;
  if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yyyy >= 2020 && yyyy <= 2035) {
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  return getTodayIsoDate();
}

function detectKnownMerchant(rawText: string): string {
  if (/poinku|indomaret|\bidm\b/i.test(rawText)) return "Indomaret";
  if (/alfamart|alfagift|sumber\s*alfaria/i.test(rawText)) return "Alfamart";
  if (/alfamidi/i.test(rawText)) return "Alfamidi";
  if (/superindo/i.test(rawText)) return "Super Indo";
  if (/lawson/i.test(rawText)) return "Lawson";
  if (/familymart/i.test(rawText)) return "FamilyMart";
  return "";
}

export function parseIndonesianReceiptText(rawText: string): ParsedReceiptResult {
  const rawLines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let merchantName = detectKnownMerchant(rawText);
  let taxAmount = 0;
  let serviceAmount = 0;
  let otherFeeAmount = 0;
  let discountAmount = 0;
  let detectedReceiptTotal = 0;
  let detectedSavings = 0;
  let inSummarySection = false;
  let pastTotalPaymentLine = false;

  const items: Array<{ name: string; qty: number; unit_price: number }> = [];

  if (!merchantName) {
    for (const line of rawLines.slice(0, 4)) {
      if (
        line.length >= 3 &&
        line.length <= 48 &&
        !/\d{2}[./-]\d{2}[./-]\d{2}/.test(line) &&
        !/\d{4,}/.test(line) &&
        !NOISE_PATTERNS.some((p) => p.test(line))
      ) {
        merchantName = line;
        break;
      }
    }
  }

  for (const line of rawLines) {
    // Check if we reached post-payment footer (TUNAI, KEMBALI, DPP=, PPN DIBEBASKAN, POINKU)
    if (POST_TOTAL_STOP_PATTERNS.some((p) => p.test(line))) {
      inSummarySection = true;

      if (/\b(anda\s*hemat|total\s*hemat)\b/i.test(line)) {
        const m = line.match(/(\d[\d.,]*)\s*$/);
        if (m) detectedSavings = parseIdrToken(m[1]);
      }
      if (/\b(tunai|cash|kembali|kembalian|change|dpp|ppn\s*dibebaskan)\b/i.test(line)) {
        pastTotalPaymentLine = true;
      }
      continue;
    }

    // Ignore lines after TUNAI / DPP (tax-inclusive footer lines like "PPN= 1,925")
    if (pastTotalPaymentLine) {
      continue;
    }

    // Check section-end summary lines (HARGA JUAL, SUBTOTAL, TOTAL)
    if (SECTION_END_PATTERNS.some((p) => p.test(line))) {
      inSummarySection = true;
      const totalMatch = line.match(/(\d[\d.,]*)\s*$/);
      if (totalMatch) {
        const val = parseIdrToken(totalMatch[1]);
        if (val > 0 && !/\bsub\s*total|subtotal\b/i.test(line)) {
          detectedReceiptTotal = val;
        }
      }
      continue;
    }

    // Detect parenthesized or negative discount lines (e.g. "VC PT RBI : (4,600)", "DISC -5.000")
    const parenDiscount = line.match(/\(\s*(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{3,7})\s*\)\s*$/i);
    if (parenDiscount) {
      const discVal = parseIdrToken(parenDiscount[1]);
      if (discVal > 0) discountAmount += discVal;
      continue;
    }

    // Extract trailing price (allow 3+ digits like 600 for plastic bags!)
    const priceMatch = line.match(
      /(-?\s*(?:rp\.?\s*)?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|-?\s*(?:rp\.?\s*)?\d{3,7})\s*$/i
    );
    if (!priceMatch) continue;

    const amount = parseIdrToken(priceMatch[1]);
    if (amount === 0) continue;

    const leftPart = line.slice(0, priceMatch.index).trim();
    if (!leftPart) continue;

    // Tax / Service / Discount / Fee lines (allowed before or inside summary section, NEVER after TUNAI)
    if (/\b(pb1|ppn|tax|pajak|vat)\b/i.test(leftPart)) {
      if (!/\bdpp\b|dibebaskan|incl/i.test(line)) {
        taxAmount += amount;
      }
      continue;
    }
    if (/\b(service|svc|servis|layanan)\b/i.test(leftPart)) {
      serviceAmount += amount;
      continue;
    }
    if (
      /\b(vc\s*pt|voucher|disc|diskon|discount|promo|potongan|pot\.)\b/i.test(leftPart) ||
      priceMatch[1].trim().startsWith("-")
    ) {
      discountAmount += amount;
      continue;
    }
    if (/\b(ongkir|delivery|bungkus|takeaway|packaging|biaya\s*lain|admin)\b/i.test(leftPart)) {
      otherFeeAmount += amount;
      continue;
    }

    // Once in summary section (after HARGA JUAL / SUBTOTAL / TOTAL), don't treat remaining lines as items
    if (inSummarySection) {
      continue;
    }

    if (NOISE_PATTERNS.some((p) => p.test(leftPart))) {
      continue;
    }

    // Pattern A: Retail 3-column format "ITEM NAME   QTY   UNIT_PRICE   LINE_TOTAL"
    // Allows OCR misreads of qty "1" as "|", "I", or "l"
    const threeColMatch = leftPart.match(
      /^(.+?)\s+(\d{1,3}|[|Il])\s+((?:\d{1,3}(?:[.,]\d{3})+)|\d{2,7})$/
    );
    if (threeColMatch) {
      const candidateName = threeColMatch[1].trim();
      const rawQty = threeColMatch[2];
      const candidateQty = /^[|Il]$/.test(rawQty)
        ? 1
        : Math.max(1, parseInt(rawQty, 10));
      const candidateUnit = parseIdrToken(threeColMatch[3]);
      if (
        candidateName.length >= 2 &&
        candidateUnit > 0 &&
        Math.abs(candidateQty * candidateUnit - amount) <= Math.max(200, amount * 0.05)
      ) {
        let resolvedUnit = candidateUnit;
        // When qty=1 and OCR misread one digit (e.g. 17508 vs 17500, or 38500 vs 38560),
        // prefer the cleaner Rupiah multiple of 100 (or 50)
        if (candidateQty === 1 && candidateUnit !== amount) {
          const unitClean100 = candidateUnit % 100 === 0;
          const amtClean100 = amount % 100 === 0;
          if (!unitClean100 && amtClean100) {
            resolvedUnit = amount;
          } else if (unitClean100 && !amtClean100) {
            resolvedUnit = candidateUnit;
          } else if (candidateUnit % 50 !== 0 && amount % 50 === 0) {
            resolvedUnit = amount;
          }
        }
        items.push({
          name: candidateName,
          qty: candidateQty,
          unit_price: resolvedUnit,
        });
        continue;
      }
    }

    // Pattern B: Restaurant format "2x Nasi Goreng 76.000" or "Nasi Goreng x2 76.000"
    let qty = 1;
    let name = leftPart;

    const leadingQty = leftPart.match(/^(\d{1,2})\s*[xX*]?\s+(.+)$/);
    const trailingQty = leftPart.match(/^(.+?)\s+[xX*]\s*(\d{1,2})$/);

    if (leadingQty) {
      qty = Math.max(1, parseInt(leadingQty[1], 10));
      name = leadingQty[2].trim();
    } else if (trailingQty) {
      name = trailingQty[1].trim();
      qty = Math.max(1, parseInt(trailingQty[2], 10));
    }

    name = name.replace(/@\s*\d[\d.,]*/g, "").replace(/[:\-–—]+$/, "").trim();
    if (name.length < 2) continue;

    const unitPrice = qty > 1 ? Math.round(amount / qty) : amount;
    items.push({ name, qty, unit_price: unitPrice });
  }

  // Fallback discount reconciliation: if "ANDA HEMAT" was printed but individual voucher lines missed OCR
  if (discountAmount === 0 && detectedSavings > 0) {
    discountAmount = detectedSavings;
  }

  // Smart Tax-Inclusive Reconciliation:
  // If items - discount already matches the printed TOTAL, tax was tax-inclusive (like Indomaret/Alfamart)
  const itemsSubtotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  if (
    detectedReceiptTotal > 0 &&
    taxAmount > 0 &&
    Math.abs(itemsSubtotal - discountAmount - detectedReceiptTotal) <= 500
  ) {
    taxAmount = 0;
  }

  return {
    merchant_name: merchantName || "Struk Belanja",
    bill_date: extractReceiptDate(rawText),
    items,
    tax_amount: taxAmount,
    service_amount: serviceAmount,
    other_fee_amount: otherFeeAmount,
    discount_amount: discountAmount,
    engine: "tesseract",
    raw_text: rawText,
  };
}
