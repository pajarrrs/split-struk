"use client";

import { useMemo, useState } from "react";
import {
  buildWhatsAppRecap,
  calculateSplit,
  formatRupiah,
} from "@/lib/split-math";
import type { BillData } from "@/lib/types";
import { ReceiptImageModal } from "./ReceiptImageModal";

interface SplitBillSummaryViewProps {
  bill: BillData;
  onBillUpdated: (bill: BillData) => void;
  onEditBill?: () => void;
  onNotify: (msg: string, tone?: "success" | "error") => void;
}

export function SplitBillSummaryView({
  bill,
  onBillUpdated,
  onEditBill,
  onNotify,
}: SplitBillSummaryViewProps) {
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [previewImg, setPreviewImg] = useState<{
    src: string;
    title: string;
    subtitle?: string;
  } | null>(null);

  const summary = useMemo(() => calculateSplit(bill), [bill]);

  const paidCount = bill.participants.filter((p) => p.is_paid).length;
  const shareUrl =
    typeof window !== "undefined" && bill.slug
      ? `${window.location.origin}/bill/${bill.slug}`
      : "";

  async function togglePaid(participantId: string, nextPaid: boolean) {
    if (!bill.slug) return;
    setTogglingId(participantId);
    try {
      const res = await fetch(`/api/bills/${bill.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle_paid",
          participant_id: participantId,
          is_paid: nextPaid,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(data.error || "Gagal memperbarui status.", "error");
        return;
      }
      onBillUpdated(data.bill);
    } catch {
      onNotify("Koneksi bermasalah.", "error");
    } finally {
      setTogglingId(null);
    }
  }

  async function copyText(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotify(successMessage, "success");
    } catch {
      onNotify("Gagal menyalin ke clipboard.", "error");
    }
  }

  function copyPersonalBill(name: string, total: number) {
    const pay = bill.payment_info;
    const payLine =
      pay.bank_name || pay.account_number
        ? `\nTransfer ke: ${[
            pay.bank_name,
            pay.account_number,
            pay.account_holder ? `a.n. ${pay.account_holder}` : "",
          ]
            .filter(Boolean)
            .join(" ")}`
        : "";
    const linkLine = shareUrl ? `\nDetail & QRIS: ${shareUrl}` : "";
    const msg = `Halo ${name}, patungan *${
      bill.merchant_name || bill.title
    }* bagianmu *${formatRupiah(total)}*.${payLine}${linkLine}`;
    copyText(msg, `Tagihan ${name} disalin`);
  }

  const hasPaymentInfo = Boolean(
    bill.payment_info.bank_name ||
      bill.payment_info.account_number ||
      bill.payment_info.qris_image_url
  );

  return (
    <div className="space-y-5 px-4 pb-12 pt-4">
      {/* Apple Wallet–Style Hero Summary Card */}
      <div className="rounded-[24px] bg-white p-5 shadow-[0_2px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-[#8E8E93]">
              {bill.bill_date}
              {bill.slug ? ` · #${bill.slug}` : ""}
            </p>
            <h2 className="mt-0.5 truncate text-[20px] font-bold tracking-[-0.025em] text-[#1C1C1E]">
              {bill.merchant_name || bill.title}
            </h2>
          </div>
          <span className="shrink-0 rounded-full bg-[#34C759]/14 px-2.5 py-1 text-[12px] font-semibold text-[#1E8E3E]">
            {paidCount}/{bill.participants.length} Lunas
          </span>
        </div>

        <div className="mt-4 border-t border-[#E5E5EA] pt-4">
          <p className="text-[12px] font-medium text-[#8E8E93]">Total Struk</p>
          <p className="mt-0.5 text-[32px] font-bold leading-tight tracking-[-0.03em] tabular-nums text-[#1C1C1E]">
            {formatRupiah(summary.grand_total)}
          </p>
        </div>

        {/* iOS Action Buttons */}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() =>
              copyText(
                buildWhatsAppRecap(bill, summary, shareUrl || undefined),
                "Rekap WhatsApp disalin"
              )
            }
            className="flex-1 rounded-[14px] bg-[#007AFF] py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
          >
            Salin Rekap WA
          </button>

          {shareUrl && (
            <button
              type="button"
              onClick={() => copyText(shareUrl, "Tautan tagihan disalin")}
              className="rounded-[14px] bg-[#EBF4FF] px-4 py-3 text-[14px] font-semibold text-[#007AFF] transition active:scale-[0.98]"
            >
              Salin Link
            </button>
          )}
        </div>

        <div className="mt-2.5 flex items-center justify-between pt-1">
          {bill.receipt_image_url ? (
            <button
              type="button"
              onClick={() =>
                setPreviewImg({
                  src: bill.receipt_image_url!,
                  title: `Struk — ${bill.merchant_name}`,
                })
              }
              className="text-[13px] font-medium text-[#007AFF]"
            >
              Lihat Foto Struk Asli
            </button>
          ) : (
            <span />
          )}

          {onEditBill && (
            <button
              type="button"
              onClick={onEditBill}
              className="text-[13px] font-medium text-[#007AFF]"
            >
              Edit Tagihan
            </button>
          )}
        </div>
      </div>

      {summary.unassigned_item_count > 0 && (
        <div className="rounded-[16px] bg-[#FF9500]/12 px-4 py-3 text-[13px] font-medium text-[#B25E00]">
          {summary.unassigned_item_count} item (
          {formatRupiah(summary.unassigned_subtotal)}) belum dipilih pesertanya.
        </div>
      )}

      {/* Per-Person Grouped Cards */}
      <div>
        <p className="mb-2 px-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
          Rincian Per Orang
        </p>

        <div className="space-y-3">
          {summary.shares.map((share) => {
            const isPaid = share.participant.is_paid;
            return (
              <section
                key={share.participant.id}
                className="overflow-hidden rounded-[20px] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.03)] ring-1 ring-black/5"
              >
                <div className="flex items-center justify-between gap-2 px-4 py-3.5">
                  <div className="min-w-0">
                    <h3 className="truncate text-[16px] font-semibold tracking-[-0.015em] text-[#1C1C1E]">
                      {share.participant.name}
                    </h3>
                    <p className="text-[12px] text-[#8E8E93]">
                      {share.lines.length} item
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2.5">
                    <span className="text-[16px] font-bold tracking-[-0.02em] tabular-nums text-[#1C1C1E]">
                      {formatRupiah(share.final_total)}
                    </span>
                    {bill.slug && (
                      <button
                        type="button"
                        disabled={togglingId === share.participant.id}
                        onClick={() => togglePaid(share.participant.id, !isPaid)}
                        className={`rounded-full px-3 py-1 text-[12px] font-semibold transition active:scale-[0.96] ${
                          isPaid
                            ? "bg-[#34C759]/15 text-[#1E8E3E]"
                            : "bg-[#F2F2F7] text-[#8E8E93]"
                        }`}
                      >
                        {isPaid ? "Lunas" : "Belum"}
                      </button>
                    )}
                  </div>
                </div>

                {share.lines.length > 0 && (
                  <ul className="divide-y divide-[#F2F2F7] border-t border-[#E5E5EA] px-4">
                    {share.lines.map((line) => (
                      <li
                        key={line.item_id}
                        className="flex items-center justify-between gap-2 py-2.5 text-[13px]"
                      >
                        <span className="min-w-0 text-[#1C1C1E]">
                          <span className="font-medium">
                            {line.qty}× {line.item_name}
                          </span>
                          {line.shared_by_count > 1 && (
                            <span className="ml-1.5 rounded-full bg-[#EBF4FF] px-2 py-0.5 text-[11px] font-semibold text-[#007AFF]">
                              ÷{line.shared_by_count}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-[#3C3C43]">
                          {formatRupiah(line.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {(share.tax_share > 0 ||
                  share.service_share > 0 ||
                  share.other_fee_share > 0 ||
                  share.discount_share > 0) && (
                  <div className="space-y-1 border-t border-[#F2F2F7] bg-[#FAFAFC] px-4 py-2.5 text-[12px] text-[#8E8E93]">
                    {share.tax_share > 0 && (
                      <div className="flex justify-between">
                        <span>Pajak proporsional</span>
                        <span className="tabular-nums">
                          +{formatRupiah(share.tax_share)}
                        </span>
                      </div>
                    )}
                    {share.service_share > 0 && (
                      <div className="flex justify-between">
                        <span>Service proporsional</span>
                        <span className="tabular-nums">
                          +{formatRupiah(share.service_share)}
                        </span>
                      </div>
                    )}
                    {share.other_fee_share > 0 && (
                      <div className="flex justify-between">
                        <span>Biaya lain</span>
                        <span className="tabular-nums">
                          +{formatRupiah(share.other_fee_share)}
                        </span>
                      </div>
                    )}
                    {share.discount_share > 0 && (
                      <div className="flex justify-between text-[#1E8E3E]">
                        <span>Diskon</span>
                        <span className="tabular-nums">
                          -{formatRupiah(share.discount_share)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <div className="border-t border-[#E5E5EA]/70 px-4 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      copyPersonalBill(share.participant.name, share.final_total)
                    }
                    className="text-[13px] font-medium text-[#007AFF]"
                  >
                    Salin Tagihan {share.participant.name}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {/* Payment Info & QRIS */}
      {hasPaymentInfo && (
        <div>
          <p className="mb-2 px-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
            Pembayaran
          </p>
          <div className="divide-y divide-[#E5E5EA] overflow-hidden rounded-[20px] bg-white ring-1 ring-black/5">
            {(bill.payment_info.bank_name ||
              bill.payment_info.account_number) && (
              <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[#8E8E93]">
                    {bill.payment_info.bank_name || "Rekening"}
                  </p>
                  <p className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-[#1C1C1E]">
                    {bill.payment_info.account_number}
                  </p>
                  {bill.payment_info.account_holder && (
                    <p className="text-[12px] text-[#8E8E93]">
                      a.n. {bill.payment_info.account_holder}
                    </p>
                  )}
                </div>
                {bill.payment_info.account_number && (
                  <button
                    type="button"
                    onClick={() =>
                      copyText(
                        bill.payment_info.account_number,
                        "Nomor rekening disalin"
                      )
                    }
                    className="shrink-0 rounded-full bg-[#EBF4FF] px-3.5 py-1.5 text-[13px] font-semibold text-[#007AFF]"
                  >
                    Salin
                  </button>
                )}
              </div>
            )}

            {bill.payment_info.qris_image_url && (
              <div className="flex items-center gap-3.5 px-4 py-3.5">
                <button
                  type="button"
                  onClick={() =>
                    setPreviewImg({
                      src: bill.payment_info.qris_image_url!,
                      title: "QRIS Pembayaran",
                      subtitle: bill.payment_info.account_holder
                        ? `a.n. ${bill.payment_info.account_holder}`
                        : undefined,
                    })
                  }
                  className="h-20 w-20 shrink-0 overflow-hidden rounded-[14px] border border-[#E5E5EA] bg-white p-1"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={bill.payment_info.qris_image_url}
                    alt="QRIS"
                    className="h-full w-full object-contain"
                  />
                </button>
                <div className="flex-1">
                  <p className="text-[15px] font-semibold text-[#1C1C1E]">
                    QRIS Pembayaran
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewImg({
                          src: bill.payment_info.qris_image_url!,
                          title: "QRIS Pembayaran",
                        })
                      }
                      className="rounded-full bg-[#F2F2F7] px-3.5 py-1.5 text-[12px] font-semibold text-[#1C1C1E]"
                    >
                      Perbesar
                    </button>
                    <a
                      href={bill.payment_info.qris_image_url}
                      download
                      className="rounded-full bg-[#EBF4FF] px-3.5 py-1.5 text-[12px] font-semibold text-[#007AFF]"
                    >
                      Simpan
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Reconciliation Summary Inset Box */}
      <div>
        <p className="mb-2 px-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-[#8E8E93]">
          Ringkasan Struk
        </p>
        <div className="space-y-2 rounded-[20px] bg-white px-4 py-3.5 text-[13px] ring-1 ring-black/5">
          <div className="flex justify-between text-[#8E8E93]">
            <span>Subtotal Item</span>
            <span className="font-medium tabular-nums text-[#1C1C1E]">
              {formatRupiah(summary.items_subtotal)}
            </span>
          </div>
          {bill.tax_amount > 0 && (
            <div className="flex justify-between text-[#8E8E93]">
              <span>Pajak</span>
              <span className="tabular-nums">+{formatRupiah(bill.tax_amount)}</span>
            </div>
          )}
          {bill.service_amount > 0 && (
            <div className="flex justify-between text-[#8E8E93]">
              <span>Service</span>
              <span className="tabular-nums">
                +{formatRupiah(bill.service_amount)}
              </span>
            </div>
          )}
          {bill.other_fee_amount > 0 && (
            <div className="flex justify-between text-[#8E8E93]">
              <span>Biaya Lain</span>
              <span className="tabular-nums">
                +{formatRupiah(bill.other_fee_amount)}
              </span>
            </div>
          )}
          {bill.discount_amount > 0 && (
            <div className="flex justify-between text-[#1E8E3E]">
              <span>Diskon</span>
              <span className="tabular-nums">
                -{formatRupiah(bill.discount_amount)}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-[#E5E5EA] pt-2.5 font-semibold text-[#1C1C1E]">
            <span>Total Terbagi ({summary.shares.length} orang)</span>
            <span className="tabular-nums">{formatRupiah(summary.shares_sum)}</span>
          </div>
        </div>
      </div>

      {previewImg && (
        <ReceiptImageModal
          src={previewImg.src}
          title={previewImg.title}
          subtitle={previewImg.subtitle}
          onClose={() => setPreviewImg(null)}
        />
      )}
    </div>
  );
}
