import fs from "node:fs";
import path from "node:path";
import {
  getMimeFromFilename,
  isValidUploadFilename,
  UPLOADS_DIR,
} from "@/lib/uploads";

export async function GET(
  _request: Request,
  context: { params: Promise<{ filename: string }> }
) {
  const { filename } = await context.params;
  if (!isValidUploadFilename(filename)) {
    return Response.json({ error: "File tidak valid." }, { status: 400 });
  }

  const fullPath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    return Response.json({ error: "Gambar tidak ditemukan." }, { status: 404 });
  }

  const bytes = fs.readFileSync(fullPath);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": getMimeFromFilename(filename),
      "Cache-Control": "public, max-age=86400",
    },
  });
}
