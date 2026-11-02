import { describe, it, expect, vi } from 'vitest';
import apiClient, { invalidateCachedGet } from '../api/client';
import { getSuppliersApi } from '../api/suppliers';

describe('getSuppliersApi', () => {
  it('returns suppliers from every page, not only the first', async () => {
    invalidateCachedGet();
    const spy = vi.spyOn(apiClient, 'get').mockImplementation(async (_url: string, config?: any) => {
      const page = config?.params?.page ?? 1;
      const data = page === 1
        ? [{ id: 1, company_name: 'أبو عدى' }]
        : page === 2 ? [{ id: 2, company_name: 'سامي' }] : [{ id: 3, company_name: 'هيثم عرب نرجس 6' }];
      return { data: { data, meta: { last_page: 3 } } } as any;
    });

    const suppliers = await getSuppliersApi();

    expect(suppliers.map((s) => s.company_name)).toEqual(['أبو عدى', 'سامي', 'هيثم عرب نرجس 6']);
    expect(spy).toHaveBeenCalledWith('/procurement/suppliers-manage', { params: { per_page: 200, page: 3 } });
    spy.mockRestore();
  });
});
