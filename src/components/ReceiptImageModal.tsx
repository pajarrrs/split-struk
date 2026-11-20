"use client";

import { X } from "lucide-react";

interface ReceiptImageModalProps {
  src: string;
  title: string;
  subtitle?: string;
  allowDownload?: boolean;
  onClose: () => void;
}

export function ReceiptImageModal({
  src,
  title,
  subtitle,
  allowDownload = true,
  onClose,
}: ReceiptImageModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-xs sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-t-[28px] bg-[#F2F2F7] shadow-2xl sm:rounded-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-2.5 pb-1">
          <div className="h-1 w-9 rounded-full bg-[#C7C7CC]" />
        </div>

        <div className="flex items-center justify-between px-5 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-[16px] font-semibold tracking-[-0.015em] text-[#1C1C1E]">
              {title}
            </h3>
            {subtitle && (
              <p className="truncate text-[12px] text-[#8E8E93]">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[#E5E5EA] text-[#3C3C43] hover:bg-[#D1D1D6]"
            aria-label="Tutup"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex max-h-[62vh] items-center justify-center overflow-auto px-4 pb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={title}
            className="max-h-[56vh] w-auto rounded-[18px] bg-white object-contain shadow-xs ring-1 ring-black/5"
          />
        </div>

        {allowDownload && (
          <div className="px-4 pb-5 pt-1">
            <a
              href={src}
              download
              className="block w-full rounded-[14px] bg-[#007AFF] py-3.5 text-center text-[15px] font-semibold text-white transition active:scale-[0.98]"
            >
              Simpan ke Foto
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
