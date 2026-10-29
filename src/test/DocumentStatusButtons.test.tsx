import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import { ActionRequiredInbox, ActionInboxItem } from '../components/dashboard/ActionRequiredInbox';
import {
  DocumentStatusButtons,
  getInvoiceDocumentButtons,
  getReceiptDocumentButtons,
} from '../components/accounting/DocumentStatusButtons';
import type { ApprovedReceipt, ReceiptDocumentStatus, SupplierInvoice } from '../api/supplierFinance';
import * as authStorage from '../utils/authStorage';
import * as authApi from '../api/auth';

const makeStatus = (invoice: Partial<ReceiptDocumentStatus['invoice']> = {}, receiptExists = true): ReceiptDocumentStatus => ({
  receipt: { exists: receiptExists, id: 59, number: 'REC-SITE-59', has_file: false },
  invoice: { exists: false, has_file: false, file_url: null, po_number: 'PO-77', count: 0, invoices: [], ...invoice },
});

const makeReceipt = (status?: ReceiptDocumentStatus): ApprovedReceipt => ({
  id: 59,
  receipt_number: 'REC-SITE-59',
  status: 'APPROVED',
  purchase_order_id: 77,
  document_status: status,
});

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
};

const renderButtons = (ui: React.ReactElement) =>
  render(
    <MemoryRouter initialEntries={['/accounting']}>
      <Routes>
        <Route path="*" element={<>{ui}<LocationProbe /></>} />
      </Routes>
    </MemoryRouter>
  );

const receiptBtn = () => screen.getByTestId('doc-btn-receipt');
const invoiceBtn = () => screen.getByTestId('doc-btn-invoice');

describe('DocumentStatusButtons («إذن الاستلام» / «الفاتورة»)', () => {
  it('receipt present → active receipt button that opens the receipt preview', () => {
    const onOpen = vi.fn();
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(makeStatus()), onOpen)} />);

    expect(receiptBtn()).toHaveAttribute('data-state', 'active');
    expect(receiptBtn()).toHaveTextContent('إذن الاستلام');
    expect(receiptBtn().getAttribute('title')).toContain('REC-SITE-59');
    fireEvent.click(receiptBtn());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('receipt absent → inactive receipt button that opens nothing', () => {
    const onOpen = vi.fn();
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(makeStatus({}, false)), onOpen)} />);

    expect(receiptBtn()).toHaveAttribute('data-state', 'inactive');
    expect(receiptBtn()).toHaveAttribute('aria-disabled', 'true');
    expect(receiptBtn()).toHaveTextContent('إذن الاستلام');
    expect(receiptBtn().getAttribute('title')).toContain('لا يوجد إذن استلام');
    fireEvent.click(receiptBtn());
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/accounting');
  });

  it('invoice absent → inactive invoice button: no link and no navigation', () => {
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(makeStatus()), vi.fn())} />);

    expect(invoiceBtn()).toHaveAttribute('data-state', 'inactive');
    expect(invoiceBtn().tagName).toBe('BUTTON');
    expect(invoiceBtn()).not.toHaveAttribute('href');
    expect(invoiceBtn()).toHaveTextContent('الفاتورة');
    fireEvent.click(invoiceBtn());
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/accounting$/);
  });

  it('missing document_status (no proof) → invoice stays inactive', () => {
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(undefined), vi.fn())} />);
    expect(invoiceBtn()).toHaveAttribute('data-state', 'inactive');
    expect(receiptBtn()).toHaveAttribute('data-state', 'inactive');
  });

  it('invoice file stored → active invoice link opening the stored file in a new tab', () => {
    const status = makeStatus({ exists: true, has_file: true, file_url: 'https://drive.google.com/file/d/AbC/view' });
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(status), vi.fn())} />);

    expect(invoiceBtn()).toHaveAttribute('data-state', 'active');
    expect(invoiceBtn()).toHaveAttribute('href', 'https://drive.google.com/file/d/AbC/view');
    expect(invoiceBtn()).toHaveAttribute('target', '_blank');
    expect(invoiceBtn()).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('one registered invoice → opens that invoice in the invoices archive', () => {
    const status = makeStatus({ exists: true, count: 1, invoices: [{ id: 5, invoice_number: 'INV-900' }] });
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(status), vi.fn())} />);

    fireEvent.click(invoiceBtn());
    expect(screen.getByTestId('location')).toHaveTextContent('/accounting/supplier-finance?tab=payments&invoice_number=INV-900');
  });

  it('multiple registered invoices → opens the filtered list, not an arbitrary one', () => {
    const status = makeStatus({
      exists: true,
      count: 2,
      invoices: [{ id: 5, invoice_number: 'INV-1' }, { id: 6, invoice_number: 'INV-2' }],
    });
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(status), vi.fn())} />);

    expect(invoiceBtn().getAttribute('title')).toContain('2 فواتير');
    fireEvent.click(invoiceBtn());
    expect(screen.getByTestId('location')).toHaveTextContent('/accounting/supplier-finance?tab=payments&invoice_po=PO-77');
  });

  it('receipt present without invoice → two independent states', () => {
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(makeStatus()), vi.fn())} />);
    expect(receiptBtn()).toHaveAttribute('data-state', 'active');
    expect(invoiceBtn()).toHaveAttribute('data-state', 'inactive');
  });

  it('invoice card without linked receipt → invoice active, receipt inactive', () => {
    const invoice = { id: 8, invoice_number: 'INV-8', purchase_receipt: null } as unknown as SupplierInvoice;
    renderButtons(<DocumentStatusButtons {...getInvoiceDocumentButtons(invoice)} />);

    expect(invoiceBtn()).toHaveAttribute('data-state', 'active');
    expect(receiptBtn()).toHaveAttribute('data-state', 'inactive');
    fireEvent.click(receiptBtn());
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/accounting$/);
  });

  it('invoice card with linked receipt → receipt opens the existing receipt preview route', () => {
    const invoice = { id: 8, invoice_number: 'INV-8', purchase_receipt: { id: 61, receipt_number: 'REC-SITE-61' } } as unknown as SupplierInvoice;
    renderButtons(<DocumentStatusButtons {...getInvoiceDocumentButtons(invoice)} />);

    fireEvent.click(receiptBtn());
    expect(screen.getByTestId('location')).toHaveTextContent('/accounting/supplier-finance?tab=payments&purchase_receipt_id=61');
  });

  it('layout is RTL and wraps safely on small screens (buttons share the row, text never hidden)', () => {
    renderButtons(<DocumentStatusButtons {...getReceiptDocumentButtons(makeReceipt(makeStatus()), vi.fn())} />);
    const row = screen.getByTestId('document-status-buttons');
    expect(row).toHaveAttribute('dir', 'rtl');
    expect(row.className).toContain('flex');
    for (const btn of [receiptBtn(), invoiceBtn()]) {
      expect(btn.className).toContain('flex-1');
      expect(btn.className).toContain('min-w-0');
      expect(btn.className).toContain('min-h-[32px]');
    }
  });
});

