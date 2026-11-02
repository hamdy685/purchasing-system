import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PurchaseReceiptPage } from '../pages/receipts/PurchaseReceiptPage';
import * as purchaseReceiptsApi from '../api/purchaseReceipts';
import * as authContext from '../context/AuthContext';

vi.mock('../api/purchaseReceipts', () => ({
  getWarehouseReceiptQueueApi: vi.fn(),
  getAssignedReceiptsApi: vi.fn(),
  getPurchaseReceiptArchiveApi: vi.fn(),
  getPurchaseReceiptByIdApi: vi.fn(),
  approvePurchaseReceiptApi: vi.fn(),
  createPurchaseReceiptApi: vi.fn(),
  cancelPurchaseReceiptApi: vi.fn(),
  updatePurchaseReceiptApi: vi.fn(),
  getReceiptPhotoUrl: vi.fn(() => ''),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

describe('PurchaseReceiptPage Role Isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders untouched warehouse keeper interface when mode is warehouse', async () => {
    vi.mocked(authContext.useAuth).mockReturnValue({
      user: { id: 5, name: 'عم سلامة', role: 'warehouse_keeper' } as any,
      hasRole: (role: string) => role === 'warehouse_keeper',
      token: 'mock-token',
      login: vi.fn(),
      logout: vi.fn(),
      loading: false,
    } as any);

    vi.mocked(purchaseReceiptsApi.getWarehouseReceiptQueueApi).mockResolvedValue([
      {
        id: 10,
        po_number: 'PO-W-10',
        items: [
          {
            id: 1,
            item_description: 'حديد تسليح 16 مم',
            quantity: 10,
            uom: 'طن',
          },
        ],
      } as any,
    ]);
    vi.mocked(purchaseReceiptsApi.getPurchaseReceiptArchiveApi).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <PurchaseReceiptPage mode="warehouse" />
      </MemoryRouter>
    );

    // Warehouse keeper specific UI elements
    expect(await screen.findByText('#PO-W-10')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('الكمية المستلمة')).toBeInTheDocument();
  });

  it('renders simple item cards when mode is site for site engineer or employee', async () => {
    vi.mocked(authContext.useAuth).mockReturnValue({
      user: { id: 7, name: 'م. أحمد مهندس الموقع', role: 'site_engineer' } as any,
      hasRole: (role: string) => role === 'site_engineer',
      token: 'mock-token',
      login: vi.fn(),
      logout: vi.fn(),
      loading: false,
    } as any);

    vi.mocked(purchaseReceiptsApi.getAssignedReceiptsApi).mockResolvedValue([
      {
        id: 50,
        receipt_number: 'REC-SITE-50',
        status: 'PENDING_SITE_ENGINEER',
        purchase_order: {
          id: 20,
          po_number: 'PO-20',
          purchase_request: {
            parcel_reference: 'قطعة 88',
            region: 'الأندلس',
          },
        },
        items: [
          {
            id: 101,
            received_quantity: 6,
            ordered_quantity: 6,
            purchase_order_item: {
              id: 701,
              item_description: 'خرسانة جاهزة للقواعد المسلحة',
              quantity: 6,
              uom: 'م³',
            },
          },
        ],
      } as any,
    ]);
    vi.mocked(purchaseReceiptsApi.getPurchaseReceiptArchiveApi).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <PurchaseReceiptPage mode="site" />
      </MemoryRouter>
    );

    // Site engineer sees one simple card per item
    expect((await screen.findAllByText('REC-SITE-50')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByPlaceholderText('الكمية المعتمدة')).toBeInTheDocument();
    expect(screen.getAllByText('خرسانة جاهزة للقواعد المسلحة').length).toBeGreaterThanOrEqual(1);

    // The quantity input is present and bound
    const qtyInput = screen.getByDisplayValue('6');
    expect(qtyInput).toBeInTheDocument();
    expect(qtyInput).toHaveAttribute('id', 'site-qty-receipt-50-101');
  });
});
