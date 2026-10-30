import apiClient from '../client';

export interface MasterOrderItem {
  id: number;
  item_description: string;
  item_reference?: string | null;
  region?: string | null;
  quantity: number;
  uom: string;
  unit_price: number;
  line_total: number;
  supplier_id?: number | null;
  supplier?: {
    id: number;
    company_name: string;
    name?: string;
    code?: string;
  } | null;
  received_quantity?: number | null;
  specifications?: string | null;
}

export interface MasterOrderRow {
  unique_key: string;
  order_id: number | null;
  request_id: number | null;
  po_number: string;
  manual_po_number?: string | null;
  pr_number: string;
  department: {
    id?: number | null;
    name: string;
    code: string;
  };
  requester: {
    id?: number | null;
    name: string;
  };
  supplier: {
    id?: number | null;
    name: string;
    code: string;
  };
  project_site: {
    parcel_reference: string;
    region: string;
  };
  po_status: string | null;
  pr_status: string;
  cycle_stage: string;
  cycle_stage_label: string;
  cycle_stage_color: string;
  cycle_stage_desc: string;
  responsible_party: string;
  is_actual_po: boolean;
  finalized_at?: string | null;
  grand_total: number;
  subtotal: number;
  items_count: number;
  items: MasterOrderItem[];
  receipt?: {
    id: number;
    receipt_number: string;
    status: string;
    received_at?: string | null;
    photo_url?: string | null;
  } | null;
  invoice?: {
    id: number;
    invoice_number: string;
    status: string;
    matching_status?: string | null;
    amount: number;
  } | null;
  delivery_date?: string | null;
  actual_delivery_date?: string | null;
  notes?: string | null;
  financial_notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MasterOrdersStats {
  total_count: number;
  invoiced_count: number;
  actual_po_count: number;
  pending_actual_po_count: number;
  grn_pending_count: number;
  po_issued_count: number;
  pending_po_count: number;
  under_review_count: number;
  rejected_count: number;
  total_financial_value: number;
}

export interface MasterOrdersResponse {
  success: boolean;
  data: MasterOrderRow[];
  meta: {
    current_page: number;
    per_page: number;
    total: number;
    last_page: number;
    from: number;
    to: number;
  };
  stats: MasterOrdersStats;
  lookups: {
    departments: Array<{ id: number; name: string; code: string }>;
    suppliers: Array<{ id: number; company_name: string; name: string; code: string }>;
  };
}

export interface ForceUpdateItemPayload {
  id?: number | null;
  supplier_id?: number | null;
  item_description: string;
  item_reference?: string | null;
  region?: string | null;
  quantity: number;
  uom: string;
  unit_price: number;
  specifications?: string | null;
  delete?: boolean;
}

export interface ForceUpdateOrderPayload {
  status?: string;
  supplier_id?: number | null;
  delivery_date?: string | null;
  actual_delivery_date?: string | null;
  delivery_notes?: string | null;
  notes?: string | null;
  financial_notes?: string | null;
  rejection_reason?: string | null;
  is_actual_po?: boolean;
  finalized_at?: string | null;
  receipt_status?: string | null;
  delivery_status?: string | null;
  admin_reason: string;
  sync_receipt?: boolean;
  sync_pr?: boolean;
  request_stage?: string | null;
  items?: ForceUpdateItemPayload[];
}

export interface RequestStageOption {
  value: string;
  label: string;
  available: boolean;
  reason: string | null;
  current: boolean;
}

export interface RequestStageInfo {
  current_stage: { value: string; label: string } | null;
  stage_options: RequestStageOption[];
}

export interface OrderMasterDetailsResponse {
  success: boolean;
  data: {
    order: any;
    request?: any;
    cycle_stage: {
      stage: string;
      label: string;
      color: string;
      description: string;
      responsible: string;
    };
    audit_logs: any[];
    available_suppliers: Array<{ id: number; company_name: string; name: string; code: string }>;
  } & RequestStageInfo;
}

export interface RequestStageDetailsResponse {
  success: boolean;
  data: {
    request: any;
    audit_logs: any[];
  } & RequestStageInfo;
}

export const getRequestStageApi = async (id: number): Promise<RequestStageDetailsResponse> => {
  const response = await apiClient.get<RequestStageDetailsResponse>(`/admin/requests/${id}/stage`);
  return response.data;
};

export const moveRequestStageApi = async (
  id: number,
  payload: { request_stage: string; admin_reason: string }
): Promise<{ success: boolean; message: string; data: any }> => {
  const response = await apiClient.post<{ success: boolean; message: string; data: any }>(
    `/admin/requests/${id}/move-stage`,
    payload
  );
  return response.data;
};

export const getMasterOrdersApi = async (params: {
  search?: string;
  stage?: string;
  department_id?: number | string;
  supplier_id?: number | string;
  date_from?: string;
  date_to?: string;
  page?: number;
  per_page?: number | string;
}): Promise<MasterOrdersResponse> => {
  try {
    const response = await apiClient.get<MasterOrdersResponse>('/admin/all-orders-master', { params });
    return response.data;
  } catch (error: any) {
    console.error('❌ [Admin Master Orders API Error] getMasterOrdersApi failed:', {
      endpoint: '/admin/all-orders-master',
      params,
      status: error?.response?.status,
      data: error?.response?.data,
      laravelMessage: error?.response?.data?.message || error?.response?.data?.error,
      originalError: error,
    });
    throw error;
  }
};

export const getOrderMasterDetailsApi = async (id: number): Promise<OrderMasterDetailsResponse> => {
  try {
    const response = await apiClient.get<OrderMasterDetailsResponse>(`/admin/orders/${id}/details`);
    return response.data;
  } catch (error: any) {
    console.error(`❌ [Admin Master Orders API Error] getOrderMasterDetailsApi failed for order #${id}:`, {
      endpoint: `/admin/orders/${id}/details`,
      status: error?.response?.status,
      data: error?.response?.data,
      originalError: error,
    });
    throw error;
  }
};

export const forceUpdateOrderApi = async (
  id: number,
  payload: ForceUpdateOrderPayload
): Promise<{ success: boolean; message: string; data: any }> => {
  try {
    const response = await apiClient.put<{ success: boolean; message: string; data: any }>(
      `/admin/orders/${id}/force-update`,
      payload
    );
    return response.data;
  } catch (error: any) {
    console.error(`❌ [Admin Master Orders API Error] forceUpdateOrderApi failed for order #${id}:`, {
      endpoint: `/admin/orders/${id}/force-update`,
      payload,
      status: error?.response?.status,
      data: error?.response?.data,
      originalError: error,
    });
    throw error;
  }
};

export interface ForceDeleteOrderPayload {
  reason?: string;
  entity_type?: 'order' | 'request' | 'auto';
}

export const forceDeleteMasterOrderApi = async (
  id: number,
  payload?: ForceDeleteOrderPayload
): Promise<{ success: boolean; message: string; deleted?: any }> => {
  try {
    const response = await apiClient.delete<{ success: boolean; message: string; deleted?: any }>(
      `/admin/orders/${id}/force-delete`,
      { data: payload }
    );
    return response.data;
  } catch (error: any) {
    console.error(`❌ [Admin Master Orders API Error] forceDeleteMasterOrderApi failed for order #${id}:`, {
      endpoint: `/admin/orders/${id}/force-delete`,
      payload,
      status: error?.response?.status,
      data: error?.response?.data,
      laravelMessage: error?.response?.data?.message || error?.response?.data?.error,
      originalError: error,
    });
    throw error;
  }
};

