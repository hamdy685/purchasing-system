import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DirectPoModal } from '../components/procurement/DirectPoModal';

vi.mock('../api/suppliers', () => ({
  getSuppliersApi: vi.fn().mockResolvedValue([
    { id: 10, company_name: 'شركة حديد عز الوطنية', is_active: true },
  ]),
}));

vi.mock('../api/procurement', () => ({
  getProcurementDepartmentsApi: vi.fn().mockResolvedValue([
    { id: 1, name: 'الإدارة الهندسية' },
  ]),
  getProcurementSiteEngineersApi: vi.fn().mockResolvedValue([
    { id: 5, name: 'م. أحمد بدوي', department_id: 1 },
  ]),
  createDirectPoApi: vi.fn().mockResolvedValue({ id: 101 }),
}));

const fillRow = (index: number, desc: string, qty: string, price: string) => {
  fireEvent.change(screen.getAllByPlaceholderText('رقم قطعة الأرض')[index], { target: { value: '105' } });
  fireEvent.change(screen.getAllByPlaceholderText('اسم الصنف')[index], { target: { value: desc } });
  fireEvent.change(screen.getAllByLabelText('كمية البند')[index], { target: { value: qty } });
  fireEvent.change(screen.getAllByLabelText('سعر الوحدة')[index], { target: { value: price } });
  fireEvent.change(screen.getAllByPlaceholderText('المنطقة')[index], { target: { value: 'بيت الوطن' } });
};

describe('DirectPoModal - steel consolidated into one "حديد" line (server-side)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('no longer offers the client-side "تجميع الوزنة" merge', async () => {
    render(<DirectPoModal isOpen={true} onClose={() => undefined} onSuccess={() => undefined} />);
    await waitFor(() => {
      expect(screen.getAllByText('＋ إضافة صنف آخر').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/تجميع الوزنة \(لبنود الحديد\)/)).not.toBeInTheDocument();
  });

  it('keeps each diameter row editable and previews one consolidated "حديد" line with the summed value', async () => {
    render(<DirectPoModal isOpen={true} onClose={() => undefined} onSuccess={() => undefined} />);
    await waitFor(() => {
      expect(screen.getAllByText('＋ إضافة صنف آخر').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('＋ إضافة صنف آخر')[0]);
    fireEvent.click(screen.getAllByText('＋ إضافة صنف آخر')[0]);

    const uomSelects = () => screen.getAllByLabelText('وحدة البند') as HTMLSelectElement[];
    fillRow(0, 'حديد تسليح 12 مم', '5', '38000');
    fillRow(1, 'حديد تسليح 8 مم', '10', '39000');
    fillRow(2, 'حديد تسليح 12 مم', '56', '38000');
    uomSelects().forEach((select) => fireEvent.change(select, { target: { value: 'TON' } }));

    await waitFor(() => {
      const preview = screen.getByTestId('steel-consolidation-preview');
      expect(preview.textContent).toMatch(/\(3\) بنود حديد/);
      expect(preview.textContent).toMatch(/71 طن/);
      expect(preview.textContent).toMatch(/2,708,000/);
    });

    // Rows are not merged on the client: the three diameters stay as entered (desktop table rows).
    const names = (screen.getAllByPlaceholderText('اسم الصنف') as HTMLInputElement[]).slice(0, 3).map((input) => input.value);
    expect(names).toEqual(['حديد تسليح 12 مم', 'حديد تسليح 8 مم', 'حديد تسليح 12 مم']);
  });
});
