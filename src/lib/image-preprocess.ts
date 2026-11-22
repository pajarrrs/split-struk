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
 * Draws an image onto a canvas with optional 90-degree rotation:
 * - rotationDeg = 0: as-is
 * - rotationDeg = -90 (90 CCW): upright for standard sideways landscape phone photos
 * - rotationDeg = 90 (90 CW): opposite sideways landscape orientation
 */
function renderScaledCanvas(
  img: HTMLImageElement,
  targetLongEdge: number,
  rotationDeg: 0 | 90 | -90
): HTMLCanvasElement {
  const srcW = img.width;
  const srcH = img.height;
  const scale = targetLongEdge / Math.max(srcW, srcH);
  const drawW = Math.max(1, Math.round(srcW * scale));
  const drawH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  if (rotationDeg === 90 || rotationDeg === -90) {
    canvas.width = drawH;
    canvas.height = drawW;
  } else {
    canvas.width = drawW;
    canvas.height = drawH;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.save();
  if (rotationDeg === -90) {
    ctx.translate(0, drawW);
    ctx.rotate(-Math.PI / 2);
  } else if (rotationDeg === 90) {
    ctx.translate(drawH, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0, drawW, drawH);
  ctx.restore();

  return canvas;
}

/**
 * Downscales large phone camera photos to max 1600px JPEG (~300-600KB)
 * and auto-uprights sideways landscape receipt photos so Vision AI & preview look right.
 */
export async function prepareReceiptForUpload(file: File): Promise<File> {
  try {
    const img = await loadImageElement(file);
    const isSidewaysLandscape = img.width > img.height * 1.18;
    const maxDim = Math.min(1600, Math.max(img.width, img.height));

    if (
      !isSidewaysLandscape &&
      maxDim === Math.max(img.width, img.height) &&
      file.size <= 1.2 * 1024 * 1024
    ) {
      return file;
    }

    const canvas = renderScaledCanvas(
      img,
      maxDim,
      isSidewaysLandscape ? -90 : 0
    );

    const blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
    const baseName = file.name.replace(/\.[^.]+$/, "") || "receipt";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * Applies integral-image local illumination normalization & contrast stretch to a canvas
 * to eliminate dark phone shadows and uneven thermal paper lighting.
 */
function applyAdaptiveContrastToCanvas(canvas: HTMLCanvasElement): void {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const total = w * h;
  const gray = new Uint8Array(total);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = Math.round(
      0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    );
  }

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

  const radius = Math.max(16, Math.min(40, Math.round(w * 0.025)));

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
      const ratio = localMean > 10 ? g / localMean : 1;
      let out: number;
      if (ratio >= 0.94) {
        out = 255;
      } else if (ratio <= 0.64) {
        out = 0;
      } else {
        out = Math.round(((ratio - 0.64) / (0.94 - 0.64)) * 255);
      }

      const idx = (y * w + x) * 4;
      data[idx] = out;
      data[idx + 1] = out;
      data[idx + 2] = out;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Enhances raw receipt photos for local Tesseract.js OCR.
 * If the photo is sideways (landscape width > height * 1.18), returns both 90° CCW and 90° CW
 * candidates so Tesseract automatically picks upright orientation.
 */
export async function preprocessReceiptCandidatesForTesseract(
  file: File
): Promise<Blob[]> {
  try {
    const img = await loadImageElement(file);
    const longEdge = Math.max(img.width, img.height);
    const targetLongEdge =
      longEdge < 1400
        ? Math.min(2200, Math.round(longEdge * 2.2))
        : Math.min(2200, longEdge);

    const isSidewaysLandscape = img.width > img.height * 1.18;
    const rotations: Array<0 | -90 | 90> = isSidewaysLandscape
      ? [-90, 90]
      : [0];

    const blobs: Blob[] = [];
    for (const rot of rotations) {
      const canvas = renderScaledCanvas(img, targetLongEdge, rot);
      applyAdaptiveContrastToCanvas(canvas);
      blobs.push(await canvasToBlob(canvas, "image/png", 1));
    }
    return blobs;
  } catch {
    return [file];
  }
}
