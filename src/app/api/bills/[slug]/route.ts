import { z } from "zod";
import { deleteBillBySlug, getBillBySlug, saveBillRecord } from "@/lib/db";
import { billSchema } from "../route";

const togglePaidSchema = z.object({
  action: z.literal("toggle_paid"),
  participant_id: z.string().min(1).max(40),
  is_paid: z.boolean(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;
  if (!/^[a-f0-9]{6,16}$/.test(slug)) {
    return Response.json({ error: "Kode bill tidak valid." }, { status: 400 });
  }

  const bill = getBillBySlug(slug);
  if (!bill) {
    return Response.json({ error: "Bill tidak ditemukan." }, { status: 404 });
  }

  return Response.json({ bill });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;
  if (!/^[a-f0-9]{6,16}$/.test(slug)) {
    return Response.json({ error: "Kode bill tidak valid." }, { status: 400 });
  }

  const existing = getBillBySlug(slug);
  if (!existing) {
    return Response.json({ error: "Bill tidak ditemukan." }, { status: 404 });
  }

  try {
    const body = await request.json();
    const toggleParsed = togglePaidSchema.safeParse(body);
    if (toggleParsed.success) {
      const updatedParticipants = existing.participants.map((p) =>
        p.id === toggleParsed.data.participant_id
          ? { ...p, is_paid: toggleParsed.data.is_paid }
          : p
      );
      const saved = saveBillRecord({
        ...existing,
        slug,
        participants: updatedParticipants,
      });
      return Response.json({ bill: saved });
    }

    const fullParsed = billSchema.safeParse({ ...body, slug });
    if (!fullParsed.success) {
      return Response.json(
        { error: fullParsed.error.issues[0]?.message ?? "Data bill tidak valid." },
        { status: 400 }
      );
    }

    const saved = saveBillRecord(fullParsed.data);
    return Response.json({ bill: saved });
  } catch {
    return Response.json({ error: "Gagal memperbarui bill." }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;
  if (!/^[a-f0-9]{6,16}$/.test(slug)) {
    return Response.json({ error: "Kode bill tidak valid." }, { status: 400 });
  }

  const ok = deleteBillBySlug(slug);
  if (!ok) {
    return Response.json({ error: "Bill tidak ditemukan." }, { status: 404 });
  }
  return Response.json({ ok: true });
}
