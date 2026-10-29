import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  ApprovedReceipt,
  CreateSupplierInvoicePayload,
  LandParcel,
  SupplierInvoice,
  createSupplierInvoiceApi,
  getAccountingDepartmentsApi,
  getApprovedReceiptsForAccountingApi,
  getLandParcelsApi,
  getSupplierInvoicesApi,
  matchSupplierInvoiceApi,
} from '../../api/supplierFinance';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import ErrorMessage from '../../components/ErrorMessage';
import { parseApiError } from '../../utils/apiError';
import { getPurchaseReceiptByIdApi, getReceiptPhotoUrl } from '../../api/purchaseReceipts';
import TableColumnFilters from '../../components/ui/TableColumnFilters';
import { getDefaultDateFrom, getTodayInputDate } from '../../utils/dateFilters';
import { getUnitLabel } from '../../utils/units';
import LandAllocationEditor, { LandAllocationDraft } from '../../components/accounting/LandAllocationEditor';
import { SupplementItemBadge } from '../../components/common/SupplementItemBadge';
import { ThreeWayMatchPrintModal } from '../../components/accounting/ThreeWayMatchPrintModal';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { printDocumentOnly } from '../../utils/print';

const today = getTodayInputDate;
const cleanDate = (d?: string | null) => d ? String(d).slice(0, 10) : '—';
const money = (value: string | number | null | undefined) => `${formatCleanNumber(value)} ج.م`;


const receiptValue = (receipt: ApprovedReceipt) => {
  const po = receipt.purchase_order;
  if (po?.grand_total && Number(po.grand_total) > 0) {
    return Number(po.grand_total);
  }
  if (po?.items && po.items.length > 0) {
    return po.items.reduce((sum: number, it: any) => {
      const q = Number(it.quantity || 0);
      const p = Number(it.unit_price || 0);
      const lt = it.line_total !== undefined && it.line_total !== null && Number(it.line_total) > 0
        ? Number(it.line_total)
        : Math.round(q * p * 100) / 100;
      return sum + lt;
    }, 0);
  }
  return (receipt.items || []).reduce((sum, item) => {
    const poItem = item.purchase_order_item;
    const poQty = Number(poItem?.quantity ?? poItem?.actual_quantity ?? item.ordered_quantity ?? item.received_quantity ?? 0);
    const unitPrice = Number(poItem?.unit_price || 0);
    const lineTotal = poItem?.line_total !== undefined && poItem?.line_total !== null && Number(poItem.line_total) > 0
      ? Number(poItem.line_total)
      : Math.round(poQty * unitPrice * 100) / 100;
    return sum + lineTotal;
  }, 0);
};

