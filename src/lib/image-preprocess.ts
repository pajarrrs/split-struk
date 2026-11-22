"use client";

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Gagal membaca file gambar."));
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Gagal mengonversi gambar."));
      },
      mime,
      quality
    );
  });
}

/**
 * Downscales large phone camera photos to max 1600px JPEG (~300-600KB)
 * so uploads never hit Vercel's 4.5MB serverless body limit and Vision AI responds faster.
 */
export async function prepareReceiptForUpload(file: File): Promise<File> {
  try {
    const img = await loadImageElement(file);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));

    // Skip re-encoding if already compact and reasonably sized
    if (scale === 1 && file.size <= 1.2 * 1024 * 1024) {
      return file;
    }

    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
    const baseName = file.name.replace(/\.[^.]+$/, "") || "receipt";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * Enhances raw receipt photos for local Tesseract.js OCR using:
 * 1) Optimal width scaling (~1600px for crisp small thermal fonts)
 * 2) Grayscale conversion
 * 3) Integral-image local illumination normalization (removes uneven shadows & yellow paper tint)
 * 4) Soft contrast stretching for sharp dark text on white background
 */
export async function preprocessReceiptForTesseract(file: File): Promise<Blob> {
  try {
    const img = await loadImageElement(file);
    const targetW = img.width < 1100 ? Math.min(1600, Math.round(img.width * 2)) : Math.min(1800, img.width);
    const scale = targetW / img.width;
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const total = w * h;
    const gray = new Uint8Array(total);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = Math.round(
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      );
    }

    // Build summed-area table (integral image) for fast O(1) local mean background estimation
    const stride = w + 1;
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
      let rowSum = 0;
      const rowOffset = y * stride;
      const prevRowOffset = (y - 1) * stride;
      const grayRow = (y - 1) * w;
      for (let x = 1; x <= w; x++) {
        rowSum += gray[grayRow + (x - 1)];
        integral[rowOffset + x] = integral[prevRowOffset + x] + rowSum;
      }
    }

    // Window radius ~2.5% of image width captures local illumination without washing out characters
    const radius = Math.max(14, Math.min(36, Math.round(w * 0.025)));

    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(h - 1, y + radius);
      const r1 = y1 * stride;
      const r2 = (y2 + 1) * stride;

      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - radius);
        const x2 = Math.min(w - 1, x + radius);
        const area = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum =
          integral[r2 + x2 + 1] -
          integral[r1 + x2 + 1] -
          integral[r2 + x1] +
          integral[r1 + x1];
        const localMean = sum / area;

        const g = gray[y * w + x];
        // Normalize relative to local paper brightness, then apply gentle S-curve contrast boost
        const ratio = localMean > 10 ? g / localMean : 1;
        let out: number;
        if (ratio >= 0.94) {
          out = 255;
        } else if (ratio <= 0.62) {
          out = 0;
        } else {
          out = Math.round(((ratio - 0.62) / (0.94 - 0.62)) * 255);
        }

        const idx = (y * w + x) * 4;
        data[idx] = out;
        data[idx + 1] = out;
        data[idx + 2] = out;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return await canvasToBlob(canvas, "image/png", 1);
  } catch {
    return file;
  }
}
