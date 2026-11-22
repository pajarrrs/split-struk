"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Minus, Plus, X } from "lucide-react";
import {
  prepareReceiptForUpload,
  preprocessReceiptForTesseract,
} from "@/lib/image-preprocess";
import { parseIndonesianReceiptText } from "@/lib/receipt-parser";
import {
  calculateSplit,
  formatRupiah,
  getTodayIsoDate,
} from "@/lib/split-math";
import type {
  BillData,
  BillItem,
  ParsedReceiptResult,
  SavedBillSummary,
} from "@/lib/types";
import { ReceiptImageModal } from "./ReceiptImageModal";
import { SplitBillSummaryView } from "./SplitBillSummaryView";

type Step = "scan" | "edit" | "assign" | "summary";

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

function createEmptyBill(): BillData {
  return {
    title: "",
    merchant_name: "",
    bill_date: getTodayIsoDate(),
    receipt_image_url: null,
    tax_amount: 0,
    service_amount: 0,
    other_fee_amount: 0,
    discount_amount: 0,
    payment_info: {
      payer_name: "",
      bank_name: "",
      account_number: "",
      account_holder: "",
      qris_image_url: null,
    },
    participants: [
      { id: "p-1", name: "Saya", is_paid: true },
      { id: "p-2", name: "Teman 1", is_paid: false },
    ],
    items: [],
  };
}

