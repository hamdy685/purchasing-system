import apiClient, { cachedGetData, invalidateCachedGet } from './client';
import { PurchaseOrder, المورد } from '../types/purchaseOrder';

export interface ApprovedReceiptItem {
  id: number;
  ordered_quantity: string | number;
  received_quantity: string | number;
  notes?: string | null;
  purchase_order_item?: {
    id: number;
    item_name?: string | null;
    item_description: string;
    item_reference?: string | null;
    region?: string | null;
    quantity: string | number;
    actual_quantity?: string | number | null;
    actual_unit_price?: string | number | null;
    actual_line_total?: string | number | null;
    uom?: string | null;
    unit_price: string | number;
    line_total?: string | number;
    specifications?: string | null;
    supplier_id?: number | null;
    supplier?: { id: number; company_name: string; code?: string | null } | null;
    pr_item?: {
      id: number;
      supplier_id?: number | null;
      supplier?: { id: number; company_name: string; code?: string | null } | null;
      item_description?: string | null;
      item_reference?: string | null;
      region?: string | null;
      quantity?: string | number;
      uom?: string | null;
      specifications?: string | null;
      notes?: string | null;
    } | null;
    item?: { id: number; name: string; sku?: string | null } | null;
    is_supplementary?: boolean;
    supplement_batch?: number | null;
  } | null;

}

export interface ApprovedReceipt {
  id: number;
  receipt_number: string;
  status: string;
  received_at?: string | null;
  created_at?: string | null;
  warehouse_submitted_at?: string | null;
  site_engineer_approved_at?: string | null;
  warehouse_notes?: string | null;
  site_engineer_notes?: string | null;
  receiver_notes?: string | null;
  receiver_user?: { id: number; name: string } | null;
  photo_path?: string | null;
  photo_name?: string | null;
  photo_url?: string | null;
  rejection_reason?: string | null;
  accountant_recorded_at?: string | null;
  accountant_recorded_by_user_id?: number | null;
  accountant_recording_notes?: string | null;
  accountant_recorded_by?: { id: number; name: string } | null;
  is_accountant_recorded?: boolean;
  warehouse_keeper?: { id: number; name: string } | null;
  site_engineer?: { id: number; name: string } | null;
  purchase_order_id: number;
  purchase_order?: PurchaseOrder | null;
  purchase_request?: PurchaseOrder['purchase_request'] | null;
  invoice_photo_url?: string | null;
  has_invoice_attachment?: boolean;
  document_status?: ReceiptDocumentStatus;
  items?: ApprovedReceiptItem[];
}

/** Photographed receipt permission uploaded at receiving (or, for steel, the scale-ticket photo). */
export interface ReceiptPhotoStatus {
  exists: boolean;
  id: number;
  number?: string | null;
  has_file: boolean;
  file_url?: string | null;
  file_source?: 'receipt_photo' | 'scale_ticket' | null;
}

/** Server-derived status of the receipt permission and supplier invoice linked to an accounting receipt. */
export interface ReceiptDocumentStatus {
  receipt: ReceiptPhotoStatus;
  invoice: {
    exists: boolean;
    has_file: boolean;
    file_url?: string | null;
    po_number?: string | null;
    count: number;
    invoices: Array<{ id: number; invoice_number?: string | null; status?: string | null; matching_status?: string | null }>;
  };
}

export type SupplierInvoiceStatus = 'DRAFT' | 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | string;

export interface SupplierPaymentAllocation {
  id: number;
  supplier_payment_id: number;
  supplier_invoice_id: number;
  amount: string | number;
  invoice?: SupplierInvoice | null;
  payment?: SupplierPayment | null;
}

export interface LandParcel {
  id: number;
  parcel_reference: string;
  region: string;
  opening_balance: string | number;
  funded_total: string | number;
  expense_total: string | number;
  balance: string | number;
  is_active: boolean;
  notes?: string | null;
}

export interface LandParcelTransaction {
  id: number;
  land_parcel_id: number;
  created_by_user_id: number;
  transaction_type: 'OPENING_BALANCE' | 'CUSTOMER_FUNDING' | 'INVOICE_EXPENSE' | string;
  amount: string | number;
  balance_after: string | number;
  reference_number?: string | null;
  transaction_date: string;
  source_type?: string | null;
  source_id?: number | null;
  notes?: string | null;
  created_by?: { id: number; name: string } | null;
}

export interface SupplierInvoiceLandAllocation {
  id: number;
  supplier_invoice_id: number;
  land_parcel_id: number;
  department_id?: number | null;
  created_by_user_id: number;
  amount: string | number;
  notes?: string | null;
  parcel?: LandParcel | null;
  department?: { id: number; name: string; code?: string | null } | null;
  invoice?: SupplierInvoice | null;
}

