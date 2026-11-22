import { getTodayIsoDate } from "./split-math";
import type { ParsedReceiptResult } from "./types";

const NOISE_PATTERNS = [
  /^(jl\.|jalan|telp|tel|phone|hp|wa|npwp|ig:|instagram|www\.|http|no\.?\s*struk|no\.?\s*nota|no\.?\s*pesanan|no\.?\s*order|order\s*id|booking\s*id|receipt\s*#|order\s*#|bill\s*#|trx|ref\b|pin\b|ptn\b|kode\s*pin|antrian|queue|waktu|tanggal|date|time|driver|kurir|pelanggan|customer|pemesan|alamat|ambil\s*di|dikirim\s*ke|order\s*type|tipe\s*pesanan|branch|outlet|cabang)/i,
  /(terima\s*kasih|terina\s*kasih|thank\s*you|selamat\s*datang|welcome|struk|invoice|receipt|kasir|cashier|order\s*no|table|meja|guest|pax|poinku|stamp|lucky|member|point|poin|call\s*center|layanan\s*konsumen|customer\s*care|kritik|saran|pt\.\s*indomarco|pt\.\s*sumber\s*alfaria|powered\s*by|moka|majoo|qasir|gobiz|go-?biz|wifi|password|detail\s*pesanan|ringkasan\s*pembayaran|rincian\s*pembayaran|detail\s*pembayaran|metode\s*pembayaran|status\s*pesanan|pesanan\s*selesai|scan\s*di\s*sini|ada\s*untuk-?mu)/i,
  /^(tunai|cash|debit|credit|kredit|qris|gopay|go-?pay|gopaylater|ovo|dana|linkaja|bca|mandiri|bni|bri|edc|visa|mastercard|change|kembali|kembalian|bayar|payment|paid|total\s*item|total\s*qty|qty|item\s*count|\d+\s*item\(s\)|id\s*poinku|cek\s*poin|dpp|non\s*tunai|e-wallet|shopeepay|flazz|emoney|e-money)/i,
  /^[-=_*#.\s]{3,}$/,
];

// Subtotal markers transition out of item list into fees/discounts, WITHOUT overwriting final grand total
const SUBTOTAL_PATTERNS = [
  /\b(harga\s*jual|sub\s*total|subtotal|total\s*harga|harga\s*makanan)\b/i,
  /^\s*harga\s*[:=\s]/i,
];

// Final grand total markers (explicitly excludes "Total Promo", "Total Diskon", "Total Hemat", "Total Harga", "Total Item", "Total Qty")
const GRAND_TOTAL_PATTERNS = [
  /\b(grand\s*total|total\s*pembayaran|total\s*bayar|total\s*belanja|total\s*tagihan|jumlah\s*bayar|net\s*sales|amount\s*due)\b/i,
  /^\s*total(?!\s+(?:promo|diskon|disc|discount|hemat|voucher|harga|item|qty|menu))\s*[:=\s]/i,
];

const POST_TOTAL_STOP_PATTERNS = [
  /\b(tunai|cash|kembali|kembalian|change|anda\s*hemat|total\s*hemat|kamu\s*hemat|dpp\s*=|ppn\s*dibebaskan|id\s*poinku|dibayar\s*dengan|pakai\s*gopay|pakai\s*qris)\b/i,
];

// Modifier / variant / note sub-lines common on GoFood / GrabFood / Se'Indonesia / Se'i Sapi receipts
const MODIFIER_LINE_PATTERNS = [
  /^[+*•\-–—]\s+/,
  /^(pilihan|pilih|varian|variant|level|ukuran|size|sambal|sayur|kuah|topping|add-?on|extra|ekstra|catatan|note|notes|request|custom|kemasan|packaging|free\b|no\s*add\s*ons)\b/i,
  /^(tidak\s*pedas|sedang|pedas|extra\s*pedas|less\s*sugar|normal\s*sugar|less\s*ice|normal\s*ice|pisah\s*sambal|sambal\s*pisah)$/i,
];

const MONTH_MAP: Record<string, string> = {
  jan: "01",
  januari: "01",
  feb: "02",
  februari: "02",
  mar: "03",
  maret: "03",
  apr: "04",
  april: "04",
  mei: "05",
  may: "05",
  jun: "06",
  juni: "06",
  jul: "07",
  juli: "07",
  agu: "08",
  agt: "08",
  aug: "08",
  agustus: "08",
  sep: "09",
  sept: "09",
  september: "09",
  okt: "10",
  oct: "10",
  oktober: "10",
  nov: "11",
  november: "11",
  des: "12",
  dec: "12",
  desember: "12",
};

function repairNumericToken(raw: string): string {
  return raw
    .replace(/[OoQD]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/B/g, "8");
}

function normalizeReceiptLine(rawLine: string): string {
  return (
    rawLine
      .replace(/\s+/g, " ")
      .trim()
      // Strip leading border/OCR noise glyphs like "|", "§", "#" while keeping "+", "-", "("
      .replace(/^[^a-zA-Z0-9+\-(]+/, "")
      .trim()
      // Collapse thermal printer spaces after thousand separator: "18, 000" -> "18.000", "(1, 300)" -> "(1.300)"
      .replace(/([\dOo])[.,]\s+([\dOo]{3}\b)/g, "$1.$2")
      .replace(/([\dOo])[.,]\s+([\dOo]{3}\b)/g, "$1.$2")
  );
}

function parseIdrToken(raw: string): number {
  let cleaned = raw
    .replace(/rp\.?/gi, "")
    .replace(/[()\s]/g, "")
    .replace(/^-/, "");

  cleaned = repairNumericToken(cleaned);

  if (/[.,]\d{2}$/.test(cleaned) && cleaned.length > 5) {
    cleaned = cleaned.slice(0, -3);
  }
  const digits = cleaned.replace(/[^\d]/g, "");
  const num = parseInt(digits, 10);
  if (!Number.isFinite(num) || num <= 0 || num > 50000000) return 0;
  return num;
}

function isPlausibleIdrPrice(rawToken: string, amount: number): boolean {
  if (amount < 100 || amount > 25000000) return false;
  const hasRp = /rp/i.test(rawToken);
  const hasThousandSep = /[.,]\d{3}\b/.test(repairNumericToken(rawToken));
  if (hasRp || hasThousandSep) return true;
  return amount >= 500 && amount <= 1000000 && amount % 50 === 0;
}

function extractReceiptDate(rawText: string): string {
  // 1. Try "22 Nov 2026" or "22 November 2026"
  const namedMatch = rawText.match(
    /\b(\d{1,2})\s+(jan(?:uari)?|feb(?:ruari)?|mar(?:et)?|apr(?:il)?|mei|may|jun(?:i)?|jul(?:i)?|agu(?:stus)?|agt|aug|sep(?:t(?:ember)?)?|okt(?:ober)?|oct|nov(?:ember)?|des(?:ember)?|dec)\s+(\d{4})\b/i
  );
  if (namedMatch) {
    const dd = Number(namedMatch[1]);
    const mm = MONTH_MAP[namedMatch[2].toLowerCase()];
    const yyyy = Number(namedMatch[3]);
    if (dd >= 1 && dd <= 31 && mm && yyyy >= 2020 && yyyy <= 2035) {
      return `${yyyy}-${mm}-${String(dd).padStart(2, "0")}`;
    }
  }

  // 2. Try numeric DD.MM.YY or DD/MM/YYYY
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
  const branchMatch = rawText.match(
    /\b(?:branch|outlet|cabang)\s*:\s*([^\r\n]+)/i
  );
  if (branchMatch) {
    const cleanedBranch = branchMatch[1]
      .replace(/se\s*['`’]?\s*i[rn]donesia/gi, "Se'Indonesia")
      .replace(/["|]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    if (cleanedBranch.length >= 3) return cleanedBranch;
  }

  if (/se\s*['`’]?\s*i[rn]donesia/i.test(rawText)) return "Se'Indonesia";
  const seiMatch = rawText.match(/\b(se'?i[ \t]*sapi[a-z0-9 \t.'-]{0,24})/i);
  if (seiMatch) {
    return seiMatch[1].replace(/\s+/g, " ").trim();
  }
  if (/poinku|indomaret|\bidm\b/i.test(rawText)) return "Indomaret";
  if (/alfamart|alfagift|sumber\s*alfaria/i.test(rawText)) return "Alfamart";
  if (/alfamidi/i.test(rawText)) return "Alfamidi";
  if (/super\s*indo|superindo/i.test(rawText)) return "Super Indo";
  if (/lawson/i.test(rawText)) return "Lawson";
  if (/family\s*mart|familymart/i.test(rawText)) return "FamilyMart";
  if (/starbucks/i.test(rawText)) return "Starbucks";
  if (/kopi\s*kenangan/i.test(rawText)) return "Kopi Kenangan";
  if (/fore\s*coffee/i.test(rawText)) return "Fore Coffee";
  if (/solaria/i.test(rawText)) return "Solaria";
  if (/hokben|hoka\s*hoka\s*bento/i.test(rawText)) return "HokBen";
  if (/mcdonald/i.test(rawText)) return "McDonald's";
  if (/\bkfc\b/i.test(rawText)) return "KFC";
  if (/mie\s*gacoan|gacoan/i.test(rawText)) return "Mie Gacoan";
  if (/gofood|go-?food/i.test(rawText)) return "GoFood";
  if (/grabfood|grab-?food/i.test(rawText)) return "GrabFood";
  if (/shopeefood|shopee\s*food/i.test(rawText)) return "ShopeeFood";
  return "";
}

function isModifierOrNoteLine(line: string): boolean {
  return MODIFIER_LINE_PATTERNS.some((p) => p.test(line));
}

function isLikelyItemNameOnly(line: string): boolean {
  if (line.length < 3 || line.length > 68) return false;
  if (!/[a-zA-Z]{2,}/.test(line)) return false;
  if (/^\d{2}[./-]\d{2}[./-]\d{2,4}/.test(line)) return false;
  if (/^\d{1,2}\s+[a-zA-Z]{3,9}\s+\d{4}\b/.test(line)) return false;
  if (isModifierOrNoteLine(line)) return false;
  if (NOISE_PATTERNS.some((p) => p.test(line))) return false;
  if (SUBTOTAL_PATTERNS.some((p) => p.test(line))) return false;
  if (GRAND_TOTAL_PATTERNS.some((p) => p.test(line))) return false;
  if (POST_TOTAL_STOP_PATTERNS.some((p) => p.test(line))) return false;
  if (/\b\d{4}[-\s]?\d{4}\b/.test(line)) return false;
  if (/\b(gofood|go-?food|grabfood|shopeefood|gobiz)\b/i.test(line)) return false;
  return true;
}

export function parseIndonesianReceiptText(rawText: string): ParsedReceiptResult {
  const rawLines = rawText
    .split(/\r?\n/)
    .map(normalizeReceiptLine)
    .filter(Boolean);

  let merchantName = detectKnownMerchant(rawText);
  let taxAmount = 0;
  let serviceAmount = 0;
  let otherFeeAmount = 0;
  let discountAmount = 0;
  let detectedReceiptTotal = 0;
  let detectedSubtotal = 0;
  let detectedSavings = 0;
  let inSummarySection = false;
  let pastTotalPaymentLine = false;
  let pendingItemName: string | null = null;
  let pendingItemQty: number | null = null;

  const items: Array<{ name: string; qty: number; unit_price: number }> = [];
  // Tracks unpriced "1 x Menu Name" lines (common on Se'Indonesia & GoFood dockets where price appears only at Subtotal)
  const unpricedQtyItems: Array<{ name: string; qty: number }> = [];

  if (!merchantName) {
    for (const line of rawLines.slice(0, 5)) {
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

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (NOISE_PATTERNS.some((p) => p.test(line))) {
      continue;
    }

    if (POST_TOTAL_STOP_PATTERNS.some((p) => p.test(line))) {
      inSummarySection = true;
      pendingItemName = null;
      pendingItemQty = null;

      if (/\b(anda\s*hemat|total\s*hemat|kamu\s*hemat)\b/i.test(line)) {
        const m = line.match(/([\dOo.,]+)\s*$/);
        if (m) detectedSavings = parseIdrToken(m[1]);
      }
      if (/\b(tunai|cash|kembali|kembalian|change|dpp|ppn\s*dibebaskan)\b/i.test(line)) {
        pastTotalPaymentLine = true;
      }
      continue;
    }

    if (pastTotalPaymentLine) {
      continue;
    }

    // Check subtotal lines (HARGA JUAL, SUBTOTAL, TOTAL HARGA on GoFood)
    if (SUBTOTAL_PATTERNS.some((p) => p.test(line))) {
      inSummarySection = true;
      pendingItemName = null;
      pendingItemQty = null;
      const subMatch = line.match(
        /((?:rp\.?\s*)?[\dOo]{1,3}(?:[.,][\dOo]{3})+(?:[.,]\d{2})?|(?:rp\.?\s*)?[\dOo]{3,7})\s*$/i
      );
      if (subMatch) {
        const val = parseIdrToken(subMatch[1]);
        if (val > 0) detectedSubtotal = val;
      }
      continue;
    }

    // Check final grand total lines (excludes "Total Promo", "Total Diskon", etc.)
    if (GRAND_TOTAL_PATTERNS.some((p) => p.test(line))) {
      inSummarySection = true;
      pendingItemName = null;
      pendingItemQty = null;
      const totalMatch = line.match(
        /((?:rp\.?\s*)?[\dOo]{1,3}(?:[.,][\dOo]{3})+(?:[.,]\d{2})?|(?:rp\.?\s*)?[\dOo]{3,7})\s*$/i
      );
      if (totalMatch) {
        const val = parseIdrToken(totalMatch[1]);
        if (val > 0) {
          detectedReceiptTotal = val;
        }
      }
      continue;
    }

    // Detect parenthesized discount lines (e.g. "VC PT RBI : (4,600)" or "DISKON : (1.300)")
    const parenDiscount = line.match(
      /\(\s*(?:rp\.?\s*)?([\dOo]{1,3}(?:[.,][\dOo]{3})+|[\dOo]{1,7})\s*\)\s*$/i
    );
    if (parenDiscount) {
      const discVal = parseIdrToken(parenDiscount[1]);
      if (discVal >= 100) {
        discountAmount += discVal;
      }
      pendingItemName = null;
      pendingItemQty = null;
      continue;
    }

    // Pattern 0 (2-line or multi-line POS / GoFood / Restaurant receipt):
    if (!inSummarySection && pendingItemName) {
      const twoLineDetail = line.match(
        /^(\d{1,3}|[|Il])\s*[xX*@]\s*@?\s*(?:rp\.?\s*)?([\dOo]{1,3}(?:[.,][\dOo]{3})+|[\dOo]{3,7})(?:\s+(?:rp\.?\s*)?([\dOo]{1,3}(?:[.,][\dOo]{3})+|[\dOo]{3,7}))?$/i
      );
      if (twoLineDetail) {
        const qty = /^[|Il]$/.test(twoLineDetail[1])
          ? 1
          : Math.max(1, parseInt(twoLineDetail[1], 10));
        const unit = parseIdrToken(twoLineDetail[2]);
        const lineTot = twoLineDetail[3] ? parseIdrToken(twoLineDetail[3]) : unit * qty;
        const resolvedUnit =
          unit > 0 ? unit : lineTot > 0 ? Math.round(lineTot / qty) : 0;
        if (resolvedUnit >= 100) {
          items.push({
            name: pendingItemName,
            qty,
            unit_price: resolvedUnit,
          });
          unpricedQtyItems.pop();
          pendingItemName = null;
          pendingItemQty = null;
          continue;
        }
      }
    }

    // Extract trailing price token
    const priceMatch = line.match(
      /(-?\s*(?:rp\.?\s*)?[\dOo]{1,3}(?:[.,][\dOo]{3})+(?:[.,]\d{2})?|-?\s*(?:rp\.?\s*)?\d{3,7})\s*$/i
    );
    if (!priceMatch) {
      if (!inSummarySection) {
        if (isModifierOrNoteLine(line)) {
          continue;
        }
        if (isLikelyItemNameOnly(line) && line !== merchantName) {
          const leadQty = line.match(/^(\d{1,2})\s*[xX]\s+(.+)$/);
          if (leadQty) {
            const q = Math.max(1, parseInt(leadQty[1], 10));
            const cleanName = leadQty[2].trim();
            pendingItemQty = q;
            pendingItemName = cleanName;
            unpricedQtyItems.push({ name: cleanName, qty: q });
          } else {
            pendingItemQty = null;
            pendingItemName = line;
          }
        }
      }
      continue;
    }

    const rawPriceToken = priceMatch[1];
    const amount = parseIdrToken(rawPriceToken);
    if (amount === 0) continue;

    let leftPart = line.slice(0, priceMatch.index).trim();

    // Standalone price line paired with previous pendingItemName
    if (!leftPart) {
      if (
        !inSummarySection &&
        pendingItemName &&
        isPlausibleIdrPrice(rawPriceToken, amount)
      ) {
        const qty = pendingItemQty ?? 1;
        items.push({
          name: pendingItemName,
          qty,
          unit_price: qty > 1 ? Math.round(amount / qty) : amount,
        });
        unpricedQtyItems.pop();
        pendingItemName = null;
        pendingItemQty = null;
      }
      continue;
    }

    // Tax / Service / Discount / GoFood Delivery & Packaging Fee lines
    if (/\b(pb1|ppn|tax|pajak|vat|pb\s*1)\b/i.test(leftPart)) {
      if (!/\bdpp\b|dibebaskan|incl/i.test(line)) {
        taxAmount += amount;
      }
      pendingItemName = null;
      pendingItemQty = null;
      continue;
    }
    if (/\b(service|svc|servis|gratuity)\b/i.test(leftPart)) {
      serviceAmount += amount;
      pendingItemName = null;
      pendingItemQty = null;
      continue;
    }
    if (
      /\b(vc\s*pt|voucher|disc|diskon|discount|promo|total\s*promo|potongan|pot\.|hemat|cashback)\b/i.test(
        leftPart
      ) ||
      rawPriceToken.trim().startsWith("-")
    ) {
      discountAmount += amount;
      pendingItemName = null;
      pendingItemQty = null;
      continue;
    }
    if (
      /\b(ongkir|ongkos\s*kirim|biaya\s*pengiriman|biaya\s*penanganan|biaya\s*bungkus|biaya\s*kemasan|biaya\s*restoran|biaya\s*layanan|biaya\s*pemesanan|biaya\s*platform|biaya\s*aplikasi|biaya\s*jasa|biaya\s*lain|packaging\s*fee|restaurant\s*packaging|delivery\s*fee|handling\s*fee|platform\s*fee|delivery|bungkus|takeaway|packaging|admin|rounding|pembulatan)\b/i.test(
        leftPart
      )
    ) {
      if (rawPriceToken.trim().startsWith("-")) {
        discountAmount += amount;
      } else {
        otherFeeAmount += amount;
      }
      pendingItemName = null;
      pendingItemQty = null;
      continue;
    }

    if (inSummarySection) {
      pendingItemName = null;
      pendingItemQty = null;
      continue;
    }

    if (NOISE_PATTERNS.some((p) => p.test(leftPart))) {
      pendingItemName = null;
      pendingItemQty = null;
      continue;
    }

    // Pattern A: Retail 3-column format "ITEM NAME   QTY   UNIT_PRICE   LINE_TOTAL"
    const threeColMatch = leftPart.match(
      /^(.+?)\s+(\d{1,3}|[|Il])\s+((?:[\dOo]{1,3}(?:[.,][\dOo]{3})+)|\d{2,7})$/
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
        candidateUnit >= 100 &&
        Math.abs(candidateQty * candidateUnit - amount) <=
          Math.max(200, amount * 0.05)
      ) {
        let resolvedUnit = candidateUnit;
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
        pendingItemName = null;
        pendingItemQty = null;
        continue;
      }
    }

    if (!isPlausibleIdrPrice(rawPriceToken, amount)) {
      continue;
    }

    // Handle GoFood strikethrough dual-price on the same line
    let effectiveAmount = amount;
    const dualPriceMatch = leftPart.match(
      /^(.+?)\s+((?:rp\.?\s*)?[\dOo]{1,3}(?:[.,][\dOo]{3})+)\s*$/i
    );
    if (dualPriceMatch) {
      const firstPrice = parseIdrToken(dualPriceMatch[2]);
      if (firstPrice >= 1000) {
        leftPart = dualPriceMatch[1].trim();
        effectiveAmount = Math.min(firstPrice, amount);
      }
    }

    // Pattern B: Restaurant / GoFood format "2x Sei Sapi 76.000" or "Sei Sapi x2 76.000"
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

    name = name
      .replace(/@\s*(?:rp\.?\s*)?[\dOo.,]+/gi, "")
      .replace(/[:\-–—]+$/, "")
      .replace(/^[+*•]\s*/, "")
      .trim();

    pendingItemName = null;
    pendingItemQty = null;
    if (name.length < 2 || !/[a-zA-Z]{2,}/.test(name)) continue;

    const unitPrice =
      qty > 1 ? Math.round(effectiveAmount / qty) : effectiveAmount;
    items.push({ name, qty, unit_price: unitPrice });
  }

  // Fallback for GoFood merchant dockets (like Se'Indonesia) where item lines have "1 x Menu Name"
  // without individual prices, and the item price is printed only at "Subtotal Rp 85.800"
  if (items.length === 0 && unpricedQtyItems.length > 0) {
    const inferredSubtotal =
      detectedSubtotal > 0
        ? detectedSubtotal
        : detectedReceiptTotal > 0
        ? Math.max(
            0,
            detectedReceiptTotal -
              taxAmount -
              serviceAmount -
              otherFeeAmount +
              discountAmount
          )
        : 0;

    if (inferredSubtotal > 0) {
      const totalQty = unpricedQtyItems.reduce((s, it) => s + it.qty, 0);
      const perUnit = Math.round(inferredSubtotal / Math.max(1, totalQty));
      for (const u of unpricedQtyItems) {
        items.push({
          name: u.name,
          qty: u.qty,
          unit_price: perUnit,
        });
      }
    }
  }

  if (discountAmount === 0 && detectedSavings > 0) {
    discountAmount = detectedSavings;
  }

  const finalTotal = detectedReceiptTotal || detectedSubtotal;

  // Smart Tax-Inclusive Reconciliation
  const itemsSubtotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  if (
    finalTotal > 0 &&
    taxAmount > 0 &&
    Math.abs(
      itemsSubtotal + serviceAmount + otherFeeAmount - discountAmount - finalTotal
    ) <= 500
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
    printed_total: finalTotal || undefined,
    engine: "tesseract",
    raw_text: rawText,
  };
}
