import { PurchaseRequestType } from './purchaseRequest';

export type PurchaseOrderStatus =
  | 'PO_DRAFT'
  | 'ISSUED'
  | 'PENDING_ACTUAL_PO'
  | 'PENDING_ACCOUNTING_REVIEW'
  | 'RETURNED_TO_PROCUREMENT'
  | 'APPROVED_BY_ACCOUNTING'
  | 'FINAL_APPROVED'
  | 'REJECTED';

export interface المورد {
  id: number;
  code?: string | null;
  company_name: string;
  contact_person?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  opening_balance?: string | number | null;
  opening_balance_notes?: string | null;
  is_active: boolean;
  notes?: string | null;
  tax_number?: string | null;
  commercial_register?: string | null;
  created_at?: string;
  purchase_orders?: Array<{
    id: number;
    po_number: string;
    status: string;
    grand_total: string;
    created_at: string;
  }>;
}

export type Supplier = المورد;

export interface PurchaseOrderItem {
  id: number;
  pr_item_id?: number | null;
  item_name?: string | null;
  pr_item_quantity?: string | null;
  item_id?: number | null;
  item?: {
    id: number;
    name: string;
    sku: string;
  } | null;
  item_description: string;
  item_reference?: string | null;
  region?: string | null;
  quantity: string;
  original_quantity?: string | number | null;
  actual_quantity?: string | number | null;
  uom?: string | null;
  unit_price: string;
  actual_unit_price?: string | number | null;
  line_total: string;
  actual_line_total?: string | number | null;
  is_discount_applied?: boolean;
  discount_amount?: string | number | null;
  specifications?: string | null;
  supplier_id?: number | null;
  supplier?: {
    id: number;
    company_name: string;
    code?: string | null;
  } | null;
  pr_item?: {
    id: number;
    supplier_id?: number | null;
    supplier?: {
      id: number;
      company_name: string;
      code?: string | null;
    } | null;
    item_description?: string | null;
    quantity?: string | number | null;
    uom?: string | null;
    specifications?: string | null;
    notes?: string | null;
    item_reference?: string | null;
    region?: string | null;
  } | null;
  is_supplementary?: boolean;
  is_consolidated_steel?: boolean;
  supplement_batch?: number | null;
  shipment_group_id?: number | null;
  shipment_group?: {
    id: number;
    group_number: string;
    group_name: string;
    status: string;
  } | null;
  weighing_group_item?: {
    id: number;
    weighing_group_id: number;
    group_number?: string;
    ordered_weight: string;
    received_weight?: string | null;
    weighing_group?: {
      id: number;
      group_number: string;
      status: string;
    } | null;
  } | null;
}


export interface PurchaseOrder {
  id: number;
  po_number: string;
  manual_po_number?: string | null;
  manual_pr_number?: string | null;
  purchase_request_id?: number | null;
  project_name?: string | null;
  parcel_reference?: string | null;
  region?: string | null;
  purchase_request?: {
    id: number;
    request_number: string;
    manual_request_number?: string | null;
    request_type?: PurchaseRequestType;
    status: string;
    created_at?: string | null;
    project_name?: string | null;
    parcel_reference?: string | null;
    region?: string | null;
    requester?: {
      id: number;
      name: string;
      email?: string;
    };
    assigned_reviewer?: {
      id: number;
      name: string;
      email?: string;
    } | null;
    site_engineer?: {
      id: number;
      name: string;
      email?: string;
    } | null;
    date_needed?: string | null;
    notes?: string | null;
    purpose?: string | null;
    department?: {
      id: number;
      name: string;
      code?: string;
    };
    target_department?: {
      id: number;
      name: string;
      code?: string;
    } | null;
    items?: Array<{
      id: number;
      item_description: string;
      quantity: string;
      uom?: string;
      specifications?: string;
    }>;
  };
  requested_by?: {
    id: number;
    name: string;
    email?: string;
  } | null;
  department_approver?: {
    id: number;
    name: string;
    email?: string;
  } | null;
  executive_approver?: {
    id: number;
    name: string;
    email?: string;
  } | null;
  department?: {
    id: number;
    name: string;
    code?: string;
  } | null;
  supplier_id: number;
  supplier?: المورد;
  created_by?: {
    id: number;
    name: string;
    email?: string;
  };
  accounting_reviewer?: {
    id: number;
    name: string;
    email?: string;
  };
  status: PurchaseOrderStatus;
  is_actual_po?: boolean;
  is_supplementary?: boolean;
  /** Always 'EGP' — Egyptian Pound */
  currency: string;
  subtotal: string;
  discount_type?: 'NONE' | 'TOTAL' | 'SELECTED_ITEMS';
  discount_percentage?: string | number | null;
  discount_amount?: string | number | null;
  tax_amount?: string | number | null;
  grand_total: string;
  payment_terms?: string | null;
  delivery_terms?: string | null;
  delivery_date?: string | null;
  delivery_status?: 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE' | 'LATE' | string;
  actual_delivery_date?: string | null;
  delivery_notes?: string | null;
  budget_code?: string | null;
  financial_notes?: string | null;
  notes?: string | null;
  purpose?: string | null;
  invoice_photo_url?: string | null;
  invoice_photo_name?: string | null;
  invoice_photo_size?: number | null;
  invoice_photo_drive_id?: string | null;
  invoice_photo_uploaded_at?: string | null;
  has_invoice_attachment?: boolean;
  invoice_attachments?: Array<{
    id: number;
    file_name: string;
    file_size?: number | null;
    mime_type?: string | null;
    drive_id?: string | null;
    file_url: string;
    download_url?: string | null;
    uploaded_at?: string | null;
  }>;
  finalized_by_user_id?: number | null;
  finalized_at?: string | null;
  finalization_notes?: string | null;
  finalized_by?: {
    id: number;
    name: string;
    email?: string;
  } | null;
  rejection_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  items?: PurchaseOrderItem[];
  shipment_groups?: Array<{
    id: number;
    group_number: string;
    group_name: string;
    status: string;
    vehicle_plate_number?: string | null;
    driver_name?: string | null;
    notes?: string | null;
    items_count?: number;
    items?: PurchaseOrderItem[];
  }>;
  weighing_groups?: Array<any>;
  receipts?: LinkedReceiptSummary[];
  approval_history?: Array<{
    action: string;
    from_state: string;
    to_state: string;
    comments?: string | null;
    created_at?: string | null;
    actor?: {
      id: number;
      name: string;
    } | null;
  }>;
}

