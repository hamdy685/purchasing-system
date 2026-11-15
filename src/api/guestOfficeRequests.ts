import { apiClient } from './client';

export interface GuestDepartmentOption {
  id: number;
  name: string;
}

export interface GuestOfficeRequestItem {
  item_description: string;
  quantity: number | '';
  uom: string;
}

export interface GuestOfficeRequestPayload {
  name: string;
  phone?: string;
  target_department_id: number;
  notes: string;
  items: GuestOfficeRequestItem[];
  /** Hidden anti-bot field, always empty for people. */
  website?: string;
}

export const getGuestOfficeFormApi = async (token: string): Promise<GuestDepartmentOption[]> => {
  const response = await apiClient.get(`/public/office-requests/${encodeURIComponent(token)}`);
  return response.data?.data?.departments ?? [];
};

export const submitGuestOfficeRequestApi = async (
  token: string,
  payload: GuestOfficeRequestPayload,
): Promise<{ request_number: string }> => {
  const response = await apiClient.post(`/public/office-requests/${encodeURIComponent(token)}`, payload);
  return response.data?.data;
};

export const getGuestOfficeLinkTokenApi = async (): Promise<string> => {
  const response = await apiClient.get('/admin/guest-office-link');
  return response.data?.data?.token;
};

export const rotateGuestOfficeLinkTokenApi = async (): Promise<string> => {
  const response = await apiClient.post('/admin/guest-office-link/rotate');
  return response.data?.data?.token;
};

export const buildGuestOfficeLink = (token: string): string =>
  `${window.location.origin}/office-request/${token}`;