export function SplitStrukWorkspace({ editSlug }: { editSlug?: string | null }) {
  const [step, setStep] = useState<Step>("scan");
  const [bill, setBill] = useState<BillData>(() => createEmptyBill());
  const [ocrEngine, setOcrEngine] = useState<ParsedReceiptResult["engine"] | null>(
    null
  );
  const [printedTotal, setPrintedTotal] = useState<number | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanLabel, setScanLabel] = useState("");
  const [scanProgress, setScanProgress] = useState<number | null>(null);

  const [history, setHistory] = useState<SavedBillSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [newPersonName, setNewPersonName] = useState("");

  const [uploadingQris, setUploadingQris] = useState(false);
  const [savingBill, setSavingBill] = useState(false);

  const [previewImg, setPreviewImg] = useState<{
    src: string;
    title: string;
  } | null>(null);

  const [toast, setToast] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      setToast({ message, tone });
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToast(null), 3200);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/bills", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setHistory(data.bills ?? []);
      }
    } catch {
      // Ignore transient error
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function fetchInitialHistory() {
      try {
        const res = await fetch("/api/bills", { cache: "no-store" });
        if (!res.ok || !active) return;
        const data = await res.json();
        if (active) setHistory(data.bills ?? []);
      } catch {
        // Ignore transient error
      }
    }
    fetchInitialHistory();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!editSlug) return;
    let active = true;
    async function loadForEdit() {
      try {
        const res = await fetch(`/api/bills/${editSlug}`, { cache: "no-store" });
        if (!res.ok || !active) return;
        const data = await res.json();
        if (data.bill) {
          setBill(data.bill);
          setStep("edit");
        }
      } catch {
        // Ignore
      }
    }
    loadForEdit();
    return () => {
      active = false;
    };
  }, [editSlug]);

  const summary = useMemo(() => calculateSplit(bill), [bill]);

  function applyParsedReceipt(
    parsed: ParsedReceiptResult,
    receiptImageUrl: string | null
  ) {
    const mappedItems: BillItem[] =
      parsed.items.length > 0
        ? parsed.items.map((it) => ({
            id: uid("item"),
            name: it.name,
            qty: Math.max(1, it.qty),
            unit_price: Math.max(0, it.unit_price),
            assigned_to: [],
          }))
        : [
            {
              id: uid("item"),
              name: "",
              qty: 1,
              unit_price: 0,
              assigned_to: [],
            },
          ];

    setBill((prev) => ({
      ...createEmptyBill(),
      merchant_name: parsed.merchant_name,
      title: parsed.merchant_name,
      bill_date: parsed.bill_date || getTodayIsoDate(),
      receipt_image_url: receiptImageUrl,
      tax_amount: parsed.tax_amount,
      service_amount: parsed.service_amount,
      other_fee_amount: parsed.other_fee_amount,
      discount_amount: parsed.discount_amount,
      participants:
        prev.participants.length > 0
          ? prev.participants
          : [
              { id: "p-1", name: "Saya", is_paid: true },
              { id: "p-2", name: "Teman 1", is_paid: false },
            ],
      items: mappedItems,
    }));
    setOcrEngine(parsed.engine);
    setPrintedTotal(parsed.printed_total ?? null);
    setStep("edit");
  }

  async function handleReceiptFileSelected(file: File) {
    setScanning(true);
    setScanProgress(null);
    setScanLabel("Menyiapkan foto struk...");

    try {
      const uploadFile = await prepareReceiptForUpload(file);
      setScanLabel("Membaca struk...");

      const form = new FormData();
      form.append("file", uploadFile);

      const res = await fetch("/api/ocr", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok) {
        notify(data.error || "Gagal mengunggah foto struk.", "error");
        return;
      }

      if (data.parsed && !data.fallback_needed) {
        applyParsedReceipt(data.parsed, data.receipt_image_url);
        notify("Struk berhasil dibaca AI Vision. Cek kembali jika perlu.", "success");
        return;
      }

      setScanLabel("Meningkatkan kontras foto...");
      setScanProgress(5);
      const enhancedBlob = await preprocessReceiptForTesseract(file);

      setScanLabel("Memindai teks struk...");
      setScanProgress(12);

      const { createWorker, PSM } = await import("tesseract.js");
      const worker = await createWorker("ind+eng", 1, {
        logger: (m) => {
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setScanProgress(Math.max(15, Math.round(m.progress * 100)));
          }
        },
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
      });

      try {
        const result = await worker.recognize(enhancedBlob);
        const parsed = parseIndonesianReceiptText(result.data.text || "");
        applyParsedReceipt(parsed, data.receipt_image_url);
        if (parsed.items.length === 0) {
          notify(
            "Teks kurang terbaca — foto tersimpan, silakan ketik item.",
            "error"
          );
        } else {
          notify(
            `${parsed.items.length} item terbaca (OCR lokal). Koreksi bila ada yang keliru.`,
            "success"
          );
        }
      } finally {
        await worker.terminate();
      }
    } catch {
      notify("Gagal memproses struk. Coba foto yang lebih jelas.", "error");
    } finally {
      setScanning(false);
      setScanLabel("");
      setScanProgress(null);
    }
  }

  function handleStartManual() {
    setBill({
      ...createEmptyBill(),
      items: [{ id: uid("item"), name: "", qty: 1, unit_price: 0, assigned_to: [] }],
    });
    setOcrEngine(null);
    setPrintedTotal(null);
    setStep("edit");
  }

  function handleResetNew() {
    setBill(createEmptyBill());
    setOcrEngine(null);
    setPrintedTotal(null);
    setStep("scan");
  }

  function updateItem(id: string, patch: Partial<BillItem>) {
    setBill((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
  }

  function addBlankItem() {
    setBill((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        { id: uid("item"), name: "", qty: 1, unit_price: 0, assigned_to: [] },
      ],
    }));
  }

  function removeItem(id: string) {
    setBill((prev) => ({
      ...prev,
      items: prev.items.filter((it) => it.id !== id),
    }));
  }

  function addParticipant(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const cleaned = newPersonName.trim();
    if (!cleaned) return;
    if (
      bill.participants.some(
        (p) => p.name.toLowerCase() === cleaned.toLowerCase()
      )
    ) {
      notify("Nama peserta sudah ada.", "error");
      return;
    }
    setBill((prev) => ({
      ...prev,
      participants: [
        ...prev.participants,
        { id: uid("p"), name: cleaned, is_paid: false },
      ],
    }));
    setNewPersonName("");
  }

  function removeParticipant(pid: string) {
    if (bill.participants.length <= 1) {
      notify("Minimal harus ada 1 peserta.", "error");
      return;
    }
    setBill((prev) => ({
      ...prev,
      participants: prev.participants.filter((p) => p.id !== pid),
      items: prev.items.map((it) => ({
        ...it,
        assigned_to: it.assigned_to.filter((id) => id !== pid),
      })),
    }));
  }

  function toggleItemAssignee(itemId: string, participantId: string) {
    setBill((prev) => ({
      ...prev,
      items: prev.items.map((it) => {
        if (it.id !== itemId) return it;
        const exists = it.assigned_to.includes(participantId);
        return {
          ...it,
          assigned_to: exists
            ? it.assigned_to.filter((id) => id !== participantId)
            : [...it.assigned_to, participantId],
        };
      }),
    }));
  }

  function splitAllEvenly() {
    const allIds = bill.participants.map((p) => p.id);
    setBill((prev) => ({
      ...prev,
      items: prev.items.map((it) => ({ ...it, assigned_to: allIds })),
    }));
    notify(`Dibagi rata ke ${allIds.length} orang`, "success");
  }

  async function handleUploadQris(file: File) {
    setUploadingQris(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "qris");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || "Gagal unggah QRIS.", "error");
        return;
      }
      setBill((prev) => ({
        ...prev,
        payment_info: { ...prev.payment_info, qris_image_url: data.url },
      }));
      notify("QRIS ditambahkan", "success");
    } catch {
      notify("Gagal menghubungi server.", "error");
    } finally {
      setUploadingQris(false);
    }
  }

  async function handleSaveBill() {
    const validItems = bill.items.filter((it) => it.name.trim().length > 0);
    if (validItems.length === 0) {
      notify("Isi minimal 1 item dulu.", "error");
      setStep("edit");
      return;
    }

    setSavingBill(true);
    try {
      const payload: BillData = {
        ...bill,
        title: bill.merchant_name.trim() || bill.title.trim() || "Split Bill",
        merchant_name: bill.merchant_name.trim() || "Struk Belanja",
        items: validItems,
      };

      const url = bill.slug ? `/api/bills/${bill.slug}` : "/api/bills";
      const method = bill.slug ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        notify(data.error || "Gagal menyimpan bill.", "error");
        return;
      }
      setBill(data.bill);
      setStep("summary");
      await loadHistory();
      notify("Tagihan tersimpan & siap dibagikan", "success");
    } catch {
      notify("Koneksi bermasalah.", "error");
    } finally {
      setSavingBill(false);
    }
  }

  async function handleDeleteHistory(slug: string) {
    if (!confirm("Hapus riwayat ini?")) return;
    try {
      const res = await fetch(`/api/bills/${slug}`, { method: "DELETE" });
      if (res.ok) {
        await loadHistory();
        notify("Riwayat dihapus", "success");
      }
    } catch {
      notify("Gagal menghapus.", "error");
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-[#F2F2F7] sm:border-x sm:border-black/8">
      {/* iOS Translucent Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-black/6 bg-[#F2F2F7]/85 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleResetNew}
            className="text-[17px] font-semibold tracking-[-0.02em] text-[#1C1C1E]"
          >
            SplitStruk
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="text-[14px] font-medium text-[#007AFF] hover:opacity-75"
            >
              Riwayat{history.length > 0 ? ` (${history.length})` : ""}
            </button>
            {step !== "scan" && (
              <button
                type="button"
                onClick={handleResetNew}
                className="text-[14px] font-medium text-[#FF3B30] hover:opacity-75"
              >
                Baru
              </button>
            )}
          </div>
        </div>

        {/* Native iOS Segmented Control */}
        {step !== "scan" && (
          <div className="mt-3 grid grid-cols-3 rounded-[10px] bg-[#767680]/12 p-[2.5px]">
            {(
              [
                { key: "edit", label: "Edit Struk" },
                { key: "assign", label: "Bagi Teman" },
                { key: "summary", label: "Tagihan" },
              ] as Array<{ key: Step; label: string }>
            ).map((tab) => {
              const active = step === tab.key;
              const disabled = tab.key === "summary" && !bill.slug;
              return (
                <button
                  key={tab.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => setStep(tab.key)}
                  className={`rounded-[8px] py-1.5 text-[12px] font-semibold transition ${
                    active
                      ? "bg-white text-[#1C1C1E] shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
                      : "text-[#3C3C43]/80 disabled:opacity-35"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Dynamic Island–Inspired Pill Toast */}
      {toast && (
        <div className="fixed left-1/2 top-16 z-50 w-[88%] max-w-sm -translate-x-1/2">
          <div
            className={`rounded-full px-4 py-2.5 text-center text-[13px] font-semibold text-white shadow-lg backdrop-blur-md ${
              toast.tone === "error" ? "bg-[#FF3B30]/95" : "bg-[#1C1C1E]/92"
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}

      {/* STEP 1: SCAN STRUK (iOS Large Title + Grouped Cards) */}
      {step === "scan" && (
        <main className="flex-1 space-y-6 px-4 pb-12 pt-5">
          <div className="px-1">
            <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.03em] text-[#1C1C1E]">
              Scan Struk,
              <br />
              Bagi Tanpa Ribet.
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-[#8E8E93]">
              Foto struk belanja, koreksi item jika keliru, lalu bagi patungan &
              pajak proporsional hingga Rp0 selisih.
            </p>
          </div>

          {/* Primary iOS Upload Card */}
          <div className="overflow-hidden rounded-[22px] bg-white p-5 shadow-[0_2px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/5">
            <label className="block cursor-pointer text-center">
              {scanning ? (
                <div className="py-6">
                  <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[#E5E5EA] border-t-[#007AFF]" />
                  <p className="mt-3 text-[15px] font-semibold text-[#1C1C1E]">
                    {scanLabel}
                  </p>
                  {scanProgress !== null && (
                    <div className="mx-auto mt-3 h-1.5 w-44 overflow-hidden rounded-full bg-[#E5E5EA]">
                      <div
                        className="h-full rounded-full bg-[#007AFF] transition-all"
                        style={{ width: `${scanProgress}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3 py-2">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[14px] bg-[#EBF4FF] text-[15px] font-bold text-[#007AFF]">
                    OCR
                  </div>
                  <div>
                    <p className="text-[16px] font-semibold tracking-[-0.015em] text-[#1C1C1E]">
                      Ambil Foto atau Pilih Struk
                    </p>
                    <p className="mt-0.5 text-[13px] text-[#8E8E93]">
                      JPG, PNG, atau WEBP · Maks. 8MB
                    </p>
                  </div>
                  <span className="mt-2 block w-full rounded-[14px] bg-[#007AFF] py-3.5 text-[15px] font-semibold text-white transition active:scale-[0.98]">
                    Scan Struk Sekarang
                  </span>
                </div>
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                disabled={scanning}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleReceiptFileSelected(f);
                  e.target.value = "";
                }}
              />
            </label>

            <div className="mt-3 border-t border-[#F2F2F7] pt-3">
              <button
                type="button"
                disabled={scanning}
                onClick={handleStartManual}
                className="w-full rounded-[12px] bg-[#F2F2F7] py-2.5 text-[13px] font-semibold text-[#1C1C1E] transition active:scale-[0.98]"
              >
                Input Manual
              </button>
            </div>
          </div>

          {/* Inset Grouped Recent History */}
          {history.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between px-3">
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
                  Terakhir Dibuat
                </h2>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(true)}
                  className="text-[13px] font-medium text-[#007AFF]"
                >
                  Semua
                </button>
              </div>
              <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
                {history.slice(0, 5).map((item) => (
                  <Link
                    key={item.slug}
                    href={`/bill/${item.slug}`}
                    className="flex items-center justify-between gap-3 px-4 py-3.5 transition active:bg-[#F2F2F7]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold text-[#1C1C1E]">
                        {item.merchant_name || item.title}
                      </p>
                      <p className="mt-0.5 text-[12px] text-[#8E8E93]">
                        {item.bill_date} · {item.paid_count}/{item.participant_count}{" "}
                        lunas
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[14px] font-semibold tabular-nums text-[#1C1C1E]">
                        {formatRupiah(item.grand_total)}
                      </span>
                      <ChevronRight className="h-4 w-4 text-[#C7C7CC]" />
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </main>
      )}

      {/* STEP 2: EDIT ITEMS & EXTRAS (iOS Inset Grouped Form) */}
      {step === "edit" && (
        <main className="flex-1 space-y-5 px-4 pb-32 pt-4">
          {/* Engine status + Total reconciliation + View original receipt */}
          <div className="space-y-2 rounded-[16px] bg-white px-4 py-3 ring-1 ring-black/5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-[#8E8E93]">
                {ocrEngine === "gemini"
                  ? "Dipindai Gemini Vision AI"
                  : ocrEngine === "groq"
                  ? "Dipindai Llama Vision AI"
                  : ocrEngine === "openai"
                  ? "Dipindai OpenAI Vision"
                  : ocrEngine === "tesseract"
                  ? "OCR Lokal · Pasang GEMINI_API_KEY untuk akurasi AI"
                  : ocrEngine === "demo"
                  ? "Mode contoh struk"
                  : "Input manual"}
              </span>
              {bill.receipt_image_url && (
                <button
                  type="button"
                  onClick={() =>
                    setPreviewImg({
                      src: bill.receipt_image_url!,
                      title: "Foto Struk Asli",
                    })
                  }
                  className="shrink-0 text-[13px] font-semibold text-[#007AFF]"
                >
                  Lihat Struk
                </button>
              )}
            </div>

            {printedTotal && printedTotal > 0 && (
              <div
                className={`flex items-center justify-between rounded-[10px] px-3 py-1.5 text-[12px] font-medium ${
                  summary.grand_total === printedTotal
                    ? "bg-[#34C759]/12 text-[#1E8E3E]"
                    : "bg-[#FF9500]/12 text-[#B25E00]"
                }`}
              >
                <span>
                  {summary.grand_total === printedTotal
                    ? "Cocok 100% dengan total struk"
                    : `Selisih ${formatRupiah(
                        Math.abs(summary.grand_total - printedTotal)
                      )} dari total struk`}
                </span>
                <span className="tabular-nums font-semibold">
                  {formatRupiah(printedTotal)}
                </span>
              </div>
            )}
          </div>

          {/* Merchant & Date Grouped Card */}
          <div>
            <p className="mb-2 px-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
              Info Struk
            </p>
            <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <label className="shrink-0 text-[14px] text-[#8E8E93]">
                  Tempat
                </label>
                <input
                  type="text"
                  value={bill.merchant_name}
                  onChange={(e) =>
                    setBill((prev) => ({
                      ...prev,
                      merchant_name: e.target.value,
                      title: e.target.value,
                    }))
                  }
                  placeholder="Nama resto / toko"
                  className="w-full bg-transparent text-right text-[14px] font-semibold text-[#1C1C1E] outline-none placeholder:text-[#C7C7CC]"
                />
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <label className="shrink-0 text-[14px] text-[#8E8E93]">
                  Tanggal
                </label>
                <input
                  type="date"
                  value={bill.bill_date}
                  onChange={(e) =>
                    setBill((prev) => ({ ...prev, bill_date: e.target.value }))
                  }
                  className="bg-transparent text-right text-[14px] font-medium text-[#1C1C1E] outline-none"
                />
              </div>
            </div>
          </div>

          {/* Editable Items Inset Card */}
          <div>
            <div className="mb-2 flex items-center justify-between px-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
                Daftar Item ({bill.items.length})
              </p>
              <button
                type="button"
                onClick={addBlankItem}
                className="text-[13px] font-semibold text-[#007AFF]"
              >
                + Tambah Item
              </button>
            </div>

            <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
              {bill.items.map((item) => (
                <div key={item.id} className="space-y-2.5 px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) =>
                        updateItem(item.id, { name: e.target.value })
                      }
                      placeholder="Nama makanan / minuman"
                      className="flex-1 bg-transparent text-[15px] font-semibold text-[#1C1C1E] outline-none placeholder:text-[#C7C7CC]"
                    />
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="text-[12px] font-medium text-[#FF3B30]"
                    >
                      Hapus
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center rounded-[10px] bg-[#F2F2F7] p-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          updateItem(item.id, {
                            qty: Math.max(1, item.qty - 1),
                          })
                        }
                        className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[#1C1C1E] hover:bg-white"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-7 text-center text-[13px] font-semibold tabular-nums">
                        {item.qty}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          updateItem(item.id, { qty: item.qty + 1 })
                        }
                        className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[#1C1C1E] hover:bg-white"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center gap-1 rounded-[10px] bg-[#F2F2F7] px-2.5 py-1.5">
                      <span className="text-[12px] text-[#8E8E93]">Rp</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={item.unit_price > 0 ? String(item.unit_price) : ""}
                        placeholder="0"
                        onChange={(e) => {
                          const val = parseInt(
                            e.target.value.replace(/\D/g, "") || "0",
                            10
                          );
                          updateItem(item.id, { unit_price: val });
                        }}
                        className="w-20 bg-transparent text-[13px] font-semibold tabular-nums text-[#1C1C1E] outline-none"
                      />
                    </div>

                    <span className="min-w-[76px] text-right text-[14px] font-semibold tabular-nums text-[#1C1C1E]">
                      {formatRupiah(item.qty * item.unit_price)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Tax, Service, Fees, Discount */}
          <div>
            <div className="mb-2 flex items-center justify-between px-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
                Pajak & Biaya Tambahan
              </p>
              <span className="text-[12px] font-medium tabular-nums text-[#8E8E93]">
                Subtotal {formatRupiah(summary.items_subtotal)}
              </span>
            </div>

            <div className="mb-2.5 flex gap-2 px-1">
              <button
                type="button"
                onClick={() =>
                  setBill((prev) => ({
                    ...prev,
                    tax_amount: Math.round(summary.items_subtotal * 0.1),
                  }))
                }
                className="rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-[#007AFF] ring-1 ring-black/6 active:scale-[0.97]"
              >
                PB1 10%
              </button>
              <button
                type="button"
                onClick={() =>
                  setBill((prev) => ({
                    ...prev,
                    tax_amount: Math.round(summary.items_subtotal * 0.11),
                  }))
                }
                className="rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-[#007AFF] ring-1 ring-black/6 active:scale-[0.97]"
              >
                PPN 11%
              </button>
              <button
                type="button"
                onClick={() =>
                  setBill((prev) => ({
                    ...prev,
                    service_amount: Math.round(summary.items_subtotal * 0.05),
                  }))
                }
                className="rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-[#007AFF] ring-1 ring-black/6 active:scale-[0.97]"
              >
                Service 5%
              </button>
            </div>

            <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
              <IosMoneyRow
                label="Pajak (PB1 / PPN)"
                value={bill.tax_amount}
                onChange={(v) => setBill((p) => ({ ...p, tax_amount: v }))}
              />
              <IosMoneyRow
                label="Service Charge"
                value={bill.service_amount}
                onChange={(v) => setBill((p) => ({ ...p, service_amount: v }))}
              />
              <IosMoneyRow
                label="Ongkir / Biaya Lain"
                value={bill.other_fee_amount}
                onChange={(v) => setBill((p) => ({ ...p, other_fee_amount: v }))}
              />
              <IosMoneyRow
                label="Diskon / Promo"
                prefix="- Rp"
                accentGreen
                value={bill.discount_amount}
                onChange={(v) => setBill((p) => ({ ...p, discount_amount: v }))}
              />
            </div>
          </div>

          {/* Frosted iOS Bottom Bar */}
          <div className="fixed bottom-0 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-black/8 bg-white/88 px-4 py-3.5 backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium text-[#8E8E93]">
                  Grand Total
                </p>
                <p className="text-[18px] font-bold tracking-[-0.02em] tabular-nums text-[#1C1C1E]">
                  {formatRupiah(summary.grand_total)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (bill.items.filter((i) => i.name.trim()).length === 0) {
                    notify("Isi minimal 1 item dulu.", "error");
                    return;
                  }
                  setStep("assign");
                }}
                className="rounded-[14px] bg-[#007AFF] px-5 py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
              >
                Lanjut Bagi
              </button>
            </div>
          </div>
        </main>
      )}

      {/* STEP 3: ASSIGN TO PARTICIPANTS & PAYMENT INFO */}
      {step === "assign" && (
        <main className="flex-1 space-y-5 px-4 pb-32 pt-4">
          {/* Participants Inset Card */}
          <div>
            <div className="mb-2 flex items-center justify-between px-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
                Peserta ({bill.participants.length})
              </p>
              <button
                type="button"
                onClick={splitAllEvenly}
                className="text-[13px] font-semibold text-[#007AFF]"
              >
                Bagi Rata Semua
              </button>
            </div>

            <div className="rounded-[20px] bg-white p-4 ring-1 ring-black/5">
              <form onSubmit={addParticipant} className="flex gap-2">
                <input
                  type="text"
                  value={newPersonName}
                  onChange={(e) => setNewPersonName(e.target.value)}
                  placeholder="Tambah nama teman..."
                  className="flex-1 rounded-[12px] bg-[#F2F2F7] px-3.5 py-2.5 text-[14px] text-[#1C1C1E] outline-none placeholder:text-[#8E8E93] focus:ring-2 focus:ring-[#007AFF]/30"
                />
                <button
                  type="submit"
                  className="rounded-[12px] bg-[#007AFF] px-4 py-2.5 text-[14px] font-semibold text-white active:scale-[0.97]"
                >
                  Tambah
                </button>
              </form>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {bill.participants.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[#F2F2F7] px-3 py-1 text-[13px] font-medium text-[#1C1C1E]"
                  >
                    {p.name}
                    {bill.participants.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeParticipant(p.id)}
                        className="text-[#8E8E93] hover:text-[#FF3B30]"
                        aria-label={`Hapus ${p.name}`}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Tap-to-Assign Items */}
          <div>
            <div className="mb-2 px-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
                Pembagian Item
              </p>
              <p className="mt-0.5 text-[12px] text-[#8E8E93]">
                Ketuk 1 nama untuk pribadi, atau beberapa nama untuk patungan.
              </p>
            </div>

            <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
              {bill.items
                .filter((it) => it.name.trim().length > 0)
                .map((item) => {
                  const lineTotal = item.qty * item.unit_price;
                  const count = item.assigned_to.length;
                  return (
                    <div key={item.id} className="px-4 py-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[14px] font-semibold text-[#1C1C1E]">
                            {item.qty}× {item.name}
                          </p>
                          <p className="mt-0.5 text-[12px]">
                            {count === 0 ? (
                              <span className="font-medium text-[#FF9500]">
                                Belum dipilih
                              </span>
                            ) : count === 1 ? (
                              <span className="text-[#8E8E93]">Pribadi</span>
                            ) : (
                              <span className="font-medium text-[#007AFF]">
                                Patungan ÷{count} (~
                                {formatRupiah(Math.round(lineTotal / count))}/org)
                              </span>
                            )}
                          </p>
                        </div>
                        <span className="shrink-0 text-[14px] font-semibold tabular-nums text-[#1C1C1E]">
                          {formatRupiah(lineTotal)}
                        </span>
                      </div>

                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {bill.participants.map((p) => {
                          const selected = item.assigned_to.includes(p.id);
                          return (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => toggleItemAssignee(item.id, p.id)}
                              className={`rounded-full px-3 py-1 text-[12px] font-semibold transition active:scale-[0.96] ${
                                selected
                                  ? "bg-[#007AFF] text-white"
                                  : "bg-[#F2F2F7] text-[#3C3C43]"
                              }`}
                            >
                              {p.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Live Preview */}
          <div>
            <div className="mb-2 flex items-center justify-between px-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
                Ringkasan Sementara
              </p>
              <span className="text-[12px] font-semibold text-[#1E8E3E]">
                {summary.unassigned_item_count === 0
                  ? "Pas · Selisih Rp0"
                  : `${summary.unassigned_item_count} belum dibagi`}
              </span>
            </div>
            <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
              {summary.shares.map((s) => (
                <div
                  key={s.participant.id}
                  className="flex items-center justify-between px-4 py-3 text-[14px]"
                >
                  <span className="font-medium text-[#1C1C1E]">
                    {s.participant.name}
                  </span>
                  <span className="font-semibold tabular-nums text-[#1C1C1E]">
                    {formatRupiah(s.final_total)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Payment Info */}
          <div>
            <p className="mb-2 px-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
              Info Pembayaran (Opsional)
            </p>
            <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="shrink-0 text-[14px] text-[#8E8E93]">Bank</span>
                <input
                  type="text"
                  value={bill.payment_info.bank_name}
                  onChange={(e) =>
                    setBill((prev) => ({
                      ...prev,
                      payment_info: {
                        ...prev.payment_info,
                        bank_name: e.target.value,
                      },
                    }))
                  }
                  placeholder="BCA, Mandiri, GoPay"
                  className="w-full bg-transparent text-right text-[14px] font-medium text-[#1C1C1E] outline-none placeholder:text-[#C7C7CC]"
                />
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="shrink-0 text-[14px] text-[#8E8E93]">
                  No. Rekening
                </span>
                <input
                  type="text"
                  value={bill.payment_info.account_number}
                  onChange={(e) =>
                    setBill((prev) => ({
                      ...prev,
                      payment_info: {
                        ...prev.payment_info,
                        account_number: e.target.value,
                      },
                    }))
                  }
                  placeholder="1234567890"
                  className="w-full bg-transparent text-right font-mono text-[14px] font-medium text-[#1C1C1E] outline-none placeholder:text-[#C7C7CC]"
                />
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="shrink-0 text-[14px] text-[#8E8E93]">
                  Atas Nama
                </span>
                <input
                  type="text"
                  value={bill.payment_info.account_holder}
                  onChange={(e) =>
                    setBill((prev) => ({
                      ...prev,
                      payment_info: {
                        ...prev.payment_info,
                        account_holder: e.target.value,
                      },
                    }))
                  }
                  placeholder="Nama pemilik rekening"
                  className="w-full bg-transparent text-right text-[14px] font-medium text-[#1C1C1E] outline-none placeholder:text-[#C7C7CC]"
                />
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-[14px] text-[#8E8E93]">QRIS</span>
                <label className="cursor-pointer text-[14px] font-semibold text-[#007AFF]">
                  {uploadingQris
                    ? "Mengunggah..."
                    : bill.payment_info.qris_image_url
                    ? "Terlampir · Ganti"
                    : "Upload Foto QRIS"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    disabled={uploadingQris}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUploadQris(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Frosted iOS Bottom CTA */}
          <div className="fixed bottom-0 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-black/8 bg-white/88 px-4 py-3.5 backdrop-blur-xl">
            <button
              type="button"
              disabled={savingBill}
              onClick={handleSaveBill}
              className="w-full rounded-[14px] bg-[#007AFF] py-3.5 text-[15px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
            >
              {savingBill
                ? "Menyimpan..."
                : bill.slug
                ? "Simpan Perubahan"
                : "Simpan & Buat Link Tagihan"}
            </button>
          </div>
        </main>
      )}

      {/* STEP 4: SUMMARY */}
      {step === "summary" && (
        <SplitBillSummaryView
          bill={bill}
          onBillUpdated={(updated) => {
            setBill(updated);
            loadHistory();
          }}
          onEditBill={() => setStep("edit")}
          onNotify={notify}
        />
      )}

      {/* iOS Sheet History Drawer */}
      {historyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-xs sm:items-center sm:p-4"
          onClick={() => setHistoryOpen(false)}
        >
          <div
            className="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-t-[28px] bg-[#F2F2F7] shadow-2xl sm:rounded-[28px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center pb-1 pt-2.5">
              <div className="h-1 w-9 rounded-full bg-[#C7C7CC]" />
            </div>

            <div className="flex items-center justify-between px-5 py-3">
              <h3 className="text-[17px] font-semibold tracking-[-0.02em] text-[#1C1C1E]">
                Riwayat ({history.length})
              </h3>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[#E5E5EA] text-[#3C3C43]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-6">
              {history.length === 0 ? (
                <p className="py-12 text-center text-[13px] text-[#8E8E93]">
                  Belum ada riwayat tersimpan.
                </p>
              ) : (
                <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
                  {history.map((item) => (
                    <div
                      key={item.slug}
                      className="flex items-center justify-between gap-3 px-4 py-3.5"
                    >
                      <Link
                        href={`/bill/${item.slug}`}
                        onClick={() => setHistoryOpen(false)}
                        className="min-w-0 flex-1"
                      >
                        <p className="truncate text-[15px] font-semibold text-[#1C1C1E]">
                          {item.merchant_name || item.title}
                        </p>
                        <p className="mt-0.5 text-[12px] text-[#8E8E93]">
                          {item.bill_date} · {item.paid_count}/
                          {item.participant_count} lunas ·{" "}
                          <span className="font-semibold tabular-nums text-[#1C1C1E]">
                            {formatRupiah(item.grand_total)}
                          </span>
                        </p>
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleDeleteHistory(item.slug)}
                        className="shrink-0 text-[13px] font-medium text-[#FF3B30]"
                      >
                        Hapus
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {previewImg && (
        <ReceiptImageModal
          src={previewImg.src}
          title={previewImg.title}
          allowDownload={false}
          onClose={() => setPreviewImg(null)}
        />
      )}
    </div>
  );
}

function IosMoneyRow({
  label,
  value,
  prefix = "Rp",
  accentGreen = false,
  onChange,
}: {
  label: string;
  value: number;
  prefix?: string;
  accentGreen?: boolean;
  onChange: (val: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-[14px] text-[#1C1C1E]">{label}</span>
      <div className="flex items-center gap-1">
        <span
          className={`text-[13px] font-medium ${
            accentGreen ? "text-[#1E8E3E]" : "text-[#8E8E93]"
          }`}
        >
          {prefix}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={value > 0 ? String(value) : ""}
          placeholder="0"
          onChange={(e) => {
            const parsed = parseInt(e.target.value.replace(/\D/g, "") || "0", 10);
            onChange(parsed);
          }}
          className={`w-24 bg-transparent text-right text-[14px] font-semibold tabular-nums outline-none placeholder:text-[#C7C7CC] ${
            accentGreen ? "text-[#1E8E3E]" : "text-[#1C1C1E]"
          }`}
        />
      </div>
    </div>
  );
}
