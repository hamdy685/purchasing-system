import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import {
  PurchaseOrder,
  FinalizeActualPoItemPayload,
  PurchaseOrderItemSource,
  المورد,
} from '../../types/purchaseOrder';
import {
  getPurchaseOrderApi,
  updatePurchaseOrderApi,
  finalizeActualPurchaseOrderApi,
  uploadPurchaseOrderInvoiceApi,
} from '../../api/purchaseOrders';
import { getSuppliersApi } from '../../api/suppliers';
import { LoadingSpinner } from '../LoadingSpinner';
import { SmartKgPricingInput } from '../common/SmartKgPricingInput';
import { SupplementItemBadge } from '../common/SupplementItemBadge';
import { getUnitLabel } from '../../utils/units';
import { toast } from '../../utils/toast';
import { formatCleanNumber } from '../../utils/numberFormat';
import { parseApiError } from '../../utils/apiError';
import { getSummaryParcels, getSummaryRegions } from '../../utils/formatRequestSummary';
import { calculateActualPoFinancials, ActualPoDiscountType } from '../../utils/actualPo';

export interface FinalizeActualPoModalProps {
  isOpen: boolean;
  poId: number | null;
  onClose: () => void;
  onSuccess?: (poNumber?: string) => void;
}

interface EditableModalItem {
  id?: number | null;
  item_id?: number | null;
  pr_item_id?: number | null;
  item_description: string;
  item_reference: string;
  region: string;
  quantity: number;
  uom: string;
  unit_price: number;
  line_total: number;
  specifications?: string;
  supplier_id?: number | null;
  is_supplementary?: boolean;
  supplement_batch?: number | null;
  is_discount_applied?: boolean;
  /** Request lines a department-consolidated line stands for (display only). */
  sources?: PurchaseOrderItemSource[];
}

/** Above this Actual PO total a written reason is required (the server enforces config procurement.actual_po_high_value_threshold). */
const HIGH_VALUE_THRESHOLD = 500000;
const HIGH_VALUE_REASON_MIN_LENGTH = 10;

