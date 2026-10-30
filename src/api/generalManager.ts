import apiClient from './client';
import { PurchaseOrder } from '../types/purchaseOrder';
import { PurchaseRequest, UpdatePurchaseRequestPayload } from '../types/purchaseRequest';
import { ProcurementAnalyticsResponse } from './procurement';

const BASE = '/general-manager/purchase-orders';
const REQUESTS_BASE = '/general-manager/purchase-requests';

export const getGeneralManagerPurchaseOrdersApi = async (params?: { per_page?: number | string; all?: boolean }): Promise<PurchaseOrder[]> =>
  (await apiClient.get<{ data: PurchaseOrder[] }>(BASE, { params: { per_page: 'all', all: true, ...params } })).data.data;

// Header fields only (status, supplier, department, total) for the dashboard's counts and totals.
export const getGeneralManagerPurchaseOrderSummariesApi = async (): Promise<PurchaseOrder[]> =>
  (await apiClient.get<{ data: PurchaseOrder[] }>(BASE, { params: { summary: 1 } })).data.data;

export const getGeneralManagerPurchaseOrderApi = async (id: number): Promise<PurchaseOrder> =>
  (await apiClient.get<{ data: PurchaseOrder }>(`${BASE}/${id}`)).data.data;

export const getGeneralManagerPurchaseRequestsApi = async (perPage: number = 100): Promise<PurchaseRequest[]> =>
  (await apiClient.get<{ data: PurchaseRequest[] }>(`${REQUESTS_BASE}?per_page=${perPage}`)).data.data;

export const getGeneralManagerPurchaseRequestApi = async (id: number): Promise<PurchaseRequest> =>
  (await apiClient.get<{ data: PurchaseRequest }>(`${REQUESTS_BASE}/${id}`)).data.data;

export const updateGeneralManagerPurchaseRequestApi = async (
  id: number,
  payload: UpdatePurchaseRequestPayload & { comment?: string },
): Promise<PurchaseRequest> =>
  (await apiClient.put<{ data: PurchaseRequest }>(`${REQUESTS_BASE}/${id}`, payload)).data.data;

export const approveGeneralManagerPurchaseRequestApi = async (
  id: number,
  comment?: string,
): Promise<PurchaseRequest> =>
  (await apiClient.post<{ data: PurchaseRequest }>(`${REQUESTS_BASE}/${id}/approve`, { comment })).data.data;

export const rejectGeneralManagerPurchaseRequestApi = async (
  id: number,
  comment: string,
): Promise<PurchaseRequest> =>
  (await apiClient.post<{ data: PurchaseRequest }>(`${REQUESTS_BASE}/${id}/reject`, { comment })).data.data;

export const getGeneralManagerAnalyticsApi = async (
  period: string = '90',
  status?: string,
): Promise<ProcurementAnalyticsResponse> => {
  const params: Record<string, string> = { period };
  if (status) params.status = status;
  return (await apiClient.get<ProcurementAnalyticsResponse>('/procurement/analytics', { params })).data;
};
