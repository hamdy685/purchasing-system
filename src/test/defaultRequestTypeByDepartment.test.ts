import { describe, expect, it } from 'vitest';
import { getDefaultRequestTypeForDepartment } from '../pages/employee/CreatePurchaseRequestPage';

describe('getDefaultRequestTypeForDepartment', () => {
  it('defaults site departments to projects', () => {
    expect(getDefaultRequestTypeForDepartment({ code: 'EXECUTION', name: 'التنفيذ' })).toBe('PROJECT');
    expect(getDefaultRequestTypeForDepartment({ code: 'FINISHING', name: 'التشطيبات' })).toBe('PROJECT');
    expect(getDefaultRequestTypeForDepartment({ code: 'BUILDINGS', name: 'المباني' })).toBe('PROJECT');
    expect(getDefaultRequestTypeForDepartment({ code: '', name: 'المبانى' })).toBe('PROJECT');
  });

  it('defaults every other department to office supplies', () => {
    expect(getDefaultRequestTypeForDepartment({ code: 'LICENSES', name: 'التراخيص' })).toBe('OFFICE_SUPPLIES');
    expect(getDefaultRequestTypeForDepartment({ code: 'SALES', name: 'المبيعات' })).toBe('OFFICE_SUPPLIES');
  });

  it('keeps projects when the user has no department', () => {
    expect(getDefaultRequestTypeForDepartment(null)).toBe('PROJECT');
  });
});
