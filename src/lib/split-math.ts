import type { BillData, PersonShare, SplitSummary } from "./types";

export function formatRupiah(amount: number): string {
  const safeInt = Number.isFinite(amount) ? Math.round(amount) : 0;
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(safeInt);
}

/**
 * Largest-Remainder integer distribution.
 * Guarantees sum(result) === totalAmount with zero floating-point drift.
 */
export function distributeInteger(
  totalAmount: number,
  weights: number[]
): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const intTotal = Math.round(totalAmount);
  if (intTotal === 0) return new Array(count).fill(0);

  const weightSum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const safeWeights =
    weightSum > 0 ? weights.map((w) => Math.max(0, w)) : new Array(count).fill(1);
  const effectiveSum = weightSum > 0 ? weightSum : count;

  const sign = intTotal < 0 ? -1 : 1;
  const absTotal = Math.abs(intTotal);

  const exact = safeWeights.map((w) => (absTotal * w) / effectiveSum);
  const floors = exact.map((val) => Math.floor(val));
  const remainder = absTotal - floors.reduce((s, v) => s + v, 0);

  const ranked = exact
    .map((val, idx) => ({ idx, frac: val - floors[idx] }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);

  for (let i = 0; i < remainder; i++) {
    floors[ranked[i % count].idx] += 1;
  }

  return floors.map((v) => v * sign);
}

export function calculateSplit(bill: BillData): SplitSummary {
  const participantIds = new Set(bill.participants.map((p) => p.id));
  const linesByPerson = new Map<string, PersonShare["lines"]>();
  const subtotalByPerson = new Map<string, number>();

  for (const p of bill.participants) {
    linesByPerson.set(p.id, []);
    subtotalByPerson.set(p.id, 0);
  }

  let itemsSubtotal = 0;
  let assignedSubtotal = 0;
  let unassignedSubtotal = 0;
  let unassignedItemCount = 0;

  for (const item of bill.items) {
    const qty = Math.max(1, Math.round(item.qty));
    const unitPrice = Math.max(0, Math.round(item.unit_price));
    const lineTotal = qty * unitPrice;
    itemsSubtotal += lineTotal;

    const validAssignees = item.assigned_to.filter((id) => participantIds.has(id));
    if (validAssignees.length === 0) {
      unassignedSubtotal += lineTotal;
      unassignedItemCount += 1;
      continue;
    }

    assignedSubtotal += lineTotal;
    const splits = distributeInteger(
      lineTotal,
      new Array(validAssignees.length).fill(1)
    );

    validAssignees.forEach((pid, idx) => {
      const share = splits[idx];
      subtotalByPerson.set(pid, (subtotalByPerson.get(pid) ?? 0) + share);
      linesByPerson.get(pid)?.push({
        item_id: item.id,
        item_name: item.name || "Item",
        qty,
        shared_by_count: validAssignees.length,
        amount: share,
      });
    });
  }

  const tax = Math.max(0, Math.round(bill.tax_amount));
  const service = Math.max(0, Math.round(bill.service_amount));
  const otherFee = Math.max(0, Math.round(bill.other_fee_amount));
  const discount = Math.max(0, Math.round(bill.discount_amount));

  const grandTotal = Math.max(
    0,
    itemsSubtotal + tax + service + otherFee - discount
  );

  // Distribute extras proportionally across participants who have items (or equally if nobody assigned yet)
  const weights = bill.participants.map((p) => subtotalByPerson.get(p.id) ?? 0);
  const anyWeight = weights.some((w) => w > 0);
  const distributionWeights = anyWeight
    ? weights
    : bill.participants.map(() => 0);

  const taxShares = anyWeight
    ? distributeInteger(tax, distributionWeights)
    : bill.participants.map(() => 0);
  const serviceShares = anyWeight
    ? distributeInteger(service, distributionWeights)
    : bill.participants.map(() => 0);
  const otherFeeShares = anyWeight
    ? distributeInteger(otherFee, distributionWeights)
    : bill.participants.map(() => 0);
  const discountShares = anyWeight
    ? distributeInteger(discount, distributionWeights)
    : bill.participants.map(() => 0);

  const shares: PersonShare[] = bill.participants.map((participant, idx) => {
    const itemsSub = subtotalByPerson.get(participant.id) ?? 0;
    const taxShare = taxShares[idx] ?? 0;
    const serviceShare = serviceShares[idx] ?? 0;
    const otherFeeShare = otherFeeShares[idx] ?? 0;
    const discountShare = discountShares[idx] ?? 0;
    const finalTotal = Math.max(
      0,
      itemsSub + taxShare + serviceShare + otherFeeShare - discountShare
    );

    return {
      participant,
      lines: linesByPerson.get(participant.id) ?? [],
      items_subtotal: itemsSub,
      tax_share: taxShare,
      service_share: serviceShare,
      other_fee_share: otherFeeShare,
      discount_share: discountShare,
      final_total: finalTotal,
    };
  });

  const sharesSum = shares.reduce((sum, s) => sum + s.final_total, 0);

  return {
    items_subtotal: itemsSubtotal,
    assigned_subtotal: assignedSubtotal,
    unassigned_subtotal: unassignedSubtotal,
    unassigned_item_count: unassignedItemCount,
    grand_total: grandTotal,
    shares,
    shares_sum: sharesSum,
  };
}

export function getTodayIsoDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function buildWhatsAppRecap(
  bill: BillData,
  summary: SplitSummary,
  shareUrl?: string
): string {
  const lines: string[] = [
    `*SplitStruk — ${bill.merchant_name || bill.title || "Patungan"}*`,
    `Tanggal: ${bill.bill_date}`,
    "",
  ];

  for (const s of summary.shares) {
    if (s.final_total <= 0 && s.lines.length === 0) continue;
    const paidMark = s.participant.is_paid ? " (Lunas)" : "";
    lines.push(`• *${s.participant.name}*: ${formatRupiah(s.final_total)}${paidMark}`);
  }

  lines.push("");
  lines.push(`Total Struk: *${formatRupiah(summary.grand_total)}*`);

  const pay = bill.payment_info;
  if (pay.bank_name || pay.account_number) {
    lines.push(
      `Transfer ke: ${[pay.bank_name, pay.account_number, pay.account_holder ? `a.n. ${pay.account_holder}` : ""]
        .filter(Boolean)
        .join(" ")}`
    );
  }

  if (shareUrl) {
    lines.push(`Detail & QRIS: ${shareUrl}`);
  }

  return lines.join("\n");
}
