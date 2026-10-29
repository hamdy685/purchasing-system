import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CreatePurchaseOrderPage } from '../pages/procurement/CreatePurchaseOrderPage';
import * as procurementApi from '../api/procurement';
import * as purchaseOrdersApi from '../api/purchaseOrders';

vi.mock('../api/procurement', () => ({
  getApprovedPurchaseRequestApi: vi.fn(),
}));

vi.mock('../api/suppliers', () => ({
  getSuppliersApi: vi.fn().mockResolvedValue([
    { id: 1, company_name: 'المورد أ', is_active: true },
    { id: 2, company_name: 'المورد ب', is_active: true },
  ]),
}));

vi.mock('../api/purchaseOrders', () => ({
  createPurchaseOrderApi: vi.fn(),
  createBatchPurchaseOrdersApi: vi.fn(),
  submitPurchaseOrderApi: vi.fn(),
  createConsolidatedPurchaseOrdersApi: vi.fn(),
  previewConsolidatedPurchaseOrdersApi: vi.fn(),
}));

vi.mock('../components/procurement/DirectPoModal', () => ({ default: () => null }));
vi.mock('../components/supplements/ProcurementSupplementProcessModal', () => ({ ProcurementSupplementProcessModal: () => null }));
vi.mock('../components/procurement/CombinedPoPrPrintModal', () => ({ CombinedPoPrPrintModal: () => null }));
vi.mock('../components/common/ActionConfirmationModal', () => ({
  ActionConfirmationModal: ({ isOpen, onConfirm, confirmLabel }: { isOpen: boolean; onConfirm: () => void; confirmLabel: string }) =>
    isOpen ? <button onClick={onConfirm}>{confirmLabel}</button> : null,
}));

const item = (id: number, description: string, supplierId: number, qty: number, price: number) => ({
  id,
  item_id: null,
  supplier_id: supplierId,
  item_description: description,
  item_reference: 'PARCEL-1',
  region: 'المنطقة الأولى',
  quantity: String(qty),
  uom: 'PCS',
  estimated_unit_price: String(price),
  specifications: '',
});

const request = (consolidated: boolean) => ({
  id: 77,
  request_number: 'PR-77',
  status: 'APPROVED_BY_PROCUREMENT',
  consolidated_po_required: consolidated,
  items: [item(1, 'دهان', 1, 10, 100), item(2, 'معجون', 1, 5, 40), item(3, 'سيلر', 2, 3, 60)],
  purchase_orders: [],
  supplements: [],
});

const preview = [
  { supplier_id: 1, supplier_name: 'المورد أ', item_reference: 'PARCEL-1', region: 'المنطقة الأولى', subtotal: 1200,
    lines: [
      { item_description: 'دهان', quantity: 10, uom: 'PCS', unit_price: 100, line_total: 1000, source_pr_item_ids: [1] },
      { item_description: 'معجون', quantity: 5, uom: 'PCS', unit_price: 40, line_total: 200, source_pr_item_ids: [2] },
    ] },
  { supplier_id: 2, supplier_name: 'المورد ب', item_reference: 'PARCEL-1', region: 'المنطقة الأولى', subtotal: 180,
    lines: [{ item_description: 'سيلر', quantity: 3, uom: 'PCS', unit_price: 60, line_total: 180, source_pr_item_ids: [3] }] },
];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/procurement/purchase-orders/create?pr=77']}>
      <Routes>
        <Route path="/procurement/purchase-orders/create" element={<CreatePurchaseOrderPage />} />
        <Route path="/procurement" element={<div>procurement home</div>} />
      </Routes>
    </MemoryRouter>
  );

