import apiClient from '../client';

export interface ReceiptItemSummary {
  id: number;
  item_description: string;
  ordered_quantity: number;
  received_quantity: number;
  uom: string;
  unit_price?: number;
  line_total?: number;
  item_reference?: string | null;
  region?: string | null;
}

export interface AdminControlSearchResult {
  entity_type: 'PURCHASE_REQUEST' | 'PURCHASE_ORDER' | 'PURCHASE_RECEIPT';
  id: number;
  code: string;
  title: string;
  status: string;
  department?: string;
  supplier?: string;
  creator?: string;
  receiver?: string;
  amount?: number;
  date: string;
  items_count?: number;
  weighing_group_id?: number | null;
  project_site?: string;
  pending_with?: string;
  fulfillment_status?: string;
  days_elapsed?: number;

  // Rich decision-making context
  po_id?: number | null;
  po_number?: string | null;
  pr_id?: number | null;
  pr_number?: string | null;
  requester_name?: string | null;
  parcel_reference?: string | null;
  region?: string | null;
  items_summary?: string | null;
  total_quantity?: number | null;
  has_photo?: boolean;
  photo_url?: string | null;
  invoice_status?: 'RECORDED' | 'VERIFIED' | 'INVOICED' | 'PENDING_INVOICE' | string;
  invoice_status_label?: string | null;
  received_at?: string | null;
  site_engineer_notes?: string | null;
  warehouse_notes?: string | null;
  items_list?: ReceiptItemSummary[];
}

export interface ImpactPreview {
  entity_type: string;
  entity_id: number;
  entity_label: string;
  action: string;
  current_status: string;
  proposed_status: string | null;
  current_owner: { id: number; name: string; email: string; role: string } | null;
  proposed_owner: { id: number; name: string; email: string; role: string } | null;
  is_financial_locked: boolean;
  financial_lock_reason: string | null;
  requires_confirm_text: boolean;
  transition_allowed: boolean;
  requires_exception: boolean;
  transition_message: string | null;
  linked_documents: {
    purchase_orders?: string[];
    receipts?: string[];
    invoices_count?: number;
    purchase_request?: string;
  };
  warnings: string[];
}

export interface AdminAuditLogEntry {
  id: number;
  actor_user_id: number | null;
  actor_name: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: number;
  entity_label: string;
  from_status: string | null;
  to_status: string | null;
  reason: string;
  old_values: any;
  new_values: any;
  metadata: any;
  ip_address: string | null;
  is_exceptional: boolean;
  created_at: string;
  actor?: {
    id: number;
    name: string;
    email: string;
  } | null;
}

export interface ExcelGridRow {
  po_id: number;
  pr_id: number | null;
  receipt_id: number | null;
  pr_number: string;
  po_number: string;
  receipt_number: string;
  department: string;
  supplier: string;
  item_name: string;
  quantity_requested: number;
  quantity_received: number;
  uom: string;
  unit_price: number;
  total_price: number;
  parcel_reference: string;
  region: string;
  purpose: string;
  requester_name: string;
  actual_receiver: string;
  po_status: string;
  receipt_status: string;
  invoice_status: string;
  created_at: string;
}

export interface ExcelGridResponse {
  success: boolean;
  summary: {
    total_records: number;
    total_requested_quantity: number;
    total_received_quantity: number;
    total_amount: number;
  };
  data: ExcelGridRow[];
}

export interface WorkflowTransitionRule {
  id: number;
  entity_type: string;
  from_status: string;
  to_status: string;
  is_allowed: boolean;
  requires_exception: boolean;
  description?: string;
}

export interface DocumentDetailsResponse {
  success: boolean;
  entity_type: string;
  id: number;
  document: any;
  allowed_transitions: WorkflowTransitionRule[];
  assignments: any[];
  audit_history: AdminAuditLogEntry[];
}

// 1. Universal Search
export const searchAdminControlApi = async (params: {
  q?: string;
  entity_type?: string;
  department_id?: number | string;
  supplier_id?: number | string;
  status?: string;
  date_from?: string;
  date_to?: string;
  per_page?: number;
}): Promise<{
  success: boolean;
  count: number;
  data: AdminControlSearchResult[];
  lookups: {
    departments: Array<{ id: number; name: string; code: string }>;
    suppliers: Array<{ id: number; company_name: string; name: string }>;
  };
}> => {
  const res = await apiClient.get('/admin/control/search', { params });
  return res.data;
};

