import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminForceEditModal } from '../components/admin/AdminForceEditModal';
import * as masterOrdersApi from '../api/admin/masterOrders';

vi.mock('../api/admin/masterOrders', () => ({
  getOrderMasterDetailsApi: vi.fn(),
  getRequestStageApi: vi.fn(),
  forceUpdateOrderApi: vi.fn(),
  moveRequestStageApi: vi.fn(),
}));

const stageOptions = [
  { value: 'REQUESTER', label: 'مقدم الطلب (للتعديل)', available: true, reason: null, current: false },
  { value: 'REVIEWER', label: 'المراجع', available: true, reason: null, current: false },
  { value: 'ACCOUNTING', label: 'الحسابات', available: false, reason: 'مرحلة الحسابات للطلبات المباشرة فقط.', current: false },
  { value: 'WAREHOUSE_RECEIPT', label: 'استلام المخزن', available: false, reason: 'المرحلة الحالية للطلب.', current: true },
];

describe('AdminForceEditModal', () => {
  const mockOrderMasterDetails = {
    success: true,
    data: {
      order: {
        id: 77,
        po_number: 'PO-2026-00077',
        status: 'ISSUED',
        supplier_id: 10,
        delivery_date: '2026-10-25',
        actual_delivery_date: '2026-10-26',
        items: [
          { id: 201, item_description: 'طوب أحمر مفرغ', item_reference: '142', region: 'A1', quantity: 12, uom: 'BRICKS', unit_price: 2450, supplier_id: 10 },
          { id: 202, item_description: 'حديد 4 لنيه', item_reference: '142', region: 'A1', quantity: 0, uom: 'TON', unit_price: 43000, supplier_id: 10 },
        ],
      },
      request: { id: 5, request_number: 'PR-160' },
      available_suppliers: [
        { id: 10, company_name: 'شركة التوريدات الأولى (أ)', name: 'المورد أ' },
        { id: 30, company_name: 'مؤسسة أسمنت المعلم (ج)', name: 'المورد ج' },
      ],
      current_stage: { value: 'WAREHOUSE_RECEIPT', label: 'استلام المخزن' },
      stage_options: stageOptions,
      audit_logs: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(masterOrdersApi.getOrderMasterDetailsApi).mockResolvedValue(mockOrderMasterDetails as any);
    vi.mocked(masterOrdersApi.forceUpdateOrderApi).mockResolvedValue({ success: true, message: 'تم الحفظ', data: {} });
    vi.mocked(masterOrdersApi.moveRequestStageApi).mockResolvedValue({ success: true, message: 'تم النقل', data: {} });
  });

  const renderOrder = () =>
    render(<AdminForceEditModal orderId={77} isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />);

  const fillReasonAndSave = (reason: string) => {
    fireEvent.change(screen.getByLabelText(/سبب التعديل/), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
  };

  it('shows items as cards with plain Arabic labels and no status jargon', async () => {
    renderOrder();
    await waitFor(() => expect(screen.getByDisplayValue('طوب أحمر مفرغ')).toBeInTheDocument());

    expect(screen.getAllByTestId('admin-item-card')).toHaveLength(2);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('تعديل الطلب')).toBeInTheDocument();
    expect(screen.getByText('استلام المخزن', { selector: 'strong' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Status Guards|Override|ISSUED|تنبيه إداري/);
  });

  it('saves zero-quantity lines and sends no PO status fields', async () => {
    renderOrder();
    await waitFor(() => expect(screen.getByDisplayValue('حديد 4 لنيه')).toBeInTheDocument());

    fillReasonAndSave('تعديل موردي البنود');

    await waitFor(() => expect(masterOrdersApi.forceUpdateOrderApi).toHaveBeenCalled());
    const [id, payload] = vi.mocked(masterOrdersApi.forceUpdateOrderApi).mock.calls[0];
    expect(id).toBe(77);
    expect(payload).toMatchObject({ admin_reason: 'تعديل موردي البنود', request_stage: null });
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('is_actual_po');
    expect(payload.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 202, quantity: 0, supplier_id: 10 })])
    );
  });

  it('applies the order supplier to every item', async () => {
    renderOrder();
    await waitFor(() => expect(screen.getByDisplayValue('طوب أحمر مفرغ')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('المورد'), { target: { value: '30' } });
    fireEvent.click(screen.getByText('تطبيق على كل البنود'));
    fillReasonAndSave('تطبيق مورد الأسمنت على الجميع');

    await waitFor(() =>
      expect(masterOrdersApi.forceUpdateOrderApi).toHaveBeenCalledWith(
        77,
        expect.objectContaining({
          supplier_id: 30,
          items: expect.arrayContaining([
            expect.objectContaining({ id: 201, supplier_id: 30 }),
            expect.objectContaining({ id: 202, supplier_id: 30 }),
          ]),
        })
      )
    );
  });

  it('offers request stages, disables unavailable ones and sends the chosen stage', async () => {
    renderOrder();
    await waitFor(() => expect(screen.getByDisplayValue('طوب أحمر مفرغ')).toBeInTheDocument());

    const stageSelect = screen.getByLabelText('نقل الطلب إلى') as HTMLSelectElement;
    const optionValues = Array.from(stageSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(['', 'REQUESTER', 'REVIEWER', 'ACCOUNTING']);
    const accounting = Array.from(stageSelect.options).find((o) => o.value === 'ACCOUNTING')!;
    expect(accounting.disabled).toBe(true);
    expect(accounting.textContent).toContain('للطلبات المباشرة فقط');

    fireEvent.change(stageSelect, { target: { value: 'REVIEWER' } });
    expect(screen.getByText(/سيُلغى أمر الشراء PO-2026-00077/)).toBeInTheDocument();
    fillReasonAndSave('إعادة للمراجع');

    await waitFor(() =>
      expect(masterOrdersApi.forceUpdateOrderApi).toHaveBeenCalledWith(
        77,
        expect.objectContaining({ request_stage: 'REVIEWER' })
      )
    );
  });

  it('shows the server message and marks the item it names', async () => {
    vi.mocked(masterOrdersApi.forceUpdateOrderApi).mockRejectedValue({
      isAxiosError: true,
      config: { url: '/admin/orders/77/force-update' },
      response: {
        status: 422,
        data: {
          message: 'البند 2 (حديد 4 لنيه) — الكمية لا يمكن أن يكون أقل من 0.',
          errors: { 'items.1.quantity': ['البند 2 (حديد 4 لنيه) — الكمية لا يمكن أن يكون أقل من 0.'] },
        },
      },
    });
    renderOrder();
    await waitFor(() => expect(screen.getByDisplayValue('حديد 4 لنيه')).toBeInTheDocument());

    fillReasonAndSave('اختبار');

    await waitFor(() => expect(screen.getAllByText(/البند 2 \(حديد 4 لنيه\) — الكمية/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/راجع الحقول المعلّمة/)).not.toBeInTheDocument();
    const cards = screen.getAllByTestId('admin-item-card');
    expect(cards[1].className).toContain('border-rose-500');
    expect((screen.getByLabelText('كمية البند 2') as HTMLInputElement).className).toContain('border-rose-500');
  });

  it('moves a request that has no purchase order', async () => {
    vi.mocked(masterOrdersApi.getRequestStageApi).mockResolvedValue({
      success: true,
      data: {
        request: { id: 9, request_number: 'PR-200', status: 'CANCELLED' },
        current_stage: { value: 'CANCELLED', label: 'ملغي' },
        stage_options: [
          { value: 'REVIEWER', label: 'المراجع', available: true, reason: null, current: false },
          { value: 'CANCELLED', label: 'ملغي', available: false, reason: 'المرحلة الحالية للطلب.', current: true },
        ],
        audit_logs: [],
      },
    } as any);

    render(<AdminForceEditModal requestId={9} isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('PR-200')).toBeInTheDocument());

    expect(screen.queryByText('البنود')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('نقل الطلب إلى'), { target: { value: 'REVIEWER' } });
    fillReasonAndSave('استعادة الطلب الملغي');

    await waitFor(() =>
      expect(masterOrdersApi.moveRequestStageApi).toHaveBeenCalledWith(9, {
        request_stage: 'REVIEWER',
        admin_reason: 'استعادة الطلب الملغي',
      })
    );
  });
});
