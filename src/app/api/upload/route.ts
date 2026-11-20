import { saveUploadedImage } from "@/lib/uploads";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "File gambar wajib dilampirkan." }, { status: 400 });
    }
    const kind = String(formData.get("kind") || "qris") === "receipt" ? "receipt" : "qris";
    const saved = await saveUploadedImage(file, kind);
    return Response.json({ url: saved.url, filename: saved.filename }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gagal mengunggah gambar.";
    return Response.json({ error: message }, { status: 400 });
  }
}
