import { isValidUploadFilename, readUploadedImage } from "@/lib/uploads";

export async function GET(
  _request: Request,
  context: { params: Promise<{ filename: string }> }
) {
  const { filename } = await context.params;
  if (!isValidUploadFilename(filename)) {
    return Response.json({ error: "File tidak valid." }, { status: 400 });
  }

  const found = await readUploadedImage(filename);
  if (!found) {
    return Response.json({ error: "Gambar tidak ditemukan." }, { status: 404 });
  }

  return new Response(new Uint8Array(found.buffer), {
    status: 200,
    headers: {
      "Content-Type": found.mime,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