// 2. Document Details
export const getAdminControlDocumentApi = async (
  type: string,
  id: number
): Promise<DocumentDetailsResponse> => {
  const res = await apiClient.get(`/admin/control/documents/${type}/${id}`);
  return res.data;
};

// 3. Dry-Run Impact Preview
export const previewImpactApi = async (payload: {
  entity_type: string;
  entity_id: number;
  action: string;
  payload?: any;
}): Promise<{ success: boolean; impact: ImpactPreview }> => {
  const res = await apiClient.post('/admin/control/preview', payload);
  return res.data;
};

// 4. Safe Cancel Document
export const cancelDocumentSafelyApi = async (payload: {
  entity_type: string;
  entity_id: number;
  reason: string;
}): Promise<{ success: boolean; message: string; document?: any }> => {
  const res = await apiClient.post('/admin/control/requests/' + payload.entity_id + '/cancel', payload);
  return res.data;
};

// 5. Reassign Receipt Recipient
export const reassignReceiptRecipientApi = async (
  receiptId: number,
  payload: {
    new_user_id: number;
    reason: string;
  }
): Promise<{ success: boolean; message: string; receipt?: any }> => {
  const res = await apiClient.post(`/admin/control/receipts/${receiptId}/reassign`, payload);
  return res.data;
};

// 6. Rollback Workflow Stage
export const rollbackWorkflowApi = async (payload: {
  entity_type: string;
  entity_id: number;
  target_status: string;
  reason: string;
  is_exceptional?: boolean;
}): Promise<{ success: boolean; message: string; document?: any }> => {
  const res = await apiClient.post('/admin/control/documents/rollback', payload);
  return res.data;
};

// 7. Forward Workflow Stage
export const forwardWorkflowApi = async (payload: {
  entity_type: string;
  entity_id: number;
  target_status: string;
  reason: string;
  is_exceptional?: boolean;
}): Promise<{ success: boolean; message: string; document?: any }> => {
  const res = await apiClient.post('/admin/control/documents/forward', payload);
  return res.data;
};

// 8. Safely Edit Request
export const editRequestSafelyApi = async (
  prId: number,
  payload: any
): Promise<{ success: boolean; message: string; request?: any }> => {
  const res = await apiClient.post(`/admin/control/requests/${prId}/edit`, payload);
  return res.data;
};

// 9. Manage Assignments
export const manageAssignmentApi = async (payload: {
  entity_type: string;
  entity_id: number;
  user_id: number;
  assignment_type: 'PRIMARY_ACTION_OWNER' | 'PARALLEL_ACTION_OWNER' | 'VIEW_ONLY_USER';
  notes?: string;
}): Promise<{ success: boolean; message: string; assignment?: any }> => {
  const res = await apiClient.post('/admin/control/assignments/manage', payload);
  return res.data;
};

// 10. Resend Notification
export const resendNotificationApi = async (
  notificationId: number,
  reason: string
): Promise<{ success: boolean; message: string }> => {
  const res = await apiClient.post(`/admin/control/notifications/${notificationId}/resend`, { reason });
  return res.data;
};

// 11. Fetch Audit Logs
export const getAdminAuditLogsApi = async (params?: {
  q?: string;
  action?: string;
  entity_type?: string;
  actor_user_id?: number;
  date_from?: string;
  date_to?: string;
  page?: number;
  per_page?: number;
}): Promise<{
  success: boolean;
  data: AdminAuditLogEntry[];
  pagination: {
    current_page: number;
    last_page: number;
    total: number;
    per_page: number;
  };
}> => {
  const res = await apiClient.get('/admin/control/audit-log', { params });
  return res.data;
};

// 12. Fetch Excel Report Grid
export const getExcelReportsGridApi = async (params?: {
  department_id?: number | string;
  supplier_id?: number | string;
  date_from?: string;
  date_to?: string;
  search?: string;
}): Promise<ExcelGridResponse> => {
  const res = await apiClient.get('/admin/control/reports/grid', { params });
  return res.data;
};