export const FinalizeActualPoModal: React.FC<FinalizeActualPoModalProps> = ({
  isOpen,
  poId,
  onClose,
  onSuccess,
}) => {
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [suppliers, setSuppliers] = useState<المورد[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<EditableModalItem[]>([]);
  const [headerParcel, setHeaderParcel] = useState<string>('');
  const [headerRegion, setHeaderRegion] = useState<string>('');
  const [discountType, setDiscountType] = useState<ActualPoDiscountType>('NONE');
  const [discountPercentage, setDiscountPercentage] = useState<number>(0);
  const [finalizationNotes, setFinalizationNotes] = useState<string>('');
  const [invoiceFiles, setInvoiceFiles] = useState<File[]>([]);
  const [highValueReason, setHighValueReason] = useState<string>('');
  const [serverRequiresReason, setServerRequiresReason] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [saveBusy, setSaveBusy] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen || !poId) {
      setPo(null);
      setSuppliers([]);
      setItems([]);
      setHeaderParcel('');
      setHeaderRegion('');
      setDiscountType('NONE');
      setDiscountPercentage(0);
      setFinalizationNotes('');
      setInvoiceFiles([]);
      setHighValueReason('');
      setServerRequiresReason(false);
      setError(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    Promise.all([
      getPurchaseOrderApi(poId),
      getSuppliersApi().catch(() => [] as المورد[]),
    ])
      .then(([data, sups]) => {
        if (!isMounted) return;
        setPo(data);
        const loadedSuppliers = Array.isArray(sups) ? sups : ((sups as any)?.data || []);
        setSuppliers(loadedSuppliers);
        setFinalizationNotes(data.finalization_notes || '');
        setDiscountType((data.discount_type as ActualPoDiscountType) || 'NONE');
        setDiscountPercentage(Number(data.discount_percentage) || 0);

        const pSummary = getSummaryParcels(data);
        const rSummary = getSummaryRegions(data);
        setHeaderParcel(pSummary !== '—' ? pSummary : (data.purchase_request?.parcel_reference || ''));
        setHeaderRegion(rSummary !== '—' ? rSummary : (data.purchase_request?.region || ''));

        const receipts = data.receipts || [];
        const rawItems = data.items || [];
        const mappedItems: EditableModalItem[] = [];

        rawItems.forEach((it) => {
          let qty = Number(it.quantity || 0);
          const price = Number(it.unit_price || 0);

          // Calculate actual received qty from approved receipts if available
          let totalReceived = 0;
          let foundInReceipt = false;
          receipts.forEach((r) => {
            if (r.status === 'APPROVED' || r.status === 'PENDING_SITE_ENGINEER') {
              r.items?.forEach((ri) => {
                if (ri.purchase_order_item_id === it.id) {
                  totalReceived += Number(ri.received_quantity || 0);
                  foundInReceipt = true;
                }
              });
            }
          });

          const uomUpper = String(it.uom || '').toUpperCase();
          const itemDesc = String(it.item_description || (it as any).item_name || '');
          const isThousandBricks = uomUpper === 'THOUSAND_BRICKS'
            || String(it.uom || '').includes('ألف')
            || String(it.uom || '').includes('الف')
            || String(it.uom || '').includes('طوب')
            || itemDesc.includes('طوب');

          if (foundInReceipt) {
            if (isThousandBricks && totalReceived >= 100) {
              qty = Math.round((totalReceived / 1000) * 1000) / 1000;
            } else {
              qty = totalReceived;
            }
          } else {
            qty = Number(it.quantity || 0);
          }

          if (isThousandBricks && qty >= 100 && price >= 500) {
            qty = Math.round((qty / 1000) * 1000) / 1000;
          }

          const isSupplementary = Boolean(
            it.is_supplementary ||
            (it.pr_item as any)?.is_supplementary ||
            ((data.purchase_request as any)?.supplements?.some((s: any) =>
              s.items?.some((si: any) => si.id === it.pr_item_id || si.item_description === it.item_description)
            ))
          );
          const supplementBatch = it.supplement_batch ?? (isSupplementary ? 1 : null);

          mappedItems.push({
            id: it.id,
            item_id: it.item_id ?? null,
            pr_item_id: it.pr_item_id ?? null,
            item_description: it.item_description || it.item_name || '',
            item_reference: it.item_reference || data.purchase_request?.parcel_reference || '',
            region: it.region || data.purchase_request?.region || '',
            quantity: qty,
            uom: it.uom || 'PCS',
            unit_price: price,
            line_total: Math.round(qty * price * 100) / 100,
            specifications: it.specifications || '',
            supplier_id: it.supplier_id ?? data.supplier_id,
            is_supplementary: isSupplementary,
            supplement_batch: supplementBatch,
            is_discount_applied: Boolean(it.is_discount_applied),
            sources: it.sources ?? [],
          });
        });

        setItems(mappedItems);
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(parseApiError(err).message || 'تعذر تحميل بيانات أمر الشراء.');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, poId]);

  // Financial calculations
  const financials = useMemo(() => {
    return calculateActualPoFinancials({
      items,
      discountType,
      discountPercentage,
    });
  }, [items, discountType, discountPercentage]);

  // A department-consolidated order keeps one supplier: only the whole order may move to another one.
  const isConsolidated = Boolean(po?.is_department_consolidated);
  const estimatedGrandTotal = financials.grandTotal + Number(po?.tax_amount || 0);
  const highValueRequired = estimatedGrandTotal > HIGH_VALUE_THRESHOLD || serverRequiresReason;

  const allSuppliers = useMemo(() => {
    const list = [...suppliers];
    if (po?.supplier && !list.some((s) => s.id === po.supplier?.id)) {
      list.unshift(po.supplier);
    }
    return list;
  }, [suppliers, po]);

  const distinctSupplierIds = useMemo(() => {
    return Array.from(new Set(items.map((it) => it.supplier_id || po?.supplier_id).filter(Boolean)));
  }, [items, po]);

  const unifiedSupplierValue = distinctSupplierIds.length === 1 ? String(distinctSupplierIds[0]) : '';

  const handleApplyUnifiedSupplier = (newSupplierId: number | null) => {
    if (!newSupplierId) return;
    setItems((prev) =>
      prev.map((it) => ({
        ...it,
        supplier_id: newSupplierId,
      }))
    );
    toast.info('تم تطبيق المورد على كافة البنود');
  };

  const handleApplyParcelAndRegionToAll = () => {
    const p = headerParcel.trim();
    const r = headerRegion.trim();
    if (!p && !r) {
      toast.warning('يرجى إدخال رقم القطعة أو المنطقة أولاً لتطبيقها.');
      return;
    }
    setItems((prev) =>
      prev.map((it) => ({
        ...it,
        ...(p ? { item_reference: p } : {}),
        ...(r ? { region: r } : {}),
      }))
    );
    toast.success('تم تطبيق رقم القطعة والمنطقة على كافة البنود بنجاح.');
  };

  const handleItemFieldChange = (index: number, field: keyof EditableModalItem, value: any) => {
    setItems((prev) => {
      const updated = [...prev];
      const item = { ...updated[index], [field]: value };
      if (field === 'quantity' || field === 'unit_price') {
        const qty = Number(field === 'quantity' ? value : item.quantity) || 0;
        const price = Number(field === 'unit_price' ? value : item.unit_price) || 0;
        item.line_total = Math.round(qty * price * 100) / 100;
      }
      updated[index] = item;
      return updated;
    });
    setError(null);
  };

  const handleItemDiscountToggle = (index: number) => {
    setItems((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        is_discount_applied: !updated[index].is_discount_applied,
      };
      return updated;
    });
    setError(null);
  };

  const handleSelectAllDiscounts = (applied: boolean) => {
    setItems((prev) =>
      prev.map((it) => ({
        ...it,
        is_discount_applied: applied,
      }))
    );
    setError(null);
  };

  const validateDiscounts = (): boolean => {
    const pct = Number(discountPercentage) || 0;
    if (pct < 0 || pct > 100) {
      setError('نسبة الخصم يجب أن تكون بين 0% و 100%.');
      return false;
    }
    if (discountType === 'SELECTED_ITEMS') {
      const hasSelected = items.some((it) => it.is_discount_applied);
      if (!hasSelected && pct > 0) {
        setError('يرجى تحديد بند واحد على الأقل لتطبيق الخصم عليه، أو اختيار «بدون خصم».');
        return false;
      }
    }
    return true;
  };

  const handleSaveOnly = async () => {
    if (!po) return;
    if (items.length === 0) {
      setError('يجب أن يحتوي أمر الشراء على بند واحد على الأقل.');
      return;
    }

    if (!validateDiscounts()) {
      return;
    }

    setSaveBusy(true);
    setError(null);
    try {
      const targetHeaderSupplierId = unifiedSupplierValue ? Number(unifiedSupplierValue) : undefined;
      const discountPct = Number(discountPercentage) || 0;
      const targetedItemIds = discountType === 'SELECTED_ITEMS'
        ? items.filter((it) => it.is_discount_applied && it.id).map((it) => it.id!)
        : [];

      await updatePurchaseOrderApi(po.id, {
        supplier_id: targetHeaderSupplierId,
        parcel_reference: headerParcel.trim() || undefined,
        region: headerRegion.trim() || undefined,
        discount_type: discountType,
        discount_percentage: discountPct,
        discount_item_ids: targetedItemIds,
        finalization_notes: finalizationNotes || undefined,
        items: items.map((it) => ({
          id: it.id ? Number(it.id) : undefined,
          item_id: it.item_id ? Number(it.item_id) : undefined,
          pr_item_id: it.pr_item_id ? Number(it.pr_item_id) : undefined,
          item_description: it.item_description.trim(),
          item_reference: it.item_reference.trim() || headerParcel.trim() || undefined,
          region: it.region.trim() || headerRegion.trim() || undefined,
          quantity: Number(it.quantity),
          uom: it.uom,
          unit_price: Number(it.unit_price),
          specifications: it.specifications,
          supplier_id: it.supplier_id ? Number(it.supplier_id) : (targetHeaderSupplierId || po.supplier_id),
          is_discount_applied: discountType === 'SELECTED_ITEMS' ? Boolean(it.is_discount_applied) : false,
        })),
      });
      for (const file of invoiceFiles) {
        await uploadPurchaseOrderInvoiceApi(po.id, file);
      }
      toast.success('✅ تم حفظ تعديلات أمر الشراء وإرفاق الفاتورة بنجاح.');
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setSaveBusy(false);
    }
  };

  const handleFinalize = async () => {
    if (!po) return;

    if (items.length === 0) {
      setError('يجب توفير بند واحد على الأقل لإصدار أمر الشراء الفعلي.');
      return;
    }

    const invalidItem = items.find(
      (it) => !it.item_description.trim() || Number(it.quantity) < 0 || Number(it.unit_price) < 0
    );
    if (invalidItem) {
      setError('يرجى التحقق من صحة جميع البنود (الكمية لا تقل عن صفر، الوصف، والسعر لا يقل عن صفر).');
      return;
    }

    if (!validateDiscounts()) {
      return;
    }

    if (highValueRequired && highValueReason.trim().length < HIGH_VALUE_REASON_MIN_LENGTH) {
      setError(`قيمة أمر الشراء الفعلي تتجاوز ${formatCleanNumber(HIGH_VALUE_THRESHOLD)} جنيه. اكتب سبب الإصدار (${HIGH_VALUE_REASON_MIN_LENGTH} أحرف على الأقل).`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const targetHeaderSupplierId = unifiedSupplierValue ? Number(unifiedSupplierValue) : undefined;
      const discountPct = Number(discountPercentage) || 0;
      const targetedItemIds = discountType === 'SELECTED_ITEMS'
        ? items.filter((it) => it.is_discount_applied && it.id).map((it) => it.id!)
        : [];

      const payloadItems: FinalizeActualPoItemPayload[] = items.map((it) => ({
        id: it.id ? Number(it.id) : undefined,
        item_id: it.item_id ? Number(it.item_id) : undefined,
        pr_item_id: it.pr_item_id ? Number(it.pr_item_id) : undefined,
        item_description: it.item_description.trim(),
        item_reference: it.item_reference.trim() || headerParcel.trim() || 'عام',
        region: it.region.trim() || headerRegion.trim() || 'عام',
        quantity: Number(it.quantity),
        uom: it.uom,
        unit_price: Number(it.unit_price),
        specifications: it.specifications,
        supplier_id: it.supplier_id ? Number(it.supplier_id) : (targetHeaderSupplierId || po.supplier_id),
        is_discount_applied: discountType === 'SELECTED_ITEMS' ? Boolean(it.is_discount_applied) : false,
      }));

      await finalizeActualPurchaseOrderApi(po.id, {
        supplier_id: targetHeaderSupplierId,
        parcel_reference: headerParcel.trim() || undefined,
        region: headerRegion.trim() || undefined,
        discount_type: discountType,
        discount_percentage: discountPct,
        discount_item_ids: targetedItemIds,
        items: payloadItems,
        notes: finalizationNotes.trim() || undefined,
        attachments: invoiceFiles,
        high_value_reason: highValueRequired ? highValueReason.trim() : undefined,
      });

      toast.success(`✅ تم إصدار أمر الشراء الفعلي (${po.po_number}) واعتماده وإرساله للإدارة المالية بنجاح.`);
      onClose();
      onSuccess?.(po.po_number);
    } catch (err) {
      if ((err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'HIGH_VALUE_REASON_REQUIRED') {
        setServerRequiresReason(true);
      }
      setError(parseApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  const latestReceipt = po?.receipts && po.receipts.length > 0 ? po.receipts[0] : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeOnBackdrop={!busy && !saveBusy}
      closeOnEscape={!busy && !saveBusy}
      title={po ? `⚡ إصدار واعتماد أمر الشراء الفعلي — ${po.po_number}` : 'إصدار أمر الشراء الفعلي'}
      subtitle="مطابقة وتعديل الأسعار والكميات والموردين وأرقام القطع الفعلية قبل اعتماد الملف وإرساله للإدارة المالية."
      size="2xl"
      footer={(
        <div className="flex flex-wrap items-center justify-between w-full gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={busy || saveBusy}
            className="cursor-pointer"
          >
            إلغاء والعودة
          </Button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveOnly}
              disabled={busy || saveBusy || loading}
              className="bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs sm:text-sm px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl shadow-lg shadow-cyan-600/30 flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saveBusy ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>جاري الحفظ...</span>
                </>
              ) : (
                <span>💾 حفظ كافة التعديلات</span>
              )}
            </button>

            <button
              type="button"
              onClick={handleFinalize}
              disabled={busy || saveBusy || loading}
              className="bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-black text-xs sm:text-sm px-5 sm:px-6 py-2 sm:py-2.5 rounded-xl shadow-xl shadow-emerald-950/50 flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>جاري الاعتماد والإرسال...</span>
                </>
              ) : (
                <span>💰 اعتماد وإرسال للإدارة المالية</span>
              )}
            </button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4 text-right" dir="rtl">
        {loading && (
          <div className="py-12">
            <LoadingSpinner message="جاري تحميل بنود أمر الشراء وإذن الاستلام المعتمد..." />
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/50 bg-rose-950/30 px-4 py-3 text-xs font-bold leading-6 text-rose-200 shadow-md"
          >
            {error}
          </div>
        )}

        {!loading && po && (
          <>
            {/* ── Context & Summary Cards ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
              <div className="rounded-xl border border-cyan-500/30 bg-slate-950/70 p-3">
                <span className="text-slate-400 block text-[11px]">رقم أمر الشراء</span>
                <span className="font-mono font-black text-cyan-200 text-sm mt-0.5 block">{po.po_number}</span>
              </div>

              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3">
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-emerald-400 block text-[11px] font-semibold">المورد المعني</span>
                  {distinctSupplierIds.length > 1 && (
                    <span className="text-[10px] font-bold text-amber-300 bg-amber-950/60 border border-amber-800 px-1.5 py-0.5 rounded">
                      متعدد ({distinctSupplierIds.length})
                    </span>
                  )}
                </div>
                <select
                  value={unifiedSupplierValue}
                  onChange={(e) => {
                    const val = e.target.value ? Number(e.target.value) : null;
                    if (val) handleApplyUnifiedSupplier(val);
                  }}
                  disabled={busy || saveBusy}
                  className="w-full bg-[#0b1424] border border-emerald-500/40 rounded-lg px-2 py-1 text-xs text-slate-100 font-bold focus:border-emerald-300 outline-none truncate cursor-pointer"
                  title="تطبيق مورد موحد على كافة البنود دفعة واحدة"
                >
                  <option value="">🏢 {distinctSupplierIds.length > 1 ? 'موردون متعددون (اضغط للتوحيد)' : (po.supplier?.company_name || 'اختر مورد موحد...')}</option>
                  {allSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.company_name}
                    </option>
                  ))}
                </select>
              </div>

              {/* ── Editable Parcel & Region Prompt Card ── */}
              <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-3 flex flex-col justify-between">
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-amber-400 block text-[11px] font-semibold">📍 قطعة الأرض والمنطقة</span>
                  <button
                    type="button"
                    onClick={handleApplyParcelAndRegionToAll}
                    disabled={busy || saveBusy}
                    className="text-[10px] font-bold text-amber-300 hover:text-white bg-amber-900/60 hover:bg-amber-800 border border-amber-700/60 px-1.5 py-0.5 rounded transition-all cursor-pointer disabled:opacity-50"
                    title="تطبيق رقم القطعة والمنطقة على كافة البنود"
                  >
                    ⚡ تطبيق على الكل
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5 mt-0.5">
                  <input
                    type="text"
                    value={headerParcel}
                    onChange={(e) => setHeaderParcel(e.target.value)}
                    disabled={busy || saveBusy}
                    placeholder="رقم القطعة..."
                    className="w-full bg-[#0b1424] border border-amber-500/40 rounded-lg px-2 py-1 text-xs text-amber-200 font-bold focus:border-amber-300 outline-none truncate"
                    title="رقم قطعة الأرض العام"
                  />
                  <input
                    type="text"
                    value={headerRegion}
                    onChange={(e) => setHeaderRegion(e.target.value)}
                    disabled={busy || saveBusy}
                    placeholder="المنطقة..."
                    className="w-full bg-[#0b1424] border border-amber-500/40 rounded-lg px-2 py-1 text-xs text-amber-300 font-bold focus:border-amber-300 outline-none truncate"
                    title="المنطقة / المشروع العام"
                  />
                </div>
              </div>

              <div className="rounded-xl border border-teal-500/30 bg-teal-950/20 p-3">
                <span className="text-teal-400 block text-[11px] font-semibold">إذن الاستلام المعتمد</span>
                <span className="font-mono font-bold text-teal-200 text-xs mt-0.5 block">
                  {latestReceipt ? `📦 ${latestReceipt.receipt_number || 'معتمد بالموقع'}` : 'تم الفحص بالموقع'}
                </span>
              </div>
            </div>

            {/* ── Instructions Banner ── */}
            <div className="rounded-xl border border-emerald-500/40 bg-gradient-to-r from-emerald-950/40 via-slate-900 to-teal-950/30 p-3.5 text-xs text-emerald-200 flex items-start gap-3 shadow-md">
              <span className="text-xl shrink-0">💡</span>
              <div>
                <p className="font-bold text-emerald-100">
                  تم توريد البضاعة واعتماد إذن الاستلام في الموقع:
                </p>
                <p className="mt-0.5 text-[11px] text-slate-300">
                  يمكنك تعديل <strong className="text-cyan-300 mx-0.5">اسم الصنف، الكمية، السعر، رقم القطعة، والمنطقة</strong> لكل بند، بالإضافة إلى
                  <strong className="text-emerald-300 mx-1 font-bold">تحديد المورد الفعلي لكل بند</strong>
                  وضبط <strong className="text-amber-300 mx-1 font-bold">نظام الخصم (على الإجمالي أو بنود محددة)</strong>
                  ثم اضغط على
                  <strong className="text-emerald-300 mx-1 font-bold">«اعتماد وإرسال للإدارة المالية»</strong>
                  لترحيل كافة التعديلات مباشرة إلى شاشات وحسابات الإدارة المالية.
                </p>
              </div>
            </div>

            {/* ── Discount Configuration Card ── */}
            <div className="rounded-xl border border-amber-500/40 bg-slate-950/90 p-4 space-y-3 shadow-md">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-base">🏷️</span>
                  <span className="font-bold text-xs sm:text-sm text-slate-100">نظام الخصومات في أمر الشراء الفعلي:</span>
                </div>
                {discountType !== 'NONE' && (
                  <span className="text-[11px] font-bold text-amber-300 bg-amber-950/60 border border-amber-800/80 px-2.5 py-0.5 rounded-full">
                    {discountType === 'TOTAL' ? 'خصم على كامل أمر الشراء' : 'خصم على بنود محددة مختارة'}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
                {/* 1. Discount Type Selector */}
                <div className="lg:col-span-7 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDiscountType('NONE')}
                    disabled={busy || saveBusy}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      discountType === 'NONE'
                        ? 'bg-slate-700 text-white shadow'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                    }`}
                  >
                    بدون خصم
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiscountType('TOTAL')}
                    disabled={busy || saveBusy}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      discountType === 'TOTAL'
                        ? 'bg-amber-600 text-white shadow-lg shadow-amber-950/50'
                        : 'bg-slate-900 text-slate-400 hover:text-amber-300 border border-slate-800'
                    }`}
                  >
                    خصم على إجمالي أمر الشراء
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiscountType('SELECTED_ITEMS')}
                    disabled={busy || saveBusy}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      discountType === 'SELECTED_ITEMS'
                        ? 'bg-amber-600 text-white shadow-lg shadow-amber-950/50'
                        : 'bg-slate-900 text-slate-400 hover:text-amber-300 border border-slate-800'
                    }`}
                  >
                    خصم على بنود محددة
                  </button>
                </div>

                {/* 2. Discount Percentage Input */}
                {discountType !== 'NONE' && (
                  <div className="lg:col-span-5 flex items-center gap-2 justify-start lg:justify-end">
                    <label className="text-xs text-amber-200 font-bold whitespace-nowrap">نسبة الخصم (%):</label>
                    <div className="relative w-32">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={discountPercentage || ''}
                        onChange={(e) => {
                          const val = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                          setDiscountPercentage(val);
                        }}
                        disabled={busy || saveBusy}
                        placeholder="0.00"
                        className="w-full bg-[#0b1424] border border-amber-500/60 rounded-lg px-2.5 py-1 text-xs text-amber-300 font-mono font-black text-center outline-none focus:border-amber-300"
                      />
                      <span className="absolute left-2 top-1.5 text-xs text-amber-400 font-bold">%</span>
                    </div>
                  </div>
                )}
              </div>

              {discountType === 'SELECTED_ITEMS' && (
                <div className="rounded-lg bg-amber-950/30 border border-amber-800/40 p-2.5 text-[11px] text-amber-200 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span>📌</span>
                    <span>حدد البنود المستهدفة بالخصم من خانات الاختيار (✓) بالجدول أدناه. البنود غير المحددة لن تتأثر بالخصم مطلقاً.</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleSelectAllDiscounts(true)}
                      className="text-[10px] font-bold text-amber-300 underline hover:text-white cursor-pointer"
                    >
                      تحديد الكل
                    </button>
                    <span className="text-slate-600">|</span>
                    <button
                      type="button"
                      onClick={() => handleSelectAllDiscounts(false)}
                      className="text-[10px] font-bold text-slate-400 underline hover:text-white cursor-pointer"
                    >
                      إلغاء التحديد
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Items Table (Desktop) ── */}
            <div className="hidden sm:block overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/80">
              <table className="w-full border-collapse text-right text-xs">
                <thead className="bg-slate-900 text-cyan-200">
                  <tr>
                    <th className="p-3 text-center w-10">#</th>
                    {discountType === 'SELECTED_ITEMS' && (
                      <th className="p-3 text-center w-20 bg-amber-950/40 text-amber-300">
                        <label className="flex items-center justify-center gap-1 cursor-pointer" title="تحديد/إلغاء تحديد كل البنود للخصم">
                          <input
                            type="checkbox"
                            checked={items.length > 0 && items.every((it) => it.is_discount_applied)}
                            onChange={(e) => handleSelectAllDiscounts(e.target.checked)}
                            disabled={busy || saveBusy}
                            className="rounded accent-amber-500 cursor-pointer"
                          />
                          <span>خصم</span>
                        </label>
                      </th>
                    )}
                    <th className="p-3 min-w-[200px]">اسم الصنف والمواصفات</th>
                    <th className="p-3 text-center w-48">القطعة والمنطقة</th>
                    <th className="p-3 text-center w-44">المورد الفعلي</th>
                    <th className="p-3 text-center w-28">الكمية المستلمة</th>
                    <th className="p-3 text-center w-44">سعر الوحدة</th>
                    <th className="p-3 text-center w-32">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={discountType === 'SELECTED_ITEMS' ? 8 : 7} className="p-8 text-center text-rose-300 font-bold">
                        لا توجد بنود متاحة للإصدار الفعلي.
                      </td>
                    </tr>
                  ) : (
                    items.map((item, idx) => {
                      const isItemDiscounted = discountType === 'SELECTED_ITEMS' && item.is_discount_applied;
                      const discountedLineTotal = isItemDiscounted
                        ? Math.max(0, item.line_total * (1 - (Number(discountPercentage) || 0) / 100))
                        : item.line_total;

                      return (
                        <tr
                          key={item.id || idx}
                          className={`transition-colors ${
                            isItemDiscounted
                              ? 'bg-amber-950/15 hover:bg-amber-950/25'
                              : 'hover:bg-slate-900/50'
                          }`}
                        >
                          <td className="p-3 text-center font-mono text-slate-400 font-bold">{idx + 1}</td>
                          {discountType === 'SELECTED_ITEMS' && (
                            <td className="p-3 text-center bg-amber-950/20">
                              <label className="flex items-center justify-center gap-1 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={Boolean(item.is_discount_applied)}
                                  onChange={() => handleItemDiscountToggle(idx)}
                                  disabled={busy || saveBusy}
                                  className="h-4 w-4 rounded accent-amber-500 cursor-pointer"
                                />
                              </label>
                            </td>
                          )}
                          <td className="p-3 font-bold text-slate-100">
                            <div className="space-y-1">
                              <span className="sr-only">{item.item_description}</span>
                              <input
                                type="text"
                                value={item.item_description}
                                onChange={(e) => handleItemFieldChange(idx, 'item_description', e.target.value)}
                                disabled={busy || saveBusy}
                                className="w-full bg-[#0b1424] border border-slate-700 focus:border-cyan-400 rounded-lg px-2 py-1 text-xs text-slate-100 font-bold outline-none"
                                placeholder="اسم الصنف..."
                                title="تعديل اسم الصنف الفعلي"
                              />
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <SupplementItemBadge
                                  isSupplementary={item.is_supplementary}
                                  batchNumber={item.supplement_batch}
                                />
                                {isItemDiscounted && (
                                  <span className="text-[10px] font-bold text-amber-300 bg-amber-950/70 border border-amber-700/60 px-1.5 py-0.5 rounded">
                                    🏷️ خاضع لخصم {discountPercentage}%
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* ── Per-Item Parcel & Region Inputs ── */}
                          <td className="p-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <input
                                type="text"
                                value={item.item_reference || ''}
                                onChange={(e) => handleItemFieldChange(idx, 'item_reference', e.target.value)}
                                disabled={busy || saveBusy}
                                placeholder="قطعة..."
                                className="w-20 bg-[#0b1424] border border-amber-500/40 focus:border-amber-300 rounded-lg px-1.5 py-1 text-[11px] text-amber-200 font-mono font-bold outline-none text-center"
                                title="رقم قطعة الأرض لهذا البند"
                              />
                              <input
                                type="text"
                                value={item.region || ''}
                                onChange={(e) => handleItemFieldChange(idx, 'region', e.target.value)}
                                disabled={busy || saveBusy}
                                placeholder="المنطقة..."
                                className="w-24 bg-[#0b1424] border border-amber-500/40 focus:border-amber-300 rounded-lg px-1.5 py-1 text-[11px] text-amber-300 font-bold outline-none text-center"
                                title="المنطقة لهذا البند"
                              />
                            </div>
                          </td>

                          {/* ── Supplier Selection per item ── */}
                          <td className="p-3 text-center">
                            <select
                              value={item.supplier_id || po.supplier_id || ''}
                              onChange={(e) => handleItemFieldChange(idx, 'supplier_id', e.target.value ? Number(e.target.value) : null)}
                              disabled={busy || saveBusy || isConsolidated}
                              className="w-full min-w-[130px] max-w-[160px] h-9 rounded-lg border border-cyan-500/60 bg-[#0b1424] px-2 text-xs text-slate-100 font-bold outline-none focus:border-cyan-300 disabled:opacity-60 truncate cursor-pointer"
                              title="تحديد المورد الفعلي لهذا البند"
                            >
                              {allSuppliers.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.company_name}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td className="p-3 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={item.quantity ?? ''}
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => handleItemFieldChange(idx, 'quantity', e.target.value)}
                                disabled={busy || saveBusy}
                                className="h-9 w-24 rounded-lg border border-cyan-500/60 bg-[#0b1424] px-2 text-center font-mono text-xs text-slate-100 outline-none focus:border-cyan-300 disabled:opacity-60"
                              />
                              <span className="text-[11px] font-bold text-amber-300">
                                {getUnitLabel(item.uom)}
                              </span>
                            </div>
                          </td>

                          <td className="p-3 text-center align-middle">
                            <SmartKgPricingInput
                              unitPrice={item.unit_price}
                              quantity={item.quantity}
                              uom={item.uom}
                              itemDescription={item.item_description}
                              disabled={busy || saveBusy}
                              onChangeUnitPrice={(newPrice) =>
                                handleItemFieldChange(idx, 'unit_price', newPrice)
                              }
                              onConvertToTon={(newQty, tonPrice) => {
                                handleItemFieldChange(idx, 'quantity', newQty);
                                handleItemFieldChange(idx, 'uom', 'TON');
                                handleItemFieldChange(idx, 'unit_price', tonPrice);
                              }}
                              onConvertToKgPrice={(newKgPrice) => {
                                handleItemFieldChange(idx, 'unit_price', newKgPrice);
                              }}
                            />
                          </td>

                          <td className="p-3 text-center font-mono font-black text-sm">
                            <span className={isItemDiscounted ? 'text-slate-400 line-through text-xs block' : 'text-emerald-300'}>
                              {formatCleanNumber(item.line_total, 2)} ج.م
                            </span>
                            {isItemDiscounted && (
                              <span className="text-emerald-300 text-xs font-black block">
                                {formatCleanNumber(discountedLineTotal, 2)} ج.م
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* ── Items Mobile Cards ── */}
            <div className="space-y-3 sm:hidden">
              {items.map((item, idx) => {
                const isItemDiscounted = discountType === 'SELECTED_ITEMS' && item.is_discount_applied;
                const discountedLineTotal = isItemDiscounted
                  ? Math.max(0, item.line_total * (1 - (Number(discountPercentage) || 0) / 100))
                  : item.line_total;

                return (
                  <div
                    key={`mobile-${item.id || idx}`}
                    className={`rounded-xl border p-3.5 space-y-3 text-xs ${
                      isItemDiscounted
                        ? 'border-amber-600/50 bg-slate-950/90'
                        : 'border-slate-800 bg-slate-950/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 border-b border-slate-850 pb-2">
                      <div className="w-full">
                        <span className="text-[10px] font-bold text-cyan-400">بند #{idx + 1}</span>
                        <span className="sr-only">{item.item_description}</span>
                        <input
                          type="text"
                          value={item.item_description}
                          onChange={(e) => handleItemFieldChange(idx, 'item_description', e.target.value)}
                          disabled={busy || saveBusy}
                          className="w-full bg-[#0b1424] border border-slate-700 focus:border-cyan-400 rounded-lg px-2 py-1 text-xs text-slate-100 font-bold outline-none mt-1"
                          placeholder="اسم الصنف..."
                        />
                      </div>
                      <span className="text-[11px] font-bold bg-amber-950/50 text-amber-300 border border-amber-800/50 px-2 py-0.5 rounded shrink-0 self-start mt-4">
                        {getUnitLabel(item.uom)}
                      </span>
                    </div>

                    {discountType === 'SELECTED_ITEMS' && (
                      <div className="flex items-center justify-between p-2 rounded-lg bg-amber-950/30 border border-amber-800/40">
                        <span className="text-[11px] font-bold text-amber-300">تطبيق الخصم على هذا البند:</span>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(item.is_discount_applied)}
                            onChange={() => handleItemDiscountToggle(idx)}
                            disabled={busy || saveBusy}
                            className="h-4 w-4 rounded accent-amber-500 cursor-pointer"
                          />
                          <span className="text-xs font-bold text-amber-200">
                            {item.is_discount_applied ? `محدد (${discountPercentage}%) ✓` : 'غير محدد'}
                          </span>
                        </label>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] text-amber-300 block mb-1 font-bold">رقم القطعة:</label>
                        <input
                          type="text"
                          value={item.item_reference || ''}
                          onChange={(e) => handleItemFieldChange(idx, 'item_reference', e.target.value)}
                          disabled={busy || saveBusy}
                          placeholder="رقم القطعة..."
                          className="h-9 w-full rounded-lg border border-amber-500/40 bg-[#0b1424] px-2 font-mono font-bold text-xs text-amber-200 outline-none focus:border-amber-300"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-amber-300 block mb-1 font-bold">المنطقة:</label>
                        <input
                          type="text"
                          value={item.region || ''}
                          onChange={(e) => handleItemFieldChange(idx, 'region', e.target.value)}
                          disabled={busy || saveBusy}
                          placeholder="المنطقة..."
                          className="h-9 w-full rounded-lg border border-amber-500/40 bg-[#0b1424] px-2 font-bold text-xs text-amber-300 outline-none focus:border-amber-300"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-400 block mb-1">المورد الفعلي للبند:</label>
                      <select
                        value={item.supplier_id || po.supplier_id || ''}
                        onChange={(e) => handleItemFieldChange(idx, 'supplier_id', e.target.value ? Number(e.target.value) : null)}
                        disabled={busy || saveBusy || isConsolidated}
                        className="h-9 w-full rounded-lg border border-cyan-500/60 bg-[#0b1424] px-2 text-xs text-slate-100 font-bold outline-none focus:border-cyan-300"
                      >
                        {allSuppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.company_name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">الكمية الفعلية:</label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={item.quantity ?? ''}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => handleItemFieldChange(idx, 'quantity', e.target.value)}
                          disabled={busy || saveBusy}
                          className="h-9 w-full rounded-lg border border-cyan-500/60 bg-[#0b1424] px-2 text-center font-mono text-xs text-slate-100 outline-none focus:border-cyan-300"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">سعر الوحدة:</label>
                        <SmartKgPricingInput
                          unitPrice={item.unit_price}
                          quantity={item.quantity}
                          uom={item.uom}
                          itemDescription={item.item_description}
                          disabled={busy || saveBusy}
                          onChangeUnitPrice={(newPrice) =>
                            handleItemFieldChange(idx, 'unit_price', newPrice)
                          }
                        />
                      </div>
                    </div>

                    <div className="flex justify-between items-center rounded-lg bg-emerald-950/30 border border-emerald-800/40 px-3 py-2">
                      <span className="text-slate-400 text-xs">إجمالي البند:</span>
                      <div className="text-left font-mono font-bold">
                        <span className={isItemDiscounted ? 'text-slate-400 line-through text-[11px] block' : 'text-emerald-300'}>
                          {formatCleanNumber(item.line_total, 2)} ج.م
                        </span>
                        {isItemDiscounted && (
                          <span className="text-emerald-300 text-xs block">
                            {formatCleanNumber(discountedLineTotal, 2)} ج.م
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Financial Summary & Grand Total Bar ── */}
            <div className="rounded-2xl border-2 border-slate-800 bg-slate-900/95 p-4 shadow-xl space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="text-xs text-slate-400 flex items-center gap-2">
                  <span>عدد البنود الفعلية:</span>
                  <strong className="text-slate-100 font-bold">{items.length}</strong>
                  {financials.discountType === 'SELECTED_ITEMS' && (
                    <span className="text-[11px] font-bold text-amber-300 bg-amber-950/60 border border-amber-800/80 px-2 py-0.5 rounded-full mr-2">
                      {financials.targetedCount} بنود مستهدفة بالخصم
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400">الإجمالي قبل الخصم:</span>
                    <span className="font-mono font-bold text-slate-200">
                      {formatCleanNumber(financials.subtotal, 2)} ج.م
                    </span>
                  </div>
                  {financials.discountType === 'SELECTED_ITEMS' && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-amber-400">إجمالي البنود المستهدفة:</span>
                      <span className="font-mono font-bold text-amber-200">
                        {formatCleanNumber(financials.targetedSubtotal, 2)} ج.م
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-3">
                  {financials.discountAmount > 0 ? (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-xs">
                      <span className="text-rose-300 font-bold">
                        🏷️ {financials.discountType === 'TOTAL' ? 'خصم إجمالي' : 'خصم بنود محددة'} ({formatCleanNumber(financials.discountPercentage, 2)}%):
                      </span>
                      <span className="font-mono font-black text-rose-300">
                        -{formatCleanNumber(financials.discountAmount, 2)} ج.م
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-500">لا يوجد خصم مطبق</span>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-xs sm:text-sm font-bold text-slate-200">الإجمالي النهائي بعد الخصم:</span>
                  <span className="font-mono font-black text-emerald-400 text-xl sm:text-2xl drop-shadow">
                    {formatCleanNumber(financials.grandTotal, 2)} ج.م
                  </span>
                </div>
              </div>
            </div>

            {isConsolidated && (
              <div data-testid="consolidated-actual-po-note" className="rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-3 text-xs text-emerald-200 space-y-1.5">
                <p className="font-bold">🧾 أمر شراء مجمع لمورد واحد: يمكن تغيير مورد الأمر بالكامل فقط، ولا يمكن جعل بند لمورد مختلف.</p>
                {items.filter((it) => (it.sources?.length ?? 0) > 1).map((it) => (
                  <p key={it.id ?? it.item_description} className="text-emerald-300/90">
                    {it.item_description}: مجمع من {it.sources!.length} بنود طلب (
                    {it.sources!.map((s) => `${formatCleanNumber(Number(s.line_quantity))} ${getUnitLabel(it.uom)}`).join(' + ')})
                  </p>
                ))}
              </div>
            )}

            {highValueRequired && (
              <div data-testid="high-value-warning" role="alert" className="rounded-xl border border-rose-500/60 bg-rose-950/30 p-4 space-y-2">
                <p className="text-xs font-black text-rose-200">
                  ⚠️ قيمة أمر الشراء الفعلي {formatCleanNumber(estimatedGrandTotal, 2)} جنيه تتجاوز {formatCleanNumber(HIGH_VALUE_THRESHOLD)} جنيه. اكتب سبب الإصدار (إلزامي).
                </p>
                <textarea
                  rows={2}
                  aria-label="سبب إصدار أمر شراء فعلي بقيمة مرتفعة"
                  value={highValueReason}
                  onChange={(e) => setHighValueReason(e.target.value)}
                  disabled={busy || saveBusy}
                  placeholder="مثال: توريد المرحلة كاملة دفعة واحدة بسعر أقل..."
                  className="w-full bg-slate-900 border border-rose-700/60 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-rose-400 disabled:opacity-60"
                />
                <p className="text-[11px] text-rose-300/80">سيتم إرسال إشعار للمدير العام والحسابات بالسبب.</p>
              </div>
            )}

            {/* ── Finalization Notes for Finance ── */}
            <div className="space-y-1.5 pt-2 border-t border-slate-800">
              <label className="text-xs font-bold text-slate-300 block">
                ملاحظات وتوضيحات للإدارة المالية والحسابات (اختياري):
              </label>
              <textarea
                rows={2}
                value={finalizationNotes}
                onChange={(e) => setFinalizationNotes(e.target.value)}
                disabled={busy || saveBusy}
                placeholder="اكتب أي توضيحات للإدارة المالية بشأن فروق الكميات أو الأسعار أو استلامات الموقع..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-60"
              />
            </div>

            {/* ── Invoice Attachment (Stored in Google Drive فواتير) ── */}
            <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-black text-amber-300 flex items-center gap-1.5">
                  <span>🧾</span>
                  <span>إرفاق فاتورة الشراء / المورد (تُحفظ في Google Drive بمجلد «فواتير»):</span>
                </label>
                {invoiceFiles.length > 0 && (
                  <span className="text-[11px] font-bold text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-700/60 flex items-center gap-1">
                    <span>✓</span> تم اختيار {invoiceFiles.length} ملف
                  </span>
                )}
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <label className="flex-1 cursor-pointer flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-dashed border-amber-500/40 hover:border-amber-400 bg-slate-900/80 hover:bg-slate-900 text-xs font-bold text-amber-200 transition-colors">
                  <span>📎</span>
                  <span className="truncate max-w-[280px]">
                    {invoiceFiles.length > 0 ? 'إضافة ملفات أخرى...' : 'اضغط لاختيار صور الفاتورة أو ملفات PDF (يمكن اختيار أكثر من ملف)...'}
                  </span>
                  <input
                    type="file"
                    multiple
                    data-testid="invoice-files-input"
                    accept="image/*,application/pdf"
                    className="hidden"
                    disabled={busy || saveBusy}
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      if (picked.length > 0) setInvoiceFiles((prev) => [...prev, ...picked].slice(0, 10));
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>

              {invoiceFiles.length > 0 && (
                <ul className="space-y-1">
                  {invoiceFiles.map((file, fIdx) => (
                    <li key={`${file.name}-${fIdx}`} className="flex items-center justify-between gap-2 text-xs text-slate-200 bg-slate-900/80 rounded-lg border border-amber-500/30 px-2.5 py-1.5">
                      <span className="truncate">
                        {fIdx === 0 ? '📄 الفاتورة الأساسية: ' : '📎 '}{file.name}
                      </span>
                      <button
                        type="button"
                        aria-label={`إزالة ${file.name}`}
                        onClick={() => setInvoiceFiles((prev) => prev.filter((_, i) => i !== fIdx))}
                        className="px-2 py-0.5 text-[11px] font-bold text-red-400 hover:text-red-300 bg-red-950/40 rounded border border-red-800/50"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {invoiceFiles.length > 0 && (
                <div className="p-3 rounded-xl bg-slate-900/90 border border-amber-500/30 text-xs space-y-1.5 animate-fade-in text-right">
                  <div className="text-amber-300 font-bold flex items-center gap-1.5">
                    <span>🏷️</span>
                    <span>بيانات التسمية الموحدة للفاتورة في Google Drive:</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-300 text-[11px] pt-1">
                    <div><span className="text-slate-400">القطعة:</span> {po?.purchase_request?.parcel_reference || (po as any)?.purchase_request?.land_parcel?.parcel_reference || po?.items?.[0]?.item_reference || 'غير محدد'}</div>
                    <div><span className="text-slate-400">المنطقة:</span> {po?.purchase_request?.region || po?.items?.[0]?.region || 'غير محدد'}</div>
                    <div><span className="text-slate-400">البند:</span> {po?.items?.length === 1 ? (po.items[0].item?.name || po.items[0].item_description) : 'متعدد البنود'}</div>
                    <div><span className="text-slate-400">المورد:</span> {po?.supplier?.company_name || (po?.supplier as any)?.name || 'غير محدد'}</div>
                  </div>
                </div>
              )}

              {/* If PO already has invoice(s) attached */}
              {/* Files already attached stay attached: new files are added, never replace them. */}
              {Boolean(po?.invoice_attachments?.length || po?.invoice_photo_url) && (
                <div className="space-y-1.5">
                  {po?.invoice_attachments && po.invoice_attachments.length > 0 ? (
                    po.invoice_attachments.map((att, idx) => (
                      <div key={att.id || idx} className="flex items-center justify-between text-xs text-slate-300 bg-slate-900/90 p-2.5 rounded-lg border border-amber-500/30">
                        <span className="flex items-center gap-1.5 text-amber-300 font-bold truncate">
                          <span>📄</span> فاتورة #{idx + 1}: {att.file_name}
                        </span>
                        <a
                          href={att.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-400 hover:text-cyan-300 font-bold underline flex items-center gap-1 shrink-0 ml-2"
                        >
                          <span>👁️ معاينة الفاتورة</span>
                        </a>
                      </div>
                    ))
                  ) : (
                    <div className="flex items-center justify-between text-xs text-slate-300 bg-slate-900/90 p-2.5 rounded-lg border border-amber-500/30">
                      <span className="flex items-center gap-1.5 text-amber-300 font-bold truncate">
                        <span>📄</span> فاتورة سابقة مرفقة: {po?.invoice_photo_name || 'فاتورة المورد'}
                      </span>
                      <a
                        href={po?.invoice_photo_url || ''}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-400 hover:text-cyan-300 font-bold underline flex items-center gap-1 shrink-0 ml-2"
                      >
                        <span>👁️ معاينة الفاتورة</span>
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default FinalizeActualPoModal;