export interface SupplierInvoice {
  id: number;
  supplier_id: number;
  purchase_order_id: number;
  purchase_receipt_id: number;
  created_by_user_id: number;
  invoice_number: string;
  amount: string | number;
  invoice_date: string;
  due_date?: string | null;
  status: SupplierInvoiceStatus;
  matching_status: 'PENDING' | 'MATCHED' | string;
  matched_at?: string | null;
  paid_amount: string | number;
  outstanding_amount: string | number;
  matching_notes?: string | null;
  notes?: string | null;
  supplier?: المورد | null;
  purchase_order?: PurchaseOrder | null;
  purchase_receipt?: ApprovedReceipt | null;
  receipt_photo_status?: ReceiptPhotoStatus | null;
  payment_allocations?: SupplierPaymentAllocation[];
  land_allocations?: SupplierInvoiceLandAllocation[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SupplierPayment {
  id: number;
  supplier_id: number;
  accountant_user_id: number;
  payment_number: string;
  amount: string | number;
  payment_date: string;
  payment_method: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | string;
  reference_number?: string | null;
  allocated_amount: string | number;
  overpayment_amount: string | number;
  notes?: string | null;
  supplier?: المورد | null;
  allocations?: SupplierPaymentAllocation[];
}

export interface SupplierBalanceSummary {
  opening_balance?: number;
  opening_balance_notes?: string | null;
  total_invoiced: number;
  total_paid: number;
  balance: number;
  is_overpaid: boolean;
  last_activity_at?: string | null;
}

export interface SupplierAccountSummary extends SupplierBalanceSummary {
  supplier_id: number;
  company_name: string;
  code?: string | null;
  email?: string | null;
  phone?: string | null;
  opening_balance?: number;
  opening_balance_notes?: string | null;
  open_invoices_count: number;
  invoices_count: number;
  payments_count: number;
}

export interface SupplierLedgerRow {
  id: string | number;
  type: 'OPENING_BALANCE' | 'SUPPLY' | 'PAYMENT' | 'CARRIED_FORWARD';
  date: string;
  date_formatted?: string;
  description: string;
  parcel: string;
  region: string;
  quantity: number | string | null;
  uom?: string | null;
  unit_price: number | string | null;
  value: number;
  paid: number;
  balance: number;
  reference?: string | null;
  purchase_order_id?: number | null;
  receipt_number?: string | null;
  invoice_number?: string | null;
  payment_id?: number | null;
}

export interface SupplierAccountDetails {
  supplier: المورد;
  summary: SupplierAccountSummary;
  invoices: SupplierInvoice[];
  payments: SupplierPayment[];
  ledger?: SupplierLedgerRow[];
}


export interface CreateSupplierInvoicePayload {
  purchase_order_id: number;
  purchase_receipt_id: number;
  invoice_number?: string;
  amount: number;
  invoice_date?: string;
  due_date?: string;
  land_allocations?: Array<{
    land_parcel_id: number;
    department_id?: number | null;
    amount: number;
    notes?: string;
  }>;
  notes?: string;
}

export interface CreateLandParcelPayload {
  parcel_reference: string;
  region: string;
  opening_balance?: number;
  transaction_date?: string;
  reference_number?: string;
  notes?: string;
}

export interface CreateLandParcelFundingPayload {
  amount: number;
  transaction_date?: string;
  reference_number?: string;
  notes?: string;
}

export interface LandParcelDepartmentSpending {
  department_name: string;
  total_amount: number;
  invoices_count: number;
}

export interface LandParcelMaterial {
  id: number;
  item_name: string;
  item_reference?: string | null;
  region?: string | null;
  ordered_quantity: number;
  received_quantity: number;
  uom?: string | null;
  unit_price: number;
  total_price: number;
  specifications?: string | null;
  po_number?: string | null;
  supplier_name?: string | null;
  date?: string | null;
}

export interface LandParcelAccountDetails {
  parcel: LandParcel;
  summary: {
    opening_balance: number;
    funded_total: number;
    expense_total: number;
    balance: number;
    is_negative: boolean;
  };
  department_breakdown?: LandParcelDepartmentSpending[];
  materials?: LandParcelMaterial[];
  transactions: LandParcelTransaction[];
  invoice_allocations: SupplierInvoiceLandAllocation[];
}

export interface CreateSupplierPaymentPayload {
  amount: number;
  payment_date?: string;
  payment_method: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';
  reference_number?: string;
  notes?: string;
}

const accountingBase = '/accounting';

export const getAccountingDepartmentsApi = async (): Promise<Array<{ id: number; name: string; code: string }>> =>
  (await cachedGetData<{ data: Array<{ id: number; name: string; code: string }> }>(`${accountingBase}/departments`)).data;

export const getLandParcelsApi = async (): Promise<LandParcel[]> =>
  (await cachedGetData<{ data: LandParcel[] }>(`${accountingBase}/land-parcels`)).data;

export const createLandParcelApi = async (payload: CreateLandParcelPayload): Promise<LandParcel> => {
  const response = await apiClient.post<{ data: LandParcel }>(`${accountingBase}/land-parcels`, payload);
  invalidateCachedGet(`${accountingBase}/land-parcels`);
  return response.data.data;
};

export const addCustomerFundingApi = async (parcelId: number, payload: CreateLandParcelFundingPayload): Promise<LandParcel> => {
  const response = await apiClient.post<{ data: LandParcel }>(`${accountingBase}/land-parcels/${parcelId}/fund`, payload);
  invalidateCachedGet(`${accountingBase}/land-parcels`);
  return response.data.data;
};

export const getLandParcelAccountApi = async (parcelId: number): Promise<LandParcelAccountDetails> =>
  (await apiClient.get<{ data: LandParcelAccountDetails }>(`${accountingBase}/land-parcels/${parcelId}`)).data.data;

export const deleteLandParcelApi = async (parcelId: number): Promise<{ message: string }> => {
  const response = await apiClient.delete<{ message: string }>(`${accountingBase}/land-parcels/${parcelId}`);
  invalidateCachedGet(`${accountingBase}/land-parcels`);
  return response.data;
};

export const wipeAllLandParcelsApi = async (): Promise<{ message: string; deleted_count?: number }> => {
  const response = await apiClient.delete<{ message: string; deleted_count?: number }>(`${accountingBase}/land-parcels/wipe-all`);
  invalidateCachedGet(`${accountingBase}/land-parcels`);
  return response.data;
};

export const getApprovedReceiptsForAccountingApi = async (params?: { recorded?: boolean; status?: string }) =>
  (await apiClient.get<{ data: ApprovedReceipt[] }>(`${accountingBase}/receipts/approved`, { params })).data.data;

export const markReceiptAsRecordedApi = async (receiptId: number, notes?: string) => {
  const response = await apiClient.post<{ message: string; data: any }>(`${accountingBase}/receipts/${receiptId}/mark-recorded`, { notes });
  invalidateCachedGet(`${accountingBase}/receipts/approved`);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('notifications-updated'));
    window.dispatchEvent(new CustomEvent('app-data-updated'));
  }
  return response.data;
};

