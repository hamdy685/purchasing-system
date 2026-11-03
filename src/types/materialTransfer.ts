export type MaterialTransferStatus =
  | 'DRAFT'
  | 'PENDING_REVIEWER'
  | 'PENDING_ACCOUNTING'
  | 'ARCHIVED'
  | 'REJECTED'
  | 'RETURNED';

export interface MaterialTransferRequestItem {
  id?: number;
  material_transfer_request_id?: number;
  item_order: number;
  item_description: string;
  uom: string;
  quantity: number | string;
  notes?: string | null;
}

export interface MaterialTransferRequest {
  id: number;
  request_number: string;
  transfer_date: string;
  from_project: string;
  to_project: string;
  driver_name?: string | null;
  vehicle_plate_number?: string | null;
  status: MaterialTransferStatus;
  status_label: string;
  general_notes?: string | null;
  rejection_reason?: string | null;
  return_reason?: string | null;
  review_notes?: string | null;
  reviewed_at?: string | null;
  accounting_notes?: string | null;
  accounted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;

  user?: {
    id: number;
    name: string;
    email: string;
    department?: string | null;
  } | null;

  reviewer?: {
    id: number;
    name: string;
    email: string;
  } | null;

  accountant?: {
    id: number;
    name: string;
    email: string;
  } | null;

  items: MaterialTransferRequestItem[];

  can_edit?: boolean;
  can_review?: boolean;
  can_account?: boolean;
}

export interface MaterialTransferPayload {
  transfer_date: string;
  from_project: string;
  to_project: string;
  driver_name?: string;
  vehicle_plate_number?: string;
  general_notes?: string;
  reviewer_id?: number;
  is_draft?: boolean;
  items: Array<{
    item_description: string;
    uom: string;
    quantity: number;
    notes?: string;
  }>;
}