describe('CreatePurchaseOrderPage — mandatory department consolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the order-mode switch and shows one server-previewed order per supplier', async () => {
    vi.mocked(procurementApi.getApprovedPurchaseRequestApi).mockResolvedValue(request(true) as any);
    vi.mocked(purchaseOrdersApi.previewConsolidatedPurchaseOrdersApi).mockResolvedValue(preview as any);

    renderPage();

    expect(await screen.findByTestId('consolidated-po-badge')).toBeInTheDocument();
    expect(screen.queryByText('📦 أمر شراء مجمع للكل')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getAllByTestId('consolidated-po-card')).toHaveLength(2), { timeout: 3000 });
    const cards = screen.getAllByTestId('consolidated-po-card');
    expect(within(cards[0]).getByText(/المورد أ/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/المورد ب/)).toBeInTheDocument();
    expect(screen.getByText(/إجمالي: 2 أمر شراء مجمع/)).toBeInTheDocument();

    const payload = vi.mocked(purchaseOrdersApi.previewConsolidatedPurchaseOrdersApi).mock.calls.at(-1)![0];
    expect(payload.purchase_request_id).toBe(77);
    expect(payload.groups?.flatMap((g) => g.items.map((i) => i.pr_item_id)).sort()).toEqual([1, 2, 3]);
  });

  it('issues through the consolidation API with one idempotency key and lists every order number', async () => {
    vi.mocked(procurementApi.getApprovedPurchaseRequestApi).mockResolvedValue(request(true) as any);
    vi.mocked(purchaseOrdersApi.previewConsolidatedPurchaseOrdersApi).mockResolvedValue(preview as any);
    vi.mocked(purchaseOrdersApi.createConsolidatedPurchaseOrdersApi).mockResolvedValue({
      orders: [{ id: 1, po_number: 'PO-2026-0001' }, { id: 2, po_number: 'PO-2026-0002' }] as any,
      replayed: false,
      message: 'ok',
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('consolidated-po-card')).toHaveLength(2), { timeout: 3000 });

    fireEvent.click(screen.getByText(/إصدار وإرسال \(2\) أمر شراء مجمع للاستلام/));
    fireEvent.click(await screen.findByText(/حسناً، إصدار \(2\) أمر شراء مجمع/));

    await waitFor(() => expect(purchaseOrdersApi.createConsolidatedPurchaseOrdersApi).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(purchaseOrdersApi.createConsolidatedPurchaseOrdersApi).mock.calls[0][0];
    expect(payload.idempotency_key).toMatch(/^[A-Za-z0-9-]{8,48}$/);
    expect(payload.groups).toHaveLength(3);
    expect(purchaseOrdersApi.createBatchPurchaseOrdersApi).not.toHaveBeenCalled();
    expect(purchaseOrdersApi.createPurchaseOrderApi).not.toHaveBeenCalled();
    expect(await screen.findByText('procurement home')).toBeInTheDocument();
  });

  it('blocks issuing while the server preview reports a problem', async () => {
    vi.mocked(procurementApi.getApprovedPurchaseRequestApi).mockResolvedValue(request(true) as any);
    vi.mocked(purchaseOrdersApi.previewConsolidatedPurchaseOrdersApi).mockRejectedValue({
      isAxiosError: true,
      response: { status: 422, data: { message: 'بنود وزنة الحديد أو الشحنة المشتركة يجب أن تكون لنفس المورد ونفس قطعة الأرض والمنطقة.' } },
    });

    renderPage();

    expect(await screen.findByText(/يجب أن تكون لنفس المورد/, {}, { timeout: 3000 })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /إصدار وإرسال/ });
    expect(submit).toBeDisabled();
    expect(purchaseOrdersApi.createConsolidatedPurchaseOrdersApi).not.toHaveBeenCalled();
  });

  it('keeps today\'s screen for other departments (no preview, mode switch shown)', async () => {
    vi.mocked(procurementApi.getApprovedPurchaseRequestApi).mockResolvedValue(request(false) as any);

    renderPage();

    expect(await screen.findByText('📦 أمر شراء مجمع للكل')).toBeInTheDocument();
    expect(screen.queryByTestId('consolidated-po-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('consolidated-po-preview')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 500));
    expect(purchaseOrdersApi.previewConsolidatedPurchaseOrdersApi).not.toHaveBeenCalled();
  });
});
