import { z } from "zod";
import { listRecentBills, saveBillRecord } from "@/lib/db";

const uploadUrlRegex = /^\/api\/uploads\/(receipt|qris)-\d+-[a-f0-9]{8}\.(png|jpg|webp)$/;

export const billSchema = z.object({
  slug: z.string().regex(/^[a-f0-9]{6,16}$/).optional(),
  title: z.string().trim().min(1, "Judul bill wajib diisi.").max(100),
  merchant_name: z.string().trim().max(100).optional().default(""),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format tanggal tidak valid."),
  receipt_image_url: z.string().regex(uploadUrlRegex).nullable().optional().default(null),
  tax_amount: z.number().int().min(0).max(50000000).default(0),
  service_amount: z.number().int().min(0).max(50000000).default(0),
  other_fee_amount: z.number().int().min(0).max(50000000).default(0),
  discount_amount: z.number().int().min(0).max(50000000).default(0),
  payment_info: z.object({
    payer_name: z.string().trim().max(60).optional().default(""),
    bank_name: z.string().trim().max(40).optional().default(""),
    account_number: z.string().trim().max(40).optional().default(""),
    account_holder: z.string().trim().max(60).optional().default(""),
    qris_image_url: z.string().regex(uploadUrlRegex).nullable().optional().default(null),
  }),
  participants: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().trim().min(1).max(50),
        is_paid: z.boolean().default(false),
      })
    )
    .min(1, "Minimal tambahkan 1 peserta."),
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().trim().min(1, "Nama item wajib diisi.").max(100),
        qty: z.number().int().min(1).max(999),
        unit_price: z.number().int().min(0).max(50000000),
        assigned_to: z.array(z.string().min(1).max(40)),
      })
    )
    .min(1, "Minimal ada 1 item pada struk."),
});

export async function GET() {
  const bills = listRecentBills(30);
  return Response.json({ bills });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = billSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "Data split bill tidak valid." },
        { status: 400 }
      );
    }

    const saved = saveBillRecord(parsed.data);
    return Response.json({ bill: saved }, { status: 201 });
  } catch {
    return Response.json({ error: "Gagal menyimpan split bill." }, { status: 500 });
  }
}
