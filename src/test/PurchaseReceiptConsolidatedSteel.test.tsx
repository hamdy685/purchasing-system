import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const consolidatedOrder = {
  id: 10,
  po_number: 'PO-STEEL-10',
  items: [
    { id: 1, item_description: 'حديد', quantity: 71, uom: 'TON', is_consolidated_steel: true },
    { id: 2, item_description: 'أسمنت بورتلاندي', quantity: 100, uom: 'BAG' },
  ],
  weighing_groups: [
    {
      id: 9,
      group_number: 'WG-9',
      status: 'PENDING_RECEIPT',
      total_ordered_weight: 71,
      unit_price: 38140.85,
      items: [{ id: 90, purchase_order_item_id: 1, item_description: 'حديد', size_or_diameter: 'أقطار مجمعة', ordered_weight: 71 }],
    },
  ],
};

const renderWarehouse = async () => {
  vi.mocked(purchaseReceiptsApi.getWarehouseReceiptQueueApi).mockResolvedValue([consolidatedOrder as any]);
  vi.mocked(purchaseReceiptsApi.getPurchaseReceiptArchiveApi).mockResolvedValue([]);
  vi.mocked(purchaseReceiptsApi.createPurchaseReceiptApi).mockResolvedValue({ id: 500 } as any);

  const view = render(
    <MemoryRouter>
      <PurchaseReceiptPage mode="warehouse" />
    </MemoryRouter>
  );
  await screen.findByTestId('steel-ticket-card');
  return view;
};

const submit = () => {
  fireEvent.click(screen.getByText(/تأكيد واعتماد الاستلام النهائي للموقع/));
};

describe('PurchaseReceiptPage - consolidated "حديد" weighing ticket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authContext.useAuth).mockReturnValue({
      user: { id: 5, name: 'عم سلامة', role: 'warehouse_keeper' } as any,
      hasRole: (role: string) => role === 'warehouse_keeper',
      token: 'mock-token',
      login: vi.fn(),
      logout: vi.fn(),
      loading: false,
    } as any);
  });

  it('asks for the steel quantity once on the "حديد" line and keeps the scale weight separate and optional', async () => {
    const { container } = await renderWarehouse();

    // One quantity input for steel, one for cement; no per-diameter inputs.
    expect(container.querySelector('#qty-10-1')).not.toBeNull();
    expect(container.querySelector('#qty-10-2')).not.toBeNull();
    expect(container.querySelectorAll('input[id^="qty-10-"]')).toHaveLength(2);

    const netInput = screen.getByLabelText('الوزن الصافي من كارتة البسكول') as HTMLInputElement;
    expect(netInput.value).toBe('');

    fireEvent.change(container.querySelector('#qty-10-1')!, { target: { value: '70.5' } });
    fireEvent.change(container.querySelector('#qty-10-2')!, { target: { value: '100' } });
    fireEvent.change(netInput, { target: { value: '70.8' } });
    submit();

    await waitFor(() => expect(purchaseReceiptsApi.createPurchaseReceiptApi).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(purchaseReceiptsApi.createPurchaseReceiptApi).mock.calls[0][1] as any;
    expect(payload.weighing_group_id).toBe(9);
    expect(payload.scale_ticket_weight).toBe(70.8);
    expect(payload.items).toEqual([
      expect.objectContaining({ purchase_order_item_id: 1, received_quantity: 70.5 }),
      expect.objectContaining({ purchase_order_item_id: 2, received_quantity: 100 }),
    ]);
  });

  it('sends an over-receipt as entered and no scale weight when the ticket field is empty', async () => {
    const { container } = await renderWarehouse();

    fireEvent.change(container.querySelector('#qty-10-1')!, { target: { value: '75' } });
    fireEvent.change(container.querySelector('#qty-10-2')!, { target: { value: '120' } });
    submit();

    await waitFor(() => expect(purchaseReceiptsApi.createPurchaseReceiptApi).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(purchaseReceiptsApi.createPurchaseReceiptApi).mock.calls[0][1] as any;
    expect(payload.scale_ticket_weight).toBeUndefined();
    expect(payload.items.map((i: any) => i.received_quantity)).toEqual([75, 120]);
  });
});
