import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import {
  getPurchasesReportApi,
  PurchasesReportResponse,
  PurchasesReportRow,
} from '../../api/reports';
import {
  createSupplierInvoiceApi,
  getLandParcelsApi,
  LandParcel,
} from '../../api/supplierFinance';
import { LandAllocationEditor, LandAllocationDraft } from '../../components/accounting/LandAllocationEditor';
import { getReceiptPhotoUrl, getReceiptAttachmentApi, ReceiptAttachmentInfo } from '../../api/purchaseReceipts';
import { getTodayInputDate } from '../../utils/dateFilters';
import { parseApiError } from '../../utils/apiError';
import { getUnitLabel } from '../../utils/units';
import { printDocumentOnly } from '../../utils/print';
import { useDebounce } from '../../hooks/useDebounce';
import {
  ArabicDatePicker,
  ArabicMonthPicker,
  formatDateDMY,
  clampDateToValidMonthDay,
} from '../../components/common/ArabicDatePicker';

export type ColumnFilters = Record<string, string>;

const initialFilters: ColumnFilters = {
  delivery_date: '',
  po_number: '',
  item_name: '',
  uom: '',
  quantity: '',
  unit_price: '',
  total_price: '',
  supplier_name: '',
  parcel_reference: '',
  region: '',
  department_name: '',
  works: '',
  invoice_status: '',
};

// Clean number formatting without any RTL reversing bugs or minus signs
const formatCleanNumber = (val: number | string | null | undefined, maxDecimals = 4) => {
  const num = Math.abs(Number(val || 0));
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
};

const formatCleanQty = (val: number | string | null | undefined) => {
  const num = Math.abs(Number(val || 0));
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
};

