import apiClient from './client';
import { getToken } from '../utils/authStorage';
import { WeighingGroup } from '../types/weighingGroup';
import { ShipmentGroup } from '../types/shipmentGroup';

export interface ReceiptOrderItem {
  id: number;
  item_description: string;
  item_reference?: string | null;
  region?: string | null;
  quantity: string | number;
  uom?: string | null;
  unit_price?: string | number | null;
  specifications?: string | null;
  notes?: string | null;
  shipment_group_id?: number | null;
  is_consolidated_steel?: boolean;
  shipment_group?: ShipmentGroup | null;
  item?: { id: number; name: string; sku?: string; category?: { name: string } } | null;
  pr_item?: {
    id: number;
    specifications?: string | null;
    notes?: string | null;
    item_description?: string | null;
    item_reference?: string | null;
    region?: string | null;
    quantity?: string | number | null;
    uom?: string | null;
  } | null;
  is_supplementary?: boolean;
  supplement_batch?: number | null;
}

export interface ReceiptPurchaseOrder {
  id: number;
  po_number: string;
  is_supplementary?: boolean;
  created_at?: string | null;
  notes?: string | null;
  supplier?: { id: number; company_name: string; contact_person?: string | null; phone?: string | null } | null;
  weighing_groups?: WeighingGroup[];
  shipment_groups?: ShipmentGroup[];
  purchase_request?: {
    id: number;
    request_number: string;
    created_at?: string | null;
    project_name?: string | null;
    parcel_reference?: string | null;
    region?: string | null;
    requester?: { id: number; name: string; email?: string } | null;
    department?: { id: number; name: string } | null;
    site_engineer?: { id: number; name: string } | null;
    site_engineer_user_id?: number | null;
    supplements?: Array<{
      id: number;
      batch_number: number;
      status: string;
      notes?: string | null;
    }>;
  } | null;
  items?: ReceiptOrderItem[];
}

export interface ReceiptRecord {
  id: number;
  receipt_number: string;
  is_supplementary?: boolean;
  receipt_type?: string | null;
  status: string;
  created_at?: string | null;
  received_at?: string | null;
  warehouse_submitted_at?: string | null;
  warehouse_notes?: string | null;
  photo_path?: string | null;
  photo_name?: string | null;
  photo_url?: string | null;
  site_engineer_notes?: string | null;
  supplier_id?: number | null;
  supplier_name?: string | null;
  supplier?: { id: number; company_name: string; contact_person?: string | null; phone?: string | null } | null;
  is_internal_warehouse?: boolean;
  warehouse_keeper_user_id?: number | null;
  warehouse_keeper?: { id: number; name: string } | null;
  warehouse_keeper_pass_status?: string | null;
  warehouse_keeper_pass_label?: string | null;
  site_engineer_user_id?: number | null;
  site_engineer?: { id: number; name: string } | null;
  receiver_user_id?: number | null;
  receiver?: { id: number; name: string } | null;
  actual_receiver_name?: string | null;
  actual_receiver_user_id?: number | null;
  actual_receiver?: { id: number; name: string } | null;
  actual_receiver_display_name?: string | null;
  warehouse_received_at?: string | null;
  weighing_group_id?: number | null;
  weighing_group?: WeighingGroup | null;
  purchase_order_id?: number | null;
  purchase_order?: ReceiptPurchaseOrder | null;
  purchase_request?: ReceiptPurchaseOrder['purchase_request'];
  items?: Array<{
    id: number;
    received_quantity: string | number;
    ordered_quantity: string | number;
    notes?: string | null;
    purchase_order_item?: ReceiptOrderItem | null;
  }>;
}

export const getReceiptPhotoUrl = (receipt: { id?: number; photo_url?: string | null }): string => {
  if (!receipt) return '';
  const token = getToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';

  if (receipt.photo_url) {
    if (receipt.photo_url.startsWith('data:') || receipt.photo_url.startsWith('blob:')) {
      return receipt.photo_url;
    }
    if (receipt.photo_url.includes('drive.google.com/file/d/')) {
      const match = receipt.photo_url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return `https://lh3.googleusercontent.com/d/${match[1]}=w1000`;
      }
    }
    if (receipt.photo_url.startsWith('http://') || receipt.photo_url.startsWith('https://')) {
      return receipt.photo_url;
    }
    if (receipt.photo_url.startsWith('/')) {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/v1';
      const rootHost = apiBase.replace(/\/api\/v1\/?$/, '');
      const base = rootHost ? `${rootHost}${receipt.photo_url}` : receipt.photo_url;
      return base.includes('?') ? `${base}&token=${encodeURIComponent(token || '')}` : `${base}${tokenParam}`;
    }
  }
  if (receipt.id) {
    const apiBase = import.meta.env.VITE_API_BASE_URL || '/api/v1';
    const cleanBase = apiBase.replace(/\/+$/, '');
    return `${cleanBase}/purchase-receipts/${receipt.id}/photo${tokenParam}`;
  }
  return receipt.photo_url || '';
};

