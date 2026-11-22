"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";

interface Props {
  onCapture: (file: File) => void;
  onClose: () => void;
  onFallbackToFile: () => void;
}

export function CameraCaptureModal({
  onCapture,
  onClose,
  onFallbackToFile,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Kamera tidak tersedia di browser ini.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          if (active) setReady(true);
        }
      } catch {
        if (active) {
          setError("Izin kamera ditolak atau kamera tidak ditemukan.");
        }
      }
    }

    startCamera();

    return () => {
      active = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  function handleSnap() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `struk-${Date.now()}.jpg`, {
          type: "image/jpeg",
        });
        onCapture(file);
      },
      "image/jpeg",
      0.92
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label="Kamera Foto Struk"
    >
      <div className="flex items-center justify-between px-4 pb-3 pt-4 text-white">
        <span className="text-[15px] font-semibold">Foto Struk</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition active:scale-95"
          aria-label="Tutup kamera"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {error ? (
          <div className="mx-6 max-w-xs space-y-4 rounded-[20px] bg-white/10 p-6 text-center text-white backdrop-blur-md">
            <p className="text-[14px] leading-relaxed text-white/90">{error}</p>
            <button
              type="button"
              onClick={onFallbackToFile}
              className="w-full rounded-[14px] bg-[#007AFF] py-3 text-[14px] font-semibold text-white"
            >
              Pilih dari Galeri
            </button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              className="h-full w-full object-cover"
            />
            {/* Subtle receipt framing guide */}
            <div className="pointer-events-none absolute inset-6 flex items-center justify-center">
              <div className="h-[78%] w-full max-w-[320px] rounded-[20px] border-2 border-white/60 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
            <p className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/55 px-3.5 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm">
              Posisikan struk rata & terang di dalam bingkai
            </p>
          </>
        )}
      </div>

      {!error && (
        <div className="flex items-center justify-center bg-black px-6 pb-8 pt-5">
          <button
            type="button"
            disabled={!ready}
            onClick={handleSnap}
            className="flex h-[70px] w-[70px] items-center justify-center rounded-full border-4 border-white/90 p-1 transition active:scale-95 disabled:opacity-40"
            aria-label="Ambil foto struk"
          >
            <span className="flex h-full w-full items-center justify-center rounded-full bg-white text-[#1C1C1E]">
              <Camera className="h-6 w-6" />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
