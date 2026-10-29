import apiClient, { cachedGetData, invalidateCachedGet } from './client';
import { PurchaseOrder, PurchaseOrderItemPayload, PurchaseOrderPayload, FinalizeActualPoPayload, ConsolidatedPoPreview } from '../types/purchaseOrder';

const base = '/procurement/purchase-orders';

export interface PurchaseOrderQueryParams {
  page?: number;
  per_page?: number;
  search?: string;
  status?: string;
  supplier_id?: number;
  department_id?: number;
  date_from?: string;
  date_to?: string;
}

export interface PurchaseOrderPaginationMeta {
  current_page: number;
  from: number | null;
  last_page: number;
  per_page: number;
  to: number | null;
  total: number;
}

export interface PurchaseOrderPage {
  data: PurchaseOrder[];
  meta: PurchaseOrderPaginationMeta;
  links?: {
    first?: string | null;
    last?: string | null;
    prev?: string | null;
    next?: string | null;
  };
}

export const getPurchaseOrdersApi = async (params: PurchaseOrderQueryParams = {}): Promise<PurchaseOrderPage> => {
  const response = await apiClient.get<PurchaseOrderPage>(base, { params });
  return response.data;
};

export const getPurchaseOrderApi = async (id: number) =>
  (await apiClient.get<{ data: PurchaseOrder }>(`${base}/${id}`)).data.data;

export const createPurchaseOrderApi = async (p: PurchaseOrderPayload) => {
  const response = await apiClient.post<{ data: PurchaseOrder }>(base, p);
  invalidateCachedGet(base);
  return response.data.data;
};

export const createBatchPurchaseOrdersApi = async (p: PurchaseOrderPayload) => {
  const response = await apiClient.post<{ message: string; data: PurchaseOrder[] }>(`${base}/batch`, p);
  invalidateCachedGet(base);
  return response.data.data;
};

/** Orders the server would issue for a department-consolidated request (nothing is saved). */
export const previewConsolidatedPurchaseOrdersApi = async (p: PurchaseOrderPayload): Promise<ConsolidatedPoPreview[]> => {
  const response = await apiClient.post<{ consolidated: boolean; data: ConsolidatedPoPreview[] }>(`${base}/consolidation-preview`, p);
  return response.data.data;
};

/** Issue a department-consolidated request: one PO per supplier and scope, decided by the server. */
export const createConsolidatedPurchaseOrdersApi = async (
  p: PurchaseOrderPayload
): Promise<{ orders: PurchaseOrder[]; replayed: boolean; message: string }> => {
  const response = await apiClient.post<{ message: string; replayed?: boolean; data: PurchaseOrder[] }>(`${base}/batch`, p);
  invalidateCachedGet(base);
  return { orders: response.data.data, replayed: Boolean(response.data.replayed), message: response.data.message };
};

export const updatePurchaseOrderApi = async (id: number, p: PurchaseOrderPayload) => {
  const response = await apiClient.put<{ data: PurchaseOrder }>(`${base}/${id}`, p);
  invalidateCachedGet(base);
  return response.data.data;
};

export const addPurchaseOrderItemApi = async (id: number, p: PurchaseOrderItemPayload) => {
  const response = await apiClient.post<{ data: PurchaseOrder }>(`${base}/${id}/items`, p);
  invalidateCachedGet(base);
  return response.data.data;
};

export const updatePurchaseOrderItemApi = async (id: number, itemId: number, p: Partial<PurchaseOrderItemPayload>) => {
  const response = await apiClient.put<{ data: PurchaseOrder }>(`${base}/${id}/items/${itemId}`, p);
  invalidateCachedGet(base);
  return response.data.data;
};

export const removePurchaseOrderItemApi = async (id: number, itemId: number) => {
  const response = await apiClient.delete<{ data: PurchaseOrder }>(`${base}/${id}/items/${itemId}`);
  invalidateCachedGet(base);
  return response.data.data;
};

export const submitPurchaseOrderApi = async (id: number) => {
  const response = await apiClient.post<{ data: PurchaseOrder }>(`${base}/${id}/submit`);
  invalidateCachedGet(base);
  return response.data.data;
};

export interface CombinedPoPrDocument {
  purchase_order: PurchaseOrder;
  purchase_request: any;
  receipt?: any;
  receipts?: any[];
}

