import { getTodayIsoDate } from "@/lib/split-math";
import { saveUploadedImage } from "@/lib/uploads";
import type { ParsedReceiptResult } from "@/lib/types";

const VISION_PROMPT = `Kamu adalah parser struk belanja, kafe, minimarket, dan restoran Indonesia yang sangat presisi.
Baca foto struk ini secara menyeluruh (termasuk bila miring, kusut, pudar, atau format 2 baris) lalu kembalikan HANYA JSON valid dengan struktur persis berikut:
{
  "merchant_name": "nama restoran atau toko",
  "bill_date": "YYYY-MM-DD (gunakan tanggal hari ini jika tidak terbaca)",
  "items": [
    { "name": "nama menu/produk bersih tanpa angka qty atau harga", "qty": 1, "unit_price": 25000 }
  ],
  "tax_amount": 0,
  "service_amount": 0,
  "other_fee_amount": 0,
  "discount_amount": 0,
  "printed_total": 0
}

Aturan wajib:
1. Semua nominal dalam Rupiah INTEGER murni tanpa titik, koma, desimal .00, atau "Rp" (contoh: 25000, bukan 25.000).
2. Format multi-qty:
   - "2 Nasi Goreng 76.000" -> qty=2, unit_price=38000 (harga PER 1 SATUAN, bukan total baris!).
   - Format 3 kolom minimarket "IDM KTG PLSTK 2 300 600" -> qty=2, unit_price=300.
   - Format 2 baris POS/kafe (Moka/Majoo/ESB/Qasir): baris 1 nama menu, baris 2 "2 x 28.000   56.000" -> gabungkan menjadi 1 item (qty=2, unit_price=28000).
   - Jangan gabungkan angka qty/harga ke dalam field "name".
   - Abaikan sub-baris catatan/modifier dengan harga 0 (misal "Less Ice", "Pedas", "No Sugar"). Jika topping/add-on punya harga > 0, masukkan sebagai item sendiri atau gabungkan ke harga itemnya.
3. Pajak (tax_amount):
   - Untuk struk minimarket/supermarket (Indomaret, Alfamart, Super Indo) di mana PPN/DPP di bagian bawah sudah termasuk harga barang (tax-inclusive), WAJIB isi tax_amount = 0.
   - Hanya isi tax_amount > 0 jika PB1/PPN/Tax benar-benar ditambahkan DI ATAS subtotal.
4. Biaya & Diskon:
   - Service Charge / Gratuity / Layanan -> service_amount.
   - Ongkir / Packaging / Takeaway / Pembulatan positif / Biaya Admin -> other_fee_amount.
   - Diskon / Promo / Voucher / Baris bertanda minus atau dalam kurung "(4,600)" / "VC PT ..." -> angka POSITIF di discount_amount. (Jangan dobel hitung baris "ANDA HEMAT" jika voucher per baris sudah dijumlahkan!).
5. printed_total: isi dengan angka TOTAL / GRAND TOTAL / HARGA JUAL / TOTAL BAYAR final yang tercetak di struk (bukan nominal TUNAI yang dibayarkan pembeli).
6. VERIFIKASI MATEMATIKA SEBELUM MENJAWAB: Pastikan sum(qty * unit_price) + tax_amount + service_amount + other_fee_amount - discount_amount sedekat mungkin / persis sama dengan printed_total!
7. Jangan pernah memasukkan Subtotal, HARGA JUAL, TOTAL, TUNAI, QRIS, Kembalian, ANDA HEMAT, DPP, atau baris footer ke dalam array items.`;

interface RawVisionJson {
  merchant_name?: string;
  bill_date?: string;
  items?: Array<{ name?: string; qty?: number; unit_price?: number }>;
  tax_amount?: number;
  service_amount?: number;
  other_fee_amount?: number;
  discount_amount?: number;
  printed_total?: number;
}

