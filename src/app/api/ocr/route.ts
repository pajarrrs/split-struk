import { getTodayIsoDate } from "@/lib/split-math";
import { saveUploadedImage } from "@/lib/uploads";
import type { ParsedReceiptResult } from "@/lib/types";

const GEMINI_PROMPT = `Kamu adalah parser struk belanja & restoran Indonesia yang sangat teliti.
Ekstrak data dari foto struk ini ke JSON valid dengan struktur persis berikut:
{
  "merchant_name": "nama restoran atau toko",
  "bill_date": "YYYY-MM-DD (gunakan tanggal hari ini jika tidak terbaca)",
  "items": [
    { "name": "nama item tanpa qty", "qty": 1, "unit_price": 25000 }
  ],
  "tax_amount": 0,
  "service_amount": 0,
  "other_fee_amount": 0,
  "discount_amount": 0
}
Aturan penting:
- Semua nominal dalam Rupiah INTEGER murni tanpa titik/koma/Rp (contoh: 25000, bukan 25.000).
- Jika di struk tertulis "2 Nasi Goreng 76.000" atau format 3 kolom "IDM KTG PLSTK 2 300 600", maka qty=2 dan unit_price=300 (harga per 1 satuan, jangan masukkan angka qty/harga ke dalam name).
- Untuk struk minimarket/supermarket (Indomaret/Alfamart) di mana PPN/DPP sudah termasuk dalam harga barang (tax-inclusive), isi tax_amount = 0. Hanya isi tax_amount jika pajak (PB1/PPN) ditambahkan di atas subtotal.
- Masukkan Service Charge/Layanan ke service_amount.
- Masukkan Ongkir/Packaging/Biaya Lain ke other_fee_amount.
- Masukkan Diskon/Promo/Voucher (termasuk baris berformat "(4,600)" atau "VC PT ...") sebagai angka POSITIF di discount_amount.
- Jangan masukkan HARGA JUAL, ANDA HEMAT, Subtotal, Total, Tunai, QRIS, Kembalian, atau baris DPP/PPN ke dalam items.`;

async function extractWithGemini(
  buffer: Buffer,
  mime: string
): Promise<ParsedReceiptResult> {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("NO_GEMINI_KEY");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: GEMINI_PROMPT },
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
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`GEMINI_HTTP_${res.status}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("GEMINI_EMPTY");

  const parsed = JSON.parse(text) as {
    merchant_name?: string;
    bill_date?: string;
    items?: Array<{ name?: string; qty?: number; unit_price?: number }>;
    tax_amount?: number;
    service_amount?: number;
    other_fee_amount?: number;
    discount_amount?: number;
  };

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

  return {
    merchant_name: (parsed.merchant_name || "").trim() || "Struk Belanja",
    bill_date:
      typeof parsed.bill_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.bill_date)
        ? parsed.bill_date
        : getTodayIsoDate(),
    items,
    tax_amount: cleanInt(parsed.tax_amount),
    service_amount: cleanInt(parsed.service_amount),
    other_fee_amount: cleanInt(parsed.other_fee_amount),
    discount_amount: cleanInt(parsed.discount_amount),
    engine: "gemini",
  };
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

    try {
      const parsed = await extractWithGemini(saved.buffer, saved.mime);
      return Response.json({
        receipt_image_url: saved.url,
        parsed,
        fallback_needed: false,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.message === "NO_GEMINI_KEY"
          ? "no_api_key"
          : "gemini_failed";
      return Response.json({
        receipt_image_url: saved.url,
        parsed: null,
        fallback_needed: true,
        reason,
      });
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Gagal memproses foto struk.";
    return Response.json({ error: message }, { status: 400 });
  }
}