export const getWarehouseReceiptQueueApi = async (): Promise<ReceiptPurchaseOrder[]> =>
  (await apiClient.get<{ data: ReceiptPurchaseOrder[] }>('/purchase-receipts/warehouse-queue')).data.data;

export const getAssignedReceiptsApi = async (): Promise<ReceiptRecord[]> =>
  (await apiClient.get<{ data: ReceiptRecord[] }>('/purchase-receipts/assigned')).data.data;

export const getPurchaseReceiptArchiveApi = async (): Promise<ReceiptRecord[]> =>
  (await apiClient.get<{ data: ReceiptRecord[] }>('/purchase-receipts/archive')).data.data;

export const getPurchaseReceiptByIdApi = async (receiptId: number): Promise<ReceiptRecord> =>
  (await apiClient.get<{ data: ReceiptRecord }>(`/purchase-receipts/${receiptId}`)).data.data;

export const createPurchaseReceiptApi = async (
  purchaseOrderId: number,
  payload: {
    received_at?: string;
    warehouse_notes?: string;
    photo_base64?: string;
    photo_name?: string;
    actual_receiver_name?: string;
    actual_receiver_user_id?: number;
    weighing_group_id?: number;
    scale_ticket_weight?: number;
    items: Array<{ purchase_order_item_id: number; received_quantity: number; notes?: string }>;
  },
): Promise<ReceiptRecord> =>
  (await apiClient.post<{ data: ReceiptRecord }>(`/purchase-receipts/purchase-orders/${purchaseOrderId}`, payload)).data.data;

export const updatePurchaseReceiptApi = async (
  receiptId: number,
  payload: { site_engineer_notes?: string; items: Array<{ id: number; received_quantity: number; notes?: string }> },
): Promise<ReceiptRecord> =>
  (await apiClient.put<{ data: ReceiptRecord }>(`/purchase-receipts/${receiptId}`, payload)).data.data;

export const approvePurchaseReceiptApi = async (
  receiptId: number,
  payload?: { site_engineer_notes?: string; items?: Array<{ id: number; received_quantity: number; notes?: string }> } | string,
): Promise<ReceiptRecord> => {
  const body = typeof payload === 'string' ? { site_engineer_notes: payload } : (payload || {});
  return (await apiClient.post<{ data: ReceiptRecord }>(`/purchase-receipts/${receiptId}/approve`, body)).data.data;
};

export const confirmOfficeReceiptApi = async (
  purchaseOrderId: number,
  payload?: { notes?: string; items?: Array<{ purchase_order_item_id: number; received_quantity: number; notes?: string }> },
): Promise<{ message: string; data: ReceiptRecord }> =>
  (await apiClient.post<{ message: string; data: ReceiptRecord }>(`/purchase-receipts/purchase-orders/${purchaseOrderId}/confirm-office`, payload || {})).data;

export const cancelPurchaseReceiptApi = async (receiptId: number): Promise<{ message: string }> =>
  (await apiClient.post<{ message: string }>(`/purchase-receipts/${receiptId}/cancel`)).data;

export interface ReceiptAttachmentInfo {
  receipt_id: number;
  receipt_number: string;
  purchase_order_id: number;
  po_number: string;
  supplier_name: string;
  received_at?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  view_url: string;
  drive_link?: string | null;
  uploaded_at?: string | null;
}

export interface ReceiptAttachmentResponse {
  success: boolean;
  has_attachment: boolean;
  message?: string;
  attachment?: ReceiptAttachmentInfo;
}

export const getReceiptAttachmentApi = async (receiptId: number): Promise<ReceiptAttachmentResponse> => {
  const res = await apiClient.get<ReceiptAttachmentResponse>(`/purchase-receipts/${receiptId}/attachment`);
  return res.data;
};