function normalizeVisionResponse(
  rawText: string,
  engine: "gemini" | "groq" | "openai"
): ParsedReceiptResult {
  // Strip accidental markdown code fences if a model wraps JSON
  const cleanedJson = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleanedJson) as RawVisionJson;

  const cleanInt = (val: unknown) => {
    const n = Math.round(Number(val) || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const items = Array.isArray(parsed.items)
    ? parsed.items
        .filter((it) => typeof it?.name === "string" && it.name.trim().length > 0)
        .map((it) => ({
          name: String(it.name).trim(),
          qty: Math.max(1, cleanInt(it.qty) || 1),
          unit_price: cleanInt(it.unit_price),
        }))
    : [];

  let taxAmount = cleanInt(parsed.tax_amount);
  const serviceAmount = cleanInt(parsed.service_amount);
  const otherFeeAmount = cleanInt(parsed.other_fee_amount);
  const discountAmount = cleanInt(parsed.discount_amount);
  const printedTotal = cleanInt(parsed.printed_total);

  // Guard against AI accidentally including tax-inclusive minimarket PPN
  if (printedTotal > 0 && taxAmount > 0) {
    const sub = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
    const totalWithoutTax = sub + serviceAmount + otherFeeAmount - discountAmount;
    const totalWithTax = totalWithoutTax + taxAmount;
    if (
      Math.abs(totalWithoutTax - printedTotal) <= 100 &&
      Math.abs(totalWithTax - printedTotal) > 100
    ) {
      taxAmount = 0;
    }
  }

  return {
    merchant_name: (parsed.merchant_name || "").trim() || "Struk Belanja",
    bill_date:
      typeof parsed.bill_date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.bill_date)
        ? parsed.bill_date
        : getTodayIsoDate(),
    items,
    tax_amount: taxAmount,
    service_amount: serviceAmount,
    other_fee_amount: otherFeeAmount,
    discount_amount: discountAmount,
    printed_total: printedTotal || undefined,
    engine,
  };
}

async function extractWithGemini(
  buffer: Buffer,
  mime: string,
  apiKey: string
): Promise<ParsedReceiptResult> {
  const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
  let lastError = "GEMINI_FAILED";

  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(22000),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: VISION_PROMPT },
              {
                inline_data: {
                  mime_type: mime,
                  data: buffer.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.05,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      lastError = `GEMINI_${model}_HTTP_${res.status}`;
      continue;
    }

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      lastError = `GEMINI_${model}_EMPTY`;
      continue;
    }

    return normalizeVisionResponse(text, "gemini");
  }

  throw new Error(lastError);
}

async function extractWithOpenAICompatible(
  buffer: Buffer,
  mime: string,
  endpoint: string,
  apiKey: string,
  model: string,
  engine: "groq" | "openai"
): Promise<ParsedReceiptResult> {
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(22000),
    body: JSON.stringify({
      model,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: dataUrl,
                ...(engine === "openai" ? { detail: "high" } : {}),
              },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`${engine.toUpperCase()}_HTTP_${res.status}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${engine.toUpperCase()}_EMPTY`);

  return normalizeVisionResponse(text, engine);
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return Response.json(
        { error: "Foto struk wajib dilampirkan." },
        { status: 400 }
      );
    }

    const saved = await saveUploadedImage(file, "receipt");

    const geminiKey = (process.env.GEMINI_API_KEY || "").trim();
    const groqKey = (process.env.GROQ_API_KEY || "").trim();
    const openaiKey = (process.env.OPENAI_API_KEY || "").trim();

    const hasAnyKey = Boolean(geminiKey || groqKey || openaiKey);
    if (!hasAnyKey) {
      return Response.json({
        receipt_image_url: saved.url,
        parsed: null,
        fallback_needed: true,
        reason: "no_api_key",
      });
    }

    // Try available AI Vision providers in priority order: Gemini -> Groq -> OpenAI
    const attempts: Array<() => Promise<ParsedReceiptResult>> = [];
    if (geminiKey) {
      attempts.push(() => extractWithGemini(saved.buffer, saved.mime, geminiKey));
    }
    if (groqKey) {
      attempts.push(() =>
        extractWithOpenAICompatible(
          saved.buffer,
          saved.mime,
          "https://api.groq.com/openai/v1/chat/completions",
          groqKey,
          "meta-llama/llama-4-scout-17b-16e-instruct",
          "groq"
        )
      );
    }
    if (openaiKey) {
      attempts.push(() =>
        extractWithOpenAICompatible(
          saved.buffer,
          saved.mime,
          "https://api.openai.com/v1/chat/completions",
          openaiKey,
          "gpt-4o-mini",
          "openai"
        )
      );
    }

    for (const run of attempts) {
      try {
        const parsed = await run();
        if (parsed.items.length > 0) {
          return Response.json({
            receipt_image_url: saved.url,
            parsed,
            fallback_needed: false,
          });
        }
      } catch {
        // Fall through to next provider or local Tesseract
      }
    }

    return Response.json({
      receipt_image_url: saved.url,
      parsed: null,
      fallback_needed: true,
      reason: "vision_failed",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Gagal memproses foto struk.";
    return Response.json({ error: message }, { status: 400 });
  }
}
