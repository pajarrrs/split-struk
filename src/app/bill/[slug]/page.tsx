"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SplitBillSummaryView } from "@/components/SplitBillSummaryView";
import type { BillData } from "@/lib/types";

export default function SharedBillPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug;

  const [bill, setBill] = useState<BillData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      setToast({ message, tone });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setToast(null), 3200);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!slug) return;
    let active = true;
    async function fetchBill() {
      try {
        const res = await fetch(`/api/bills/${slug}`, { cache: "no-store" });
        if (!active) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = await res.json();
        setBill(data.bill);
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchBill();
    return () => {
      active = false;
    };
  }, [slug]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-[#F2F2F7] sm:border-x sm:border-black/8">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-black/6 bg-[#F2F2F7]/85 px-4 py-3 backdrop-blur-xl">
        <Link
          href="/"
          className="text-[16px] font-semibold tracking-[-0.02em] text-[#1C1C1E]"
        >
          SplitStruk
        </Link>
        <Link
          href="/"
          className="text-[14px] font-medium text-[#007AFF] hover:opacity-80"
        >
          Buat Baru
        </Link>
      </header>

      {toast && (
        <div className="fixed left-1/2 top-16 z-50 w-[90%] max-w-sm -translate-x-1/2">
          <div
            className={`rounded-full px-4 py-2.5 text-center text-[13px] font-semibold text-white shadow-lg backdrop-blur-md ${
              toast.tone === "error" ? "bg-[#FF3B30]/95" : "bg-[#1C1C1E]/90"
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-20">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-[#D1D1D6] border-t-[#007AFF]" />
        </div>
      ) : notFound || !bill ? (
        <div className="px-6 py-20 text-center">
          <h2 className="text-[17px] font-semibold text-[#1C1C1E]">
            Tagihan tidak ditemukan
          </h2>
          <p className="mt-1 text-[13px] text-[#8E8E93]">
            Tautan mungkin sudah dihapus atau keliru.
          </p>
          <Link
            href="/"
            className="mt-5 inline-block rounded-[14px] bg-[#007AFF] px-5 py-2.5 text-[14px] font-semibold text-white"
          >
            Kembali ke Beranda
          </Link>
        </div>
      ) : (
        <SplitBillSummaryView
          bill={bill}
          onBillUpdated={(updated) => setBill(updated)}
          onEditBill={() => router.push(`/?edit=${bill.slug}`)}
          onNotify={notify}
        />
      )}
    </div>
  );
}
