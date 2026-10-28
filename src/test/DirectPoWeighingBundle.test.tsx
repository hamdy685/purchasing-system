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

describe('DirectPoModal - Rebar Weighing Bundle (تجميع الوزنة كبند استلام ومحاسبة موحد)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('renders the "تجميع الوزنة (لبنود الحديد)" button in DirectPoModal', async () => {
    render(<DirectPoModal isOpen={true} onClose={() => undefined} onSuccess={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText(/تجميع الوزنة \(لبنود الحديد\)/)).toBeInTheDocument();
    });
  });

  it('bundles multiple steel items into a single unified item with total weight in TON and specifications breakdown', async () => {
    render(<DirectPoModal isOpen={true} onClose={() => undefined} onSuccess={() => undefined} />);

    await waitFor(() => {
      expect(screen.getAllByText('＋ إضافة صنف آخر').length).toBeGreaterThan(0);
    });

    // Add another item so we have 2 items
    fireEvent.click(screen.getAllByText('＋ إضافة صنف آخر')[0]);

    // Fill Item 1
    fireEvent.change(screen.getAllByPlaceholderText('رقم قطعة الأرض')[0], { target: { value: '105' } });
    fireEvent.change(screen.getAllByPlaceholderText('اسم الصنف')[0], { target: { value: 'حديد تسليح 4 لينيا 12مم' } });
    fireEvent.change(screen.getAllByLabelText('كمية البند')[0], { target: { value: '2' } });
    fireEvent.change(screen.getAllByLabelText('سعر الوحدة')[0], { target: { value: '42000' } });
    fireEvent.change(screen.getAllByPlaceholderText('المنطقة')[0], { target: { value: 'بيت الوطن' } });

    // Fill Item 2
    fireEvent.change(screen.getAllByPlaceholderText('رقم قطعة الأرض')[1], { target: { value: '105' } });
    fireEvent.change(screen.getAllByPlaceholderText('اسم الصنف')[1], { target: { value: 'حديد تسليح 5 لينيا 16مم' } });
    fireEvent.change(screen.getAllByLabelText('كمية البند')[1], { target: { value: '3' } });
    fireEvent.change(screen.getAllByLabelText('سعر الوحدة')[1], { target: { value: '42000' } });
    fireEvent.change(screen.getAllByPlaceholderText('المنطقة')[1], { target: { value: 'بيت الوطن' } });

    // Click "تجميع الوزنة (لبنود الحديد)"
    const bundleSpan = screen.getByText(/تجميع الوزنة \(لبنود الحديد\)/);
    const bundleBtn = bundleSpan.closest('button') || bundleSpan;
    fireEvent.click(bundleBtn);

    // Verify consolidated single item exists
    await waitFor(() => {
      expect(screen.getByText(/وزنة حديد مجمعة نشطة/)).toBeInTheDocument();
      expect(screen.getAllByDisplayValue('وزنة حديد تسليح مجمعة (ميزان بسكول)').length).toBeGreaterThan(0);
      expect(screen.getByText(/فك تجميع الوزنة/)).toBeInTheDocument();
    });

    // Verify that specifications contain the breakdown of both diameters
    const specInputs = screen.getAllByPlaceholderText('المواصفات');
    const bundledSpecs = specInputs[0]?.getAttribute('value') || (specInputs[0] as HTMLInputElement)?.value;
    expect(bundledSpecs).toMatch(/حديد تسليح 4 لينيا.*حديد تسليح 5 لينيا/);

    // Test unbundling / undo
    const unbundleSpan = screen.getByText(/فك تجميع الوزنة/);
    const unbundleBtn = unbundleSpan.closest('button') || unbundleSpan;
    fireEvent.click(unbundleBtn);

    await waitFor(() => {
      expect(screen.getByText(/تجميع الوزنة \(لبنود الحديد\)/)).toBeInTheDocument();
      expect(screen.getAllByDisplayValue('حديد تسليح 4 لينيا 12مم').length).toBeGreaterThan(0);
      expect(screen.getAllByDisplayValue('حديد تسليح 5 لينيا 16مم').length).toBeGreaterThan(0);
    });
  });
});