export const getSupplierInvoicesApi = async (supplierId?: number) =>
  (await apiClient.get<{ data: SupplierInvoice[] }>(`${accountingBase}/invoices`, {
    params: supplierId ? { supplier_id: supplierId } : undefined,
  })).data.data;

export const createSupplierInvoiceApi = async (payload: CreateSupplierInvoicePayload) => {
  const response = await apiClient.post<{ data: SupplierInvoice }>(`${accountingBase}/invoices`, payload);
  invalidateCachedGet(`${accountingBase}/land-parcels`);
  invalidateCachedGet(`${accountingBase}/suppliers/accounts`);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('notifications-updated'));
    window.dispatchEvent(new CustomEvent('app-data-updated'));
  }
  return response.data.data;
};

export const matchSupplierInvoiceApi = async (invoiceId: number) => {
  const response = await apiClient.post<{ data: SupplierInvoice }>(`${accountingBase}/invoices/${invoiceId}/match`);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('notifications-updated'));
    window.dispatchEvent(new CustomEvent('app-data-updated'));
  }
  return response.data.data;
};

export interface SupplierPaymentResult {
  payment: SupplierPayment;
  supplier_balance: SupplierBalanceSummary;
  overpayment_warning: boolean;
  message: string;
}

export const recordSupplierPaymentApi = async (supplierId: number, payload: CreateSupplierPaymentPayload): Promise<SupplierPaymentResult> => {
  const response = await apiClient.post<SupplierPaymentResult>(`${accountingBase}/suppliers/${supplierId}/payments`, payload);
  invalidateCachedGet(`${accountingBase}/suppliers/accounts`);
  return response.data;
};

/** Backward-compatible invoice route; new screens should use the supplier-level endpoint above. */
export const recordSupplierPaymentForInvoiceApi = async (invoiceId: number, payload: CreateSupplierPaymentPayload): Promise<SupplierPaymentResult> => {
  const response = await apiClient.post<SupplierPaymentResult>(`${accountingBase}/invoices/${invoiceId}/payments`, payload);
  invalidateCachedGet(`${accountingBase}/suppliers/accounts`);
  return response.data;
};

export const getSupplierAccountsApi = async () =>
  (await cachedGetData<{ data: SupplierAccountSummary[] }>(`${accountingBase}/suppliers/accounts`)).data;

export const getSupplierAccountApi = async (supplierId: number, fromDate?: string | null) => {
  const query = fromDate ? `?from_date=${encodeURIComponent(fromDate)}` : '';
  return (await apiClient.get<{ data: SupplierAccountDetails }>(`${accountingBase}/suppliers/${supplierId}/account${query}`)).data.data;
};

export const setSupplierOpeningBalanceApi = async (
  supplierId: number,
  payload: { opening_balance: number; notes?: string }
): Promise<{ message: string; data: SupplierAccountDetails }> => {
  const response = await apiClient.post<{ message: string; data: SupplierAccountDetails }>(
    `${accountingBase}/suppliers/${supplierId}/opening-balance`,
    payload
  );
  invalidateCachedGet(`${accountingBase}/suppliers/accounts`);
  invalidateCachedGet('/procurement/suppliers-manage');
  return response.data;
};