export interface LinkedReceiptItem {
  id: number;
  purchase_order_item_id?: number | null;
  ordered_quantity: string | number;
  received_quantity: string | number;
  notes?: string | null;
  purchase_order_item?: {
    id: number;
    item_description: string;
    item_name?: string | null;
    uom?: string | null;
    unit_price?: string | number;
    supplier_id?: number | null;
    supplier?: {
      id: number;
      company_name: string;
      code?: string | null;
    } | null;
    pr_item?: {
      id: number;
      supplier_id?: number | null;
      supplier?: {
        id: number;
        company_name: string;
        code?: string | null;
      } | null;
    } | null;
  } | null;

}

export interface LinkedReceiptSummary {
  id: number;
  receipt_number: string;
  receipt_type?: string | null;
  status: string;
  received_at?: string | null;
  warehouse_submitted_at?: string | null;
  site_engineer_approved_at?: string | null;
  warehouse_notes?: string | null;
  site_engineer_notes?: string | null;
  receiver_notes?: string | null;
  photo_url?: string | null;
  photo_name?: string | null;
  warehouse_keeper?: { id: number; name: string } | null;
  site_engineer?: { id: number; name: string } | null;
  receiver?: { id: number; name: string } | null;
  is_supplementary?: boolean;
  items?: LinkedReceiptItem[];
}

export interface PurchaseOrderPayload {
  purchase_request_id?: number;
  manual_po_number?: string;
  manual_pr_number?: string;
  supplier_id?: number;
  one_time_supplier_name?: string;
  payment_terms?: string;
  delivery_terms?: string;
  delivery_date?: string;
  budget_code?: string;
  financial_notes?: string;
  notes?: string;
  finalization_notes?: string;
  parcel_reference?: string;
  region?: string;
  discount_type?: 'NONE' | 'TOTAL' | 'SELECTED_ITEMS';
  discount_percentage?: number;
  discount_item_ids?: number[];
  items?: Array<{
    id?: number;
    pr_item_id?: number | null;
    item_id?: number | null;
    item_description?: string;
    item_reference?: string;
    region?: string;
    quantity?: number;
    uom?: string;
    unit_price?: number;
    specifications?: string;
    supplier_id?: number | null;
    is_discount_applied?: boolean;
  }>;
  groups?: PurchaseOrderGroupPayload[];
}

export interface PurchaseOrderGroupPayload {
  group_name?: string;
  group_type?: 'SHARED_SHIPMENT' | 'STEEL_WEIGHING' | 'NONE';
  supplier_id?: number;
  one_time_supplier_name?: string;
  payment_terms?: string;
  delivery_terms?: string;
  delivery_date?: string;
  notes?: string;
  items: Array<{
    pr_item_id: number;
    item_id?: number | null;
    item_description?: string;
    item_reference?: string;
    region?: string;
    quantity: number;
    uom?: string;
    unit_price: number;
    specifications?: string;
    supplier_id?: number | null;
  }>;
}

export interface PurchaseOrderItemPayload {
  item_id?: number | null;
  item_description: string;
  item_reference?: string;
  region?: string;
  quantity: number | string;
  uom?: string;
  unit_price: number | string;
  specifications?: string;
}

export interface FinalizeActualPoItemPayload {
  id?: number | null;
  item_id?: number | null;
  pr_item_id?: number | null;
  item_description: string;
  item_reference: string;
  region: string;
  quantity: number;
  uom?: string | null;
  unit_price: number;
  is_discount_applied?: boolean;
  discount_amount?: number;
  specifications?: string | null;
  supplier_id?: number | null;
}

export interface FinalizeActualPoPayload {
  supplier_id?: number | null;
  parcel_reference?: string;
  region?: string;
  discount_type?: 'NONE' | 'TOTAL' | 'SELECTED_ITEMS';
  discount_percentage?: number;
  discount_item_ids?: number[];
  items: FinalizeActualPoItemPayload[];
  notes?: string;
  invoice_file?: File | null;
  invoice_photo?: string | null;
  invoice_photo_name?: string | null;
}
