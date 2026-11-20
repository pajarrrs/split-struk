export interface BillParticipant {
  id: string;
  name: string;
  is_paid: boolean;
}

export interface BillItem {
  id: string;
  name: string;
  qty: number;
  unit_price: number;
  assigned_to: string[]; // participant IDs (1 = solo, >1 = shared/patungan)
}

export interface BillPaymentInfo {
  payer_name: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  qris_image_url: string | null;
}

export interface BillData {
  slug?: string;
  title: string;
  merchant_name: string;
  bill_date: string;
  receipt_image_url: string | null;
  tax_amount: number;
  service_amount: number;
  other_fee_amount: number;
  discount_amount: number;
  payment_info: BillPaymentInfo;
  participants: BillParticipant[];
  items: BillItem[];
  created_at?: string;
  updated_at?: string;
}

export interface SavedBillSummary {
  slug: string;
  title: string;
  merchant_name: string;
  bill_date: string;
  grand_total: number;
  participant_count: number;
  paid_count: number;
  created_at: string;
}

export interface PersonItemLine {
  item_id: string;
  item_name: string;
  qty: number;
  shared_by_count: number;
  amount: number;
}

export interface PersonShare {
  participant: BillParticipant;
  lines: PersonItemLine[];
  items_subtotal: number;
  tax_share: number;
  service_share: number;
  other_fee_share: number;
  discount_share: number;
  final_total: number;
}

export interface SplitSummary {
  items_subtotal: number;
  assigned_subtotal: number;
  unassigned_subtotal: number;
  unassigned_item_count: number;
  grand_total: number;
  shares: PersonShare[];
  shares_sum: number;
}

export interface ParsedReceiptResult {
  merchant_name: string;
  bill_date: string;
  items: Array<{ name: string; qty: number; unit_price: number }>;
  tax_amount: number;
  service_amount: number;
  other_fee_amount: number;
  discount_amount: number;
  engine: "gemini" | "tesseract" | "demo";
  raw_text?: string;
}