describe('ActionRequiredInbox urgent cards with document buttons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authStorage, 'getToken').mockReturnValue('mock-token');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue({
      id: 3,
      name: 'المهندسة حبيبة',
      email: 'habiba@example.com',
      is_active: true,
      roles: ['site_accountant'],
      permissions: ['accounting.invoice.view', 'accounting.invoice.create'],
      department: { id: 1, name: 'الحسابات', code: 'ACC' },
    } as any);
  });

  it('renders both buttons inside the card while keeping the existing actions', () => {
    const onPreview = vi.fn();
    const receipt = makeReceipt(makeStatus());
    const item: ActionInboxItem = {
      id: 'rcpt-59',
      rawId: 59,
      type: 'RECEIPT',
      code: 'REC-SITE-59',
      title: 'أمر شراء فعلي معتمد بانتظار التسجيل',
      urgency: 'HIGH',
      reason: 'تم اعتماد إذن الاستلام في الموقع',
      actionUrl: '/accounting/supplier-finance?tab=payments&purchase_receipt_id=59',
      actionLabel: 'تسجيل الفاتورة',
      onAction: vi.fn(),
      onDirectApprove: vi.fn(),
      directApproveLabel: 'تم التسجيل',
      onPreviewReceipt: onPreview,
      documentSlot: <DocumentStatusButtons {...getReceiptDocumentButtons(receipt, onPreview)} />,
    };

    render(
      <MemoryRouter>
        <AuthProvider>
          <ActionRequiredInbox title="المهام والإجراءات العاجلة" items={[item]} />
        </AuthProvider>
      </MemoryRouter>
    );

    const row = screen.getByTestId('document-status-buttons');
    expect(within(row).getByTestId('doc-btn-receipt')).toHaveAttribute('data-state', 'active');
    expect(within(row).getByTestId('doc-btn-invoice')).toHaveAttribute('data-state', 'inactive');
    expect(screen.getByText('تسجيل الفاتورة')).toBeInTheDocument();
    expect(screen.getByText('معاينة الإذن')).toBeInTheDocument();
    expect(screen.getByText('تم التسجيل')).toBeInTheDocument();

    fireEvent.click(within(row).getByTestId('doc-btn-receipt'));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
});
