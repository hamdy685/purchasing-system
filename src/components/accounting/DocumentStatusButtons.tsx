import React from 'react';
import { Link } from 'react-router-dom';
import type { ApprovedReceipt, ReceiptPhotoStatus, SupplierInvoice } from '../../api/supplierFinance';
import { getReceiptPhotoUrl } from '../../api/purchaseReceipts';

/**
 * State of one document button. An active button opens exactly one destination:
 * an external stored file (`href`), an in-app route (`to`) or an in-page preview (`onOpen`).
 */
export interface DocumentButtonState {
  active: boolean;
  tooltip: string;
  href?: string | null;
  to?: string | null;
  onOpen?: () => void;
}

const invoicesArchiveUrl = (params: Record<string, string>) =>
  `/accounting/supplier-finance?${new URLSearchParams({ tab: 'payments', ...params }).toString()}`;

/** Opens the uploaded receipt photo itself: Drive/public URLs as-is, API paths with the auth token. */
const receiptPhotoHref = (photo: ReceiptPhotoStatus): string | null => {
  const url = photo.file_url;
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return getReceiptPhotoUrl({ id: photo.id, photo_url: url }) || null;
};

/** «إذن الاستلام» is active only when the photographed receipt (or steel scale ticket) is really stored. */
export const getReceiptPhotoButton = (photo?: ReceiptPhotoStatus | null): DocumentButtonState => {
  const href = photo?.has_file ? receiptPhotoHref(photo) : null;
  if (!photo || !href) {
    return { active: false, tooltip: 'لم تُرفع صورة إذن الاستلام (أو صورة وزن الحديد) لهذا السجل بعد' };
  }
  const what = photo.file_source === 'scale_ticket' ? 'صورة وزن الحديد (تذكرة الميزان)' : 'صورة إذن الاستلام';
  return {
    active: true,
    tooltip: `${what} المرفوعة عند الاستلام${photo.number ? ` للإذن ${photo.number}` : ''} — اضغط لفتحها`,
    href,
  };
};

/** Derives both document buttons for an accounting receipt from the server's `document_status`. */
export const getReceiptDocumentButtons = (
  receipt: ApprovedReceipt,
): { receipt: DocumentButtonState; invoice: DocumentButtonState } => {
  const status = receipt.document_status;
  const receiptState = getReceiptPhotoButton(status?.receipt);

  const invoice = status?.invoice;
  let invoiceState: DocumentButtonState = {
    active: false,
    tooltip: 'لم تُسجَّل أو تُرفق فاتورة مورد لهذا الإذن بعد',
  };
  if (invoice?.exists) {
    const singleNumber = invoice.count === 1 ? invoice.invoices[0]?.invoice_number : null;
    if (invoice.count >= 1 && !singleNumber && invoice.po_number) {
      invoiceState = {
        active: true,
        tooltip: `${invoice.count} فواتير مسجلة لهذا الإذن — اضغط لعرض قائمة فواتير أمر الشراء ${invoice.po_number}`,
        to: invoicesArchiveUrl({ invoice_po: invoice.po_number }),
      };
    } else if (singleNumber) {
      invoiceState = {
        active: true,
        tooltip: `فاتورة المورد ${singleNumber} مسجلة ومرتبطة بالإذن — اضغط لعرض تفاصيلها`,
        to: invoicesArchiveUrl({ invoice_number: String(singleNumber) }),
      };
    } else if (invoice.has_file && invoice.file_url) {
      invoiceState = {
        active: true,
        tooltip: 'ملف فاتورة المورد مرفق بأمر الشراء — اضغط لفتح الفاتورة',
        href: invoice.file_url,
      };
    }
  }

  return { receipt: receiptState, invoice: invoiceState };
};

/** Derives both document buttons for a registered supplier invoice (the invoice itself always exists). */
export const getInvoiceDocumentButtons = (
  invoice: SupplierInvoice,
): { receipt: DocumentButtonState; invoice: DocumentButtonState } => {
  return {
    receipt: invoice.purchase_receipt
      ? getReceiptPhotoButton(invoice.receipt_photo_status)
      : { active: false, tooltip: 'لا يوجد إذن استلام مرتبط بهذه الفاتورة' },
    invoice: {
      active: true,
      tooltip: `فاتورة المورد ${invoice.invoice_number} مسجلة — اضغط لعرض تفاصيلها`,
      to: invoicesArchiveUrl({ invoice_number: invoice.invoice_number }),
    },
  };
};

const baseClass =
  'inline-flex min-h-[32px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11px] font-black whitespace-nowrap transition-all';
const activeClass =
  'bg-emerald-950/60 border-emerald-500/60 text-emerald-200 hover:bg-emerald-900/70 hover:text-white cursor-pointer active:scale-95 shadow-sm shadow-emerald-950/40';
const inactiveClass = 'bg-slate-800/70 border-slate-700/70 text-slate-400 cursor-not-allowed select-none';

const DocumentButton: React.FC<{ label: string; icon: string; state: DocumentButtonState; testId: string }> = ({
  label,
  icon,
  state,
  testId,
}) => {
  const content = (
    <>
      <span aria-hidden="true" className={state.active ? '' : 'grayscale opacity-70'}>{icon}</span>
      <span>{label}</span>
      <span aria-hidden="true" className={`text-[9px] font-bold ${state.active ? 'text-emerald-300' : 'text-slate-500'}`}>
        {state.active ? '✓ متوفر' : 'غير متوفر'}
      </span>
    </>
  );
  const common = {
    title: state.tooltip,
    'aria-label': `${label}: ${state.tooltip}`,
    'data-testid': testId,
    'data-state': state.active ? 'active' : 'inactive',
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  if (state.active && state.href) {
    return (
      <a {...common} href={state.href} target="_blank" rel="noopener noreferrer" className={`${baseClass} ${activeClass}`}>
        {content}
      </a>
    );
  }
  if (state.active && state.to) {
    return (
      <Link {...common} to={state.to} className={`${baseClass} ${activeClass}`}>
        {content}
      </Link>
    );
  }
  if (state.active && state.onOpen) {
    return (
      <button
        {...common}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          state.onOpen?.();
        }}
        className={`${baseClass} ${activeClass}`}
      >
        {content}
      </button>
    );
  }

  // Inactive: focusable so the tooltip/label stays reachable, but it opens nothing.
  return (
    <button
      {...common}
      type="button"
      aria-disabled="true"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={`${baseClass} ${inactiveClass}`}
    >
      {content}
    </button>
  );
};

export const DocumentStatusButtons: React.FC<{
  receipt: DocumentButtonState;
  invoice: DocumentButtonState;
  className?: string;
}> = ({ receipt, invoice, className = '' }) => (
  <div dir="rtl" className={`flex items-stretch gap-2 ${className}`} data-testid="document-status-buttons">
    <DocumentButton label="إذن الاستلام" icon="📦" state={receipt} testId="doc-btn-receipt" />
    <DocumentButton label="الفاتورة" icon="🧾" state={invoice} testId="doc-btn-invoice" />
  </div>
);

export default DocumentStatusButtons;