export const PurchasesReportView: React.FC = () => {
  const { hasRole } = useAuth();
  const isManagerOrExecutive = hasRole('procurement_manager') || hasRole('general_manager') || hasRole('execution_manager');
  const canRegisterInvoice = !isManagerOrExecutive && (hasRole('general_accountant') || hasRole('site_accountant') || hasRole('licenses_accountant') || hasRole('buffet_accountant') || hasRole('development_accountant') || hasRole('admin'));

  const isRowActionAllowed = (row: PurchasesReportRow) => {
    if (!canRegisterInvoice) return false;
    if (hasRole('admin') || hasRole('general_accountant')) return true;
    if (hasRole('development_accountant')) {
      return (
        row.department_code === 'DEVELOPMENT' ||
        row.department_code === 'MARKETING' ||
        row.department_code === 'SALES' ||
        (row.department_name && (row.department_name.includes('تطوير') || row.department_name.includes('تسويق') || row.department_name.includes('مبيعات')))
      );
    }
    if (hasRole('licenses_accountant')) {
      return row.department_code === 'LICENSES' || (row.department_name && row.department_name.includes('تراخيص'));
    }
    if (hasRole('buffet_accountant')) {
      return row.department_code === 'BUFFET' || row.department_code === 'OFFICE' || (row.department_name && (row.department_name.includes('مكتبيات') || row.department_name.includes('بوفيه')));
    }
    if (hasRole('site_accountant')) {
      return ['EXECUTION', 'FINISHING', 'BUILDINGS', 'SITE'].includes(row.department_code || '');
    }
    return false;
  };

  // Period filter states
  const [filterType, setFilterType] = useState<'daily' | 'monthly' | 'custom'>('monthly');
  const [dateBasis, setDateBasis] = useState<'po_date' | 'delivery_date' | 'pr_date'>('po_date');
  const [actualOnly, setActualOnly] = useState<boolean>(true); // أوامر الشراء الفعلية فقط (الافتراضي نعم)
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(() => clampDateToValidMonthDay(getTodayInputDate()));
  const [fromDate, setFromDate] = useState(() => clampDateToValidMonthDay(getTodayInputDate()));
  const [toDate, setToDate] = useState(() => clampDateToValidMonthDay(getTodayInputDate()));
  const [selectedDepartment, setSelectedDepartment] = useState<string>('ALL');
  const [accountingFilter, setAccountingFilter] = useState<'ALL' | 'VERIFIED_ONLY' | 'PENDING'>('ALL');

  // Column search filters with Debounce (400ms) for high performance
  const [colFilters, setColFilters] = useState<Record<string, string>>(initialFilters);
  const debouncedColFilters = useDebounce<Record<string, string>>(colFilters, 400);
  const [showColumnFilters, setShowColumnFilters] = useState<boolean>(true);
  // Phones: line cards by default (the 14-column sheet is ~1750px wide); filters folded into one line.
  const [mobileView, setMobileView] = useState<'cards' | 'sheet'>('cards');
  const [showMobileFilters, setShowMobileFilters] = useState<boolean>(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  // Data state
  const [data, setData] = useState<PurchasesReportResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);

  // Active cell selection indicator (Excel aesthetic)
  const [selectedCell, setSelectedCell] = useState<string | null>(null);

  // Land parcels for allocation
  const [parcels, setParcels] = useState<LandParcel[]>([]);

  // Invoice Registration Modal State (Unified In-Page Registration)
  const [selectedRowForInvoice, setSelectedRowForInvoice] = useState<PurchasesReportRow | null>(null);
  const [invoiceForm, setInvoiceForm] = useState<{
    invoice_number: string;
    amount: string;
    invoice_date: string;
    due_date: string;
    notes: string;
  }>({
    invoice_number: '',
    amount: '',
    invoice_date: getTodayInputDate(),
    due_date: '',
    notes: '',
  });
  const [allocations, setAllocations] = useState<LandAllocationDraft[]>([]);
  const [submittingInvoice, setSubmittingInvoice] = useState<boolean>(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [invoiceSuccessNotice, setInvoiceSuccessNotice] = useState<string | null>(null);
  const [photoZoomUrl, setPhotoZoomUrl] = useState<string | null>(null);

  // Receipt Attachment Preview Modal State
  const [selectedRowForReceiptModal, setSelectedRowForReceiptModal] = useState<PurchasesReportRow | null>(null);
  const [receiptAttachmentData, setReceiptAttachmentData] = useState<ReceiptAttachmentInfo | null>(null);
  const [receiptAttachmentLoading, setReceiptAttachmentLoading] = useState<boolean>(false);
  const [receiptAttachmentError, setReceiptAttachmentError] = useState<string | null>(null);
  const [receiptZoom, setReceiptZoom] = useState<number>(1);
  const [receiptRotation, setReceiptRotation] = useState<number>(0);
  const [receiptImgFailed, setReceiptImgFailed] = useState<boolean>(false);

  // Load parcels once
  useEffect(() => {
    getLandParcelsApi().then(setParcels).catch(() => {});
  }, []);

  // Fetch report from backend
  const loadReport = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await getPurchasesReportApi({
        filter_type: filterType,
        date_basis: dateBasis,
        month: filterType === 'monthly' ? selectedMonth : undefined,
        date: filterType === 'daily' ? selectedDate : undefined,
        from_date: filterType === 'custom' ? fromDate : undefined,
        to_date: filterType === 'custom' ? toDate : undefined,
        department_id: selectedDepartment !== 'ALL' ? selectedDepartment : undefined,
        accounting_filter: accountingFilter,
        actual_only: actualOnly,
        page: currentPage,
        per_page: pageSize,
      });
      setData(response);
    } catch (err) {
      setError(parseApiError(err).message || 'تعذر تحميل بيانات تقرير المشتريات.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Reset to page 1 on filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filterType, dateBasis, actualOnly, selectedMonth, selectedDate, fromDate, toDate, selectedDepartment, accountingFilter]);

  useEffect(() => {
    void loadReport();
  }, [filterType, dateBasis, actualOnly, selectedMonth, selectedDate, fromDate, toDate, selectedDepartment, accountingFilter, currentPage, pageSize]);

  // Selected Department Name for dynamic title
  const activeDepartmentName = useMemo(() => {
    if (selectedDepartment === 'ALL' || !data?.departments) return null;
    const dept = data.departments.find((d) => String(d.id) === String(selectedDepartment));
    return dept?.name || null;
  }, [selectedDepartment, data?.departments]);

  // Dynamic Report Title
  const dynamicReportTitle = useMemo(() => {
    let deptPrefix = activeDepartmentName ? `قسم ${activeDepartmentName}` : 'العام';
    let timePeriod = '';

    if (filterType === 'monthly') {
      const [y, m] = selectedMonth.split('-');
      timePeriod = `لشهر ${m}/${y}`;
    } else if (filterType === 'daily') {
      timePeriod = `ليوم ${formatDateDMY(selectedDate)}`;
    } else {
      timePeriod = `للفترة من ${formatDateDMY(fromDate)} إلى ${formatDateDMY(toDate)}`;
    }

    const basisLabel = dateBasis === 'po_date' ? '(بأمر الشراء)' : (dateBasis === 'pr_date' ? '(بطلب الشراء)' : '(بالتوريد)');
    return `تقرير مشتريات ${deptPrefix} ${timePeriod} ${basisLabel}`;
  }, [activeDepartmentName, filterType, dateBasis, selectedMonth, selectedDate, fromDate, toDate]);

  // Client-side filtering by column inputs with multi-column AND logic (every)
  // Protected against null/undefined values and crashes
  const filteredRows = useMemo(() => {
    if (!data?.rows || !Array.isArray(data.rows)) return [];

    const activeFilterEntries = Object.entries(debouncedColFilters).filter(
      ([, value]) => typeof value === 'string' && value.trim() !== ''
    );

    if (activeFilterEntries.length === 0) {
      return data.rows;
    }

    return data.rows.filter((row) => {
      if (!row) return false;

      // Multi-Column AND Logic: Row must match every active filter
      return activeFilterEntries.every(([key, rawValue]) => {
        const searchStr = String(rawValue || '').trim().toLowerCase();
        if (!searchStr) return true;

        // 1. Status Dropdown filter (تسجيل الفاتورة / الحالة)
        // Runs in parallel with text column filters without overriding them
        if (key === 'invoice_status') {
          if (!rawValue) return true; // 'كل الحالات'
          if (rawValue === 'VERIFIED') {
            return row.accounting_status === 'VERIFIED' || Boolean(row.invoice_number);
          }
          if (rawValue === 'PENDING') {
            return row.accounting_status === 'PENDING' || !row.invoice_number;
          }
          return true;
        }

        // 2. Delivery Date filter: checks both ISO date and formatted date safely
        if (key === 'delivery_date') {
          const val1 = String(row?.delivery_date || '').toLowerCase();
          const val2 = String(row?.delivery_date_formatted || '').toLowerCase();
          return val1.includes(searchStr) || val2.includes(searchStr);
        }

        // 3. PO Number filter: checks both full PO number and short number safely
        if (key === 'po_number') {
          const val1 = String(row?.po_number || '').toLowerCase();
          const val2 = String(row?.po_number_short || '').toLowerCase();
          return val1.includes(searchStr) || val2.includes(searchStr);
        }

        // 4. All other columns: Null-Safe evaluation with String(...) and .toLowerCase()
        const fieldVal = (row as any)?.[key];
        const fieldStr = String(fieldVal != null ? fieldVal : '').toLowerCase();
        return fieldStr.includes(searchStr);
      });
    });
  }, [data?.rows, debouncedColFilters]);

  // Live totals of currently filtered rows
  const liveTotals = useMemo(() => {
    const totalQty = filteredRows.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    const totalAmount = filteredRows.reduce((sum, r) => sum + Number(r.total_price || 0), 0);
    const uniqueOrders = new Set(filteredRows.map((r) => r.purchase_order_id)).size;
    const uniqueSuppliers = new Set(filteredRows.map((r) => r.supplier_name).filter((s) => s && s !== '—')).size;
    const verifiedItemsCount = filteredRows.filter((r) => r.accounting_status === 'VERIFIED' || !!r.invoice_number).length;
    const pendingItemsCount = filteredRows.filter((r) => r.accounting_status === 'PENDING' || !r.invoice_number).length;

    return { totalQty, totalAmount, uniqueOrders, uniqueSuppliers, verifiedItemsCount, pendingItemsCount };
  }, [filteredRows]);

  // Calculate PO groupings to color all items of the same purchase order with identical color
  const poGroupingMeta = useMemo(() => {
    const map = new Map<string, { groupIdx: number; count: number }>();
    let currentGroupIdx = 0;

    filteredRows.forEach((row) => {
      const poKey = String(row.purchase_order_id || row.po_number || row.id);
      if (!map.has(poKey)) {
        map.set(poKey, { groupIdx: currentGroupIdx, count: 1 });
        currentGroupIdx++;
      } else {
        const entry = map.get(poKey)!;
        entry.count++;
      }
    });

    return map;
  }, [filteredRows]);

  // Alternating palette for distinct purchase orders so items of same PO share the exact same background & border theme
  const PO_PALETTES = [
    {
      bg: 'bg-white',
      hover: 'hover:bg-blue-50/70',
      accentBorder: 'border-r-[6px] border-r-blue-600',
      poTag: 'bg-blue-100 text-blue-900 border border-blue-300',
      rowNumBg: 'bg-blue-50/80 text-blue-900',
      poNumberColor: 'text-blue-700',
    },
    {
      bg: 'bg-[#f4fbf7]', // soft emerald/mint
      hover: 'hover:bg-emerald-100/60',
      accentBorder: 'border-r-[6px] border-r-emerald-600',
      poTag: 'bg-emerald-100 text-emerald-900 border border-emerald-300',
      rowNumBg: 'bg-emerald-50/80 text-emerald-900',
      poNumberColor: 'text-emerald-800',
    },
    {
      bg: 'bg-[#fdfaf3]', // soft warm amber
      hover: 'hover:bg-amber-100/60',
      accentBorder: 'border-r-[6px] border-r-amber-500',
      poTag: 'bg-amber-100 text-amber-900 border border-amber-300',
      rowNumBg: 'bg-amber-50/80 text-amber-900',
      poNumberColor: 'text-amber-800',
    },
    {
      bg: 'bg-[#fbf7fd]', // soft violet
      hover: 'hover:bg-violet-100/60',
      accentBorder: 'border-r-[6px] border-r-violet-600',
      poTag: 'bg-violet-100 text-violet-900 border border-violet-300',
      rowNumBg: 'bg-violet-50/80 text-violet-900',
      poNumberColor: 'text-violet-800',
    },
  ];

  // Open invoice modal for a specific PO row
  const handleOpenInvoiceModal = (row: PurchasesReportRow) => {
    if (!canRegisterInvoice || !isRowActionAllowed(row)) return;
    setSelectedRowForInvoice(row);
    setInvoiceError(null);

    const suggestedAmount = row.grand_total && row.grand_total > 0
      ? String(row.grand_total)
      : String(row.total_price || '');

    setInvoiceForm({
      invoice_number: '',
      amount: suggestedAmount,
      invoice_date: getTodayInputDate(),
      due_date: '',
      notes: `أمر شراء ${row.po_number} - مورد: ${row.supplier_name}`,
    });

    // Pre-seed allocation if parcel matches
    const matchingParcel = parcels.find(
      (p) => p.parcel_reference.trim().toLowerCase() === (row.parcel_reference || '').trim().toLowerCase()
    );

    if (matchingParcel && suggestedAmount) {
      setAllocations([
        {
          land_parcel_id: matchingParcel.id,
          department_id: row.department_id || '',
          amount: suggestedAmount,
          notes: `تخصيص أمر شراء ${row.po_number}`,
        },
      ]);
    } else {
      setAllocations([]);
    }
  };

  const handleCloseInvoiceModal = () => {
    if (submittingInvoice) return;
    setSelectedRowForInvoice(null);
    setInvoiceError(null);
  };

  const handleOpenReceiptModal = async (row: PurchasesReportRow) => {
    setSelectedRowForReceiptModal(row);
    setReceiptAttachmentData(null);
    setReceiptAttachmentError(null);
    setReceiptZoom(1);
    setReceiptRotation(0);
    setReceiptImgFailed(false);

    if (!row.receipt_id) {
      if (row.photo_url) {
        setReceiptAttachmentData({
          receipt_id: 0,
          receipt_number: row.receipt_number || '—',
          purchase_order_id: row.purchase_order_id,
          po_number: row.po_number,
          supplier_name: row.supplier_name,
          received_at: row.delivery_date_formatted || row.delivery_date,
          view_url: row.photo_url,
          drive_link: row.photo_url.includes('drive.google.com') ? row.photo_url : null,
        });
      } else {
        setReceiptAttachmentError('لا يوجد إذن استلام مسجل لهذا البند.');
      }
      return;
    }

    try {
      setReceiptAttachmentLoading(true);
      const res = await getReceiptAttachmentApi(row.receipt_id);
      if (res.success && res.attachment) {
        setReceiptAttachmentData(res.attachment);
      } else if (row.photo_url) {
        setReceiptAttachmentData({
          receipt_id: row.receipt_id,
          receipt_number: row.receipt_number || `#${row.receipt_id}`,
          purchase_order_id: row.purchase_order_id,
          po_number: row.po_number,
          supplier_name: row.supplier_name,
          received_at: row.delivery_date_formatted || row.delivery_date,
          view_url: row.photo_url,
          drive_link: row.photo_url.includes('drive.google.com') ? row.photo_url : null,
        });
      } else {
        setReceiptAttachmentError(res.message || 'لا توجد صورة مرفقة بهذا الإذن.');
      }
    } catch (err) {
      if (row.photo_url) {
        setReceiptAttachmentData({
          receipt_id: row.receipt_id,
          receipt_number: row.receipt_number || `#${row.receipt_id}`,
          purchase_order_id: row.purchase_order_id,
          po_number: row.po_number,
          supplier_name: row.supplier_name,
          received_at: row.delivery_date_formatted || row.delivery_date,
          view_url: row.photo_url,
          drive_link: row.photo_url.includes('drive.google.com') ? row.photo_url : null,
        });
      } else {
        setReceiptAttachmentError(parseApiError(err).message || 'تعذر تحميل مرفق إذن الاستلام.');
      }
    } finally {
      setReceiptAttachmentLoading(false);
    }
  };

  const handleCloseReceiptModal = () => {
    setSelectedRowForReceiptModal(null);
    setReceiptAttachmentData(null);
    setReceiptAttachmentError(null);
    setReceiptZoom(1);
    setReceiptRotation(0);
    setReceiptImgFailed(false);
  };

  const handlePrintInvoiceVoucher = () => {
    printDocumentOnly('#printable-invoice-voucher', {
      title: `سند_فاتورة_${invoiceForm.invoice_number || selectedRowForInvoice?.po_number || 'مورد'}`,
      orientation: 'portrait',
    });
  };

  const handleShareInvoiceWhatsApp = () => {
    if (!selectedRowForInvoice) return;
    const lines = [
      '🏢 *شركة إشبيلية للتطوير العقاري والمقاولات*',
      '🧾 *إشعار تسجيل فاتورة مورد بالحسابات*',
      '─────────────────────────',
      `📑 *رقم الفاتورة:* ${invoiceForm.invoice_number.trim() || 'مسودة قيد الحفظ'}`,
      `💰 *المبلغ الإجمالي:* ${formatCleanNumber(invoiceForm.amount)} ج.م`,
      `📅 *تاريخ الفاتورة:* ${invoiceForm.invoice_date || '—'}`,
      invoiceForm.due_date ? `⏳ *تاريخ الاستحقاق:* ${invoiceForm.due_date}` : '',
      '─────────────────────────',
      `🏬 *المورد:* ${selectedRowForInvoice.supplier_name}`,
      `📦 *أمر الشراء:* ${selectedRowForInvoice.po_number}`,
      `📥 *إذن الاستلام بالموقع:* ${selectedRowForInvoice.receipt_number || (selectedRowForInvoice.receipt_id ? `#${selectedRowForInvoice.receipt_id}` : '—')}`,
      `📍 *القطعة / المنطقة:* ${selectedRowForInvoice.parcel_reference || '—'} ${selectedRowForInvoice.region ? `(${selectedRowForInvoice.region})` : ''}`,
      `🏗️ *القسم:* ${selectedRowForInvoice.department_name || '—'}`,
      `⚖️ *الصنف المستلم:* ${selectedRowForInvoice.item_name} (كمية: ${formatCleanQty(selectedRowForInvoice.quantity)} ${selectedRowForInvoice.uom || ''})`,
      invoiceForm.notes ? `📝 *ملاحظات:* ${invoiceForm.notes}` : '',
      selectedRowForInvoice.photo_url ? `📎 *مرفق بوليصة الميزان البسكول متوفر.*` : '',
      '─────────────────────────',
      '✅ *تم تدقيق الفاتورة ومطابقتها ثلاثياً للإدراج في القيود المحاسبية.*',
    ].filter(Boolean);

    const url = `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
    window.open(url, '_blank');
  };

  const handleSubmitInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRowForInvoice) return;

    const numAmount = Number(invoiceForm.amount);
    if (!numAmount || numAmount <= 0) {
      setInvoiceError('يرجى إدخال مبلغ صحيح للفاتورة أكبر من صفر.');
      return;
    }

    if (!selectedRowForInvoice.receipt_id) {
      setInvoiceError('لا يوجد إذن استلام معتمد بالموقع لهذا الأمر. يجب استلام وفحص المواد بالموقع أولاً قبل تسجيل الفاتورة.');
      return;
    }

    setSubmittingInvoice(true);
    setInvoiceError(null);

    try {
      const validAllocations = allocations
        .filter((a) => Number(a.land_parcel_id) > 0 && Number(a.amount) > 0)
        .map((a) => ({
          land_parcel_id: Number(a.land_parcel_id),
          department_id: a.department_id ? Number(a.department_id) : undefined,
          amount: Number(a.amount),
          notes: a.notes || undefined,
        }));

      const newInvoice = await createSupplierInvoiceApi({
        purchase_order_id: selectedRowForInvoice.purchase_order_id,
        purchase_receipt_id: selectedRowForInvoice.receipt_id,
        invoice_number: invoiceForm.invoice_number.trim() || undefined,
        amount: numAmount,
        invoice_date: invoiceForm.invoice_date || undefined,
        due_date: invoiceForm.due_date || undefined,
        notes: invoiceForm.notes.trim() || undefined,
        land_allocations: validAllocations.length > 0 ? validAllocations : undefined,
      });

      const recordedInvoiceNum = newInvoice.invoice_number || invoiceForm.invoice_number.trim() || String(newInvoice.id);

      // Instant local state update for all rows of this PO without full page reload
      setData((prev) => {
        if (!prev) return prev;
        const updatedRows = prev.rows.map((r) => {
          if (r.purchase_order_id === selectedRowForInvoice.purchase_order_id) {
            return {
              ...r,
              accounting_status: 'VERIFIED',
              accounting_status_label: 'مسقط ومسجل بالحسابات',
              invoice_number: recordedInvoiceNum,
              invoice_id: newInvoice.id,
            };
          }
          return r;
        });

        return {
          ...prev,
          rows: updatedRows,
          metrics: {
            ...prev.metrics,
            verified_items_count: (prev.metrics.verified_items_count || 0) + 1,
          },
        };
      });

      setInvoiceSuccessNotice(`تم تسجيل فاتورة المورد #${recordedInvoiceNum} بنجاح لأمر الشراء ${selectedRowForInvoice.po_number}`);
      setSelectedRowForInvoice(null);
      setTimeout(() => {
        setInvoiceSuccessNotice(null);
      }, 6000);

      // Refresh background data
      void loadReport();
    } catch (err) {
      setInvoiceError(parseApiError(err).message || 'حدث خطأ أثناء تسجيل الفاتورة.');
    } finally {
      setSubmittingInvoice(false);
    }
  };

  const hasActiveColFilters = useMemo(() => {
    return Object.values(colFilters).some(
      (val) => typeof val === 'string' && val.trim() !== ''
    );
  }, [colFilters]);

  const handleClearColFilters = () => {
    setColFilters(initialFilters);
  };

  const handleUpdateColFilter = (key: string, value: string) => {
    setColFilters((prev) => ({ ...prev, [key]: value }));
  };

  // Export CSV (Excel Compatible with UTF-8 BOM)
  const handleExportCSV = () => {
    if (!filteredRows.length) return;

    const dateHeader = dateBasis === 'po_date' ? 'تاريخ أمر الشراء' : (dateBasis === 'pr_date' ? 'تاريخ طلب الشراء' : 'تاريخ التوريد');
    const headers = [
      dateHeader,
      'رقم أمر الشراء',
      'الصنف',
      'الوحدة',
      'الكمية',
      'سعر الوحدة',
      'سعر الكمية',
      'أسم المورد',
      'رقم القطعة',
      'إسم المنطقة',
      'القسم',
      'الاعمال',
      'تسجيل الفاتورة / الحالة',
    ];

    const lines: string[] = [];
    lines.push('\uFEFF' + headers.join(','));

    filteredRows.forEach((r) => {
      const statusText = r.accounting_status === 'VERIFIED' || r.invoice_number
        ? `مسجلة (${r.invoice_number || ''})`
        : 'بانتظار التسجيل';

      const rowDate = dateBasis === 'po_date'
        ? (r.po_date_formatted || r.po_date || '—')
        : (dateBasis === 'pr_date'
          ? (r.pr_date_formatted || r.pr_date || '—')
          : (r.delivery_date_formatted || r.delivery_date || '—'));

      lines.push(
        [
          `"${rowDate}"`,
          `"${r.po_number || '—'}"`,
          `"${(r.item_name || '—').replace(/"/g, '""')}"`,
          `"${r.uom || '—'}"`,
          r.quantity,
          r.unit_price,
          r.total_price,
          `"${(r.supplier_name || '—').replace(/"/g, '""')}"`,
          `"${r.parcel_reference || '—'}"`,
          `"${r.region || '—'}"`,
          `"${r.department_name || '—'}"`,
          `"${(r.works || '—').replace(/"/g, '""')}"`,
          `"${statusText}"`,
        ].join(',')
      );
    });

    lines.push(
      [
        '"الإجمالي"',
        `"${liveTotals.uniqueOrders} أمر شراء"`,
        '""',
        '""',
        liveTotals.totalQty,
        '""',
        liveTotals.totalAmount,
        `"${liveTotals.uniqueSuppliers} مورد"`,
        '""',
        '""',
        '""',
        '""',
        `"المسجلة: ${liveTotals.verifiedItemsCount} | بالانتظار: ${liveTotals.pendingItemsCount}"`,
      ].join(',')
    );

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${dynamicReportTitle.replace(/[\s/]/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Copy to Clipboard (Tab-separated for direct paste into Excel)
  const handleCopyClipboard = () => {
    if (!filteredRows.length) return;

    const dateHeader = dateBasis === 'po_date' ? 'تاريخ أمر الشراء' : (dateBasis === 'pr_date' ? 'تاريخ طلب الشراء' : 'تاريخ التوريد');
    const headers = [
      dateHeader,
      'رقم أمر الشراء',
      'الصنف',
      'الوحدة',
      'الكمية',
      'سعر الوحدة',
      'سعر الكمية',
      'أسم المورد',
      'رقم القطعة',
      'إسم المنطقة',
      'القسم',
      'الاعمال',
      'تسجيل الفاتورة / الحالة',
    ];

    const lines: string[] = [headers.join('\t')];
    filteredRows.forEach((r) => {
      const statusText = r.accounting_status === 'VERIFIED' || r.invoice_number
        ? `مسجلة (${r.invoice_number || ''})`
        : 'بانتظار التسجيل';

      const rowDate = dateBasis === 'po_date'
        ? (r.po_date_formatted || r.po_date || '—')
        : (dateBasis === 'pr_date'
          ? (r.pr_date_formatted || r.pr_date || '—')
          : (r.delivery_date_formatted || r.delivery_date || '—'));

      lines.push(
        [
          rowDate,
          r.po_number || '—',
          r.item_name || '—',
          r.uom || '—',
          r.quantity,
          r.unit_price,
          r.total_price,
          r.supplier_name || '—',
          r.parcel_reference || '—',
          r.region || '—',
          r.department_name || '—',
          r.works || '—',
          statusText,
        ].join('\t')
      );
    });

    void navigator.clipboard.writeText(lines.join('\n'));
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 3000);
  };

  // الإذن • الفاتورة • التسجيل — shared by the sheet's M column and the mobile line cards.
  const renderDocumentActions = (row: PurchasesReportRow, layout: string) => {
    const isUnpriced = Number(row.total_price || 0) <= 0;

    return (
      <div className={`flex items-center gap-1.5 ${layout}`}>
        {/* زر رؤية الإذن */}
        {row.has_receipt_attachment ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenReceiptModal(row);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 hover:bg-blue-700 active:scale-95 text-white py-1 px-2.5 text-xs font-bold shadow-2xs transition-all border border-blue-700 hover:shadow-xs cursor-pointer select-none shrink-0"
            title="استعراض صورة إذن الاستلام ومستند التوريد / Google Drive"
          >
            <span>📄</span>
            <span>رؤية الإذن</span>
          </button>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-400 border border-slate-200 py-1 px-2 text-xs font-medium cursor-not-allowed select-none shadow-2xs shrink-0"
            title="لا توجد صورة أو وزنة مرفقة لهذا الإذن"
          >
            <span className="opacity-50">📄</span>
            <span className="text-slate-400">رؤية الإذن</span>
          </button>
        )}

        {/* زر الفاتورة: أصفر إذا توفرت ورمادي إذا لم تتوفر */}
        {row.has_invoice_attachment && row.invoice_url ? (
          <a
            href={row.invoice_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 rounded-md bg-amber-500 hover:bg-amber-400 active:scale-95 text-amber-950 py-1 px-2.5 text-xs font-black shadow-2xs transition-all border border-amber-400 hover:shadow-xs cursor-pointer select-none shrink-0"
            title="استعراض فاتورة المورد المرفوعة على Google Drive بمجلد «فواتير»"
          >
            <span>🧾</span>
            <span>الفاتورة</span>
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-400 border border-slate-200 py-1 px-2 text-xs font-medium cursor-not-allowed select-none shadow-2xs shrink-0"
            title="لا توجد فاتورة مرفقة لهذا الطلب"
          >
            <span className="opacity-40">🧾</span>
            <span className="text-slate-400">الفاتورة</span>
          </button>
        )}

        {/* زر أو بطاقة الحالة المحاسبية */}
        {row.accounting_status === 'VERIFIED' || row.invoice_number ? (
          <div className="flex flex-col items-center justify-center gap-0.5 shrink-0">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 border border-emerald-300 px-2.5 py-0.5 text-xs font-bold text-emerald-800 shadow-2xs">
              <span className="text-emerald-600 font-bold">✓</span>
              <span>تم التسجيل</span>
            </span>
            {row.invoice_number && (
              <span
                className="text-[10px] font-mono font-bold text-slate-700 bg-white/90 border border-slate-200 px-1.5 py-0.5 rounded mt-0.5 shadow-2xs"
                title={`رقم فاتورة المورد: ${row.invoice_number}`}
              >
                فاتورة #{row.invoice_number}
              </span>
            )}
          </div>
        ) : canRegisterInvoice && isRowActionAllowed(row) ? (
          isUnpriced ? (
            <button
              type="button"
              disabled
              className="inline-flex items-center justify-center gap-1 rounded-md bg-gray-200 text-gray-400 border border-gray-300 py-1 px-2 text-xs font-medium cursor-not-allowed select-none shadow-2xs shrink-0"
              title="لا يمكن تسجيل فاتورة لبند غير مسعر (القيمة 0 ج.م)"
            >
              <span>🧾</span>
              <span>تسجيل الفاتورة</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleOpenInvoiceModal(row);
              }}
              className="inline-flex items-center justify-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white py-1 px-2.5 text-xs font-bold shadow-2xs transition-all border border-emerald-700 hover:shadow-xs cursor-pointer select-none shrink-0"
              title="تسجيل فاتورة المورد واعتمادها بالحسابات"
            >
              <span>🧾</span>
              <span>تسجيل الفاتورة</span>
            </button>
          )
        ) : (
          <span
            className="inline-flex items-center justify-center gap-1 rounded-md bg-slate-100 border border-slate-200 py-1 px-2 text-[11px] font-medium text-slate-500 shadow-2xs shrink-0"
            title={canRegisterInvoice ? "المستند خارج نطاق اختصاصك - متاح للاطلاع والتحليلات فقط" : "تسجيل الفواتير المالية مسند لمحاسب القسم المختص وفقاً لقاعدة فصل المهام"}
          >
            <span className="text-slate-400">{canRegisterInvoice ? "🔒" : "⏳"}</span>
            <span>{canRegisterInvoice ? "(للاطلاع فقط)" : "(مسند للحسابات)"}</span>
          </span>
        )}
      </div>
    );
  };

  const mobilePeriodLabel = filterType === 'monthly'
    ? selectedMonth
    : (filterType === 'daily' ? selectedDate : `${fromDate} ← ${toDate}`);
  const mobileDepartmentLabel = selectedDepartment === 'ALL'
    ? 'جميع الأقسام'
    : (data?.departments?.find((dept) => String(dept.id) === String(selectedDepartment))?.name || 'قسم محدد');

  return (
    <div className="space-y-4" dir="rtl">
      {/* ========================================================================= */}
      {/* ── 1. OFFICIAL PRINT VIEW (Pure Clean White Paper Document) ─────────────── */}
      {/* ========================================================================= */}
      <div className="hidden print:block font-sans text-black bg-white p-0 m-0 purchases-report-print-target">
        {/* Company Header */}
        <div className="border-b-2 border-black pb-3 mb-3 flex items-start justify-between bg-white text-black">
          <div className="flex items-center gap-3">
            <img src="/eshbelia-logo.png" alt="شعار شركة اشبيلية" className="h-14 w-auto object-contain" />
            <div>
              <div className="text-[10px] text-slate-800 font-bold">نظام المشتريات والحسابات المعتمد</div>
              <h1 className="text-lg font-black text-black mt-0.5">
                شركة إشبيلية للتطوير العقاري والمقاولات
              </h1>
              <h2 className="text-xs font-bold text-slate-800 mt-0.5">
                {dynamicReportTitle}
              </h2>
            </div>
          </div>
          <div className="text-left text-[10.5px] font-mono border border-black p-2 rounded bg-white text-black" dir="rtl">
            <div><strong>تاريخ الطباعة:</strong> {new Date().toLocaleDateString('ar-EG')}</div>
            <div><strong>الوقت:</strong> {new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</div>
            <div><strong>الحالة:</strong> معتمد نهائي</div>
          </div>
        </div>

        {/* Summary Metadata Box */}
        <div className="grid grid-cols-4 gap-2 mb-3 text-xs border border-black bg-white p-2 font-semibold text-black">
          <div>
            <span className="text-slate-600 block text-[10px]">القسم المحدد:</span>
            <span className="font-bold text-black">{activeDepartmentName || 'كافة الأقسام'}</span>
          </div>
          <div>
            <span className="text-slate-600 block text-[10px]">عدد الأوامر المسجلة:</span>
            <span className="font-bold text-black font-mono">{liveTotals.uniqueOrders} أمر شراء</span>
          </div>
          <div>
            <span className="text-slate-600 block text-[10px]">إجمالي الكميات:</span>
            <span className="font-bold text-black font-mono" dir="ltr">
              {formatCleanQty(liveTotals.totalQty)}
            </span>
          </div>
          <div>
            <span className="text-slate-600 block text-[10px]">إجمالي قيمة المشتريات:</span>
            <span className="font-black text-black font-mono text-sm" dir="ltr">
              {formatCleanNumber(liveTotals.totalAmount)} ج.م
            </span>
          </div>
        </div>

        {/* 13-Column Official Excel Table */}
        <table className="w-full border-collapse border border-black text-[10px] text-right">
          <thead>
            <tr className="bg-slate-100 border-b border-black font-black text-black">
              <th className="border border-black px-1 py-1.5 text-center w-7">م</th>
              <th className="border border-black px-2 py-1.5 text-center whitespace-nowrap">
                {dateBasis === 'po_date' ? 'تاريخ أمر الشراء' : (dateBasis === 'pr_date' ? 'تاريخ طلب الشراء' : 'تاريخ التوريد')}
              </th>
              <th className="border border-black px-2 py-1.5 text-center whitespace-nowrap">رقم أمر الشراء</th>
              <th className="border border-black px-2 py-1.5">الصنف</th>
              <th className="border border-black px-1.5 py-1.5 text-center">الوحدة</th>
              <th className="border border-black px-2 py-1.5 text-center">الكمية</th>
              <th className="border border-black px-2 py-1.5 text-center">سعر الوحدة</th>
              <th className="border border-black px-2 py-1.5 text-center font-bold bg-slate-200">سعر الكمية</th>
              <th className="border border-black px-2 py-1.5">أسم المورد</th>
              <th className="border border-black px-1.5 py-1.5 text-center">رقم القطعة</th>
              <th className="border border-black px-2 py-1.5 text-center">إسم المنطقة</th>
              <th className="border border-black px-2 py-1.5 text-center">القسم</th>
              <th className="border border-black px-2 py-1.5">الاعمال</th>
              <th className="border border-black px-2 py-1.5 text-center whitespace-nowrap">تسجيل الفاتورة / الحالة</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, idx) => (
              <tr key={row.id} className="border-b border-black bg-white">
                <td className="border border-black px-1 py-1 text-center font-bold font-mono">{idx + 1}</td>
                <td className="border border-black px-2 py-1 text-center font-mono whitespace-nowrap">
                  {dateBasis === 'po_date'
                    ? (row.po_date_formatted || row.po_date || '—')
                    : (dateBasis === 'pr_date'
                      ? (row.pr_date_formatted || row.pr_date || '—')
                      : (row.delivery_date_formatted || row.delivery_date || '—'))}
                </td>
                <td className="border border-black px-2 py-1 text-center font-mono font-bold whitespace-nowrap">
                  {row.po_number_short || row.po_number}
                </td>
                <td className="border border-black px-2 py-1 font-bold text-black">{row.item_name}</td>
                <td className="border border-black px-1.5 py-1 text-center">{getUnitLabel(row.uom) || row.uom}</td>
                <td className="border border-black px-2 py-1 text-center font-mono font-bold" dir="ltr">
                  <div>{formatCleanQty(row.quantity)}</div>
                  {row.received_quantity !== undefined && row.received_quantity !== null && (
                    <div className="text-[8px] text-slate-600 font-sans" dir="rtl">
                      (مستلم: {formatCleanQty(row.received_quantity)})
                    </div>
                  )}
                </td>
                <td className="border border-black px-2 py-1 text-center font-mono" dir="ltr">
                  {formatCleanNumber(row.unit_price)}
                </td>
                <td className="border border-black px-2 py-1 text-center font-mono font-black bg-slate-100" dir="ltr">
                  {formatCleanNumber(row.total_price)}
                </td>
                <td className="border border-black px-2 py-1">{row.supplier_name}</td>
                <td className="border border-black px-1.5 py-1 text-center font-mono font-bold">{row.parcel_reference}</td>
                <td className="border border-black px-2 py-1 text-center">{row.region}</td>
                <td className="border border-black px-2 py-1 text-center">{row.department_name}</td>
                <td className="border border-black px-2 py-1">{row.works}</td>
                <td className="border border-black px-2 py-1 text-center font-bold text-[9px]">
                  {row.accounting_status === 'VERIFIED' || row.invoice_number ? (
                    <span className="text-emerald-800">مسجلة (#{row.invoice_number || 'معتمد'})</span>
                  ) : (
                    <span className="text-amber-800">بانتظار التسجيل</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 border-t-2 border-black font-black text-black">
              <td colSpan={5} className="border border-black px-2 py-1.5 text-center text-xs font-bold">
                الإجمالي العام ({filteredRows.length} بند مسجل)
              </td>
              <td className="border border-black px-2 py-1.5 text-center font-mono font-bold" dir="ltr">
                {formatCleanQty(liveTotals.totalQty)}
              </td>
              <td className="border border-black px-2 py-1.5 text-center">—</td>
              <td className="border border-black px-2 py-1.5 text-center font-mono font-black text-xs bg-slate-200" dir="ltr">
                {formatCleanNumber(liveTotals.totalAmount)} ج.م
              </td>
              <td colSpan={6} className="border border-black px-2 py-1.5 text-left text-[10px] text-slate-700">
                أوامر الشراء: {liveTotals.uniqueOrders} | الموردين: {liveTotals.uniqueSuppliers} | المسجلة: {liveTotals.verifiedItemsCount} | بالانتظار: {liveTotals.pendingItemsCount}
              </td>
            </tr>
          </tfoot>
        </table>

        {/* Signatures */}
        <div className="mt-6 pt-3 border-t-2 border-black grid grid-cols-3 gap-6 text-center text-xs bg-white text-black">
          <div className="space-y-3">
            <div className="font-bold">إعداد الحسابات</div>
            <div className="border-b border-dashed border-black h-7 w-44 mx-auto" />
            <div className="text-[10px] text-slate-600">التوقيع والتاريخ</div>
          </div>
          <div className="space-y-3">
            <div className="font-bold">مراجعة مدير المشتريات</div>
            <div className="border-b border-dashed border-black h-7 w-44 mx-auto" />
            <div className="text-[10px] text-slate-600">التوقيع والتاريخ</div>
          </div>
          <div className="space-y-3">
            <div className="font-bold">اعتماد المدير التنفيذي</div>
            <div className="border-b border-dashed border-black h-7 w-44 mx-auto" />
            <div className="text-[10px] text-slate-600">التوقيع والتاريخ</div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* ── 2. ON-SCREEN AUTHENTIC EXCEL SPREADSHEET VIEW ───────────────────────── */}
      {/* ========================================================================= */}
      <div className="print:hidden space-y-4 font-sans">
        
        {/* ── EXCEL RIBBON & WORKBOOK HEADER ── */}
        <div className="rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden">
          
          {/* Top Green Excel Title Bar */}
          <div className="bg-[#107c41] px-4 py-2.5 text-white flex flex-wrap items-center justify-between gap-3 shadow-md">
            <div className="flex items-center gap-3">
              <span className="flex h-7 w-7 items-center justify-center rounded bg-white/20 font-black text-base shadow-inner">
                📗
              </span>
              <div>
                <h1 className="text-sm sm:text-base font-black tracking-wide flex items-center gap-2">
                  <span>ورقة إكسيل: {dynamicReportTitle}.xlsx</span>
                </h1>
                <span className="text-[10px] text-emerald-100 opacity-90 hidden sm:block">
                  تقرير المشتريات المسقطة محاسبياً (بعد تسجيل فاتورة المورد في المرحلة النهائية) • 12 عموداً • إمكانية التصفية والفرز والتصدير
                </span>
              </div>
            </div>

            {/* Quick Excel Actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleExportCSV}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5 text-xs font-bold text-white transition border border-white/20 shadow-sm"
                title="تنزيل كملف Excel CSV"
              >
                <span>📥</span>
                <span className="hidden sm:inline">حفظ Excel</span>
              </button>

              <button
                type="button"
                onClick={handleCopyClipboard}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5 text-xs font-bold text-white transition border border-white/20 shadow-sm"
                title="نسخ الجدول لبرنامج إكسل"
              >
                <span>📋</span>
                <span className="hidden sm:inline">{copySuccess ? 'تم النسخ!' : 'نسخ الورقة'}</span>
              </button>

              <button
                type="button"
                onClick={() => printDocumentOnly('.purchases-report-print-target', { orientation: 'landscape', title: dynamicReportTitle })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-900 px-3.5 py-1.5 text-xs font-extrabold text-white transition border border-emerald-600 shadow"
                title="طباعة تقرير إكسل مسطر"
              >
                <span>🖨️</span>
                <span className="hidden sm:inline">طباعة الورقة</span>
              </button>


              <button
                type="button"
                onClick={() => void loadReport()}
                disabled={refreshing}
                className="inline-flex items-center gap-1 rounded-lg bg-white/10 hover:bg-white/20 px-2.5 py-1.5 text-xs text-white transition border border-white/20 disabled:opacity-50"
                title="إعادة احتساب وتحديث البيانات"
              >
                <span className={refreshing ? 'animate-spin' : ''}>🔄</span>
              </button>
            </div>
          </div>

          {/* Formula & Status Bar (fx) */}
          <div className="bg-slate-800/90 px-4 py-2 border-b border-slate-700 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="hidden md:flex items-center gap-3 flex-1 min-w-[280px]">
              <div className="font-mono font-black text-amber-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-700 text-[11px]">
                fx
              </div>
              <div className="text-slate-300 font-mono text-[11px] truncate flex items-center gap-4">
                <span>
                  =SUM(الكمية): <strong className="text-amber-300 font-bold" dir="ltr">{formatCleanQty(liveTotals.totalQty)}</strong>
                </span>
                <span className="text-slate-500">|</span>
                <span>
                  =SUM(سعر_الكمية): <strong className="text-emerald-300 font-bold" dir="ltr">{formatCleanNumber(liveTotals.totalAmount)} ج.م</strong>
                </span>
                <span className="text-slate-500">|</span>
                <span>
                  =COUNT(البنود): <strong className="text-cyan-300 font-bold">{filteredRows.length}</strong>
                </span>
                {selectedCell && (
                  <>
                    <span className="text-slate-500">|</span>
                    <span className="text-slate-400">الخلية المحددة: <strong className="text-white">{selectedCell}</strong></span>
                  </>
                )}
              </div>
            </div>

            {/* Actual Orders Toggle (Default: True) */}
            <div className="hidden md:flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800">
              <button
                type="button"
                onClick={() => setActualOnly((prev) => !prev)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold rounded transition cursor-pointer ${
                  actualOnly
                    ? 'bg-cyan-950 text-cyan-300 border border-cyan-700/60 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
                title="تصفية التقرير لعرض أوامر الشراء الفعلية المعتمدة فقط بدون الأوامر المبدئية"
              >
                <span>{actualOnly ? '✅' : '⚪'}</span>
                <span>الأوامر الفعلية فقط</span>
                {actualOnly && <span className="text-[9px] bg-cyan-900/60 text-cyan-200 px-1.5 rounded-full font-mono">افتراضي</span>}
              </button>
            </div>

            {/* Accounting Mode Toggle (All Orders vs Pending Invoices vs Verified) */}
            <div className="grid grid-cols-3 w-full md:w-auto md:flex md:items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
              <span className="hidden md:inline text-[10px] font-bold text-slate-400 px-2">عرض:</span>
              <button
                type="button"
                onClick={() => setAccountingFilter('ALL')}
                className={`px-2.5 py-1 text-[11px] font-bold rounded transition ${
                  accountingFilter === 'ALL'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                جميع أوامر الشراء ({data?.rows?.length || 0})
              </button>
              <button
                type="button"
                onClick={() => setAccountingFilter('PENDING')}
                className={`px-2.5 py-1 text-[11px] font-bold rounded transition ${
                  accountingFilter === 'PENDING'
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                ⏳ بانتظار تسجيل الفاتورة
              </button>
              <button
                type="button"
                onClick={() => setAccountingFilter('VERIFIED_ONLY')}
                className={`px-2.5 py-1 text-[11px] font-bold rounded transition ${
                  accountingFilter === 'VERIFIED_ONLY'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                ✅ مسقط ومسجل بالحسابات ({data?.metrics?.verified_items_count || 0})
              </button>
            </div>
          </div>

          {/* Phones: totals first, then one line that unfolds the filters, then the cards/sheet switch */}
          <div className="md:hidden p-3 space-y-2.5 bg-slate-950/70 border-b border-slate-800">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 rounded-xl border border-emerald-700/60 bg-emerald-950/40 px-3 py-2">
                <span className="block text-[11px] font-bold text-emerald-300/80">إجمالي القيمة</span>
                <strong className="block text-lg font-black text-emerald-300" dir="ltr">{formatCleanNumber(liveTotals.totalAmount)} ج.م</strong>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2">
                <span className="block text-[11px] font-bold text-slate-400">أوامر الشراء</span>
                <strong className="text-base font-black text-slate-100">{liveTotals.uniqueOrders}</strong>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2">
                <span className="block text-[11px] font-bold text-slate-400">الموردين</span>
                <strong className="text-base font-black text-slate-100">{liveTotals.uniqueSuppliers}</strong>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowMobileFilters((prev) => !prev)}
              aria-expanded={showMobileFilters}
              className="w-full flex items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-200"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span>🔍</span>
                <span className="truncate">
                  {mobilePeriodLabel} · {mobileDepartmentLabel}{actualOnly ? ' · الفعلية فقط' : ''}
                </span>
              </span>
              <span className="shrink-0 text-emerald-400">{showMobileFilters ? 'إخفاء الفلاتر ▴' : 'الفلاتر ▾'}</span>
            </button>

            <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1 text-xs font-bold">
              <button
                type="button"
                onClick={() => setMobileView('cards')}
                className={`flex-1 rounded-lg py-1.5 transition ${mobileView === 'cards' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400'}`}
              >
                📇 بطاقات ({filteredRows.length})
              </button>
              <button
                type="button"
                onClick={() => setMobileView('sheet')}
                className={`flex-1 rounded-lg py-1.5 transition ${mobileView === 'sheet' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400'}`}
              >
                📊 ورقة الإكسيل
              </button>
            </div>
          </div>

          {/* Controls Bar: Period Type + Date + Department Dropdown */}
          <div className={`${showMobileFilters ? 'flex' : 'hidden'} md:flex p-3 bg-slate-950/70 border-b border-slate-800 flex-wrap items-center justify-between gap-3 text-xs`}>
            <div className="flex flex-wrap items-center gap-3">
              
              {/* Period Type */}
              <div className="flex items-center gap-1 rounded-lg bg-slate-900 p-1 border border-slate-800">
                <button
                  type="button"
                  onClick={() => setFilterType('monthly')}
                  className={`px-3 py-1 rounded text-xs font-bold transition ${
                    filterType === 'monthly' ? 'bg-[#107c41] text-white shadow' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  شهري
                </button>
                <button
                  type="button"
                  onClick={() => setFilterType('daily')}
                  className={`px-3 py-1 rounded text-xs font-bold transition ${
                    filterType === 'daily' ? 'bg-[#107c41] text-white shadow' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  يومي
                </button>
                <button
                  type="button"
                  onClick={() => setFilterType('custom')}
                  className={`px-3 py-1 rounded text-xs font-bold transition ${
                    filterType === 'custom' ? 'bg-[#107c41] text-white shadow' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  مخصص
                </button>
              </div>

              {/* Date Input */}
              {filterType === 'monthly' && (
                <ArabicMonthPicker
                  value={selectedMonth}
                  onChange={setSelectedMonth}
                  label="الشهر:"
                />
              )}

              {filterType === 'daily' && (
                <ArabicDatePicker
                  value={selectedDate}
                  onChange={setSelectedDate}
                  label="اليوم:"
                />
              )}

              {filterType === 'custom' && (
                <div className="flex items-center gap-2">
                  <ArabicDatePicker
                    value={fromDate}
                    onChange={setFromDate}
                    label="من:"
                  />
                  <span className="text-slate-500 font-bold text-xs select-none">إلى</span>
                  <ArabicDatePicker
                    value={toDate}
                    onChange={setToDate}
                    label="إلى:"
                  />
                </div>
              )}

              {/* Department Dropdown */}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-bold text-slate-400">القسم:</span>
                <select
                  value={selectedDepartment}
                  onChange={(e) => setSelectedDepartment(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-bold text-slate-200 focus:border-emerald-400 focus:outline-none"
                >
                  <option value="ALL">جميع الأقسام</option>
                  {data?.departments?.map((dept) => (
                    <option key={dept.id} value={dept.id}>
                      {dept.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Date Basis Dropdown */}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-bold text-slate-400">البحث بالتاريخ حسب:</span>
                <select
                  value={dateBasis}
                  onChange={(e) => {
                    setDateBasis(e.target.value as any);
                    setCurrentPage(1);
                  }}
                  className="rounded-lg border border-emerald-500/60 bg-slate-900 px-2.5 py-1 text-xs font-bold text-emerald-300 focus:border-emerald-400 focus:outline-none shadow-sm"
                >
                  <option value="po_date">📝 أمر الشراء (تاريخ الأمر)</option>
                  <option value="delivery_date">🚚 التوريد (تاريخ الاستلام)</option>
                  <option value="pr_date">📋 طلب الشراء (تاريخ الطلب)</option>
                </select>
              </div>

              {/* Actual POs Only Filter (Default: true) */}
              <label
                className={`flex items-center gap-1.5 cursor-pointer rounded-lg px-2.5 py-1 text-xs font-bold transition border select-none ${
                  actualOnly
                    ? 'bg-cyan-950/70 border-cyan-500/70 text-cyan-300 shadow-sm'
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                title="استبعاد الأوامر المبدئية وحصر التقرير على أوامر الشراء الفعلية المعتمدة لضمان دقة الأرقام المالية"
              >
                <input
                  type="checkbox"
                  checked={actualOnly}
                  onChange={(e) => {
                    setActualOnly(e.target.checked);
                    setCurrentPage(1);
                  }}
                  className="rounded border-slate-700 text-cyan-500 focus:ring-cyan-400 h-3.5 w-3.5 cursor-pointer"
                />
                <span>🛡️ أوامر الشراء الفعلية فقط</span>
              </label>
            </div>

            {/* Filter Toggle Button */}
            <div className="flex items-center gap-2">
              {hasActiveColFilters && (
                <button
                  type="button"
                  onClick={handleClearColFilters}
                  className="text-[11px] font-bold text-rose-400 hover:underline"
                >
                  مسح فلاتر الأعمدة ✕
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowColumnFilters((prev) => !prev)}
                className="text-[11px] font-bold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition"
              >
                <span>🔍</span>
                <span>{showColumnFilters ? 'إخفاء فلاتر الأعمدة' : 'إظهار فلاتر الأعمدة'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs font-bold text-rose-300">
            {error}
          </div>
        )}

        {/* Invoice Recorded Success Notice */}
        {invoiceSuccessNotice && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-xs font-bold text-emerald-300 flex items-center justify-between shadow-lg">
            <div className="flex items-center gap-2">
              <span className="text-base">✅</span>
              <span>{invoiceSuccessNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setInvoiceSuccessNotice(null)}
              className="text-emerald-400 hover:text-white font-bold px-2 py-0.5"
            >
              ✕
            </button>
          </div>
        )}

        {/* ── PHONE LINE CARDS: every column of the sheet stacked, so nothing needs sideways scrolling ── */}
        {mobileView === 'cards' && (
          <div className="md:hidden space-y-2.5">
            {loading ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-xs font-bold text-slate-400">
                جاري تحميل بيانات التقرير...
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center space-y-2">
                <p className="text-sm font-black text-slate-200">لا توجد بيانات في الفترة أو الفلاتر المحددة</p>
                {hasActiveColFilters && (
                  <button
                    type="button"
                    onClick={handleClearColFilters}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white"
                  >
                    ✕ مسح فلاتر الأعمدة
                  </button>
                )}
              </div>
            ) : (
              <>
                {filteredRows.map((row, idx) => {
                  const poKey = String(row.purchase_order_id || row.po_number || row.id);
                  const palette = PO_PALETTES[(poGroupingMeta.get(poKey)?.groupIdx ?? idx) % PO_PALETTES.length];
                  const rawItemName = (row.item_name || '').trim();
                  const isFictitiousOrEmpty = !rawItemName || ['صنف 00', 'صنف 0', '00', '0'].includes(rawItemName);
                  const totalPriceNum = Number(row.total_price || 0);
                  const dateLabel = dateBasis === 'po_date'
                    ? (row.po_date_formatted || row.po_date || '—')
                    : (dateBasis === 'pr_date'
                      ? (row.pr_date_formatted || row.pr_date || '—')
                      : (row.delivery_date_formatted || row.delivery_date || '—'));
                  const uomLabel = getUnitLabel(row.uom) || row.uom || '';

                  return (
                    <article
                      key={row.id}
                      className="rounded-xl border border-slate-700 bg-slate-900 p-3 space-y-2.5 text-xs text-slate-300"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-[11px] text-slate-500">{idx + 1}.</span>
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-black font-mono ${palette.poTag}`}>
                            {row.po_number_short || row.po_number}
                          </span>
                        </span>
                        <span className="font-mono text-[11px] text-slate-400 shrink-0">{dateLabel}</span>
                      </div>

                      <h3 className="text-sm font-black text-slate-100 leading-snug" style={{ overflowWrap: 'anywhere' }}>
                        {isFictitiousOrEmpty ? '---' : rawItemName}
                      </h3>

                      <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-950/70 border border-slate-800 px-2.5 py-2">
                        <div className="min-w-0">
                          <span className="block text-[11px] text-slate-400">الكمية</span>
                          <strong className="text-sm font-black text-slate-100" dir="ltr">{formatCleanQty(row.quantity)}</strong>
                          <span className="block text-[11px] text-slate-400">{uomLabel}</span>
                        </div>
                        <div className="min-w-0 text-center">
                          <span className="block text-[11px] text-slate-400">سعر الوحدة</span>
                          <strong className="font-mono text-slate-200" dir="ltr" style={{ overflowWrap: 'anywhere' }}>
                            {Number(row.unit_price || 0) > 0 ? formatCleanNumber(row.unit_price) : '—'}
                          </strong>
                        </div>
                        <div className="min-w-0 text-left">
                          <span className="block text-[11px] text-slate-400">الإجمالي</span>
                          <strong
                            className={`font-mono text-sm font-black ${totalPriceNum > 0 ? 'text-emerald-300' : 'text-slate-500'}`}
                            dir="ltr"
                            style={{ overflowWrap: 'anywhere' }}
                          >
                            {totalPriceNum > 0 ? formatCleanNumber(row.total_price) : 'غير مسعر'}
                          </strong>
                        </div>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                        <div className="min-w-0">
                          <dt className="text-[11px] text-slate-500">الكمية المستلمة</dt>
                          <dd className="font-bold text-slate-200">
                            {row.received_quantity !== undefined && row.received_quantity !== null
                              ? <><span dir="ltr">{formatCleanQty(row.received_quantity)}</span> {uomLabel}</>
                              : '—'}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="text-[11px] text-slate-500">رقم القطعة</dt>
                          <dd className="font-mono font-bold text-amber-300" style={{ overflowWrap: 'anywhere' }}>{row.parcel_reference || '—'}</dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="text-[11px] text-slate-500">المنطقة</dt>
                          <dd className="font-bold text-slate-200" style={{ overflowWrap: 'anywhere' }}>{row.region || '—'}</dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="text-[11px] text-slate-500">القسم</dt>
                          <dd className="font-bold text-slate-200" style={{ overflowWrap: 'anywhere' }}>{row.department_name || '—'}</dd>
                        </div>
                        <div className="col-span-2 min-w-0">
                          <dt className="text-[11px] text-slate-500">المورد</dt>
                          <dd className="font-bold text-slate-200" style={{ overflowWrap: 'anywhere' }}>{row.supplier_name || '—'}</dd>
                        </div>
                        <div className="col-span-2 min-w-0">
                          <dt className="text-[11px] text-slate-500">الأعمال</dt>
                          <dd className="text-slate-200 leading-snug" style={{ overflowWrap: 'anywhere' }}>{row.works || '—'}</dd>
                        </div>
                      </dl>

                      <div className="pt-2 border-t border-slate-800">
                        {renderDocumentActions(row, 'flex-wrap justify-start')}
                      </div>
                    </article>
                  );
                })}

                <div className="rounded-xl border border-emerald-700/60 bg-emerald-950/40 px-3 py-2.5 flex items-center justify-between gap-2 text-xs font-bold text-emerald-200">
                  <span>الإجمالي ({filteredRows.length} بند)</span>
                  <span className="font-mono font-black text-sm text-emerald-300" dir="ltr">{formatCleanNumber(liveTotals.totalAmount)} ج.م</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── REAL EXCEL SPREADSHEET GRID (WHITE PAPER SHEET) ── */}
        <div className={`${mobileView === 'cards' ? 'hidden md:block' : ''} rounded-2xl border-2 border-slate-300 bg-white text-slate-900 shadow-2xl overflow-hidden print:border-none print:shadow-none print:rounded-none`}>
          
          {/* Printable Header: Logo Top Right, Title Center, Date Left (Appears in Print) */}
          <div className="hidden print:flex items-start justify-between pb-3 border-b-2 border-black p-4 bg-white text-black">
            {/* 1. TOP RIGHT: Logo + Company Name */}
            <div className="text-right flex items-center gap-3 shrink-0">
              <img src="/eshbelia-logo.png" alt="شعار شركة اشبيلية" className="h-14 w-auto object-contain" />
              <div className="text-[11px] leading-snug">
                <div className="font-black text-sm text-black">شركة إشبيلية</div>
                <div className="text-[10px] text-slate-800 font-bold">للتطوير والاستثمار العقاري</div>
              </div>
            </div>

            {/* 2. CENTER: Title */}
            <div className="text-center self-center">
              <h1 className="text-base font-black text-black border-b-2 border-black pb-0.5 inline-block">
                تقرير المشتريات والتوريدات المعتمد ({dynamicReportTitle})
              </h1>
              <div className="text-[10px] font-bold text-slate-700 mt-0.5">
                ورقة إكسل المحاسبية — 12 عموداً
              </div>
            </div>

            {/* 3. TOP LEFT: Metadata */}
            <div className="text-left font-mono text-[10px] font-bold text-black" dir="rtl">
              <div><strong>تاريخ الطباعة:</strong> {new Date().toLocaleDateString('ar-EG')}</div>
              <div><strong>أوامر الشراء:</strong> {liveTotals.uniqueOrders}</div>
              <div><strong>الموردين:</strong> {liveTotals.uniqueSuppliers}</div>
              <div><strong>إجمالي البنود:</strong> {filteredRows.length}</div>
            </div>
          </div>

          {/* Sheet Tab Bar at top */}
          <div className="bg-[#e9ecef] border-b border-slate-300 px-4 py-2 flex items-center justify-between text-xs print:hidden">
            <div className="flex items-center gap-2 font-bold text-slate-700">
              <span className="text-emerald-700">📊</span>
              <span>ورقة العمل: مشتريات وتوريدات شركة اشبيلية ({dynamicReportTitle})</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono text-slate-600">
              <span>أوامر الشراء: <strong className="text-black">{liveTotals.uniqueOrders}</strong></span>
              <span>•</span>
              <span>الموردين: <strong className="text-black">{liveTotals.uniqueSuppliers}</strong></span>
              <span>•</span>
              <span>إجمالي البنود: <strong className="text-black">{filteredRows.length}</strong></span>
            </div>
          </div>

          {loading ? (
            <div className="flex min-h-[300px] items-center justify-center p-12 text-emerald-700">
              <div className="flex flex-col items-center gap-3 text-center">
                <span className="h-9 w-9 animate-spin rounded-full border-3 border-emerald-600 border-t-transparent" />
                <span className="text-xs font-bold text-slate-600">
                  جاري تحميل وحساب بيانات ورقة العمل...
                </span>
              </div>
            </div>
          ) : !data?.rows || data.rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-16 text-center bg-white text-slate-600">
              <span className="text-4xl mb-3">📋</span>
              <p className="text-base font-black text-slate-800">
                لا توجد بيانات مسجلة في هذا الشهر أو الفترة المحددة
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-md">
                قم بتعديل محدد الشهر أو القسم، أو اضغط على &quot;عرض: الكل&quot; لمشاهدة كافة الأوامر الصادرة.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[700px] overflow-y-auto">
              <table className="w-full text-right text-xs border-collapse min-w-[1200px]">
                
                {/* 1. Excel Column Letter Headers (A, B, C, D... M) */}
                <thead className="sticky top-0 z-20 bg-[#f1f5f9] border-b-2 border-slate-400 text-slate-700 select-none">
                  <tr className="text-[11px] font-mono text-center font-extrabold print:hidden">
                    <th className="border border-slate-300 px-1 py-1 w-8 bg-[#e2e8f0]">#</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">A</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">B</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">C</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">D</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">E</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">F</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">G</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">H</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">I</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">J</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">K</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0]">L</th>
                    <th className="border border-slate-300 px-2 py-1 bg-[#e2e8f0] w-36">M</th>
                  </tr>

                  {/* 2. Formal 13-Column Title Headers from Handwritten Note */}
                  <tr className="bg-[#f8fafc] text-slate-900 font-black text-[11.5px] border-b-2 border-slate-400 whitespace-nowrap">
                    <th className="border border-slate-300 px-1 py-2 text-center w-8 bg-[#e2e8f0]">م</th>
                    <th className="border border-slate-300 px-2.5 py-2 text-center whitespace-nowrap min-w-[100px]">
                      {dateBasis === 'po_date' ? 'تاريخ أمر الشراء' : (dateBasis === 'pr_date' ? 'تاريخ طلب الشراء' : 'تاريخ التوريد')}
                    </th>
                    <th className="border border-slate-300 px-2.5 py-2 text-center whitespace-nowrap min-w-[110px]">رقم أمر الشراء</th>
                    <th className="border border-slate-300 px-3 py-2 min-w-[170px]">الصنف</th>
                    <th className="border border-slate-300 px-2 py-2 text-center w-16">الوحدة</th>
                    <th className="border border-slate-300 px-2.5 py-2 text-center w-24">الكمية</th>
                    <th className="border border-slate-300 px-2.5 py-2 text-center w-24">سعر الوحدة</th>
                    <th className="border border-slate-300 px-3 py-2 text-center w-28 bg-emerald-50 text-emerald-900">سعر الكمية</th>
                    <th className="border border-slate-300 px-3 py-2 min-w-[140px]">أسم المورد</th>
                    <th className="border border-slate-300 px-2 py-2 text-center w-20">رقم القطعة</th>
                    <th className="border border-slate-300 px-2.5 py-2 text-center w-24">إسم المنطقة</th>
                    <th className="border border-slate-300 px-2.5 py-2 text-center w-24">القسم</th>
                    <th className="border border-slate-300 px-3 py-2 min-w-[170px]">الاعمال</th>
                    <th className="border border-slate-300 px-3 py-2 text-center whitespace-nowrap min-w-[250px] bg-slate-200/90 text-slate-900 font-black">
                      الإذن • الفاتورة • التسجيل
                    </th>
                  </tr>

                  {/* 3. Excel Filter Input Row under each column */}
                  {showColumnFilters && (
                    <tr className="bg-gray-50 border-b border-gray-300 text-xs">
                      <th className="p-0.5 border border-slate-300 text-center bg-gray-100 text-slate-400">—</th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="فلتر..."
                          value={colFilters.delivery_date || ''}
                          onChange={(e) => handleUpdateColFilter('delivery_date', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1.5 py-0.5 text-xs outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="الأمر..."
                          value={colFilters.po_number || ''}
                          onChange={(e) => handleUpdateColFilter('po_number', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1.5 py-0.5 text-xs outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="الصنف..."
                          value={colFilters.item_name || ''}
                          onChange={(e) => handleUpdateColFilter('item_name', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1.5 py-0.5 text-xs outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="الوحدة..."
                          value={colFilters.uom || ''}
                          onChange={(e) => handleUpdateColFilter('uom', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="كمية..."
                          value={colFilters.quantity || ''}
                          onChange={(e) => handleUpdateColFilter('quantity', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="سعر..."
                          value={colFilters.unit_price || ''}
                          onChange={(e) => handleUpdateColFilter('unit_price', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="إجمالي..."
                          value={colFilters.total_price || ''}
                          onChange={(e) => handleUpdateColFilter('total_price', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="المورد..."
                          value={colFilters.supplier_name || ''}
                          onChange={(e) => handleUpdateColFilter('supplier_name', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1.5 py-0.5 text-xs outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="قطعة..."
                          value={colFilters.parcel_reference || ''}
                          onChange={(e) => handleUpdateColFilter('parcel_reference', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="منطقة..."
                          value={colFilters.region || ''}
                          onChange={(e) => handleUpdateColFilter('region', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="القسم..."
                          value={colFilters.department_name || ''}
                          onChange={(e) => handleUpdateColFilter('department_name', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <input
                          type="text"
                          placeholder="الاعمال..."
                          value={colFilters.works || ''}
                          onChange={(e) => handleUpdateColFilter('works', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1.5 py-0.5 text-xs outline-none transition-all shadow-2xs"
                        />
                      </th>
                      <th className="p-1 border border-slate-300">
                        <select
                          value={colFilters.invoice_status || ''}
                          onChange={(e) => handleUpdateColFilter('invoice_status', e.target.value)}
                          className="w-full rounded bg-white border border-gray-300 text-gray-700 font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500 px-1 py-0.5 text-xs text-center outline-none transition-all shadow-2xs"
                        >
                          <option value="">كل الحالات</option>
                          <option value="VERIFIED">✅ تم التسجيل</option>
                          <option value="PENDING">⏳ بانتظار التسجيل</option>
                        </select>
                      </th>
                    </tr>
                  )}
                </thead>

                {/* 4. Table Rows with Clear Authentic Excel Cell Borders & PO Color Grouping */}
                <tbody>
                  {filteredRows.length > 0 ? (
                    filteredRows.map((row, idx) => {
                    const rowNumber = idx + 1;
                    const poKey = String(row.purchase_order_id || row.po_number || row.id);
                    const groupInfo = poGroupingMeta.get(poKey);
                    const groupIdx = groupInfo ? groupInfo.groupIdx : idx;
                    const palette = PO_PALETTES[groupIdx % PO_PALETTES.length];

                    const prevRow = idx > 0 ? filteredRows[idx - 1] : null;
                    const isFirstOfGroup = !prevRow || String(prevRow.purchase_order_id || prevRow.po_number) !== poKey;
                    const nextRow = idx < filteredRows.length - 1 ? filteredRows[idx + 1] : null;
                    const isLastOfGroup = !nextRow || String(nextRow.purchase_order_id || nextRow.po_number) !== poKey;

                    const rawItemName = (row.item_name || '').trim();
                    const isFictitiousOrEmpty = !rawItemName || rawItemName === 'صنف 00' || rawItemName === 'صنف 0' || rawItemName === '00' || rawItemName === '0';
                    const displayItemName = isFictitiousOrEmpty ? '---' : rawItemName;

                    const unitPriceNum = Number(row.unit_price || 0);
                    const totalPriceNum = Number(row.total_price || 0);
                    const isUnpriced = totalPriceNum <= 0;

                    return (
                      <tr
                        key={row.id}
                        className={`transition-colors ${palette.bg} ${palette.hover} ${
                          isLastOfGroup ? 'border-b-2 border-gray-300' : 'border-b border-gray-200/70'
                        } ${isFirstOfGroup && idx > 0 ? 'border-t-2 border-gray-300' : ''}`}
                      >
                        {/* Row Number (Excel Index Column with PO Accent Strip) */}
                        <td className={`border border-slate-300 px-1.5 py-1.5 text-center font-mono text-xs font-bold select-none ${palette.rowNumBg} ${palette.accentBorder}`}>
                          {rowNumber}
                        </td>

                        {/* A: التاريخ المحدد */}
                        <td
                          onClick={() => setSelectedCell(`A${rowNumber}`)}
                          className="border border-slate-300 px-2.5 py-1.5 text-center font-mono text-slate-800 whitespace-nowrap text-sm"
                        >
                          <div className="font-bold">
                            {dateBasis === 'po_date'
                              ? (row.po_date_formatted || row.po_date || '—')
                              : (dateBasis === 'pr_date'
                                ? (row.pr_date_formatted || row.pr_date || '—')
                                : (row.delivery_date_formatted || row.delivery_date || '—'))}
                          </div>
                          {dateBasis !== 'delivery_date' && row.delivery_date && (
                            <div className="text-[10px] text-slate-500 font-normal">
                              توريد: {row.delivery_date_formatted || row.delivery_date}
                            </div>
                          )}
                        </td>

                        {/* B: رقم أمر الشراء */}
                        <td
                          onClick={() => setSelectedCell(`B${rowNumber}`)}
                          className="border border-slate-300 px-2 py-1.5 text-center font-mono whitespace-nowrap"
                        >
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-black shadow-2xs ${palette.poTag}`}>
                            {row.po_number_short || row.po_number}
                          </span>
                        </td>

                        {/* C: الصنف */}
                        <td
                          onClick={() => setSelectedCell(`C${rowNumber}`)}
                          className="border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-900 leading-snug"
                        >
                          {isFictitiousOrEmpty ? (
                            <span className="text-gray-400 font-mono">---</span>
                          ) : (
                            displayItemName
                          )}
                        </td>

                        {/* D: الوحدة */}
                        <td
                          onClick={() => setSelectedCell(`D${rowNumber}`)}
                          className="border border-slate-300 px-2 py-1.5 text-center text-sm text-slate-700 whitespace-nowrap"
                        >
                          {getUnitLabel(row.uom) || row.uom || '—'}
                        </td>

                        {/* E: الكمية */}
                        <td
                          onClick={() => setSelectedCell(`E${rowNumber}`)}
                          className="border border-slate-300 px-2.5 py-1.5 text-center font-mono text-sm font-extrabold text-slate-900"
                          dir="ltr"
                        >
                          <div>{formatCleanQty(row.quantity)}</div>
                          {row.received_quantity !== undefined && row.received_quantity !== null && (
                            <div className="text-[10px] font-medium text-slate-500 font-sans mt-0.5" dir="rtl">
                              المستلم: <span className="font-mono font-bold text-slate-700">{formatCleanQty(row.received_quantity)}</span>
                            </div>
                          )}
                        </td>

                        {/* F: سعر الوحدة */}
                        <td
                          onClick={() => setSelectedCell(`F${rowNumber}`)}
                          className="border border-slate-300 px-2.5 py-1.5 text-center font-mono text-sm text-slate-800"
                          dir="ltr"
                        >
                          {unitPriceNum > 0 ? (
                            formatCleanNumber(row.unit_price)
                          ) : (
                            <span className="text-gray-400 text-sm font-normal" title="بانتظار التسعير">-</span>
                          )}
                        </td>

                        {/* G: سعر الكمية (الإجمالي) */}
                        <td
                          onClick={() => setSelectedCell(`G${rowNumber}`)}
                          className={`border border-slate-300 px-3 py-1.5 text-center font-mono text-sm ${
                            totalPriceNum > 0
                              ? 'font-black text-emerald-800 bg-emerald-50/50'
                              : 'text-gray-400 bg-slate-50/50'
                          }`}
                          dir="ltr"
                        >
                          {totalPriceNum > 0 ? (
                            formatCleanNumber(row.total_price)
                          ) : (
                            <span className="text-gray-400 text-xs font-normal" title="غير مسعر">(غير مسعر)</span>
                          )}
                        </td>

                        {/* H: أسم المورد */}
                        <td
                          onClick={() => setSelectedCell(`H${rowNumber}`)}
                          className="border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-800 max-w-[150px]"
                        >
                          <div className="truncate" title={row.supplier_name || '—'}>
                            {row.supplier_name || '—'}
                          </div>
                        </td>

                        {/* I: رقم القطعة */}
                        <td
                          onClick={() => setSelectedCell(`I${rowNumber}`)}
                          className="border border-slate-300 px-2 py-1.5 text-center font-mono text-sm font-bold text-amber-800 bg-amber-50/30"
                        >
                          {row.parcel_reference || '—'}
                        </td>

                        {/* J: إسم المنطقة */}
                        <td
                          onClick={() => setSelectedCell(`J${rowNumber}`)}
                          className="border border-slate-300 px-2.5 py-1.5 text-center text-sm text-slate-800 max-w-[120px]"
                        >
                          <div className="truncate" title={row.region || '—'}>
                            {row.region || '—'}
                          </div>
                        </td>

                        {/* K: القسم */}
                        <td
                          onClick={() => setSelectedCell(`K${rowNumber}`)}
                          className="border border-slate-300 px-2.5 py-1.5 text-center"
                        >
                          <span className="inline-block rounded bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-800">
                            {row.department_name || '—'}
                          </span>
                        </td>

                        {/* L: الاعمال */}
                        <td
                          onClick={() => setSelectedCell(`L${rowNumber}`)}
                          className="border border-slate-300 px-3 py-1.5 text-slate-700 text-sm max-w-[200px]"
                        >
                          <div className="truncate" title={row.works || '—'}>
                            {row.works || '—'}
                          </div>
                        </td>

                        {/* M: الإذن / تسجيل الفاتورة / الحالة */}
                        <td
                          onClick={() => setSelectedCell(`M${rowNumber}`)}
                          className="border border-slate-300 px-2 py-1.5 text-center whitespace-nowrap"
                        >
                          {renderDocumentActions(row, 'justify-center')}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td
                      colSpan={14}
                      className="border border-slate-300 py-16 text-center text-slate-600 bg-slate-50/50"
                    >
                      <div className="flex flex-col items-center justify-center gap-2">
                        <span className="text-3xl">🔍</span>
                        <p className="text-sm font-bold text-slate-800">
                          لا توجد بيانات مطابقة لخيارات الفلترة المدخلة
                        </p>
                        <p className="text-xs text-slate-500">
                          تأكد من صحة نص البحث أو جرّب تعديل نصوص الفلاتر في الأعمدة أعلاه.
                        </p>
                        {hasActiveColFilters && (
                          <button
                            type="button"
                            onClick={handleClearColFilters}
                            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-1.5 text-xs font-black shadow-sm transition-all"
                          >
                            <span>✕ مسح كافة فلاتر الأعمدة</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </tbody>

                {/* 5. Excel Total Formula Row with Double Bottom Underline */}
                <tfoot className="sticky bottom-0 z-10 bg-[#e2e8f0] border-t-2 border-slate-500 border-b-4 border-double border-slate-900 text-slate-900 font-black">
                  <tr className="text-xs">
                    <td className="border border-slate-300 px-1.5 py-2 text-center font-bold bg-[#cbd5e1]">Σ</td>
                    <td colSpan={4} className="border border-slate-300 px-3 py-2 text-center font-bold text-slate-800">
                      الإجمالي العام (=SUM لـ {filteredRows.length} بند مسجل)
                    </td>
                    <td className="border border-slate-300 px-2.5 py-2 text-center font-mono font-extrabold text-slate-900 text-sm" dir="ltr">
                      {formatCleanQty(liveTotals.totalQty)}
                    </td>
                    <td className="border border-slate-300 px-2 py-2 text-center text-slate-500">—</td>
                    <td className="border border-slate-300 px-3 py-2 text-center font-mono font-black text-sm text-emerald-800 bg-emerald-100" dir="ltr">
                      {formatCleanNumber(liveTotals.totalAmount)} ج.م
                    </td>
                    <td colSpan={6} className="border border-slate-300 px-3 py-2 text-slate-700 text-left text-[11px] font-mono">
                      أوامر الشراء: {liveTotals.uniqueOrders} | الموردين: {liveTotals.uniqueSuppliers} | المسجلة: {liveTotals.verifiedItemsCount} | بالانتظار: {liveTotals.pendingItemsCount}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Pagination Navigation Bar */}
          {data?.pagination && data.pagination.last_page > 1 && (
            <div className="bg-slate-50 border-t border-slate-300 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-700">
              <div className="flex items-center gap-2">
                <span className="font-semibold">صفحة</span>
                <span className="font-mono font-bold text-slate-900 bg-white border border-slate-300 rounded px-2 py-0.5">
                  {data.pagination.current_page}
                </span>
                <span>من</span>
                <span className="font-mono font-bold text-slate-900">{data.pagination.last_page}</span>
                <span className="text-slate-500 font-mono text-[11px] mr-2">
                  (عرض البنود من {data.pagination.from} إلى {data.pagination.to} من أصل {data.pagination.total} مسجل)
                </span>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={pageSize}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setPageSize(next);
                    setCurrentPage(1);
                  }}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:border-emerald-600 focus:outline-none"
                >
                  <option value={25}>25 بند بالصفحة</option>
                  <option value={50}>50 بند بالصفحة</option>
                  <option value={100}>100 بند بالصفحة</option>
                </select>

                <button
                  type="button"
                  disabled={currentPage <= 1 || refreshing}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className="rounded border border-slate-300 bg-white px-3 py-1 font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  السابق
                </button>
                <button
                  type="button"
                  disabled={currentPage >= (data?.pagination?.last_page || 1) || refreshing}
                  onClick={() => setCurrentPage((p) => Math.min(data?.pagination?.last_page || 1, p + 1))}
                  className="rounded border border-slate-300 bg-white px-3 py-1 font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  التالي
                </button>
              </div>
            </div>
          )}

          {/* Bottom Sheet Status Bar */}
          <div className="bg-[#f1f5f9] border-t border-slate-300 px-4 py-2 flex flex-wrap items-center justify-between text-[11px] text-slate-600 font-mono">
            <div className="flex items-center gap-4">
              <span>جاهز | READY</span>
              <span>•</span>
              <span>الصفوف المعروضة: <strong>{filteredRows.length}</strong></span>
              <span>•</span>
              <span>مجموع الكميات: <strong dir="ltr">{formatCleanQty(liveTotals.totalQty)}</strong></span>
              <span>•</span>
              <span>مجموع المبالغ: <strong dir="ltr">{formatCleanNumber(liveTotals.totalAmount)} EGP</strong></span>
            </div>
            <div className="text-[10px] text-slate-500">
              تحديث تلقائي • نظام إدارة المشتريات والحسابات
            </div>
          </div>
        </div>
      </div>

      {/* ── 3. UNIFIED INVOICE REGISTRATION MODAL (IN-PAGE POPUP) ── */}
      {canRegisterInvoice && selectedRowForInvoice && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm overflow-y-auto">
          <div
            className="relative w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl my-8 overflow-hidden"
            dir="rtl"
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-emerald-950/80 via-slate-900 to-slate-900 p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl p-2 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">🧾</span>
                <div>
                  <h3 className="text-base font-black text-white">تسجيل فاتورة مورد واعتماد بالحسابات</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    ربط إذن الاستلام المعتمد بالموقع مع أمر الشراء وتسجيل الفاتورة في القيود المالية
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseInvoiceModal}
                disabled={submittingInvoice}
                className="rounded-lg bg-slate-800 p-2 text-slate-400 hover:bg-slate-700 hover:text-white transition disabled:opacity-50"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitInvoice} className="p-6 space-y-5">
              {/* Order & Receipt Context Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-950/70 p-4 rounded-xl border border-slate-800 text-xs">
                <div>
                  <span className="text-slate-400 block text-[11px]">رقم أمر الشراء:</span>
                  <span className="font-mono font-black text-blue-400 text-sm">{selectedRowForInvoice.po_number}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">المورد:</span>
                  <span className="font-bold text-white truncate block">{selectedRowForInvoice.supplier_name}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">إذن الاستلام بالموقع:</span>
                  <span className="font-mono font-bold text-emerald-400">
                    {selectedRowForInvoice.receipt_number || (selectedRowForInvoice.receipt_id ? `#${selectedRowForInvoice.receipt_id}` : 'غير متوفر')}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">قيمة أمر الشراء:</span>
                  <span className="font-mono font-black text-amber-300 text-sm" dir="ltr">
                    {formatCleanNumber(selectedRowForInvoice.grand_total || selectedRowForInvoice.total_price)} ج.م
                  </span>
                </div>
              </div>

              {/* Weighbridge scale photo preview if available */}
              {selectedRowForInvoice.photo_url && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3.5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <img
                      src={getReceiptPhotoUrl({ photo_url: selectedRowForInvoice.photo_url })}
                      alt="إيصال الميزان البسكول"
                      className="h-14 w-20 object-cover rounded-lg border border-emerald-500/40 cursor-pointer shadow-sm hover:opacity-90 transition"
                      onClick={() => setPhotoZoomUrl(selectedRowForInvoice.photo_url || null)}
                    />
                    <div>
                      <div className="text-xs font-bold text-emerald-300">مرفق صورة بوليصة / ميزان البسكول المعتمدة بالموقع</div>
                      <div className="text-[11px] text-slate-400">تم التقاطها أثناء الاستلام وتأكيد الكميات الفعلية</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selectedRowForInvoice.photo_url.includes('drive.google.com') && (
                      <a
                        href={selectedRowForInvoice.photo_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-200 text-xs font-bold border border-emerald-500/30 transition flex items-center gap-1"
                      >
                        <span>📁</span> Drive ↗
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => setPhotoZoomUrl(selectedRowForInvoice.photo_url || null)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 text-xs font-bold border border-emerald-500/30 transition shrink-0"
                    >
                      🔍 تكبير الصورة
                    </button>
                  </div>
                </div>
              )}

              {/* Missing Receipt Warning */}
              {!selectedRowForInvoice.receipt_id && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200">
                  ⚠️ تنبيه: لا يوجد إذن استلام وفحص معتمد بالموقع لهذا الأمر حتى الآن. يتطلب النظام فحص واستلام المواد بالموقع أولاً لربط الفاتورة به.
                </div>
              )}

              {/* Form Input Fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    رقم فاتورة المورد <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="مثال: INV-10492"
                    value={invoiceForm.invoice_number}
                    onChange={(e) => setInvoiceForm((prev) => ({ ...prev, invoice_number: e.target.value }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs font-mono font-bold text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                  />
                  <span className="text-[10px] text-slate-400 mt-1 block">رقم الفاتورة المطبوع على إشعار المورد الورقي</span>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    مبلغ الفاتورة الإجمالي (ج.م) <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    min="0.01"
                    value={invoiceForm.amount}
                    onChange={(e) => setInvoiceForm((prev) => ({ ...prev, amount: e.target.value }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs font-mono font-black text-emerald-400 focus:border-emerald-500 focus:outline-none"
                    dir="ltr"
                  />
                  <span className="text-[10px] text-slate-400 mt-1 block">الإجمالي المعتمد للخصم والاستحقاق المالي</span>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    تاريخ الفاتورة <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={invoiceForm.invoice_date}
                    onChange={(e) => setInvoiceForm((prev) => ({ ...prev, invoice_date: e.target.value }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs font-mono text-white focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">
                    تاريخ الاستحقاق (اختياري)
                  </label>
                  <input
                    type="date"
                    value={invoiceForm.due_date}
                    onChange={(e) => setInvoiceForm((prev) => ({ ...prev, due_date: e.target.value }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs font-mono text-white focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5">ملاحظات الفاتورة</label>
                <textarea
                  rows={2}
                  value={invoiceForm.notes}
                  onChange={(e) => setInvoiceForm((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder="ملاحظات محاسبية أو بنود إضافية..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              {/* Cost Allocation to Land Parcels */}
              <div className="border-t border-slate-800 pt-4">
                <h4 className="text-xs font-bold text-slate-300 mb-2">توزيع التكلفة على قطع الأراضي (اختياري / موصى به):</h4>
                <LandAllocationEditor
                  parcels={parcels}
                  departments={data?.departments?.map((d) => ({ id: d.id, name: d.name, code: d.code })) || []}
                  allocations={allocations}
                  invoiceAmount={Number(invoiceForm.amount || 0)}
                  disabled={submittingInvoice}
                  onChange={setAllocations}
                  onParcelCreated={(newP) => setParcels((prev) => [...prev, newP])}
                />
              </div>

              {invoiceError && (
                <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs font-bold text-rose-300">
                  {invoiceError}
                </div>
              )}

              {/* Modal Actions */}
              <div className="border-t border-slate-800 pt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handlePrintInvoiceVoucher}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-800/40 text-xs font-bold transition shadow-sm"
                    title="طباعة سند تسجيل الفاتورة والمرفقات"
                  >
                    <span>🖨️</span> طباعة الفاتورة والمرفقات
                  </button>
                  <button
                    type="button"
                    onClick={handleShareInvoiceWhatsApp}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-800/50 text-xs font-bold transition shadow-sm"
                    title="مشاركة تفاصيل الفاتورة عبر تطبيق واتساب"
                  >
                    <span>📱</span> إرسال واتساب
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleCloseInvoiceModal}
                    disabled={submittingInvoice}
                    className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition disabled:opacity-50"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    disabled={submittingInvoice || !selectedRowForInvoice.receipt_id}
                    className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-xs font-black shadow-lg shadow-emerald-900/30 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submittingInvoice ? (
                      <>
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        <span>جاري حفظ واعتماد الفاتورة...</span>
                      </>
                    ) : (
                      <>
                        <span>✅</span>
                        <span>حفظ وتسجيل الفاتورة بالحسابات</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>

            {/* Hidden Printable Voucher for Print Engine */}
            <div id="printable-invoice-voucher" className="hidden p-8 bg-white text-black font-sans text-xs" dir="rtl">
              <div className="flex items-center justify-between border-b-2 border-black pb-3 mb-4">
                <div className="text-right">
                  <h1 className="text-base font-bold text-black">شركة إشبيلية للتطوير العقاري والمقاولات</h1>
                  <p className="text-xs text-gray-700">الإدارة المالية - قسم الحسابات والمشتريات</p>
                  <p className="text-[11px] text-gray-500 font-mono">تاريخ التقرير: {new Date().toLocaleDateString('ar-EG')}</p>
                </div>
                <div className="text-left font-mono">
                  <div className="border-2 border-black px-4 py-1.5 font-bold text-sm bg-gray-100 rounded">
                    سند تسجيل فاتورة مورد
                  </div>
                  <div className="text-xs mt-1 text-gray-700 font-bold">
                    رقم الفاتورة: {invoiceForm.invoice_number || 'مسودة قيد الحفظ'}
                  </div>
                </div>
              </div>

              <table className="w-full border-collapse border border-black text-xs mb-4">
                <tbody>
                  <tr>
                    <td className="border border-black bg-gray-100 p-2 font-bold w-1/4">المورد:</td>
                    <td className="border border-black p-2 w-1/4 font-bold">{selectedRowForInvoice.supplier_name}</td>
                    <td className="border border-black bg-gray-100 p-2 font-bold w-1/4">تاريخ الفاتورة:</td>
                    <td className="border border-black p-2 w-1/4 font-mono">{invoiceForm.invoice_date || '—'}</td>
                  </tr>
                  <tr>
                    <td className="border border-black bg-gray-100 p-2 font-bold">رقم أمر الشراء:</td>
                    <td className="border border-black p-2 font-mono font-bold">{selectedRowForInvoice.po_number}</td>
                    <td className="border border-black bg-gray-100 p-2 font-bold">إذن الاستلام بالموقع:</td>
                    <td className="border border-black p-2 font-mono font-bold text-emerald-800">
                      {selectedRowForInvoice.receipt_number || (selectedRowForInvoice.receipt_id ? `#${selectedRowForInvoice.receipt_id}` : '—')}
                    </td>
                  </tr>
                  <tr>
                    <td className="border border-black bg-gray-100 p-2 font-bold">المشروع / القطعة:</td>
                    <td className="border border-black p-2">{selectedRowForInvoice.parcel_reference || '—'} ({selectedRowForInvoice.region || '—'})</td>
                    <td className="border border-black bg-gray-100 p-2 font-bold">القسم الطالب:</td>
                    <td className="border border-black p-2">{selectedRowForInvoice.department_name || '—'}</td>
                  </tr>
                  <tr>
                    <td className="border border-black bg-gray-100 p-2 font-bold">الصنف وبيان الأعمال:</td>
                    <td className="border border-black p-2 font-semibold" colSpan={3}>
                      {selectedRowForInvoice.item_name} {selectedRowForInvoice.works ? ` - ${selectedRowForInvoice.works}` : ''}
                      {' '}(الكمية المعتمدة: {formatCleanQty(selectedRowForInvoice.quantity)} {selectedRowForInvoice.uom || ''} × سعر: {formatCleanNumber(selectedRowForInvoice.unit_price)} ج.م)
                    </td>
                  </tr>
                  <tr>
                    <td className="border border-black bg-gray-100 p-2 font-bold text-sm">إجمالي مبلغ الفاتورة:</td>
                    <td className="border border-black p-2 font-mono font-black text-sm" colSpan={3} dir="ltr">
                      {formatCleanNumber(invoiceForm.amount)} EGP (جنيه مصري)
                    </td>
                  </tr>
                  {invoiceForm.due_date && (
                    <tr>
                      <td className="border border-black bg-gray-100 p-2 font-bold">تاريخ الاستحقاق:</td>
                      <td className="border border-black p-2 font-mono" colSpan={3}>{invoiceForm.due_date}</td>
                    </tr>
                  )}
                  {invoiceForm.notes && (
                    <tr>
                      <td className="border border-black bg-gray-100 p-2 font-bold">ملاحظات الفاتورة:</td>
                      <td className="border border-black p-2" colSpan={3}>{invoiceForm.notes}</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {allocations.length > 0 && (
                <div className="mb-4">
                  <h3 className="font-bold text-xs mb-1">جدول توزيع التكلفة على قطع الأراضي والمشاريع:</h3>
                  <table className="w-full border-collapse border border-black text-[11px]">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="border border-black p-1 text-right">#</th>
                        <th className="border border-black p-1 text-right">رقم القطعة</th>
                        <th className="border border-black p-1 text-right">المبلغ المخصص (ج.م)</th>
                        <th className="border border-black p-1 text-right">الملاحظات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocations.map((alloc, idx) => {
                        const p = parcels.find(item => item.id === alloc.land_parcel_id);
                        return (
                          <tr key={idx}>
                            <td className="border border-black p-1 font-mono">{idx + 1}</td>
                            <td className="border border-black p-1 font-bold">{p?.parcel_reference || `قطعة #${alloc.land_parcel_id}`}</td>
                            <td className="border border-black p-1 font-mono font-bold">{formatCleanNumber(alloc.amount)}</td>
                            <td className="border border-black p-1">{alloc.notes || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {selectedRowForInvoice.photo_url && (
                <div className="mb-4 border border-black p-3 rounded page-break-inside-avoid">
                  <div className="font-bold text-xs mb-1.5 text-gray-900">مرفق صورة بوليصة ميزان البسكول المعتمدة من الموقع:</div>
                  <div className="text-center">
                    <img
                      src={selectedRowForInvoice.photo_url}
                      alt="بوليصة ميزان البسكول"
                      className="max-h-64 max-w-full mx-auto object-contain border border-gray-300 rounded shadow-sm"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4 pt-6 border-t-2 border-black text-center text-xs mt-6">
                <div>
                  <p className="font-bold">محاسب المشتريات / الموقع</p>
                  <p className="mt-8 text-gray-400">..............................</p>
                </div>
                <div>
                  <p className="font-bold">رئيس قسم الحسابات</p>
                  <p className="mt-8 text-gray-400">..............................</p>
                </div>
                <div>
                  <p className="font-bold">المدير المالي والتنفيذي</p>
                  <p className="mt-8 text-gray-400">..............................</p>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 3. RECEIPT ATTACHMENT PREVIEW MODAL ── */}
      {selectedRowForReceiptModal && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-950/85 backdrop-blur-md animate-fade-in"
          onClick={handleCloseReceiptModal}
        >
          <div
            className="relative w-full max-w-4xl max-h-[92vh] flex flex-col bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 bg-slate-950/80 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <span className="text-xl">📄</span>
                <div>
                  <h3 className="text-sm md:text-base font-bold text-white flex items-center gap-2">
                    <span>مستند إذن الاستلام بالموقع</span>
                    <span className="text-xs font-mono font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full">
                      أمر الشراء #{selectedRowForReceiptModal.po_number}
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    إذن رقم: <span className="font-mono font-bold text-emerald-400">{receiptAttachmentData?.receipt_number || selectedRowForReceiptModal.receipt_number || (selectedRowForReceiptModal.receipt_id ? `#${selectedRowForReceiptModal.receipt_id}` : '—')}</span>
                    {' '}• المورد: <span className="font-semibold text-slate-300">{receiptAttachmentData?.supplier_name || selectedRowForReceiptModal.supplier_name || '—'}</span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {receiptAttachmentData?.drive_link && (
                  <a
                    href={receiptAttachmentData.drive_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-xs font-bold transition hover:scale-105"
                    title="فتح الملف مباشرة في Google Drive"
                  >
                    <span>📁</span>
                    <span>Google Drive ↗</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleCloseReceiptModal}
                  className="rounded-lg bg-slate-800 p-2 text-slate-400 hover:bg-slate-700 hover:text-white transition cursor-pointer"
                  title="إغلاق (Esc)"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Context & Zoom Toolbar */}
            <div className="px-5 py-2.5 bg-slate-800/40 border-b border-slate-800 text-xs flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-300 text-[11px]">
                <div>
                  <span className="text-slate-400">تاريخ التوريد: </span>
                  <span className="font-mono text-slate-200">{receiptAttachmentData?.received_at || selectedRowForReceiptModal.delivery_date_formatted || selectedRowForReceiptModal.delivery_date || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400">القسم: </span>
                  <span className="text-slate-200">{selectedRowForReceiptModal.department_name || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400">القطعة: </span>
                  <span className="font-mono font-bold text-amber-300">{selectedRowForReceiptModal.parcel_reference || '—'}</span>
                </div>
                {receiptAttachmentData?.file_name && (
                  <div className="hidden md:block">
                    <span className="text-slate-400">الملف: </span>
                    <span className="font-mono text-slate-300">{receiptAttachmentData.file_name}</span>
                  </div>
                )}
              </div>

              {/* Controls */}
              <div className="flex items-center gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => setReceiptZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
                  disabled={receiptZoom <= 0.5}
                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded text-slate-300 font-bold cursor-pointer"
                  title="تصغير (-)"
                >
                  −
                </button>
                <span className="font-mono text-slate-300 px-1 text-[11px] min-w-[42px] text-center">
                  {Math.round(receiptZoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setReceiptZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))}
                  disabled={receiptZoom >= 3}
                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded text-slate-300 font-bold cursor-pointer"
                  title="تكبير (+)"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setReceiptRotation((r) => (r + 90) % 360)}
                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 text-[11px] cursor-pointer"
                  title="تدوير الصورة 90 درجة"
                >
                  ↻ تدوير
                </button>
                <button
                  type="button"
                  onClick={() => { setReceiptZoom(1); setReceiptRotation(0); }}
                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-400 text-[11px] cursor-pointer"
                  title="إعادة ضبط الحجم"
                >
                  إعادة ضبط
                </button>
              </div>
            </div>

            {/* Image Viewer Body */}
            <div className="relative flex-1 overflow-auto p-4 flex items-center justify-center min-h-[350px] max-h-[68vh] bg-slate-950/60">
              {receiptAttachmentLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-400">
                  <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm font-medium">جاري تحميل صورة ومرفق إذن الاستلام...</p>
                </div>
              ) : receiptAttachmentError && !receiptAttachmentData ? (
                <div className="text-center py-12 px-6">
                  <span className="text-3xl block mb-2">⚠️</span>
                  <p className="text-rose-400 text-sm font-semibold">{receiptAttachmentError}</p>
                  <p className="text-slate-400 text-xs mt-1">تأكد من وجود صورة مرفقة بإذن الاستلام وصلاحيات الوصول.</p>
                </div>
              ) : (
                (() => {
                  const rawUrl = receiptAttachmentData?.view_url || selectedRowForReceiptModal.photo_url || '';
                  const displayUrl = getReceiptPhotoUrl({
                    photo_url: rawUrl,
                    id: receiptAttachmentData?.receipt_id || selectedRowForReceiptModal.receipt_id || 0,
                  });

                  return receiptImgFailed ? (
                    <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-3">
                      <span className="text-4xl">📁</span>
                      <p className="text-sm font-bold text-slate-200">مستند إذن الاستلام مؤرشف على الخادم</p>
                      <p className="text-xs text-slate-400 max-w-md">تم تسجيل هذا الإذن قبل التحديث، المستندات الجديدة تُحفظ وتُعرض تلقائياً عبر سحابة Google Drive المشتركة.</p>
                      {receiptAttachmentData?.drive_link && (
                        <a
                          href={receiptAttachmentData.drive_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-md"
                        >
                          <span>📁 فتح في Google Drive</span>
                          <span>↗</span>
                        </a>
                      )}
                    </div>
                  ) : (
                    <div
                      className="transition-transform duration-150 ease-out flex items-center justify-center"
                      style={{
                        transform: `scale(${receiptZoom}) rotate(${receiptRotation}deg)`,
                        transformOrigin: 'center center',
                      }}
                    >
                      <img
                        src={displayUrl}
                        alt={`مرفق إذن استلام ${selectedRowForReceiptModal.po_number}`}
                        className="max-w-full max-h-[64vh] object-contain rounded-lg shadow-xl border border-slate-700 select-none"
                        loading="lazy"
                        onError={() => setReceiptImgFailed(true)}
                      />
                    </div>
                  );
                })()
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 bg-slate-950/90 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
              <div className="flex items-center gap-2">
                {receiptAttachmentData?.drive_link && (
                  <a
                    href={receiptAttachmentData.drive_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 font-bold underline inline-flex items-center gap-1"
                  >
                    <span>📁 فتح في Google Drive</span>
                    <span>↗</span>
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={handleCloseReceiptModal}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold transition cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 4. PHOTO ZOOM LIGHTBOX MODAL ── */}
      {photoZoomUrl && createPortal(
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/90 p-4 backdrop-blur-md"
          onClick={() => setPhotoZoomUrl(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] bg-slate-900 rounded-2xl overflow-hidden border border-slate-700 p-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-2 border-b border-slate-800 text-xs text-slate-300">
              <span className="font-bold">معاينة بوليصة / ميزان البسكول المعتمدة بالموقع</span>
              <button
                type="button"
                onClick={() => setPhotoZoomUrl(null)}
                className="rounded-lg bg-slate-800 hover:bg-slate-700 text-white px-2.5 py-1 text-xs font-bold"
              >
                ✕ إغلاق
              </button>
            </div>
            <div className="p-2 flex items-center justify-center">
              <img
                src={photoZoomUrl}
                alt="صورة الميزان البسكول"
                className="max-h-[80vh] w-auto mx-auto object-contain rounded-lg"
              />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default PurchasesReportView;
