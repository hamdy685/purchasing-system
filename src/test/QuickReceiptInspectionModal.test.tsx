import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuickReceiptInspectionModal } from '../components/receipts/QuickReceiptInspectionModal';
import { ActionInboxItem } from '../components/dashboard/ActionRequiredInbox';
import * as purchaseReceiptsApi from '../api/purchaseReceipts';

vi.mock('../api/purchaseReceipts', () => ({
  getPurchaseReceiptByIdApi: vi.fn(),
  approvePurchaseReceiptApi: vi.fn(),
  getReceiptPhotoUrl: vi.fn((receipt: any) => receipt?.photo_url || ''),
}));

describe('QuickReceiptInspectionModal Component', () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();

  const sampleItem: ActionInboxItem = {
    id: 'receipt-505',
    rawId: 505,
    receipt_id: 505,
    po_id: 88,
    type: 'RECEIPT',
    code: 'REC-505',
    title: 'إذن استلام مواد سيراميك',
    subtitle: 'لأمر الشراء PO-88',
    department: 'المكتب الفني',
    parcel_number: '550',
    region: 'الأندلس',
    supplier: 'شركة الخزف السعودي',
    urgency: 'CRITICAL',
    reason: 'تم استلام المواد بالمخزن وبانتظار معاينتك ومطابقتك الهندسية بالموقع',
    actionUrl: '/receipts/505/inspect',
    actionLabel: 'فحص واعتماد إذن الاستلام',
  };

  const sampleReceiptData: purchaseReceiptsApi.ReceiptRecord = {
    id: 505,
    receipt_number: 'REC-505',
    status: 'WAREHOUSE_RECEIPT_SUBMITTED',
    warehouse_notes: 'تم فحص الشحنة ظاهرياً وتطابق بون الميزان',
    photo_url: 'https://example.com/receipt-photo.jpg',
    supplier: {
      id: 12,
      company_name: 'شركة الخزف السعودي',
    },
    warehouse_keeper: {
      id: 5,
      name: 'عم سلامة (أمين المخزن)',
    },
    purchase_order: {
      id: 88,
      po_number: 'PO-88',
      purchase_request: {
        id: 10,
        request_number: 'PR-10',
        parcel_reference: '550',
        region: 'الأندلس',
        department: { id: 1, name: 'المكتب الفني' },
      },
    },
    items: [
      {
        id: 101,
        received_quantity: 15,
        ordered_quantity: 15,
        notes: null,
        purchase_order_item: {
          id: 77,
          item_description: 'كشافات طوارئ شحن ليد معتمدة لاشتراطات التراخيص',
          item_reference: 'قطاع هـ - قطعة 550',
          quantity: 15,
          uom: 'قطعة',
        },
      },
      {
        id: 102,
        received_quantity: 40,
        ordered_quantity: 50,
        notes: null,
        purchase_order_item: {
          id: 78,
          item_description: 'مفاتيح إنارة ثنائية معتمدة',
          item_reference: 'قطاع هـ - قطعة 550',
          quantity: 50,
          uom: 'حبة',
        },
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(purchaseReceiptsApi.getPurchaseReceiptByIdApi).mockResolvedValue(sampleReceiptData);
    vi.mocked(purchaseReceiptsApi.approvePurchaseReceiptApi).mockResolvedValue({
      id: 505,
      receipt_number: 'REC-505',
      status: 'SITE_ENGINEER_APPROVED',
    });
  });

  it('renders receipt details, parcel, supplier and items when opened', async () => {
    render(
      <QuickReceiptInspectionModal
        isOpen={true}
        item={sampleItem}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );

    // Header & metadata
    expect(await screen.findByText(/فحص واعتماد إذن الاستلام: REC-505/i)).toBeInTheDocument();
    expect(screen.getByText(/PO-88/i)).toBeInTheDocument();
    expect(screen.getByText('شركة الخزف السعودي · قطعة 550 · منطقة الأندلس')).toBeInTheDocument();

    // Warehouse notes
    expect(screen.getByText(/تم فحص الشحنة ظاهرياً وتطابق بون الميزان/)).toBeInTheDocument();

    // Items
    expect(screen.getByText('كشافات طوارئ شحن ليد معتمدة لاشتراطات التراخيص')).toBeInTheDocument();
    expect(screen.getByText('مفاتيح إنارة ثنائية معتمدة')).toBeInTheDocument();
  });

  it('allows user to modify confirmed quantity and submits correct payload to backend', async () => {
    render(
      <QuickReceiptInspectionModal
        isOpen={true}
        item={sampleItem}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );

    await screen.findByText('كشافات طوارئ شحن ليد معتمدة لاشتراطات التراخيص');

    // Change confirmed quantity for first item from 15 to 14
    const qtyInput1 = screen.getByDisplayValue('15');
    fireEvent.change(qtyInput1, { target: { value: '14' } });

    // Add general notes
    const generalNotesInput = screen.getByPlaceholderText('ملاحظات (اختياري)');
    fireEvent.change(generalNotesInput, { target: { value: 'تم فحص الكشافات والمطابقة تمت بنجاح مع استلام 14 كشاف فقط سليم' } });

    // Click confirm & submit button
    const submitBtn = screen.getByRole('button', { name: /اعتماد الاستلام/ });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(purchaseReceiptsApi.approvePurchaseReceiptApi).toHaveBeenCalledTimes(1);
    });

    expect(purchaseReceiptsApi.approvePurchaseReceiptApi).toHaveBeenCalledWith(505, {
      site_engineer_notes: 'تم فحص الكشافات والمطابقة تمت بنجاح مع استلام 14 كشاف فقط سليم',
      items: [
        { id: 101, received_quantity: 14, notes: undefined },
        { id: 102, received_quantity: 40, notes: undefined },
      ],
    });

    expect(mockOnSuccess).toHaveBeenCalledWith(505, 'REC-505');
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('validates quantities and blocks submission if negative or empty', async () => {
    render(
      <QuickReceiptInspectionModal
        isOpen={true}
        item={sampleItem}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );

    await screen.findByText('كشافات طوارئ شحن ليد معتمدة لاشتراطات التراخيص');

    const qtyInput1 = screen.getByDisplayValue('15');
    fireEvent.change(qtyInput1, { target: { value: '-2' } });

    const submitBtn = screen.getByRole('button', { name: /اعتماد الاستلام/ });
    fireEvent.click(submitBtn);

    expect(await screen.findByText(/قيمة الكمية غير صحيحة للبند/i)).toBeInTheDocument();
    expect(purchaseReceiptsApi.approvePurchaseReceiptApi).not.toHaveBeenCalled();
  });
});