export const SupplierPaymentsPage: React.FC = () => {
  const { hasRole } = useAuth();
  const isManagerOrExecutive = hasRole('procurement_manager') || hasRole('general_manager') || hasRole('execution_manager');
  const isDepartmentAccountant = !isManagerOrExecutive && (hasRole('site_accountant') || hasRole('licenses_accountant') || hasRole('buffet_accountant') || hasRole('development_accountant'));
  const isFinancialDirector = !isManagerOrExecutive && hasRole('accountant') && !isDepartmentAccountant && !hasRole('admin');
  const isSiteAccountant = isDepartmentAccountant;

  const [receipts, setReceipts] = useState<ApprovedReceipt[]>([]);
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [parcels, setParcels] = useState<LandParcel[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invoiceReceipt, setInvoiceReceipt] = useState<ApprovedReceipt | null>(null);
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);

  const [documentPreview, setDocumentPreview] = useState<ApprovedReceipt | null>(null);
  const [threeWayPrintReceipt, setThreeWayPrintReceipt] = useState<ApprovedReceipt | null>(null);
  const [searchParams] = useSearchParams();
  const [invoiceForm, setInvoiceForm] = useState({ invoice_number: '', invoice_date: today(), due_date: '', amount: '', land_allocations: [] as LandAllocationDraft[] });
  const [invoiceAllocationError, setInvoiceAllocationError] = useState<string | null>(null);
  const [invoiceModalError, setInvoiceModalError] = useState<string | null>(null);
  const defaultDateFrom = getDefaultDateFrom;
  const [receiptFilters, setReceiptFilters] = usePersistedState('accounting.receipt-filters.v3', { receipt: '', po: '', supplier: '', department: '', dateFrom: defaultDateFrom(), dateTo: today(), value: '', action: '' });
  const [invoiceFilters, setInvoiceFilters] = usePersistedState('accounting.invoice-filters.v3', { invoice: '', supplier: '', po: '', invoiceDateFrom: defaultDateFrom(), invoiceDateTo: today(), dueDate: '', action: '' });

  const validatePositiveAmount = (value: number, label: string): string | null => {
    if (!Number.isFinite(value) || value <= 0) {
      return `${label} يجب أن يكون رقماً أكبر من صفر.`;
    }
    return null;
  };

  const refreshReceipts = async () => {
    const data = await getApprovedReceiptsForAccountingApi();
    setReceipts(data);
    return data;
  };

  const refreshInvoices = async () => {
    const data = await getSupplierInvoicesApi();
    setInvoices(data);
    return data;
  };



  const refreshParcels = async () => {
    const data = await getLandParcelsApi();
    setParcels(data);
    return data;
  };

  const refreshDepartments = async () => {
    try {
      const data = await getAccountingDepartmentsApi();
      setDepartments(data || []);
      return data;
    } catch {
      return [];
    }
  };

  const openInvoiceForm = (receipt: ApprovedReceipt, currentParcels: LandParcel[] = parcels, currentDepts: Array<{ id: number; name: string; code: string }> = departments) => {
    if (isManagerOrExecutive || (!isDepartmentAccountant && !hasRole('admin'))) {
      setError('غير مصرح لك بتسجيل الفواتير المالية. هذا الإجراء مخصص للإدارة المالية ومحاسبي الأقسام فقط.');
      return;
    }
    setError(null);
    setNotice(null);
    setInvoiceReceipt(receipt);
    setInvoiceAllocationError(null);
    setInvoiceModalError(null);
    const rawVal = receiptValue(receipt);
    const receiptTotal = Number.isInteger(rawVal) ? rawVal.toString() : parseFloat(rawVal.toFixed(2)).toString();
    const defaultDeptId = receipt.purchase_order?.purchase_request?.department?.id || (currentDepts.length ? currentDepts[0].id : '');
    // #3 — Smart auto-fill: if only one parcel exists, auto-select it and fill amount
    const defaultAllocations: LandAllocationDraft[] = currentParcels.length === 1
      ? [{ land_parcel_id: currentParcels[0].id, department_id: defaultDeptId, amount: receiptTotal, notes: '' }]
      : [{ land_parcel_id: '', department_id: defaultDeptId, amount: '', notes: '' }];
    setInvoiceForm({
      invoice_number: '',
      invoice_date: today(),
      due_date: '',
      amount: receiptTotal,
      land_allocations: defaultAllocations,
    });
  };

  const handlePrintInvoiceVoucher = () => {
    printDocumentOnly('#printable-supplier-invoice-voucher', {
      title: `سند_فاتورة_${invoiceForm.invoice_number || invoiceReceipt?.purchase_order?.po_number || 'مورد'}`,
      orientation: 'portrait',
    });
  };

  const handleShareInvoiceWhatsApp = () => {
    if (!invoiceReceipt) return;
    const lines = [
      '🏢 *شركة إشبيلية للتطوير العقاري والمقاولات*',
      '🧾 *إشعار تسجيل فاتورة مورد بالحسابات*',
      '─────────────────────────',
      `📑 *رقم الفاتورة:* ${invoiceForm.invoice_number.trim() || 'مسودة قيد الحفظ'}`,
      `💰 *المبلغ الإجمالي:* ${formatCleanNumber(invoiceForm.amount)} ج.م`,
      `📅 *تاريخ الفاتورة:* ${invoiceForm.invoice_date || '—'}`,
      invoiceForm.due_date ? `⏳ *تاريخ الاستحقاق:* ${invoiceForm.due_date}` : '',
      '─────────────────────────',
      `🏬 *المورد:* ${invoiceReceipt.purchase_order?.supplier?.company_name || '—'}`,
      `📦 *أمر الشراء:* ${invoiceReceipt.purchase_order?.po_number || '—'}`,
      `📥 *إذن الاستلام بالموقع:* ${invoiceReceipt.receipt_number}`,
      `🏗️ *القسم:* ${invoiceReceipt.purchase_order?.purchase_request?.department?.name || '—'}`,
      '─────────────────────────',
      '✅ *تم تدقيق الفاتورة ومطابقتها ثلاثياً للإدراج في القيود المحاسبية.*',
    ].filter(Boolean);

    const url = `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
    window.open(url, '_blank');
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [approvedReceipts, _invoices, loadedParcels, loadedDepts] = (await Promise.all([
        refreshReceipts(),
        refreshInvoices(),
        refreshParcels(),
        refreshDepartments(),
      ])) as [ApprovedReceipt[], SupplierInvoice[], LandParcel[], Array<{ id: number; name: string; code: string }>];
      const requestedReceiptId = Number(searchParams.get('purchase_receipt_id') || searchParams.get('receipt_id') || 0);
      const isCreateInvoice = (searchParams.get('action') === 'create_invoice' || searchParams.get('action') === 'invoice') && isSiteAccountant;
      if (requestedReceiptId > 0) {
        const requestedReceipt = approvedReceipts.find((receipt) => receipt.id === requestedReceiptId);
        if (requestedReceipt) {
          if (isCreateInvoice) {
            openInvoiceForm(requestedReceipt, loadedParcels, loadedDepts);
          } else {
            setDocumentPreview(requestedReceipt);
          }
        } else {
          try {
            const linkedReceipt = await getPurchaseReceiptByIdApi(requestedReceiptId);
            if (isCreateInvoice) {
              openInvoiceForm(linkedReceipt as unknown as ApprovedReceipt, loadedParcels, loadedDepts);
            } else {
              setDocumentPreview(linkedReceipt as unknown as ApprovedReceipt);
            }
          } catch {
            setNotice('تم فتح شاشة الحسابات، لكن تعذر تحميل إذن الاستلام المرتبط بالرسالة.');
          }
        }
      }
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [searchParams.get('purchase_receipt_id'), searchParams.get('action')]);

  // Deep link from the dashboard «الفاتورة» button: narrow the invoices archive to the linked invoice(s).
  useEffect(() => {
    const invoiceNumber = searchParams.get('invoice_number');
    const invoicePo = searchParams.get('invoice_po');
    if (invoiceNumber || invoicePo) {
      setInvoiceFilters(current => ({ ...current, invoice: invoiceNumber || '', po: invoicePo || '' }));
    }
  }, [searchParams.get('invoice_number'), searchParams.get('invoice_po')]);

  const contains = (value: unknown, filter: string) => !filter || String(value ?? '').toLocaleLowerCase('ar-EG').includes(filter.toLocaleLowerCase('ar-EG'));
  const receiptHasNonDateSearch = Boolean(receiptFilters.receipt || receiptFilters.po || receiptFilters.supplier || receiptFilters.department || receiptFilters.value || receiptFilters.action);
  const invoiceHasNonDateSearch = Boolean(invoiceFilters.invoice || invoiceFilters.supplier || invoiceFilters.po || invoiceFilters.dueDate || invoiceFilters.action);
  const filteredReceipts = useMemo(() => receipts.filter((receipt) => { const receiptDate = String(receipt.received_at || '').slice(0, 10); return contains(receipt.receipt_number, receiptFilters.receipt) && contains(receipt.purchase_order?.po_number, receiptFilters.po) && contains(receipt.purchase_order?.supplier?.company_name, receiptFilters.supplier) && contains(receipt.purchase_order?.purchase_request?.department?.name, receiptFilters.department) && (receiptHasNonDateSearch || ((!receiptFilters.dateFrom || receiptDate >= receiptFilters.dateFrom) && (!receiptFilters.dateTo || receiptDate <= receiptFilters.dateTo))) && contains(receiptValue(receipt), receiptFilters.value) && contains('عرض تسجيل فاتورة', receiptFilters.action); }), [receipts, receiptFilters, receiptHasNonDateSearch]);
  const filteredInvoices = useMemo(() => invoices.filter((invoice) => { const invoiceDate = String(invoice.invoice_date || '').slice(0, 10); return contains(invoice.invoice_number, invoiceFilters.invoice) && contains(invoice.supplier?.company_name, invoiceFilters.supplier) && contains(invoice.purchase_order?.po_number, invoiceFilters.po) && (invoiceHasNonDateSearch || ((!invoiceFilters.invoiceDateFrom || invoiceDate >= invoiceFilters.invoiceDateFrom) && (!invoiceFilters.invoiceDateTo || invoiceDate <= invoiceFilters.invoiceDateTo))) && contains(invoice.due_date, invoiceFilters.dueDate) && contains('مسجلة في الأرشيف', invoiceFilters.action); }), [invoices, invoiceFilters, invoiceHasNonDateSearch]);

  const submitInvoice = async (event: FormEvent) => {
    event.preventDefault();
    if (!invoiceReceipt) return;
    setInvoiceModalError(null);
    setInvoiceAllocationError(null);

    const poId = invoiceReceipt.purchase_order_id || invoiceReceipt.purchase_order?.id;
    if (!poId) {
      setInvoiceModalError('بيانات أمر الشراء المرتبط غير متوفرة لهذا الإذن.');
      return;
    }

    const amount = Number(String(invoiceForm.amount || '').replace(/,/g, '').trim());
    const invoiceNumber = (invoiceForm.invoice_number || '').trim();
    if (invoiceForm.due_date && invoiceForm.due_date < invoiceForm.invoice_date) {
      setInvoiceModalError('تاريخ الاستحقاق لا يمكن أن يسبق تاريخ الفاتورة.');
      return;
    }
    const amountError = validatePositiveAmount(amount, 'مبلغ الفاتورة');
    if (amountError) {
      setInvoiceModalError(amountError);
      return;
    }
    const normalizedAllocations = (invoiceForm.land_allocations || [])
      .filter((allocation) => Boolean(allocation.land_parcel_id) && Number(allocation.amount) > 0)
      .map((allocation) => ({
        land_parcel_id: Number(allocation.land_parcel_id),
        department_id: allocation.department_id ? Number(allocation.department_id) : undefined,
        amount: Number(allocation.amount),
        notes: (allocation.notes || '').trim() || undefined,
      }));
    setSaving(true);
    setError(null);
    try {
      const payload: CreateSupplierInvoicePayload = {
        purchase_order_id: poId,
        purchase_receipt_id: invoiceReceipt.id,
        invoice_number: invoiceNumber || undefined,
        amount,
        invoice_date: invoiceForm.invoice_date,
        due_date: invoiceForm.due_date || undefined,
        land_allocations: normalizedAllocations.length > 0 ? normalizedAllocations : undefined,
      };
      const createdInvoice = await createSupplierInvoiceApi(payload);
      setInvoiceReceipt(null);
      // #6 — Auto 3-way matching: if invoice amount matches receipt value within 1% tolerance, auto-match
      const receiptTotal = receiptValue(invoiceReceipt);
      const tolerance = receiptTotal * 0.01;
      if (Math.abs(amount - receiptTotal) <= tolerance && createdInvoice?.id) {
        try {
          await matchSupplierInvoiceApi(createdInvoice.id);
          setNotice('تم تسجيل فاتورة المورد وإجراء المطابقة الثلاثية تلقائيًا ✅ — تم إغلاق دورة الشراء.');
        } catch {
          setNotice('تم تسجيل الفاتورة بنجاح. لم تتم المطابقة التلقائية — يمكنك تنفيذها يدويًا من أرشيف الفواتير.');
        }
      } else {
        setNotice('تم تسجيل فاتورة المورد بنجاح ✅' + (normalizedAllocations.length > 0 ? ' وتم ترحيل المصروف على قطع الأراضي.' : ''));
      }
      await Promise.all([refreshReceipts(), refreshInvoices(), refreshParcels()]);
    } catch (err) {
      const parsed = parseApiError(err).message;
      setInvoiceModalError(parsed);
    } finally {
      setSaving(false);
    }
  };

  const matchInvoice = async (invoice: SupplierInvoice) => {
    setSaving(true);
    setError(null);
    try {
      await matchSupplierInvoiceApi(invoice.id);
      setNotice(`تمت مطابقة الفاتورة ${invoice.invoice_number} مع أمر الشراء وإذن الاستلام.`);
      await refreshInvoices();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setSaving(false);
    }
  };





  if (loading) return <div className="min-h-[360px] p-6 text-sm font-bold text-cyan-300" dir="rtl">جاري تحميل إذونات الاستلام والفواتير...</div>;

  return (
    <div className="space-y-6 animate-fade-in" dir="rtl">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-black text-slate-100">
            {isSiteAccountant ? 'تسجيل فواتير الموردين ومطابقة الأذونات' : 'تسجيل فواتير الموردين والمطابقة الثلاثية'}
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            {isSiteAccountant
              ? 'إذونات الاستلام المعتمدة (التنفيذ، التشطيبات، المباني) → تسجيل فاتورة المورد → المطابقة → إغلاق الدورة.'
              : 'إذن الاستلام المعتمد → فاتورة المورد → المطابقة الثلاثية → إغلاق دورة الشراء.'}
          </p>
        </div>
        <span className="rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs font-bold text-amber-300">الجنيه المصري — بدون ضرائب أو خصومات</span>
      </div>

      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} onRetry={() => void load()} />}
      {notice && <div className="rounded-xl border border-cyan-700/60 bg-cyan-950/30 p-3 text-sm font-bold text-cyan-200">{notice}<button type="button" className="mr-3 text-cyan-400 underline" onClick={() => setNotice(null)}>إغلاق</button></div>}

      {/* #2 — Enhanced KPI Dashboard */}
      {(() => {
        const openInvoices = invoices.filter(inv => ['OPEN', 'PARTIALLY_PAID'].includes(inv.status));
        const overdueInvoices = openInvoices.filter(inv => inv.due_date && inv.due_date < today());
        const overdueTotal = overdueInvoices.reduce((sum, inv) => sum + Number(inv.outstanding_amount || 0), 0);
        const pendingMatch = invoices.filter(inv => inv.matching_status === 'PENDING');

        if (isSiteAccountant) {
          return (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card>
                <div className="text-[11px] text-slate-400">إذن استلام جاهز للفوترة</div>
                <div className="mt-2 text-2xl font-black text-amber-300">{receipts.length}</div>
              </Card>
              <Card>
                <div className="text-[11px] text-slate-400">إجمالي الفواتير المسجلة</div>
                <div className="mt-2 text-2xl font-black text-cyan-300">{invoices.length}</div>
              </Card>
              <Card className={pendingMatch.length ? 'border-amber-700/60 bg-amber-950/20' : undefined}>
                <div className="text-[11px] text-slate-400">بانتظار المطابقة</div>
                <div className={`mt-2 text-2xl font-black ${pendingMatch.length ? 'text-amber-400' : 'text-slate-500'}`}>
                  {pendingMatch.length}
                </div>
              </Card>
            </div>
          );
        }

        return (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {isFinancialDirector ? (
              <Card><div className="text-[11px] text-slate-400">إذونات بانتظار فوترة المحاسبين</div><div className="mt-2 text-2xl font-black text-slate-300">{receipts.length}</div><div className="mt-1 text-[10px] text-slate-500 font-medium">للعلم والمتابعة</div></Card>
            ) : (
              <Card><div className="text-[11px] text-slate-400">إذن استلام جاهز للفوترة</div><div className="mt-2 text-2xl font-black text-amber-300">{receipts.length}</div></Card>
            )}
            <Card><div className="text-[11px] text-slate-400">فواتير مفتوحة</div><div className="mt-2 text-2xl font-black text-cyan-300">{openInvoices.length}</div></Card>
            <Card><div className="text-[11px] text-slate-400">إجمالي المستحق للفواتير</div><div className="mt-2 text-2xl font-black text-emerald-300">{money(openInvoices.reduce((sum, inv) => sum + Number(inv.outstanding_amount || 0), 0))}</div></Card>
            <Card className={overdueInvoices.length ? 'border-rose-700/60 bg-rose-950/20' : undefined}><div className="text-[11px] text-slate-400">فواتير متأخرة</div><div className={`mt-2 text-2xl font-black ${overdueInvoices.length ? 'text-rose-400' : 'text-slate-500'}`}>{overdueInvoices.length}</div>{overdueInvoices.length > 0 && <div className="mt-1 text-[10px] font-bold text-rose-300">{money(overdueTotal)}</div>}</Card>
            <Card className={pendingMatch.length ? 'border-amber-700/60 bg-amber-950/20' : undefined}><div className="text-[11px] text-slate-400">بانتظار المطابقة</div><div className={`mt-2 text-2xl font-black ${pendingMatch.length ? 'text-amber-400' : 'text-slate-500'}`}>{pendingMatch.length}</div></Card>
          </div>
        );
      })()}
      <Card className="space-y-4">
        {isFinancialDirector && (
          <div className="rounded-xl border border-sky-800/40 bg-sky-950/20 p-3 text-xs text-sky-200 flex items-center gap-2.5">
            <span className="text-base shrink-0">ℹ️</span>
            <div>
              <strong className="font-bold text-sky-100">إشعار للمدير المالي (للعلم فقط):</strong>
              <span className="mr-1 text-sky-200">
                تسجيل فواتير التوريد مسند بالكامل لمحاسبي الأقسام المختصين (حبيبة لمشاريع التنفيذ والمباني والتشطيبات، م. أحمد للتراخيص، م. شروق للبوفيه). تُعرض إذونات الاستلام أدناه للاطلاع والمتابعة المالية فقط دون تسجيل فواتير.
              </span>
            </div>
          </div>
        )}
        <div>
          <h2 className="text-base font-black text-slate-100">
            {isFinancialDirector
              ? `إذونات الاستلام المعتمدة (بانتظار فوترة محاسبي الأقسام — للعلم فقط) (${filteredReceipts.length} من ${receipts.length})`
              : `إذونات الاستلام المعتمدة الجاهزة للفوترة (${filteredReceipts.length} من ${receipts.length})`}
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            {isFinancialDirector
              ? 'تُعرض هنا لمتابعة الإذونات المعتمدة فقط؛ تسجيل الفواتير مسؤولية محاسب كل قسم مختص.'
              : 'لا تظهر هنا إلا الإذونات التي اعتمدها مهندس الموقع ولم تسجل لها فاتورة.'}
          </p>
        </div>
        <TableColumnFilters filters={[{ key: 'receipt', label: 'إذن الاستلام', value: receiptFilters.receipt, onChange: (value) => setReceiptFilters(current => ({ ...current, receipt: value })) }, { key: 'po', label: 'أمر الشراء', value: receiptFilters.po, onChange: (value) => setReceiptFilters(current => ({ ...current, po: value })) }, { key: 'supplier', label: 'المورد', value: receiptFilters.supplier, onChange: (value) => setReceiptFilters(current => ({ ...current, supplier: value })) }, { key: 'department', label: 'القسم', value: receiptFilters.department, onChange: (value) => setReceiptFilters(current => ({ ...current, department: value })) }, { key: 'dateFrom', label: 'من تاريخ الاستلام', type: 'date', value: receiptFilters.dateFrom, onChange: (value) => setReceiptFilters(current => ({ ...current, dateFrom: value })) }, { key: 'dateTo', label: 'إلى تاريخ الاستلام', type: 'date', value: receiptFilters.dateTo, onChange: (value) => setReceiptFilters(current => ({ ...current, dateTo: value })) }, { key: 'value', label: 'قيمة المستلم', type: 'number', value: receiptFilters.value, onChange: (value) => setReceiptFilters(current => ({ ...current, value: value })) }, { key: 'action', label: 'الإجراء', value: receiptFilters.action, onChange: (value) => setReceiptFilters(current => ({ ...current, action: value })) }]} hasActiveFilters={Boolean(receiptFilters.receipt || receiptFilters.po || receiptFilters.supplier || receiptFilters.department || receiptFilters.dateFrom !== defaultDateFrom() || receiptFilters.dateTo !== today() || receiptFilters.value || receiptFilters.action)} onClear={() => setReceiptFilters({ receipt: '', po: '', supplier: '', department: '', dateFrom: defaultDateFrom(), dateTo: today(), value: '', action: '' })} />
        <div className="hidden min-w-0 md:block"><Table><TableHeader><TableRow><TableHead className="whitespace-nowrap">إذن الاستلام</TableHead><TableHead className="whitespace-nowrap">أمر الشراء</TableHead><TableHead className="whitespace-nowrap">المورد</TableHead><TableHead className="whitespace-nowrap">القسم</TableHead><TableHead className="whitespace-nowrap">تاريخ الاستلام</TableHead><TableHead className="whitespace-nowrap">قيمة المستلم</TableHead><TableHead className="whitespace-nowrap">الإجراء</TableHead></TableRow></TableHeader><TableBody>{filteredReceipts.map(receipt => <TableRow key={receipt.id}><TableCell className="whitespace-nowrap font-mono font-bold text-cyan-300">{receipt.receipt_number}</TableCell><TableCell className="whitespace-nowrap font-mono">{receipt.purchase_order?.po_number || '—'}</TableCell><TableCell className="max-w-[180px]">{receipt.purchase_order?.supplier?.company_name || '—'}</TableCell><TableCell className="max-w-[160px]">{receipt.purchase_order?.purchase_request?.department?.name || '—'}</TableCell><TableCell className="whitespace-nowrap font-mono">{receipt.received_at || '—'}</TableCell><TableCell className="whitespace-nowrap font-mono font-bold text-emerald-300">{money(receiptValue(receipt))}</TableCell><TableCell><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => setDocumentPreview(receipt)}>عرض المستند</Button>{isDepartmentAccountant ? <Button size="sm" variant="primary" className="whitespace-nowrap" onClick={() => openInvoiceForm(receipt)}>تسجيل فاتورة</Button> : <span className="rounded bg-slate-800/80 border border-slate-700/60 px-2 py-0.5 text-[10px] font-bold text-slate-400 whitespace-nowrap">مسند للمحاسب المختص</span>}<Button size="sm" variant="secondary" className="whitespace-nowrap border-cyan-700/70 text-cyan-200 hover:bg-cyan-950/60 hover:text-white" onClick={() => setThreeWayPrintReceipt(receipt)} title="طباعة دورة الطلب المجمعة (طلب الشراء + أمر الشراء + إذن الاستلام)">🖨️ طباعة الدورة (3 في 1)</Button></div></TableCell></TableRow>)}</TableBody></Table></div><div className="space-y-3 md:hidden">{filteredReceipts.map(receipt => <article key={`mobile-receipt-${receipt.id}`} className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/80 p-4"><div className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0 break-normal font-mono text-sm font-black text-cyan-300">{receipt.receipt_number}</span><span className={`shrink-0 text-[11px] ${isFinancialDirector ? 'text-slate-400' : 'text-emerald-300'}`}>{isFinancialDirector ? 'للعلم والمتابعة' : 'جاهز للفوترة'}</span></div><dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 text-xs min-[420px]:grid-cols-2"><div><dt className="text-slate-500">أمر الشراء</dt><dd className="mt-1 break-normal font-mono text-slate-300">{receipt.purchase_order?.po_number || '—'}</dd></div><div><dt className="text-slate-500">المورد</dt><dd className="mt-1 break-normal font-bold leading-6 text-slate-100">{receipt.purchase_order?.supplier?.company_name || 'غير محدد'}</dd></div><div><dt className="text-slate-500">القسم</dt><dd className="mt-1 break-normal text-slate-300">{receipt.purchase_order?.purchase_request?.department?.name || 'غير محدد'}</dd></div><div><dt className="text-slate-500">تاريخ الاستلام</dt><dd className="mt-1 whitespace-nowrap font-mono text-slate-300">{receipt.received_at || '—'}</dd></div><div className="min-[420px]:col-span-2"><dt className="text-slate-500">قيمة المستلم</dt><dd className="mt-1 whitespace-nowrap font-mono font-bold text-emerald-300">{money(receiptValue(receipt))}</dd></div></dl>{isDepartmentAccountant ? (<div className="mt-4 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2"><Button size="sm" variant="secondary" className="w-full whitespace-nowrap" onClick={() => setDocumentPreview(receipt)}>عرض المستند</Button><Button size="sm" variant="primary" className="w-full whitespace-nowrap" onClick={() => openInvoiceForm(receipt)}>تسجيل فاتورة</Button><Button size="sm" variant="secondary" className="w-full whitespace-nowrap min-[420px]:col-span-2 border-cyan-700/70 text-cyan-200 hover:bg-cyan-950/60" onClick={() => setThreeWayPrintReceipt(receipt)}>🖨️ طباعة دورة الطلب (طلب + أمر + استلام)</Button></div>) : (<div className="mt-4 flex flex-col gap-2"><Button size="sm" variant="secondary" className="w-full whitespace-nowrap" onClick={() => setDocumentPreview(receipt)}>عرض المستند</Button><Button size="sm" variant="secondary" className="w-full whitespace-nowrap border-cyan-700/70 text-cyan-200 hover:bg-cyan-950/60" onClick={() => setThreeWayPrintReceipt(receipt)}>🖨️ طباعة دورة الطلب (طلب + أمر + استلام)</Button><span className="text-center rounded bg-slate-800/80 border border-slate-700/60 py-1 text-[11px] font-bold text-slate-400">مسند لمحاسب القسم المختص (للعلم فقط)</span></div>)}</article>)}</div>
        {!filteredReceipts.length && <div className="py-8 text-center text-sm text-slate-500">{receipts.length ? 'لا توجد نتائج مطابقة للفلاتر الحالية.' : 'لا توجد إذونات استلام معتمدة تنتظر الفوترة.'}</div>}
      </Card>

      <Card className="space-y-4">
        <div><h2 className="text-base font-black text-slate-100">أرشيف الفواتير ({filteredInvoices.length} من {invoices.length})</h2><p className="mt-1 text-xs text-slate-400">{isSiteAccountant ? 'سجل الفواتير المسجلة الخاصة بأقسام التنفيذ والتشطيبات والمباني وحالة مطابقتها وإغلاق الدورة.' : 'كل فاتورة يتم تسجيلها ومطابقتها تغلق دورة الشراء، بينما يتم الصرف من شاشة كشف حسابات الموردين.'}</p></div>
        <TableColumnFilters filters={[{ key: 'invoice', label: 'الفاتورة', value: invoiceFilters.invoice, onChange: (value) => setInvoiceFilters(current => ({ ...current, invoice: value })) }, { key: 'supplier', label: 'المورد', value: invoiceFilters.supplier, onChange: (value) => setInvoiceFilters(current => ({ ...current, supplier: value })) }, { key: 'po', label: 'أمر الشراء', value: invoiceFilters.po, onChange: (value) => setInvoiceFilters(current => ({ ...current, po: value })) }, { key: 'invoiceDateFrom', label: 'الفاتورة من تاريخ', type: 'date', value: invoiceFilters.invoiceDateFrom, onChange: (value) => setInvoiceFilters(current => ({ ...current, invoiceDateFrom: value })) }, { key: 'invoiceDateTo', label: 'الفاتورة إلى تاريخ', type: 'date', value: invoiceFilters.invoiceDateTo, onChange: (value) => setInvoiceFilters(current => ({ ...current, invoiceDateTo: value })) }, { key: 'dueDate', label: 'تاريخ الاستحقاق', type: 'date', value: invoiceFilters.dueDate, onChange: (value) => setInvoiceFilters(current => ({ ...current, dueDate: value })) }, { key: 'action', label: 'الإجراءات', value: invoiceFilters.action, onChange: (value) => setInvoiceFilters(current => ({ ...current, action: value })) }]} hasActiveFilters={Boolean(invoiceFilters.invoice || invoiceFilters.supplier || invoiceFilters.po || invoiceFilters.invoiceDateFrom !== defaultDateFrom() || invoiceFilters.invoiceDateTo !== today() || invoiceFilters.dueDate || invoiceFilters.action)} onClear={() => setInvoiceFilters({ invoice: '', supplier: '', po: '', invoiceDateFrom: defaultDateFrom(), invoiceDateTo: today(), dueDate: '', action: '' })} />
        <div className="hidden min-w-0 md:block"><Table><TableHeader><TableRow><TableHead className="whitespace-nowrap">الفاتورة</TableHead><TableHead className="whitespace-nowrap">المورد</TableHead><TableHead className="whitespace-nowrap">أمر الشراء</TableHead><TableHead className="whitespace-nowrap">تاريخ الفاتورة</TableHead><TableHead className="whitespace-nowrap">تاريخ الاستحقاق</TableHead><TableHead className="whitespace-nowrap">الحالة</TableHead><TableHead className="whitespace-nowrap">توزيع مصروف القطع والأقسام</TableHead><TableHead className="whitespace-nowrap">الإجراءات</TableHead></TableRow></TableHeader><TableBody>{filteredInvoices.map(invoice => { const isOverdue = invoice.due_date && invoice.due_date < today() && ['OPEN', 'PARTIALLY_PAID'].includes(invoice.status); const dueSoon = !isOverdue && invoice.due_date && ['OPEN', 'PARTIALLY_PAID'].includes(invoice.status) && (() => { const due = new Date(invoice.due_date!); const now = new Date(today()); return (due.getTime() - now.getTime()) / 86400000 <= 7; })(); const overdueDays = isOverdue ? Math.ceil((new Date(today()).getTime() - new Date(invoice.due_date!).getTime()) / 86400000) : 0; return <TableRow key={invoice.id} className={isOverdue ? 'bg-rose-950/20' : dueSoon ? 'bg-amber-950/10' : undefined}><TableCell className="whitespace-nowrap font-mono font-bold text-cyan-300">{invoice.invoice_number}</TableCell><TableCell className="max-w-[180px] font-bold">{invoice.supplier?.company_name || '—'}</TableCell><TableCell className="whitespace-nowrap font-mono">{invoice.purchase_order?.po_number || '—'}</TableCell><TableCell className="whitespace-nowrap font-mono">{invoice.invoice_date || '—'}</TableCell><TableCell className="whitespace-nowrap font-mono">{invoice.due_date || '—'}{isOverdue && <div className="mt-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-black text-rose-300">⏰ متأخرة {overdueDays} يوم</div>}{dueSoon && <div className="mt-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-black text-amber-300">⚡ مستحقة قريباً</div>}</TableCell><TableCell>{invoice.matching_status === 'MATCHED' ? <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black text-emerald-300">✅ مطابقة</span> : <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-black text-amber-300">⏳ بانتظار المطابقة</span>}</TableCell><TableCell><div className="space-y-1 text-xs">{invoice.land_allocations?.length ? invoice.land_allocations.map((allocation) => <div key={allocation.id} className="whitespace-nowrap font-mono text-amber-300 flex items-center gap-1.5"><span>{allocation.parcel?.parcel_reference || `قطعة #${allocation.land_parcel_id}`}</span>{allocation.department?.name && <span className="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800/60 px-1.5 py-0.2 rounded">({allocation.department.name})</span>}<span>: {money(allocation.amount)}</span></div>) : <span className="text-slate-500">—</span>}</div></TableCell><TableCell>{invoice.matching_status === 'PENDING' ? <Button size="sm" variant="primary" className="whitespace-nowrap" onClick={() => void matchInvoice(invoice)}>تنفيذ المطابقة</Button> : <span className="whitespace-nowrap text-xs font-bold text-emerald-400">✅ دورة الشراء مكتملة ومطابقة</span>}</TableCell></TableRow>; })}</TableBody></Table></div><div className="space-y-3 md:hidden">{filteredInvoices.map(invoice => { const isOverdue = invoice.due_date && invoice.due_date < today() && ['OPEN', 'PARTIALLY_PAID'].includes(invoice.status); const dueSoon = !isOverdue && invoice.due_date && ['OPEN', 'PARTIALLY_PAID'].includes(invoice.status) && (() => { const due = new Date(invoice.due_date!); const now = new Date(today()); return (due.getTime() - now.getTime()) / 86400000 <= 7; })(); const overdueDays = isOverdue ? Math.ceil((new Date(today()).getTime() - new Date(invoice.due_date!).getTime()) / 86400000) : 0; return <article key={`mobile-invoice-${invoice.id}`} className={`min-w-0 rounded-2xl border p-4 ${isOverdue ? 'border-rose-700/60 bg-rose-950/20' : dueSoon ? 'border-amber-700/60 bg-amber-950/10' : 'border-slate-800 bg-slate-900/80'}`}><div className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0 break-normal font-mono text-sm font-black text-cyan-300">{invoice.invoice_number}</span><span className="shrink-0">{isOverdue ? <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-black text-rose-300">⏰ متأخرة {overdueDays} يوم</span> : dueSoon ? <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-black text-amber-300">⚡ قريباً</span> : invoice.matching_status === 'MATCHED' ? <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-black text-emerald-300">✅ مطابقة</span> : <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-black text-amber-300">⏳ بانتظار</span>}</span></div><dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 text-xs min-[420px]:grid-cols-2"><div><dt className="text-slate-500">المورد</dt><dd className="mt-1 break-normal font-bold leading-6 text-slate-100">{invoice.supplier?.company_name || 'غير محدد'}</dd></div><div><dt className="text-slate-500">أمر الشراء</dt><dd className="mt-1 break-normal font-mono text-slate-300">{invoice.purchase_order?.po_number || '—'}</dd></div><div><dt className="text-slate-500">تاريخ الفاتورة</dt><dd className="mt-1 whitespace-nowrap font-mono text-slate-300">{invoice.invoice_date || '—'}</dd></div><div><dt className="text-slate-500">تاريخ الاستحقاق</dt><dd className="mt-1 whitespace-nowrap font-mono text-slate-300">{invoice.due_date || '—'}</dd></div><div className="min-[420px]:col-span-2"><dt className="text-slate-500">توزيع مصروف القطع والأقسام</dt><dd className="mt-1 break-normal text-xs leading-6 text-amber-300">{invoice.land_allocations?.length ? invoice.land_allocations.map((allocation) => <div key={allocation.id} className="flex items-center gap-1.5"><span>{allocation.parcel?.parcel_reference || `قطعة #${allocation.land_parcel_id}`}</span>{allocation.department?.name && <span className="text-[10px] bg-cyan-950 text-cyan-300 border border-cyan-800/60 px-1.5 py-0.2 rounded">({allocation.department.name})</span>}<span>: {money(allocation.amount)}</span></div>) : '—'}</dd></div></dl>{invoice.matching_status === 'PENDING' ? <Button size="sm" variant="primary" className="mt-4 w-full" onClick={() => void matchInvoice(invoice)}>تنفيذ المطابقة</Button> : <p className="mt-4 break-normal text-xs font-bold leading-6 text-emerald-400">✅ دورة الشراء مكتملة ومطابقة</p>}</article>; })}</div>
        {!filteredInvoices.length && <div className="py-8 text-center text-sm text-slate-500">{invoices.length ? 'لا توجد نتائج مطابقة للفلاتر الحالية.' : 'لا توجد فواتير مسجلة في الأرشيف حتى الآن.'}</div>}
      </Card>

      {documentPreview && createPortal(
        <div className="modal-top-viewport fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/85 p-2 sm:p-4" role="dialog" aria-modal="true">
          <div className="max-h-[calc(100vh-1rem)] w-full max-w-6xl space-y-5 overflow-y-auto rounded-2xl border border-cyan-800/70 bg-slate-900 p-4 shadow-2xl sm:max-h-[calc(100vh-2rem)] sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black text-slate-100">مراجعة أمر الشراء وإذن الاستلام</h2>
                <p className="mt-1 text-xs text-slate-400">المستندان مرتبطان بنفس الطلب ويمكنك مراجعتهما قبل إنشاء فاتورة المورد.</p>
              </div>
              <button
                type="button"
                onClick={() => setDocumentPreview(null)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-2xl font-black text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                aria-label="إغلاق النافذة"
                title="إغلاق النافذة"
              >
                ×
              </button>
            </div>

            {/* Top Cards: PO & Receipt Headers */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-cyan-800/60 bg-cyan-950/20 p-4">
                <h3 className="text-sm font-black text-cyan-200">أمر الشراء</h3>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div><span className="text-slate-400 font-medium">الرقم</span><p className="mt-1 font-mono font-bold text-cyan-300">{documentPreview.purchase_order?.po_number || `PO #${documentPreview.purchase_order_id}`}</p></div>
                  <div><span className="text-slate-400 font-medium">المورد</span><p className="mt-1 font-bold text-slate-100">{documentPreview.purchase_order?.supplier?.company_name || '—'}</p></div>
                  <div><span className="text-slate-400 font-medium">الإجمالي</span><p className="mt-1 font-mono font-bold text-emerald-300">{money(documentPreview.purchase_order?.grand_total)}</p></div>
                  <div><span className="text-slate-400 font-medium">حالة الأمر</span><p className="mt-1 font-bold text-slate-100">{documentPreview.purchase_order?.status || '—'}</p></div>
                </div>
              </div>
              <div className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4">
                <h3 className="text-sm font-black text-amber-200">إذن الاستلام</h3>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div><span className="text-slate-400 font-medium">الرقم</span><p className="mt-1 font-mono font-bold text-amber-300">{documentPreview.receipt_number}</p></div>
                  <div><span className="text-slate-400 font-medium">الحالة</span><p className="mt-1 font-bold text-slate-100">{documentPreview.status}</p></div>
                  <div><span className="text-slate-400 font-medium">تاريخ الاستلام</span><p className="mt-1 font-mono font-bold text-slate-100">{cleanDate(documentPreview.received_at)}</p></div>
                  <div><span className="text-slate-400 font-medium">اعتماد الموقع</span><p className="mt-1 font-mono font-bold text-slate-100">{cleanDate(documentPreview.site_engineer_approved_at)}</p></div>
                </div>
              </div>
            </div>

            {/* Attached Photo from Warehouse Keeper in Document Preview */}
            {Boolean(documentPreview.photo_url || documentPreview.photo_path) && (
              <div className="rounded-xl border-2 border-cyan-500/60 bg-cyan-950/30 p-4 space-y-3 shadow-lg">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs sm:text-sm font-black text-cyan-200 flex items-center gap-2">
                    <span>📷</span> صورة فحص واستلام المخزن المرفقة (بون الميزان / وزنة الحديد):
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(documentPreview))}
                    className="text-xs font-bold text-cyan-400 hover:text-cyan-300 underline inline-flex items-center gap-1 cursor-pointer"
                  >
                    <span>🔍</span> تكبير ومعاينة الصورة بالحجم الكامل
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 bg-slate-950/90 p-3 rounded-xl border border-slate-800">
                  <div className="relative h-20 w-20 sm:h-24 sm:w-24 rounded-xl border-2 border-cyan-500/70 overflow-hidden bg-slate-900 shrink-0 flex items-center justify-center">
                    <img
                      src={getReceiptPhotoUrl(documentPreview)}
                      alt="صورة بون الميزان"
                      onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(documentPreview))}
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                        const fallback = e.currentTarget.parentElement?.querySelector('.photo-fallback');
                        if (fallback) fallback.classList.remove('hidden');
                      }}
                      className="h-full w-full object-cover cursor-pointer hover:scale-105 transition-transform"
                    />
                    <div className="photo-fallback hidden flex flex-col items-center justify-center p-1 text-center">
                      <span className="text-xl">📷</span>
                      <span className="text-[9px] text-slate-400 mt-1">غير متوفرة حالياً</span>
                    </div>
                  </div>

                  <div className="text-xs space-y-1.5 flex-1">
                    <p className="font-bold text-slate-100 text-sm">صورة وزنة الحديد / بون الميزان الفعلي الموثق من أمين المخزن</p>
                    <p className="text-slate-300">
                      يمكنك مراجعة الأوزان والأختام المطبوعة على بون الميزان ومطابقتها قبل تسجيل فاتورة المورد والصرف.
                    </p>
                    <button
                      type="button"
                      onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(documentPreview))}
                      className="text-xs font-bold text-cyan-400 hover:underline cursor-pointer"
                    >
                      اضغط هنا لمعاينة الصورة المكبرة ←
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 3 Detail Columns */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-slate-700 bg-slate-950/80 p-4">
                <h3 className="text-sm font-black text-slate-100 border-b border-slate-800 pb-2">بيانات دورة الطلب</h3>
                <div className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">رقم طلب الشراء:</span><strong className="font-mono text-cyan-300 font-bold">{documentPreview.purchase_order?.purchase_request?.request_number || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">مقدم الطلب:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.purchase_request?.requester?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">القسم:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.purchase_request?.department?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">المراجع:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.purchase_request?.assigned_reviewer?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">مهندس الموقع:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.purchase_request?.site_engineer?.name || documentPreview.site_engineer?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">تاريخ الاحتياج:</span><strong className="font-mono text-amber-300 font-bold">{cleanDate(documentPreview.purchase_order?.purchase_request?.date_needed)}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">ملاحظات الطلب:</span><strong className="text-slate-200 font-bold">{documentPreview.purchase_order?.purchase_request?.notes || '—'}</strong></div>
                </div>
              </div>
              <div className="rounded-xl border border-cyan-800/50 bg-slate-950/80 p-4">
                <h3 className="text-sm font-black text-cyan-200 border-b border-slate-800 pb-2">بيانات أمر الشراء المالية والتجارية</h3>
                <div className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">أنشأه:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.created_by?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">راجعته الحسابات:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.accounting_reviewer?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">الإجمالي المبدئي (Subtotal):</span><strong className="font-mono text-slate-300 font-bold">{money(documentPreview.purchase_order?.subtotal)}</strong></div>
                  <div className="flex justify-between items-center bg-emerald-950/60 px-2.5 py-1.5 rounded-lg border border-emerald-800/80"><span className="text-emerald-300 font-bold">إجمالي أمر الشراء الفعلي:</span><strong className="font-mono text-emerald-300 font-black">{money(documentPreview.purchase_order?.grand_total)}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">شروط الدفع:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.payment_terms || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">شروط التوريد:</span><strong className="text-slate-100 font-bold">{documentPreview.purchase_order?.delivery_terms || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">تاريخ التوريد المتوقع:</span><strong className="font-mono text-amber-300 font-bold">{cleanDate(documentPreview.purchase_order?.delivery_date)}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">ملاحظات مالية:</span><strong className="text-slate-200 font-bold">{documentPreview.purchase_order?.financial_notes || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">ملاحظات الأمر:</span><strong className="text-slate-200 font-bold">{documentPreview.purchase_order?.notes || '—'}</strong></div>
                </div>
              </div>
              <div className="rounded-xl border border-amber-800/50 bg-slate-950/80 p-4">
                <h3 className="text-sm font-black text-amber-200 border-b border-slate-800 pb-2">بيانات الاستلام والتوريد</h3>
                <div className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">أمين المخزن:</span><strong className="text-slate-100 font-bold">{documentPreview.warehouse_keeper?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">وقت إرسال الاستلام:</span><strong className="font-mono text-slate-100 font-bold">{cleanDate(documentPreview.warehouse_submitted_at)}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">ملاحظات المخزن:</span><strong className="text-slate-200 font-bold">{documentPreview.warehouse_notes || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">مهندس الموقع:</span><strong className="text-slate-100 font-bold">{documentPreview.site_engineer?.name || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">وقت اعتماد الموقع:</span><strong className="font-mono text-slate-100 font-bold">{cleanDate(documentPreview.site_engineer_approved_at)}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">ملاحظات مهندس الموقع:</span><strong className="text-slate-200 font-bold">{documentPreview.site_engineer_notes || '—'}</strong></div>
                  <div className="flex justify-between items-center bg-slate-900/90 px-2.5 py-1.5 rounded-lg border border-slate-800"><span className="text-slate-300 font-bold">سبب الرفض:</span><strong className="text-slate-200 font-bold">{documentPreview.rejection_reason || '—'}</strong></div>
                </div>
              </div>
            </div>

            {/* Items Table */}
            <div className="rounded-xl border border-slate-700 bg-slate-950/50 p-4">
              <h3 className="mb-3 text-sm font-black text-slate-100">تفاصيل البنود في المستندين</h3>
              <div className="hidden min-w-0 md:block overflow-x-auto">
                <Table className="min-w-[850px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">اسم الصنف</TableHead>
                      <TableHead className="whitespace-nowrap">رقم القطعة</TableHead>
                      <TableHead className="whitespace-nowrap">المنطقة</TableHead>
                      <TableHead className="whitespace-nowrap">الكمية المطلوبة (PR)</TableHead>
                      <TableHead className="whitespace-nowrap">كمية أمر الشراء (PO)</TableHead>
                      <TableHead className="whitespace-nowrap">الكمية المستلمة</TableHead>
                      <TableHead className="whitespace-nowrap">الوحدة</TableHead>
                      <TableHead className="whitespace-nowrap">سعر الوحدة</TableHead>
                      <TableHead className="whitespace-nowrap">إجمالي البند</TableHead>
                      <TableHead className="whitespace-nowrap">المواصفات والملاحظات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(documentPreview.items || []).map((item) => {
                      const poItem = item.purchase_order_item;
                      const finalQty = poItem?.quantity !== undefined ? Number(poItem.quantity) : Number(item.ordered_quantity || 0);
                      const unitPrice = Number(poItem?.unit_price || 0);
                      const finalLineTotal = poItem?.line_total !== undefined && Number(poItem.line_total) > 0
                        ? Number(poItem.line_total)
                        : Math.round(finalQty * unitPrice * 100) / 100;

                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-bold text-slate-100">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span>{poItem?.item_name || poItem?.item_description || '—'}</span>
                              <SupplementItemBadge
                                isSupplementary={poItem?.is_supplementary}
                                batchNumber={poItem?.supplement_batch}
                              />
                            </div>
                          </TableCell>
                          <TableCell className="font-mono font-bold text-cyan-300">{poItem?.item_reference || '—'}</TableCell>
                          <TableCell className="text-slate-200">{poItem?.region || '—'}</TableCell>
                          <TableCell className="font-mono font-bold text-slate-200">{poItem?.pr_item?.quantity ?? '—'}</TableCell>
                          <TableCell className="font-mono font-bold text-cyan-200">{formatCleanQty(finalQty)}</TableCell>
                          <TableCell className="font-mono font-black text-emerald-300">{formatCleanQty(item.received_quantity)}</TableCell>
                          <TableCell className="font-bold text-slate-200">{getUnitLabel(poItem?.uom)}</TableCell>
                          <TableCell className="font-mono font-bold text-slate-200">{money(unitPrice)}</TableCell>
                          <TableCell className="font-mono font-black text-emerald-300">{money(finalLineTotal)}</TableCell>
                          <TableCell className="max-w-xs whitespace-normal text-xs text-slate-300">
                            <div>مواصفات: {poItem?.specifications || poItem?.pr_item?.specifications || '—'}</div>
                            <div>ملاحظات: {item.notes || poItem?.pr_item?.notes || '—'}</div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-3 md:hidden">
                {(documentPreview.items || []).map((item, idx) => {
                  const poItem = item.purchase_order_item;
                  const finalQty = poItem?.quantity !== undefined ? Number(poItem.quantity) : Number(item.ordered_quantity || 0);
                  const unitPrice = Number(poItem?.unit_price || 0);
                  const lineTotal = poItem?.line_total !== undefined && Number(poItem.line_total) > 0
                    ? Number(poItem.line_total)
                    : Math.round(finalQty * unitPrice * 100) / 100;
                  return (
                    <article key={`mobile-preview-item-${item.id}`} className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-3">
                      <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2">
                        <div className="min-w-0">
                          <span className="inline-block rounded bg-cyan-950 px-2 py-0.5 font-mono text-[10px] font-bold text-cyan-300 border border-cyan-800/60 mb-1">بند {idx + 1}</span>
                          <h4 className="font-bold text-slate-100 text-xs flex items-center gap-1.5 flex-wrap">
                            <span>{poItem?.item_name || poItem?.item_description || '—'}</span>
                            <SupplementItemBadge
                              isSupplementary={poItem?.is_supplementary}
                              batchNumber={poItem?.supplement_batch}
                            />
                          </h4>
                        </div>
                        <span className="shrink-0 rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 font-bold">{getUnitLabel(poItem?.uom)}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><span className="text-slate-400 font-bold block text-[10px]">رقم القطعة</span><strong className="font-mono text-cyan-300">{poItem?.item_reference || '—'}</strong></div>
                        <div><span className="text-slate-400 font-bold block text-[10px]">المنطقة</span><strong className="text-slate-100 font-bold">{poItem?.region || '—'}</strong></div>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-slate-950/80 p-2.5 text-center text-xs border border-slate-800/60">
                        <div><span className="text-[10px] text-slate-400 font-bold block">الكمية المطلوبة (PR)</span><strong className="font-mono text-slate-100 font-bold">{poItem?.pr_item?.quantity ?? '—'}</strong></div>
                        <div><span className="text-[10px] text-slate-400 font-bold block">كمية أمر الشراء (PO)</span><strong className="font-mono text-cyan-300 font-bold">{formatCleanQty(finalQty)}</strong></div>
                        <div><span className="text-[10px] text-slate-400 font-bold block">الكمية المستلمة</span><strong className="font-mono text-emerald-400 font-black">{formatCleanQty(item.received_quantity)}</strong></div>
                      </div>
                      <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-800/60">
                        <div><span className="text-slate-400 font-bold text-[10px]">سعر الوحدة: </span><span className="font-mono text-slate-200 font-bold">{money(unitPrice)}</span></div>
                        <div><span className="text-slate-400 font-bold text-[10px]">الإجمالي: </span><strong className="font-mono text-emerald-400 font-black">{money(lineTotal)}</strong></div>
                      </div>
                      {(poItem?.specifications || item.notes) && (
                        <div className="text-[11px] text-slate-300 bg-slate-950/50 rounded-lg p-2 space-y-1">
                          {poItem?.specifications && <div><span className="text-slate-400 font-bold">المواصفات: </span>{poItem.specifications}</div>}
                          {item.notes && <div><span className="text-slate-400 font-bold">الملاحظات: </span>{item.notes}</div>}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
              <Button type="button" variant="secondary" className="min-h-10 text-xs" onClick={() => setDocumentPreview(null)}>إغلاق</Button>
              <Button
                type="button"
                variant="secondary"
                className="min-h-10 text-xs font-bold border-cyan-700/70 text-cyan-200 hover:bg-cyan-950/60 hover:text-white"
                onClick={() => setThreeWayPrintReceipt(documentPreview)}
              >
                🖨️ طباعة دورة الطلب (3 في 1)
              </Button>
              {isDepartmentAccountant ? (
                <Button
                  type="button"
                  variant="primary"
                  className="min-h-10 text-xs font-bold"
                  onClick={() => {
                    const receipt = documentPreview;
                    setDocumentPreview(null);
                    openInvoiceForm(receipt);
                  }}
                >
                  تسجيل فاتورة المورد
                </Button>
              ) : (
                <span className="inline-flex items-center justify-center rounded-xl bg-slate-800/80 border border-slate-700/60 px-3 py-2 text-xs font-bold text-slate-400">
                  مسند لمحاسب القسم المختص للتسجيل
                </span>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {invoiceReceipt && createPortal(
        <div className="modal-top-viewport fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/85 p-2 sm:p-4" role="dialog" aria-modal="true">
          <form onSubmit={submitInvoice} className="max-h-[calc(100vh-1rem)] w-full max-w-5xl space-y-5 overflow-y-auto rounded-2xl border border-cyan-800/80 bg-slate-900 p-4 shadow-2xl sm:max-h-[calc(100vh-2rem)] sm:p-6">
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-lg font-black text-slate-100 flex items-center gap-2">
                  <span>🧾</span> تسجيل فاتورة المورد
                </h2>
                <p className="mt-1 text-xs text-slate-400 font-medium">
                  {invoiceReceipt.receipt_number} — المورد: <strong className="text-slate-200">{invoiceReceipt.purchase_order?.supplier?.company_name || 'المورد'}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInvoiceReceipt(null)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-2xl font-black text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                aria-label="إغلاق النافذة"
                title="إغلاق النافذة"
              >
                ×
              </button>
            </div>

            {/* 1. Supporting Summary Card — All context right in front of the accountant */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-cyan-800/60 bg-cyan-950/30 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-cyan-300">📋 بيانات أمر الشراء الفعلي</span>
                  <span className="font-mono text-xs font-bold text-cyan-200">{invoiceReceipt.purchase_order?.po_number || `PO #${invoiceReceipt.purchase_order_id}`}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-slate-400 block text-[10px]">المورد</span><strong className="text-slate-200">{invoiceReceipt.purchase_order?.supplier?.company_name || '—'}</strong></div>
                  <div><span className="text-slate-400 block text-[10px]">إجمالي أمر الشراء الفعلي</span><strong className="font-mono text-emerald-300">{money(invoiceReceipt.purchase_order?.grand_total)}</strong></div>
                  <div><span className="text-slate-400 block text-[10px]">شروط الدفع</span><span className="text-slate-300">{invoiceReceipt.purchase_order?.payment_terms || 'حسب الاتفاق'}</span></div>
                  <div><span className="text-slate-400 block text-[10px]">القسم الطالب</span><span className="text-slate-300">{invoiceReceipt.purchase_order?.purchase_request?.department?.name || '—'}</span></div>
                </div>
              </div>

              <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-amber-300">📦 بيانات إذن الاستلام المعتمد</span>
                  <span className="font-mono text-xs font-bold text-amber-200">{invoiceReceipt.receipt_number}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-slate-400 block text-[10px]">تاريخ الاستلام الفعلي</span><strong className="font-mono text-slate-200">{invoiceReceipt.received_at || '—'}</strong></div>
                  <div><span className="text-slate-400 block text-[10px]">القيمة المستلمة المعتمدة</span><strong className="font-mono text-emerald-300">{money(receiptValue(invoiceReceipt))}</strong></div>
                  <div><span className="text-slate-400 block text-[10px]">أمين المخزن</span><span className="text-slate-300">{invoiceReceipt.warehouse_keeper?.name || 'تم الفحص'}</span></div>
                  <div><span className="text-slate-400 block text-[10px]">اعتماد مهندس الموقع</span><span className="text-emerald-300 font-bold">✅ معتمد</span></div>
                </div>
              </div>
            </div>

            {/* Attached Photo from Warehouse Keeper (Weighbridge / Scale Photo) */}
            {Boolean(invoiceReceipt.photo_url || invoiceReceipt.photo_path) && (
              <div className="rounded-xl border border-cyan-500/50 bg-cyan-950/30 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs sm:text-sm font-black text-cyan-200 flex items-center gap-2">
                    <span>📷</span> صورة بون الميزان / استلام المخزن المرفقة:
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(invoiceReceipt))}
                    className="text-xs font-bold text-cyan-400 hover:text-cyan-300 underline inline-flex items-center gap-1 cursor-pointer"
                  >
                    <span>🔍</span> تكبير ومعاينة الصورة
                  </button>
                </div>
                <div className="flex items-center gap-3 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800">
                  <img
                    src={getReceiptPhotoUrl(invoiceReceipt)}
                    alt="صورة بون الميزان"
                    onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(invoiceReceipt))}
                    className="h-16 w-16 sm:h-20 sm:w-20 rounded-lg object-cover border border-cyan-500/60 cursor-pointer hover:scale-105 transition-transform shrink-0"
                  />
                  <div className="text-xs space-y-1">
                    <p className="font-bold text-slate-100">صورة وزنة الحديد / بون الميزان الفعلي المرفوعة من أمين المخزن</p>
                    <p className="text-slate-400 text-[11px]">يمكنك تدقيق الوزن والأختام المسجلة بالصورة قبل اعتماد الفاتورة والصرف.</p>
                  </div>
                </div>
              </div>
            )}

            {/* 2. Items & Received Quantities Reference Table */}
            {invoiceReceipt.items && invoiceReceipt.items.length > 0 && (
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200">🔍 البنود المستلمة ومطابقة الأسعار:</span>
                  <span className="text-[11px] text-slate-400">({invoiceReceipt.items.length} صنف مستلم)</span>
                </div>
                {/* Mobile-First Item Cards for phone screens */}
                <div className="space-y-2.5 sm:hidden">
                  {invoiceReceipt.items.map((item, idx) => {
                    const poItem = item.purchase_order_item;
                    const lineTotal = Number(item.received_quantity || 0) * Number(poItem?.unit_price || 0);
                    const matchPoItem = invoiceReceipt.purchase_order?.items?.find((p: any) => p.id === poItem?.id || (p.item_description && p.item_description === poItem?.item_description));
                    const prQty = poItem?.pr_item?.quantity 
                      ?? (poItem as any)?.pr_item_quantity 
                      ?? matchPoItem?.pr_item?.quantity 
                      ?? (matchPoItem as any)?.pr_item_quantity 
                      ?? null;
                    const poQty = poItem?.quantity 
                      ?? matchPoItem?.quantity 
                      ?? item.ordered_quantity 
                      ?? null;
                    const receivedQty = item.received_quantity;
                    const uomLabel = getUnitLabel(poItem?.uom || poItem?.pr_item?.uom || matchPoItem?.uom);

                    return (
                      <div
                        key={item.id || idx}
                        className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-2.5 shadow-sm text-xs"
                      >
                        <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2">
                          <div className="font-bold text-slate-100 leading-snug flex items-center gap-1.5 flex-wrap">
                            <span className="text-cyan-400 ml-1">#{idx + 1}</span>
                            <span>{poItem?.item_name || poItem?.item_description || '—'}</span>
                            <SupplementItemBadge
                              isSupplementary={poItem?.is_supplementary}
                              batchNumber={poItem?.supplement_batch}
                            />
                          </div>
                          <span className="shrink-0 rounded-lg bg-emerald-950/80 border border-emerald-700/60 px-2.5 py-1 font-mono font-black text-emerald-300 text-xs">
                            {money(lineTotal)}
                          </span>
                        </div>

                        {/* مقارنة الكميات الثلاث: طلب الشراء • أمر الشراء الفعلي • المستلم */}
                        <div className="grid grid-cols-3 gap-2 text-[11px]">
                          <div className="rounded-lg bg-slate-950/90 border border-slate-800 px-2 py-1.5 flex flex-col items-center justify-center text-center">
                            <span className="text-slate-400 text-[10px]">طلب الشراء (PR)</span>
                            <strong className="font-mono text-slate-200 font-bold mt-0.5">
                              {prQty !== null ? `${formatCleanQty(prQty)} ${uomLabel}` : '—'}
                            </strong>
                          </div>
                          <div className="rounded-lg bg-slate-950/90 border border-slate-800 px-2 py-1.5 flex flex-col items-center justify-center text-center">
                            <span className="text-slate-400 text-[10px]">أمر الشراء (PO)</span>
                            <strong className="font-mono text-cyan-300 font-bold mt-0.5">
                              {poQty !== null ? `${formatCleanQty(poQty)} ${uomLabel}` : '—'}
                            </strong>
                          </div>
                          <div className="rounded-lg bg-slate-950/90 border border-slate-800 px-2 py-1.5 flex flex-col items-center justify-center text-center">
                            <span className="text-slate-400 text-[10px]">المستلم (GRN)</span>
                            <strong className="font-mono text-emerald-300 font-black mt-0.5">
                              {receivedQty !== undefined && receivedQty !== null ? `${formatCleanQty(receivedQty)} ${uomLabel}` : '—'}
                            </strong>
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 text-[11px] pt-1">
                          <div className="rounded-lg bg-slate-950/90 border border-slate-800 px-2.5 py-1.5 flex items-center justify-between">
                            <span className="text-slate-400">السعر:</span>
                            <strong className="font-mono text-slate-200 font-bold">
                              {money(poItem?.unit_price)}
                            </strong>
                          </div>
                          <div className="rounded-lg bg-slate-950/90 border border-slate-800 px-2.5 py-1.5 flex items-center justify-between">
                            <span className="text-slate-400">القطعة:</span>
                            <strong className="font-mono text-cyan-300 font-bold">
                              {poItem?.item_reference || '—'}
                            </strong>
                          </div>
                          <div className="rounded-lg bg-slate-950/90 border border-slate-800 px-2.5 py-1.5 flex items-center justify-between">
                            <span className="text-slate-400">المنطقة:</span>
                            <strong className="text-amber-300 font-bold">
                              {poItem?.region || '—'}
                            </strong>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Desktop Table View */}
                <div className="hidden sm:block overflow-x-auto">
                  <Table className="min-w-[850px] text-xs">
                    <TableHeader>
                      <TableRow className="border-slate-800">
                        <TableHead>الصنف / المادة</TableHead>
                        <TableHead>رقم القطعة</TableHead>
                        <TableHead>المنطقة</TableHead>
                        <TableHead className="text-center whitespace-nowrap">كمية طلب الشراء</TableHead>
                        <TableHead className="text-center whitespace-nowrap">كمية أمر الشراء الفعلي</TableHead>
                        <TableHead className="text-center whitespace-nowrap">الكمية المستلمة</TableHead>
                        <TableHead>السعر المعتمد</TableHead>
                        <TableHead>إجمالي البند</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoiceReceipt.items.map((item) => {
                        const poItem = item.purchase_order_item;
                        const lineTotal = Number(item.received_quantity || 0) * Number(poItem?.unit_price || 0);
                        const matchPoItem = invoiceReceipt.purchase_order?.items?.find((p: any) => p.id === poItem?.id || (p.item_description && p.item_description === poItem?.item_description));
                        const prQty = poItem?.pr_item?.quantity 
                          ?? (poItem as any)?.pr_item_quantity 
                          ?? matchPoItem?.pr_item?.quantity 
                          ?? (matchPoItem as any)?.pr_item_quantity 
                          ?? null;
                        const poQty = poItem?.quantity 
                          ?? matchPoItem?.quantity 
                          ?? item.ordered_quantity 
                          ?? null;
                        const receivedQty = item.received_quantity;
                        const uomLabel = getUnitLabel(poItem?.uom || poItem?.pr_item?.uom || matchPoItem?.uom);

                        return (
                          <TableRow key={item.id} className="border-slate-800/60">
                            <TableCell className="font-bold text-slate-200">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span>{poItem?.item_name || poItem?.item_description || '—'}</span>
                                <SupplementItemBadge
                                  isSupplementary={poItem?.is_supplementary}
                                  batchNumber={poItem?.supplement_batch}
                                />
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-cyan-300 font-bold">{poItem?.item_reference || '—'}</TableCell>
                            <TableCell className="text-slate-300">{poItem?.region || '—'}</TableCell>

                            {/* كمية طلب الشراء (PR) */}
                            <TableCell className="font-mono text-center font-bold text-slate-300 whitespace-nowrap">
                              {prQty !== null ? `${formatCleanQty(prQty)} ${uomLabel}` : '—'}
                            </TableCell>

                            {/* كمية أمر الشراء الفعلي (PO) */}
                            <TableCell className="font-mono text-center font-bold text-cyan-300 whitespace-nowrap">
                              {poQty !== null ? `${formatCleanQty(poQty)} ${uomLabel}` : '—'}
                            </TableCell>

                            {/* الكمية المستلمة (GRN) */}
                            <TableCell className="font-mono text-center font-black text-emerald-300 whitespace-nowrap">
                              {receivedQty !== undefined && receivedQty !== null ? `${formatCleanQty(receivedQty)} ${uomLabel}` : '—'}
                            </TableCell>

                            <TableCell className="font-mono text-slate-300">{money(poItem?.unit_price)}</TableCell>
                            <TableCell className="font-mono font-black text-emerald-300">{money(lineTotal)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* 3. Invoice Input Fields */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-4">
              <h3 className="text-xs font-black text-cyan-300 flex items-center gap-1.5">
                <span>✍️</span> إدخال بيانات الفاتورة الرسمية من المورد:
              </h3>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <label className="block text-xs font-bold text-slate-300">
                  رقم فاتورة المورد (اختياري)
                  <input
                    value={invoiceForm.invoice_number}
                    onChange={(event) => setInvoiceForm({ ...invoiceForm, invoice_number: event.target.value })}
                    placeholder="مثال: INV-2026-981 (تلقائي إن ترك فارغاً)"
                    className="mt-1 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
                  />
                </label>

                <label className="block text-xs font-bold text-slate-300">
                  تاريخ الفاتورة *
                  <input
                    type="date"
                    required
                    value={invoiceForm.invoice_date}
                    onChange={(event) => setInvoiceForm({ ...invoiceForm, invoice_date: event.target.value })}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
                  />
                </label>

                <label className="block text-xs font-bold text-slate-300">
                  تاريخ الاستحقاق
                  <input
                    type="date"
                    value={invoiceForm.due_date}
                    onChange={(event) => setInvoiceForm({ ...invoiceForm, due_date: event.target.value })}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
                  />
                </label>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-slate-300">
                    قيمة الفاتورة (ج.م) *
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const total = receiptValue(invoiceReceipt).toFixed(2);
                      setInvoiceForm({ ...invoiceForm, amount: total });
                    }}
                    className="text-[11px] font-bold text-cyan-400 hover:text-cyan-300 underline"
                  >
                    ⚡ استخدام القيمة المستلمة المعتمدة ({money(receiptValue(invoiceReceipt))})
                  </button>
                </div>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  aria-invalid={Boolean(error && invoiceForm.amount && Number(invoiceForm.amount) <= 0)}
                  value={invoiceForm.amount}
                  onChange={(event) => {
                    const value = event.target.value;
                    setInvoiceForm({ ...invoiceForm, amount: value });
                    setError(value && Number(value) <= 0 ? 'مبلغ الفاتورة يجب أن يكون رقماً أكبر من صفر.' : null);
                  }}
                  className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-mono font-bold text-emerald-300 focus:border-cyan-500 focus:outline-none"
                />
              </div>
            </div>

      {/* #4 — Land Allocation Editor */}
            <LandAllocationEditor
              parcels={parcels}
              departments={departments}
              allocations={invoiceForm.land_allocations}
              invoiceAmount={Number(invoiceForm.amount || 0)}
              disabled={saving}
              error={invoiceAllocationError}
              onChange={(land_allocations) => {
                setInvoiceForm({ ...invoiceForm, land_allocations });
                setInvoiceAllocationError(null);
              }}
              onParcelCreated={(newParcel) => {
                setParcels((prev) => [...prev, newParcel]);
              }}
            />

            {invoiceModalError && (
              <div role="alert" className="rounded-xl border border-rose-600/80 bg-rose-950/80 p-3.5 text-xs font-bold text-rose-200 flex items-center justify-between gap-3 shadow-lg">
                <div className="flex items-center gap-2">
                  <span className="text-base">⚠️</span>
                  <span>{invoiceModalError}</span>
                </div>
                <button type="button" onClick={() => setInvoiceModalError(null)} className="text-xs text-rose-400 hover:text-white px-1">✕</button>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-2 border-t border-slate-800 pt-3">
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handlePrintInvoiceVoucher}
                  className="inline-flex items-center gap-1.5 text-cyan-300 border-cyan-800/40 text-xs font-bold"
                  title="طباعة سند تسجيل الفاتورة والمرفقات"
                >
                  <span>🖨️</span> طباعة الفاتورة والمرفقات
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleShareInvoiceWhatsApp}
                  className="inline-flex items-center gap-1.5 text-emerald-300 border-emerald-800/40 text-xs font-bold hover:bg-emerald-950/50"
                  title="مشاركة تفاصيل الفاتورة عبر تطبيق واتساب"
                >
                  <span>📱</span> إرسال واتساب
                </Button>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <Button type="button" variant="secondary" className="min-h-10" onClick={() => setInvoiceReceipt(null)}>
                  إلغاء
                </Button>
                <Button type="submit" variant="primary" className="min-h-10 font-bold" isLoading={saving} disabled={!parcels.length}>
                  حفظ الفاتورة وترحيل المصروف
                </Button>
              </div>
            </div>
          </form>

          {/* Hidden Printable Voucher for SupplierPaymentsPage */}
          <div id="printable-supplier-invoice-voucher" className="hidden p-8 bg-white text-black font-sans text-xs" dir="rtl">
            <div className="flex items-center justify-between border-b-2 border-black pb-3 mb-4">
              <div className="text-right">
                <h1 className="text-base font-bold text-black">شركة إشبيلية للتطوير العقاري والمقاولات</h1>
                <p className="text-xs text-gray-700">الإدارة المالية - قسم الحسابات</p>
                <p className="text-[11px] text-gray-500 font-mono">تاريخ الطباعة: {new Date().toLocaleDateString('ar-EG')}</p>
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
                  <td className="border border-black p-2 w-1/4 font-bold">{invoiceReceipt.purchase_order?.supplier?.company_name || '—'}</td>
                  <td className="border border-black bg-gray-100 p-2 font-bold w-1/4">تاريخ الفاتورة:</td>
                  <td className="border border-black p-2 w-1/4 font-mono">{invoiceForm.invoice_date || '—'}</td>
                </tr>
                <tr>
                  <td className="border border-black bg-gray-100 p-2 font-bold">رقم أمر الشراء:</td>
                  <td className="border border-black p-2 font-mono font-bold">{invoiceReceipt.purchase_order?.po_number || '—'}</td>
                  <td className="border border-black bg-gray-100 p-2 font-bold">إذن الاستلام بالموقع:</td>
                  <td className="border border-black p-2 font-mono font-bold text-emerald-800">{invoiceReceipt.receipt_number}</td>
                </tr>
                <tr>
                  <td className="border border-black bg-gray-100 p-2 font-bold">القسم:</td>
                  <td className="border border-black p-2" colSpan={3}>{invoiceReceipt.purchase_order?.purchase_request?.department?.name || '—'}</td>
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
              </tbody>
            </table>

            {/* Signatures */}
            <div className="grid grid-cols-3 gap-4 pt-6 border-t-2 border-black text-center text-xs mt-6">
              <div>
                <p className="font-bold">محاسب القسم / المشتريات</p>
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
        </div>,
        document.body,
      )}


      {/* Full-Screen Image Preview Modal */}
      {previewPhotoUrl && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm animate-fade-in"
          onClick={() => setPreviewPhotoUrl(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] w-full bg-slate-950 rounded-2xl border border-slate-700 p-2 overflow-hidden shadow-2xl flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full flex items-center justify-between p-3 border-b border-slate-800 text-slate-100">
              <span className="font-black text-sm flex items-center gap-2">
                <span>📷</span> معاينة صورة بون الميزان / استلام المخزن المرفقة
              </span>
              <button
                type="button"
                onClick={() => setPreviewPhotoUrl(null)}
                className="h-8 w-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="p-2 overflow-auto max-h-[75vh] flex items-center justify-center w-full">
              <img
                src={previewPhotoUrl}
                alt="معاينة بون الميزان"
                className="max-h-[70vh] max-w-full object-contain rounded-lg shadow-inner"
              />
            </div>
            <div className="p-3 w-full border-t border-slate-800 text-center">
              <a
                href={previewPhotoUrl}
                target="_blank"
                rel="noreferrer"
                download="receipt-scale-photo.jpg"
                className="text-xs font-bold text-cyan-400 hover:underline inline-flex items-center gap-1.5"
              >
                <span>📥</span> فتح في نافذة مستقلة / تحميل الصورة
              </a>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 3-in-1 Combined Print Modal (PR + PO + GRN) */}
      <ThreeWayMatchPrintModal
        receipt={threeWayPrintReceipt}
        isOpen={Boolean(threeWayPrintReceipt)}
        onClose={() => setThreeWayPrintReceipt(null)}
      />
    </div>
  );
};

export default SupplierPaymentsPage;
