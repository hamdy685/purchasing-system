import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FinalizeActualPoModal } from '../components/procurement/FinalizeActualPoModal';
import * as purchaseOrdersApi from '../api/purchaseOrders';
import { PurchaseOrder } from '../types/purchaseOrder';

vi.mock('../api/purchaseOrders', () => ({
  getPurchaseOrderApi: vi.fn(),
  updatePurchaseOrderApi: vi.fn(),
  finalizeActualPurchaseOrderApi: vi.fn(),
  uploadPurchaseOrderInvoiceApi: vi.fn(),
}));

vi.mock('../api/suppliers', () => ({
  getSuppliersApi: vi.fn().mockResolvedValue([
    { id: 12, company_name: 'المورد أ', is_active: true },
    { id: 99, company_name: 'المورد ب', is_active: true },
  ]),
}));

vi.mock('../utils/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const FINALIZE = '💰 اعتماد وإرسال للإدارة المالية';

const makePo = (unitPrice: number, extra: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id: 101,
  po_number: 'PO-2026-00101',
  purchase_request_id: 55,
  supplier_id: 12,
  status: 'PENDING_ACTUAL_PO',
  grand_total: unitPrice,
  subtotal: unitPrice,
  created_at: '2026-10-08T10:00:00Z',
  updated_at: '2026-10-08T10:00:00Z',
  supplier: { id: 12, company_name: 'المورد أ', is_active: true, created_at: '2026-01-01', updated_at: '2026-01-01' },
  items: [
    {
      id: 501,
      purchase_order_id: 101,
      item_description: 'مصعد',
      item_reference: 'PARCEL-7',
      region: 'المنطقة السابعة',
      quantity: 1,
      uom: 'PCS',
      unit_price: unitPrice,
      line_total: unitPrice,
      supplier_id: 12,
    },
  ],
  ...extra,
} as unknown as PurchaseOrder);

const renderModal = () =>
  render(<FinalizeActualPoModal isOpen={true} poId={101} onClose={vi.fn()} onSuccess={vi.fn()} />);

describe('FinalizeActualPoModal — high value, files and consolidated orders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('above 500,000 asks for a reason and sends it with the Actual PO', async () => {
    vi.mocked(purchaseOrdersApi.getPurchaseOrderApi).mockResolvedValueOnce(makePo(750000));
    vi.mocked(purchaseOrdersApi.finalizeActualPurchaseOrderApi).mockResolvedValueOnce(makePo(750000, { status: 'ISSUED' }));

    renderModal();
    expect(await screen.findByTestId('high-value-warning')).toBeInTheDocument();

    fireEvent.click(screen.getByText(FINALIZE));
    await waitFor(() => expect(screen.getAllByText(/اكتب سبب الإصدار/).length).toBeGreaterThan(0));
    expect(purchaseOrdersApi.finalizeActualPurchaseOrderApi).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('سبب إصدار أمر شراء فعلي بقيمة مرتفعة'), { target: { value: 'مصعد ركاب للمبنى الإداري' } });
    fireEvent.click(screen.getByText(FINALIZE));

    await waitFor(() =>
      expect(purchaseOrdersApi.finalizeActualPurchaseOrderApi).toHaveBeenCalledWith(
        101,
        expect.objectContaining({ high_value_reason: 'مصعد ركاب للمبنى الإداري' })
      )
    );
  });

  it('at or below 500,000 shows no warning and sends no reason', async () => {
    vi.mocked(purchaseOrdersApi.getPurchaseOrderApi).mockResolvedValueOnce(makePo(500000));
    vi.mocked(purchaseOrdersApi.finalizeActualPurchaseOrderApi).mockResolvedValueOnce(makePo(500000, { status: 'ISSUED' }));

    renderModal();
    await screen.findByText(FINALIZE);
    expect(screen.queryByTestId('high-value-warning')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(FINALIZE));
    await waitFor(() =>
      expect(purchaseOrdersApi.finalizeActualPurchaseOrderApi).toHaveBeenCalledWith(101, expect.objectContaining({ high_value_reason: undefined }))
    );
  });

  it('opens the reason field when the server says a reason is required', async () => {
    vi.mocked(purchaseOrdersApi.getPurchaseOrderApi).mockResolvedValueOnce(makePo(499000, { tax_amount: 0 } as any));
    vi.mocked(purchaseOrdersApi.finalizeActualPurchaseOrderApi).mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 422, data: { code: 'HIGH_VALUE_REASON_REQUIRED', message: 'قيمة أمر الشراء الفعلي تتجاوز 500,000 جنيه.' } },
    });

    renderModal();
    await screen.findByText(FINALIZE);
    expect(screen.queryByTestId('high-value-warning')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(FINALIZE));
    expect(await screen.findByTestId('high-value-warning')).toBeInTheDocument();
  });

  it('sends several invoice files and lets one be removed before sending', async () => {
    vi.mocked(purchaseOrdersApi.getPurchaseOrderApi).mockResolvedValueOnce(makePo(1000));
    vi.mocked(purchaseOrdersApi.finalizeActualPurchaseOrderApi).mockResolvedValueOnce(makePo(1000, { status: 'ISSUED' }));

    renderModal();
    await screen.findByText(FINALIZE);

    const files = [
      new File(['a'], 'invoice.pdf', { type: 'application/pdf' }),
      new File(['b'], 'page-2.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'page-3.jpg', { type: 'image/jpeg' }),
    ];
    fireEvent.change(screen.getByTestId('invoice-files-input'), { target: { files } });
    expect(await screen.findByText(/تم اختيار 3 ملف/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('إزالة page-2.jpg'));
    fireEvent.click(screen.getByText(FINALIZE));

    await waitFor(() => expect(purchaseOrdersApi.finalizeActualPurchaseOrderApi).toHaveBeenCalled());
    const payload = vi.mocked(purchaseOrdersApi.finalizeActualPurchaseOrderApi).mock.calls[0][1];
    expect(payload.attachments?.map((f) => f.name)).toEqual(['invoice.pdf', 'page-3.jpg']);
  });

  it('locks the per-line supplier on a department-consolidated order and shows its sources', async () => {
    const po = makePo(1000, { is_department_consolidated: true } as any);
    (po.items as any)[0].sources = [
      { id: 1, purchase_request_id: 55, purchase_request_item_id: 1, source_quantity: '1', source_uom: 'PCS', line_quantity: '1', line_amount: '600', is_active: true },
      { id: 2, purchase_request_id: 55, purchase_request_item_id: 2, source_quantity: '1', source_uom: 'PCS', line_quantity: '1', line_amount: '400', is_active: true },
    ];
    vi.mocked(purchaseOrdersApi.getPurchaseOrderApi).mockResolvedValueOnce(po);

    renderModal();
    expect(await screen.findByTestId('consolidated-actual-po-note')).toHaveTextContent('مجمع من 2 بنود طلب');

    const lineSupplierSelects = screen.getAllByTitle('تحديد المورد الفعلي لهذا البند');
    expect(lineSupplierSelects.length).toBeGreaterThan(0);
    lineSupplierSelects.forEach((select) => expect(select).toBeDisabled());
  });
});
