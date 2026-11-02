import apiClient, { cachedGetData, invalidateCachedGet } from './client';
import { المورد } from '../types/purchaseOrder';

export interface SupplierPayload {
  company_name: string;
  code?: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  address?: string;
  payment_terms?: string;
  opening_balance?: number | string;
  opening_balance_notes?: string;
  notes?: string;
  is_active?: boolean;
}

type SupplierPage = { data: المورد[]; meta?: { last_page?: number } };

// Every supplier, not just the server's first page: a supplier missing from the list
// makes a select show an empty or wrong name for an order that already has it.
export const getSuppliersApi = async (): Promise<المورد[]> => {
  const page = (n: number) =>
    cachedGetData<SupplierPage>('/procurement/suppliers-manage', { params: { per_page: 200, page: n } });
  const first = await page(1);
  const lastPage = first.meta?.last_page ?? 1;
  const rest = await Promise.all(Array.from({ length: Math.max(lastPage - 1, 0) }, (_, i) => page(i + 2)));
  return [first, ...rest].flatMap((p) => p.data || []);
};

export const getSupplierApi = async (id: number) =>
  (await apiClient.get<{ data: المورد }>(`/procurement/suppliers-manage/${id}`)).data.data;

export const createSupplierApi = async (payload: SupplierPayload) => {
  const response = await apiClient.post<{ data: المورد }>('/procurement/suppliers', payload);
  invalidateCachedGet('/procurement/suppliers-manage');
  return response.data.data;
};

export const updateSupplierApi = async (id: number, payload: Partial<SupplierPayload>) => {
  const response = await apiClient.put<{ data: المورد }>(`/procurement/suppliers/${id}`, payload);
  invalidateCachedGet('/procurement/suppliers-manage');
  return response.data.data;
};

export const deleteSupplierApi = async (id: number) => {
  const response = await apiClient.delete<{ message: string }>(`/procurement/suppliers/${id}`);
  invalidateCachedGet('/procurement/suppliers-manage');
  return response.data;
};