export const getCombinedPoPrDocumentApi = async (id: number): Promise<CombinedPoPrDocument> => {
  const response = await apiClient.get<{ data: CombinedPoPrDocument }>(`${base}/${id}/combined-document`);
  return response.data.data;
};

export const getPendingActualPosApi = async (params: { page?: number; per_page?: number; search?: string } = {}): Promise<PurchaseOrderPage> => {
  const response = await apiClient.get<PurchaseOrderPage>('/procurement/pending-actual-pos', { params });
  return response.data;
};

export const finalizeActualPurchaseOrderApi = async (id: number, payload: FinalizeActualPoPayload): Promise<PurchaseOrder> => {
  const { attachments, ...jsonPayload } = payload;
  let body: any = jsonPayload;
  let headers: Record<string, string> | undefined = undefined;

  if (payload.invoice_file instanceof File || (attachments && attachments.length > 0)) {
    const formData = new FormData();
    if (payload.supplier_id) formData.append('supplier_id', String(payload.supplier_id));
    if (payload.parcel_reference) formData.append('parcel_reference', payload.parcel_reference);
    if (payload.region) formData.append('region', payload.region);
    if (payload.discount_type) formData.append('discount_type', payload.discount_type);
    if (payload.discount_percentage !== undefined && payload.discount_percentage !== null) {
      formData.append('discount_percentage', String(payload.discount_percentage));
    }
    if (payload.discount_item_ids && payload.discount_item_ids.length > 0) {
      payload.discount_item_ids.forEach((dId, dIdx) => {
        formData.append(`discount_item_ids[${dIdx}]`, String(dId));
      });
    }
    if (payload.notes) formData.append('notes', payload.notes);
    if (payload.high_value_reason) formData.append('high_value_reason', payload.high_value_reason);
    if (payload.invoice_file instanceof File) formData.append('invoice_file', payload.invoice_file);
    (attachments || []).forEach((file, fIdx) => formData.append(`attachments[${fIdx}]`, file));
    payload.items.forEach((item, idx) => {
      if (item.id) formData.append(`items[${idx}][id]`, String(item.id));
      if (item.item_id) formData.append(`items[${idx}][item_id]`, String(item.item_id));
      if (item.pr_item_id) formData.append(`items[${idx}][pr_item_id]`, String(item.pr_item_id));
      formData.append(`items[${idx}][item_description]`, item.item_description);
      formData.append(`items[${idx}][item_reference]`, item.item_reference);
      formData.append(`items[${idx}][region]`, item.region);
      formData.append(`items[${idx}][quantity]`, String(item.quantity));
      if (item.uom) formData.append(`items[${idx}][uom]`, item.uom);
      formData.append(`items[${idx}][unit_price]`, String(item.unit_price));
      if (item.is_discount_applied !== undefined) {
        formData.append(`items[${idx}][is_discount_applied]`, item.is_discount_applied ? '1' : '0');
      }
      if (item.specifications) formData.append(`items[${idx}][specifications]`, item.specifications);
      if (item.supplier_id) formData.append(`items[${idx}][supplier_id]`, String(item.supplier_id));
    });
    body = formData;
    headers = { 'Content-Type': 'multipart/form-data' };
  }

  const response = await apiClient.post<{ message: string; data: PurchaseOrder }>(`${base}/${id}/finalize`, body, { headers });
  invalidateCachedGet(base);
  invalidateCachedGet('/procurement/pending-actual-pos');
  invalidateCachedGet('/accounting/receipts/approved');
  invalidateCachedGet('/procurement/reports/purchases');
  return response.data.data;
};

export const uploadPurchaseOrderInvoiceApi = async (
  id: number,
  file: File | { photo: string; name?: string }
): Promise<PurchaseOrder> => {
  let response;
  if (file instanceof File) {
    const formData = new FormData();
    formData.append('invoice_file', file);
    response = await apiClient.post<{ message: string; data: PurchaseOrder }>(`${base}/${id}/upload-invoice`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  } else {
    response = await apiClient.post<{ message: string; data: PurchaseOrder }>(`${base}/${id}/upload-invoice`, {
      invoice_photo: file.photo,
      invoice_photo_name: file.name,
    });
  }
  invalidateCachedGet(base);
  invalidateCachedGet('/procurement/pending-actual-pos');
  invalidateCachedGet('/accounting/receipts/approved');
  invalidateCachedGet('/procurement/reports/purchases');
  return response.data.data;
};
