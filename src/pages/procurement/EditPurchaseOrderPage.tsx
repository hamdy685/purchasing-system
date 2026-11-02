import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  getPurchaseOrderApi,
  updatePurchaseOrderApi,
  finalizeActualPurchaseOrderApi,
  uploadPurchaseOrderInvoiceApi,
  submitPurchaseOrderApi
} from '../../api/purchaseOrders';
import { getSuppliersApi } from '../../api/suppliers';
import { PurchaseOrder, المورد, FinalizeActualPoItemPayload } from '../../types/purchaseOrder';
import LoadingSpinner from '../../components/LoadingSpinner';
import ErrorMessage from '../../components/ErrorMessage';
import { parseApiError } from '../../utils/apiError';
import { SupplierSelectWithQuickAdd } from '../../components/common/SupplierSelectWithQuickAdd';
import { formatCleanNumber } from '../../utils/numberFormat';
import PurchaseOrderStatusBadge from '../../components/procurement/PurchaseOrderStatusBadge';
import { getUnitLabel, getUnitOptions, DEFAULT_PR_UNIT_CODES } from '../../utils/units';
import { SupplementItemBadge } from '../../components/common/SupplementItemBadge';
import { getReceiptPhotoUrl } from '../../api/purchaseReceipts';
import { getSummaryParcels, getSummaryRegions } from '../../utils/formatRequestSummary';
import { toast } from '../../utils/toast';
import CreateWeighingGroupModal from '../../components/procurement/CreateWeighingGroupModal';
import { calculateActualPoFinancials, ActualPoDiscountType } from '../../utils/actualPo';


const UNIT_OPTIONS = getUnitOptions(DEFAULT_PR_UNIT_CODES);

interface EditableItem {
  id?: number;
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
}

export const EditPurchaseOrderPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [suppliers, setSuppliers] = useState<المورد[]>([]);

  // Header State
  const [supplierId, setSupplierId] = useState<string>('');
  const [oneTimeSupplierName, setOneTimeSupplierName] = useState<string>('');
  const [paymentTerms, setPaymentTerms] = useState<string>('');
  const [deliveryDate, setDeliveryDate] = useState<string>('');
  const [budgetCode, setBudgetCode] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [finalizationNotes, setFinalizationNotes] = useState<string>('');
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [discountType, setDiscountType] = useState<ActualPoDiscountType>('NONE');
  const [discountPercentage, setDiscountPercentage] = useState<number>(0);

  // Items State (Local editable array for reactive & fast editing)
  const [items, setItems] = useState<EditableItem[]>([]);

  // Add Item Inputs
  const [newItemDesc, setNewItemDesc] = useState<string>('');
  const [newItemReference, setNewItemReference] = useState<string>('');
  const [newItemRegion, setNewItemRegion] = useState<string>('');
  const [newItemQty, setNewItemQty] = useState<number>(1);
  const [newItemPrice, setNewItemPrice] = useState<number>(0);
  const [newItemUom, setNewItemUom] = useState<string>('PCS');
  const [newItemSpecs, setNewItemSpecs] = useState<string>('');
  const [newItemSupplierId, setNewItemSupplierId] = useState<string>('');

  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);
  const [weighingModalOpen, setWeighingModalOpen] = useState<boolean>(false);

  const loadData = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [poData, sups] = await Promise.all([
        getPurchaseOrderApi(Number(id)),
        getSuppliersApi()
      ]);
      setPo(poData);
      // The order's own suppliers stay selectable even if the list does not carry them
      // (inactive supplier), so the selects never show an empty or wrong name.
      const listed = new Set((sups || []).map((s) => s.id));
      const ownSuppliers = [poData?.supplier, ...((poData?.items || []).map((it: any) => it.supplier))]
        .filter((s: any) => s?.id && !listed.has(s.id) && listed.add(s.id));
      setSuppliers([...(sups || []), ...ownSuppliers]);

      if (poData) {
        setSupplierId(String(poData.supplier_id || ''));
        setPaymentTerms(poData.payment_terms || '');
        setDeliveryDate(poData.delivery_date || '');
        setBudgetCode(poData.budget_code || '');
        setNotes(poData.notes || '');
        setFinalizationNotes(poData.finalization_notes || '');
        setDiscountType((poData.discount_type as ActualPoDiscountType) || 'NONE');
        setDiscountPercentage(Number(poData.discount_percentage) || 0);

        const isPendingActual = poData.status === 'PENDING_ACTUAL_PO';
        const receipts = poData.receipts || [];
        const hasApprovedOrPendingReceipt = receipts.some(
          (r) => r.status === 'APPROVED' || r.status === 'PENDING_SITE_ENGINEER'
        );

        // Map PO items to local editable state
        const rawItems = poData.items || [];
        const mappedItems: EditableItem[] = [];

        rawItems.forEach((it) => {
          let qty = Number(it.quantity || 0);
          const price = Number(it.unit_price || 0);

          // If in Actual PO workflow and receipts exist:
          if (isPendingActual && hasApprovedOrPendingReceipt && it.id) {
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

            if (foundInReceipt) {
              qty = totalReceived;
            } else if (isPendingActual) {
              qty = 0;
            }
          }

          const isSupplementary = Boolean(
            it.is_supplementary ||
            (it.pr_item as any)?.is_supplementary ||
            ((poData.purchase_request as any)?.supplements?.some((s: any) =>
              s.items?.some((si: any) => si.id === it.pr_item_id || si.item_description === it.item_description)
            ))
          );
          const supplementBatch = it.supplement_batch ?? (isSupplementary ? 1 : null);

          mappedItems.push({
            id: it.id,
            item_id: it.item_id ?? null,
            pr_item_id: it.pr_item_id ?? null,
            item_description: it.item_description || it.item_name || '',
            item_reference: it.item_reference || '',
            region: it.region || '',
            quantity: qty,
            uom: it.uom || 'PCS',
            unit_price: price,
            line_total: Math.round(qty * price * 100) / 100,
            specifications: it.specifications || '',
            supplier_id: it.supplier_id ?? null,
            is_supplementary: isSupplementary,
            supplement_batch: supplementBatch,
            is_discount_applied: Boolean(it.is_discount_applied),
          });
        });

        setItems(mappedItems);
      }
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [id]);

  if (loading) {
    return <LoadingSpinner message="جاري تحميل تفاصيل أمر الشراء ومحرر البنود..." />;
  }

  if (!po) {
    return (
      <div className="p-8 text-center bg-slate-950 border border-slate-800 text-slate-400 text-xs rounded-xl" dir="rtl">
        لم يتم العثور على أمر الشراء المطلوب للتعديل.
      </div>
    );
  }

  const isPendingActualPo = po.status === 'PENDING_ACTUAL_PO';
  const isDraftOrReturned = ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT'].includes(po.status);
  const isEditable = po.status !== 'REJECTED';

  // Calculate live Grand Total and Financials
  const financials = calculateActualPoFinancials({
    items,
    discountType,
    discountPercentage,
    taxAmount: Number(po.tax_amount) || 0,
  });
  const calculatedGrandTotal = financials.grandTotal;

  const handleItemDiscountToggle = (index: number) => {
    setItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], is_discount_applied: !copy[index].is_discount_applied };
      return copy;
    });
  };

  const handleSelectAllDiscounts = (applied: boolean) => {
    setItems((prev) => prev.map((it) => ({ ...it, is_discount_applied: applied })));
  };

  // Helper to find received quantity from linked GRN receipts
  const getReceivedQtyForPoItem = (poItemId?: number): number | null => {
    if (!poItemId || !po.receipts || !po.receipts.length) return null;
    let totalReceived = 0;
    let found = false;
    po.receipts.forEach((r) => {
      if (r.status === 'APPROVED' || r.status === 'PENDING_SITE_ENGINEER') {
        r.items?.forEach((ri) => {
          if (ri.purchase_order_item_id === poItemId) {
            totalReceived += Number(ri.received_quantity || 0);
            found = true;
          }
        });
      }
    });
    return found ? totalReceived : null;
  };

  // Update item field locally
  const handleItemFieldChange = (index: number, field: keyof EditableItem, value: any) => {
    setItems((prev) => {
      const copy = [...prev];
      const item = { ...copy[index], [field]: value };
      if (field === 'quantity' || field === 'unit_price') {
        const q = field === 'quantity' ? Number(value) : item.quantity;
        const p = field === 'unit_price' ? Number(value) : item.unit_price;
        item.line_total = Math.round(q * p * 100) / 100;
      }
      copy[index] = item;
      return copy;
    });
  };

  // Match item quantity with GRN received quantity
  const handleApplyGrnQty = (index: number, grnQty: number) => {
    handleItemFieldChange(index, 'quantity', grnQty);
  };

  // Match all items with GRN received quantities
  const handleMatchAllWithGrn = () => {
    setItems((prev) =>
      prev.map((it) => {
        const grnQty = getReceivedQtyForPoItem(it.id);
        if (grnQty !== null && grnQty >= 0) {
          const lineTotal = Math.round(grnQty * it.unit_price * 100) / 100;
          return { ...it, quantity: grnQty, line_total: lineTotal };
        }
        return it;
      })
    );
    setSuccessMsg('تمت مطابقة كميات البنود مع الكميات المستلمة فعلياً في إذن الاستلام.');
  };

  // Add Item to local list
  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemDesc.trim() || !newItemReference.trim() || !newItemRegion.trim() || newItemQty <= 0) {
      setError('وصف البند، رقم قطعة الأرض، المنطقة، والكمية حقول مطلوبة.');
      return;
    }
    const lineTotal = Math.round(newItemQty * newItemPrice * 100) / 100;
    const newItem: EditableItem = {
      item_description: newItemDesc.trim(),
      item_reference: newItemReference.trim(),
      region: newItemRegion.trim(),
      quantity: newItemQty,
      uom: newItemUom.trim() || 'PCS',
      unit_price: newItemPrice,
      line_total: lineTotal,
      supplier_id: newItemSupplierId ? Number(newItemSupplierId) : (supplierId ? Number(supplierId) : (po?.supplier_id ?? undefined)),
      specifications: newItemSpecs.trim() || undefined,
    };
    setItems((prev) => [...prev, newItem]);
    setNewItemDesc('');
    setNewItemReference('');
    setNewItemRegion('');
    setNewItemQty(1);
    setNewItemPrice(0);
    setNewItemSpecs('');
    setNewItemSupplierId('');
    setError(null);
  };

  // Remove Item from local list
  const handleRemoveItem = (index: number) => {
    if (items.length <= 1) {
      setError('يجب أن يحتوي أمر الشراء على بند واحد على الأقل.');
      return;
    }
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  // Build items payload for saving
  const buildItemsPayload = () => {
    return items.map((it) => ({
      id: it.id,
      item_id: it.item_id,
      pr_item_id: it.pr_item_id,
      item_description: it.item_description,
      item_reference: it.item_reference,
      region: it.region,
      quantity: Number(it.quantity),
      uom: it.uom,
      unit_price: Number(it.unit_price),
      supplier_id: it.supplier_id ? Number(it.supplier_id) : (supplierId ? Number(supplierId) : po.supplier_id),
      is_supplementary: Boolean(it.is_supplementary),
      supplement_batch: it.supplement_batch ?? null,
      is_discount_applied: discountType === 'SELECTED_ITEMS' ? Boolean(it.is_discount_applied) : false,
    }));
  };

  // Save All Changes (Header + Line Items) - Full autonomy for Procurement Manager
  const handleSaveAllChanges = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (items.length === 0) {
      setError('يجب أن يحتوي أمر الشراء على بند واحد على الأقل.');
      return;
    }
    const hasInvalid = items.some(
      (it) => it.quantity < 0 || !it.item_description.trim() || !it.item_reference.trim() || !it.region.trim()
    );
    if (hasInvalid) {
      setError('يرجى التأكد من ملء حقول (الوصف، رقم قطعة الأرض، المنطقة، والكمية لا تقل عن صفر) لجميع البنود.');
      return;
    }

    const discountPct = Number(discountPercentage) || 0;
    if (discountPct < 0 || discountPct > 100) {
      setError('نسبة الخصم يجب أن تكون بين 0% و 100%.');
      return;
    }
    if (discountType === 'SELECTED_ITEMS' && discountPct > 0 && !items.some((it) => it.is_discount_applied)) {
      setError('يرجى تحديد بند واحد على الأقل لتطبيق الخصم عليه، أو اختيار «بدون خصم».');
      return;
    }

    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const payloadItems = buildItemsPayload();
      const targetedItemIds = discountType === 'SELECTED_ITEMS'
        ? items.filter((it) => it.is_discount_applied && it.id).map((it) => it.id!)
        : [];

      const updated = await updatePurchaseOrderApi(po.id, {
        supplier_id: supplierId ? Number(supplierId) : undefined,
        one_time_supplier_name: oneTimeSupplierName.trim() || undefined,
        payment_terms: paymentTerms || undefined,
        delivery_date: deliveryDate || undefined,
        budget_code: budgetCode || undefined,
        notes: notes || undefined,
        finalization_notes: finalizationNotes || undefined,
        discount_type: discountType,
        discount_percentage: discountPct,
        discount_item_ids: targetedItemIds,
        items: payloadItems,
      });
      let currentPo = updated;
      if (invoiceFile) {
        currentPo = await uploadPurchaseOrderInvoiceApi(po.id, invoiceFile);
        setInvoiceFile(null);
      }
      setPo(currentPo);
      setSuccessMsg('✅ تم حفظ كافة تعديلات أمر الشراء وبيانات البنود والأسعار ونظام الخصومات والفاتورة بنجاح.');
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
    } finally {
      setBusy(false);
    }
  };

  // Submit Draft to Site/Warehouse
  const handleSubmitDraftToSite = async () => {
    if (!confirm('هل أنت متأكد من حفظ التعديلات وإرسال أمر الشراء المبدئي للاستلام والتوريد بالموقع؟')) return;
    setBusy(true);
    setError(null);
    try {
      const payloadItems = buildItemsPayload();
      await updatePurchaseOrderApi(po.id, {
        supplier_id: supplierId ? Number(supplierId) : undefined,
        one_time_supplier_name: oneTimeSupplierName.trim() || undefined,
        payment_terms: paymentTerms || undefined,
        delivery_date: deliveryDate || undefined,
        budget_code: budgetCode || undefined,
        notes: notes || undefined,
        items: payloadItems,
      });
      await submitPurchaseOrderApi(po.id);
      setSuccessMsg('✅ تم حفظ وإرسال أمر الشراء للاستلام بالموقع بنجاح.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await loadData();
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
    } finally {
      setBusy(false);
    }
  };

  // Finalize Actual PO & Send to Accounting
  const handleFinalizeActualPo = async () => {
    if (items.length === 0) {
      setError('لا يمكن إصدار أمر شراء فعلي بدون بنود.');
      return;
    }
    const hasInvalid = items.some((it) => it.quantity < 0 || !it.item_description || !it.item_reference || !it.region);
    if (hasInvalid) {
      setError('يرجى التحقق من صحة جميع البنود (الكمية لا تقل عن صفر، الوصف، رقم قطعة الأرض، والمنطقة).');
      return;
    }

    const discountPct = Number(discountPercentage) || 0;
    if (discountPct < 0 || discountPct > 100) {
      setError('نسبة الخصم يجب أن تكون بين 0% و 100%.');
      return;
    }
    if (discountType === 'SELECTED_ITEMS' && discountPct > 0 && !items.some((it) => it.is_discount_applied)) {
      setError('يرجى تحديد بند واحد على الأقل لتطبيق الخصم عليه، أو اختيار «بدون خصم».');
      return;
    }

    if (!confirm('هل أنت متأكد من إصدار أمر الشراء الفعلي بعد اعتماد الاستلام وإرساله رسميًا للإدارة المالية والحسابات؟')) return;

    setBusy(true);
    setError(null);
    try {
      // First update header if supplier or dates changed
      if (supplierId && Number(supplierId) !== po.supplier_id) {
        await updatePurchaseOrderApi(po.id, {
          supplier_id: Number(supplierId),
          payment_terms: paymentTerms || undefined,
          delivery_date: deliveryDate || undefined,
          notes: notes || undefined,
        });
      }

      const targetedItemIds = discountType === 'SELECTED_ITEMS'
        ? items.filter((it) => it.is_discount_applied && it.id).map((it) => it.id!)
        : [];

      const payloadItems: FinalizeActualPoItemPayload[] = items.map((it) => ({
        id: it.id,
        item_id: it.item_id,
        pr_item_id: it.pr_item_id,
        item_description: it.item_description,
        item_reference: it.item_reference,
        region: it.region,
        quantity: Number(it.quantity),
        uom: it.uom,
        unit_price: Number(it.unit_price),
        specifications: it.specifications,
        supplier_id: it.supplier_id ? Number(it.supplier_id) : (supplierId ? Number(supplierId) : po.supplier_id),
        is_discount_applied: discountType === 'SELECTED_ITEMS' ? Boolean(it.is_discount_applied) : false,
      }));

      await finalizeActualPurchaseOrderApi(po.id, {
        supplier_id: supplierId ? Number(supplierId) : undefined,
        discount_type: discountType,
        discount_percentage: discountPct,
        discount_item_ids: targetedItemIds,
        items: payloadItems,
        notes: finalizationNotes.trim() || undefined,
        invoice_file: invoiceFile || undefined,
      });

      toast.success(`✅ تم إصدار أمر الشراء الفعلي (${po.po_number}) بنجاح واعتماده وإرساله للإدارة المالية.`);
      navigate('/procurement', {
        replace: true,
        state: { successMsg: `✅ تم إصدار أمر الشراء الفعلي (${po.po_number}) بنجاح واعتماده وإرساله للإدارة المالية.` },
      });
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
    } finally {
      setBusy(false);
    }
  };

  const latestReceipt = po.receipts && po.receipts.length > 0 ? po.receipts[0] : null;

  const hasSteelItems = Boolean(
    po?.items?.some((item) => {
      const desc = (item.item_description || '').toLowerCase();
      const uom = (item.uom || '').toUpperCase();
      const isExcluded = ['رمل', 'سن', 'زلط', 'ركام', 'أسمنت', 'اسمنت', 'خشب', 'طوب', 'بلوك', 'سلك'].some((kw) => desc.includes(kw));
      if (isExcluded) return false;
      return desc.includes('حديد') || desc.includes('تسليح') || desc.includes('سيخ') || ['BAR_2_5LINIA', 'BAR_3LINIA', 'BAR_4LINIA', 'BAR_5LINIA', 'PARCEL', 'TON'].includes(uom);
    })
  );

  return (
    <div className="procurement-reference-page space-y-6 pb-20 animate-fade-in" dir="rtl">
      {/* ── Header Bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-black text-slate-100 font-mono">{po.po_number}</h1>
            <PurchaseOrderStatusBadge status={po.status} />
          </div>
          <div className="flex items-center gap-2 mt-2 px-3 py-1.5 rounded-xl bg-gradient-to-r from-amber-950/60 to-slate-900 border border-amber-500/40 text-xs w-fit">
            <span className="text-amber-400 font-bold">🏷️ رقم قطعة الأرض:</span>
            <strong className="font-mono font-black text-amber-300 text-sm">{getSummaryParcels(po)}</strong>
            <span className="text-slate-600 mx-1">|</span>
            <span className="text-copper-400 font-bold">📍 المشروع / المنطقة:</span>
            <strong className="font-black text-copper-200 text-sm">{getSummaryRegions(po)}</strong>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {isPendingActualPo
              ? '⚡ إصدار أمر الشراء الفعلي — مطابقة وتعديل الكميات والأسعار بعد اعتماد إذن الاستلام بالموقع'
              : 'تحديث الشروط التجاريّة والبنود لأمر الشراء'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasSteelItems && (
            <button
              type="button"
              onClick={() => setWeighingModalOpen(true)}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-4 py-2 rounded-lg shadow-lg shadow-indigo-600/30 flex items-center gap-1.5 transition-all cursor-pointer"
              title="تجميع بنود الحديد من نفس المورد في وزنة ميزان بسكول واحدة"
            >
              <span>⚖️</span>
              <span>تجميع الوزنة</span>
            </button>
          )}

          <Link
            to={`/procurement/purchase-orders/${po.id}`}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-4 py-2 rounded-lg font-semibold transition-colors"
          >
            ← العودة للتفاصيل
          </Link>

          {isEditable && (
            <button
              type="button"
              onClick={handleSaveAllChanges}
              disabled={busy}
              className="bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs px-5 py-2.5 rounded-lg shadow-lg shadow-cyan-600/30 flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <span>💾 حفظ كافة التعديلات</span>
            </button>
          )}

          {isPendingActualPo && (
            <button
              type="button"
              onClick={handleFinalizeActualPo}
              disabled={busy}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black text-xs px-5 py-2.5 rounded-lg shadow-lg shadow-emerald-900/40 flex items-center gap-2 transition-all cursor-pointer"
            >
              <span>💰 اعتماد وإرسال للإدارة المالية</span>
            </button>
          )}

          {isDraftOrReturned && (
            <button
              type="button"
              onClick={handleSubmitDraftToSite}
              disabled={busy}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-5 py-2.5 rounded-lg shadow-lg shadow-indigo-600/20 transition-all cursor-pointer"
            >
              حفظ وإرسال للاستلام بالموقع
            </button>
          )}
        </div>
      </div>

      {error && <ErrorMessage error={error} />}

      {successMsg && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200 shadow-lg shadow-emerald-950/40">
          <div className="flex items-center gap-2">
            <span className="text-lg">✅</span>
            <span className="font-bold">{successMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            className="text-emerald-400 hover:text-emerald-200 text-xs font-bold px-2 py-1 rounded"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Procurement Autonomy Banner (When not PENDING_ACTUAL_PO) ── */}
      {!isPendingActualPo && (
        <div className="rounded-xl border border-cyan-800/40 bg-gradient-to-r from-cyan-950/30 via-slate-900 to-slate-950 p-4 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 text-cyan-300">
            <span className="text-xl">💼</span>
            <div>
              <p className="font-bold text-slate-100">
                صلاحية تعديل كاملة ومستقلة لمدير المشتريات
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                يمكنك تعديل أي بيانات في أمر الشراء (الكميات، الأسعار، المورد، شروط الدفع، وحذف أو إضافة بنود) مباشرة في أي وقت دون الحاجة لطلب إرجاع أو اعتماد إضافي.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSaveAllChanges}
            disabled={busy}
            className="bg-cyan-600 hover:bg-cyan-500 text-white font-bold px-4 py-2 rounded-lg shadow-md transition-all cursor-pointer self-start sm:self-auto whitespace-nowrap"
          >
            {busy ? 'جاري الحفظ...' : '💾 حفظ التعديلات'}
          </button>
        </div>
      )}

      {/* ── Actual PO Callout Banner (When PENDING_ACTUAL_PO) ── */}
      {isPendingActualPo && (
        <div className="rounded-2xl border-2 border-indigo-500/50 bg-gradient-to-r from-indigo-950/40 via-slate-900 to-slate-950 p-5 shadow-2xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="text-3xl">📦</span>
              <div>
                <h3 className="text-base font-black text-indigo-300">
                  مرحلة إصدار أمر الشراء الفعلي (Actual PO Workflow)
                </h3>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                  تم توريد البضاعة واعتماد إذن الاستلام (GRN) في الموقع. بصفتك إدارة المشتريات، لديك الصلاحية الكاملة لتعديل الكميات والأسعار وإضافة أو حذف أي بنود لتعكس الواقع الفعلي تماماً، ثم إرسال الملف النهائي للإدارة المالية.
                </p>
                {latestReceipt && (
                  <div className="flex flex-wrap items-center justify-between gap-3 mt-3 text-xs text-slate-400 bg-slate-900/80 p-2.5 rounded-xl border border-slate-800">
                    <div className="flex flex-wrap items-center gap-3">
                      <span>إذن الاستلام: <strong className="text-cyan-300 font-mono">{latestReceipt.receipt_number}</strong></span>
                      <span>•</span>
                      <span>أمين المخزن: <strong className="text-slate-200">{latestReceipt.warehouse_keeper?.name || '—'}</strong></span>
                      <span>•</span>
                      <span>مهندس الموقع: <strong className="text-slate-200">{latestReceipt.site_engineer?.name || '—'}</strong></span>
                      {latestReceipt.received_at && (
                        <>
                          <span>•</span>
                          <span>تاريخ الاستلام: <strong className="text-slate-200 font-mono">{latestReceipt.received_at}</strong></span>
                        </>
                      )}
                    </div>
                    {Boolean(latestReceipt.photo_url || (latestReceipt as any).photo_path) && (
                      <div className="flex items-center gap-2">
                        <div
                          onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(latestReceipt))}
                          className="relative h-9 w-9 rounded-lg overflow-hidden border border-cyan-400/80 cursor-pointer shrink-0 shadow group"
                          title="اضغط لتكبير صورة بون الميزان"
                        >
                          <img
                            src={getReceiptPhotoUrl(latestReceipt)}
                            alt="بون الميزان"
                            className="h-full w-full object-cover group-hover:scale-110 transition-transform"
                          />
                          <div className="absolute inset-0 bg-slate-950/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="text-[10px] text-white">🔍</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(latestReceipt))}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-950/90 hover:bg-cyan-900 border border-cyan-500/60 text-cyan-300 font-bold text-xs transition-all cursor-pointer shadow-sm hover:border-cyan-400"
                          title="معاينة صورة بون الميزان أو إذن التوريد المرفوعة من أمين المخزن"
                        >
                          <span>📷</span>
                          <span>🔍 عرض صورة بون الميزان</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handleMatchAllWithGrn}
              className="shrink-0 bg-indigo-700/80 hover:bg-indigo-600 text-white font-bold text-xs px-4 py-2.5 rounded-xl border border-indigo-500/50 shadow-md transition-all flex items-center gap-2 cursor-pointer"
            >
              <span>⚡ مطابقة كافة الكميات مع إذن الاستلام</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Supplement Information Callout Banner ── */}
      {items.some((it) => it.is_supplementary) && (
        <div className="rounded-2xl border-2 border-amber-500/80 bg-gradient-to-r from-amber-950/70 via-slate-900 to-amber-950/50 p-5 shadow-2xl text-amber-200 space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 border border-amber-500/50 text-amber-300 text-xl font-black shadow-inner">
              ⚡
            </span>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h3 className="text-base font-black text-amber-300">
                  أمر الشراء هذا يتضمن بنود كمالة إضافية معتمدة (طلب كمالة)
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-amber-500 text-slate-950 shadow-sm">
                  {items.filter((it) => it.is_supplementary).length} بند كمالة
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                تم تحميل بنود الكمالة (المميزة بالبادج الذهبي ⚡) على أمر الشراء الحالي لتعكس الكميات والأسعار الإجمالية المعتمدة.
                {latestReceipt && (
                  <span className="block mt-1 text-amber-200/95 font-semibold">
                    📌 تنبيه: إذن الاستلام الميداني رقم (<strong className="font-mono text-cyan-300">{latestReceipt.receipt_number}</strong>) يخص التوريد المبدئي المستلم، بينما بنود الكمالة تمثل كميات إضافية ملحقة بأمر الشراء.
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Commercial Header Form ── */}
      <form onSubmit={handleSaveAllChanges} className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
            البيانات التجارية والرئيسية
          </h3>
          {isEditable && (
            <button
              type="submit"
              disabled={busy}
              className="bg-slate-800 hover:bg-slate-700 text-cyan-400 font-bold text-xs min-h-[44px] sm:min-h-0 px-3.5 py-1.5 rounded-xl border border-slate-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none transition-all flex items-center justify-center gap-1.5"
            >
              {busy ? 'جاري الحفظ...' : '💾 حفظ البيانات'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <SupplierSelectWithQuickAdd
              suppliers={suppliers}
              selectedSupplierId={supplierId}
              onSelectSupplierId={(val) => {
                const oldId = supplierId ? Number(supplierId) : po?.supplier_id;
                setSupplierId(val);
                if (val) {
                  const newNum = Number(val);
                  setItems((prev) =>
                    prev.map((it) => {
                      if (!it.supplier_id || it.supplier_id === oldId) {
                        return { ...it, supplier_id: newNum };
                      }
                      return it;
                    })
                  );
                }
              }}
              oneTimeSupplierName={oneTimeSupplierName}
              onChangeOneTimeSupplierName={(name) => setOneTimeSupplierName(name)}
              onSupplierCreated={(newSup) => {
                const oldId = supplierId ? Number(supplierId) : po?.supplier_id;
                setSuppliers((prev) => [...prev, newSup]);
                setSupplierId(String(newSup.id));
                setOneTimeSupplierName('');
                setItems((prev) =>
                  prev.map((it) => {
                    if (!it.supplier_id || it.supplier_id === oldId) {
                      return { ...it, supplier_id: newSup.id };
                    }
                    return it;
                  })
                );
              }}
              disabled={!isEditable}
              label="المورد المعتمد"
              required
            />
            {isEditable && supplierId && (
              <button
                type="button"
                onClick={() => {
                  const sNum = Number(supplierId);
                  setItems((prev) => prev.map((it) => ({ ...it, supplier_id: sNum })));
                  toast.info('تم تطبيق هذا المورد على كافة البنود أدناه');
                }}
                className="mt-1.5 text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 cursor-pointer"
                title="تطبيق هذا المورد المعتمد على جميع بنود الطلب في الجدول"
              >
                <span>⚡ تطبيق هذا المورد على كافة بنود الطلب أدناه</span>
              </button>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">تاريخ التوريد الفعلي / المتوقع</label>
            <input
              type="date"
              disabled={!isEditable}
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-cyan-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">شروط الدفع والتعاقد</label>
            <input
              type="text"
              disabled={!isEditable}
              placeholder="مثال: نقدي عند الاستلام / آجل 30 يوم"
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-cyan-500"
            />
          </div>
        </div>
      </form>

      {/* ── Line Items Section ── */}
      <div className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-4 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div>
            <h3 className="text-sm font-black text-slate-100">
              بنود أمر الشراء والأسعار التنافسية ({items.length} بند)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              يمكنك تعديل الكمية أو السعر مباشرة، وسيتم تحديث الإجمالي تلقائياً
            </p>
          </div>

          {isPendingActualPo && (
            <button
              type="button"
              onClick={handleMatchAllWithGrn}
              className="text-xs font-bold text-indigo-300 hover:text-indigo-200 bg-indigo-950/60 hover:bg-indigo-900/60 px-3 py-1.5 rounded-lg border border-indigo-700/60 transition-colors flex items-center gap-1 self-start sm:self-auto cursor-pointer"
            >
              <span>⚡ مطابقة الكل مع إذن الاستلام</span>
            </button>
          )}
        </div>

        {/* ── Discount Configuration Card ── */}
        <div className="rounded-xl border border-amber-500/40 bg-slate-900/90 p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
            <div className="flex items-center gap-2">
              <span className="text-base">🏷️</span>
              <span className="font-bold text-xs sm:text-sm text-slate-100">نظام الخصومات:</span>
            </div>
            {discountType !== 'NONE' && (
              <span className="text-[11px] font-bold text-amber-300 bg-amber-950/60 border border-amber-800/80 px-2.5 py-0.5 rounded-full">
                {discountType === 'TOTAL' ? 'خصم على إجمالي أمر الشراء' : 'خصم على بنود محددة مختارة'}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
            {/* 1. Discount Type Selector */}
            <div className="lg:col-span-7 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!isEditable || busy}
                onClick={() => setDiscountType('NONE')}
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
                disabled={!isEditable || busy}
                onClick={() => setDiscountType('TOTAL')}
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
                disabled={!isEditable || busy}
                onClick={() => setDiscountType('SELECTED_ITEMS')}
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
                    disabled={!isEditable || busy}
                    value={discountPercentage || ''}
                    onChange={(e) => {
                      const val = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                      setDiscountPercentage(val);
                    }}
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
                <span>حدد البنود المستهدفة بالخصم من خانات الاختيار (✓) بالجدول أدناه. البنود غير المحددة لن تتأثر بالخصم.</span>
              </div>
              {isEditable && (
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
              )}
            </div>
          )}
        </div>

        {/* Existing Items Table (Desktop) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-900 text-slate-400 font-bold uppercase border-b border-slate-800">
              <tr>
                <th className="p-3 w-10">#</th>
                {discountType === 'SELECTED_ITEMS' && (
                  <th className="p-3 w-20 text-center bg-amber-950/40 text-amber-300">
                    <label className="flex items-center justify-center gap-1 cursor-pointer" title="تحديد/إلغاء تحديد كل البنود للخصم">
                      <input
                        type="checkbox"
                        checked={items.length > 0 && items.every((it) => it.is_discount_applied)}
                        onChange={(e) => handleSelectAllDiscounts(e.target.checked)}
                        disabled={!isEditable || busy}
                        className="rounded accent-amber-500 cursor-pointer"
                      />
                      <span>خصم</span>
                    </label>
                  </th>
                )}
                <th className="p-3">رقم قطعة الأرض *</th>
                <th className="p-3">المنطقة *</th>
                <th className="p-3">الوصف والمواصفات</th>
                <th className="p-3 w-40 text-center">المورد الفعلي</th>
                {isPendingActualPo && <th className="p-3 text-center">المستلم في GRN</th>}
                <th className="p-3 w-28">الكمية الفعلية *</th>
                <th className="p-3 w-20">الوحدة</th>
                <th className="p-3 w-32">سعر الوحدة (ج.م) *</th>
                <th className="p-3 w-32">الإجمالي</th>
                {isEditable && <th className="p-3 text-center w-14">حذف</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {items.map((item, idx) => {
                const grnQty = getReceivedQtyForPoItem(item.id);
                const isDifferentFromGrn = grnQty !== null && Number(item.quantity) !== Number(grnQty);
                const isItemDiscounted = discountType === 'SELECTED_ITEMS' && item.is_discount_applied;
                const discountedLineTotal = isItemDiscounted
                  ? Math.max(0, item.line_total * (1 - (Number(discountPercentage) || 0) / 100))
                  : item.line_total;

                return (
                  <tr
                    key={`item-row-${item.id || idx}`}
                    className={`transition-colors ${
                      isItemDiscounted
                        ? 'bg-amber-950/15 hover:bg-amber-950/25'
                        : 'hover:bg-slate-900/50'
                    }`}
                  >
                    <td className="p-3 font-mono text-slate-500 text-center">{idx + 1}</td>

                    {discountType === 'SELECTED_ITEMS' && (
                      <td className="p-3 text-center bg-amber-950/20">
                        <label className="flex items-center justify-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(item.is_discount_applied)}
                            onChange={() => handleItemDiscountToggle(idx)}
                            disabled={!isEditable || busy}
                            className="h-4 w-4 rounded accent-amber-500 cursor-pointer"
                          />
                        </label>
                      </td>
                    )}

                    {/* Parcel Reference */}
                    <td className="p-3">
                      <input
                        type="text"
                        required
                        disabled={!isEditable || busy}
                        value={item.item_reference}
                        onChange={(e) => handleItemFieldChange(idx, 'item_reference', e.target.value)}
                        dir="ltr"
                        className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:border-cyan-500"
                      />
                    </td>

                    {/* Region */}
                    <td className="p-3">
                      <input
                        type="text"
                        required
                        disabled={!isEditable || busy}
                        value={item.region}
                        onChange={(e) => handleItemFieldChange(idx, 'region', e.target.value)}
                        className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-cyan-500"
                      />
                    </td>

                    {/* Description */}
                    <td className="p-3">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            type="text"
                            required
                            disabled={!isEditable || busy}
                            value={item.item_description}
                            onChange={(e) => handleItemFieldChange(idx, 'item_description', e.target.value)}
                            className="flex-1 min-w-[160px] bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-cyan-500"
                          />
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
                        {item.specifications && (
                          <p className="text-[10px] text-slate-400 mt-1">{item.specifications}</p>
                        )}
                      </div>
                    </td>

                    {/* Supplier Selector */}
                    <td className="p-3 text-center">
                      {isEditable ? (
                        <select
                          disabled={busy}
                          value={item.supplier_id || supplierId || po?.supplier_id || ''}
                          onChange={(e) => handleItemFieldChange(idx, 'supplier_id', e.target.value ? Number(e.target.value) : null)}
                          className="w-36 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:border-cyan-500 font-medium cursor-pointer truncate"
                          title="تحديد المورد الفعلي لهذا البند"
                        >
                          <option value="">— اختر المورد —</option>
                        {suppliers.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.company_name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-slate-300 font-semibold truncate block max-w-[140px]">
                          {suppliers.find((s) => s.id === (item.supplier_id || po?.supplier_id))?.company_name || po?.supplier?.company_name || '—'}
                        </span>
                      )}
                    </td>

                    {/* GRN Received Quantity Hint */}
                    {isPendingActualPo && (
                      <td className="p-3 text-center">
                        {grnQty !== null ? (
                          <div className="flex flex-col items-center gap-1">
                            <span className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-bold ${
                              isDifferentFromGrn
                                ? 'bg-amber-950/80 text-amber-300 border border-amber-700/60'
                                : 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/60'
                            }`}>
                              📦 {grnQty}
                            </span>
                            {isDifferentFromGrn && (
                              <button
                                type="button"
                                onClick={() => handleApplyGrnQty(idx, grnQty)}
                                className="text-[10px] text-indigo-400 hover:text-indigo-200 underline font-semibold cursor-pointer"
                              >
                                تطبيق
                              </button>
                            )}
                          </div>
                        ) : item.is_supplementary ? (
                          <div className="flex flex-col items-center gap-0.5" title="هذا البند تمت إضافته كطلب كمالة إضافية بعد التوريد المبدئي">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-950/80 text-amber-300 border border-amber-600/60 shadow-sm whitespace-nowrap">
                              ⚡ كمالة إضافية
                            </span>
                            <span className="text-[9px] text-slate-400 font-medium whitespace-nowrap">بانتظار استلام الموقع</span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-500">—</span>
                        )}
                      </td>
                    )}

                    {/* Actual Quantity */}
                    <td className="p-3">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        required
                        disabled={!isEditable || busy}
                        value={item.quantity}
                        onChange={(e) => handleItemFieldChange(idx, 'quantity', Number(e.target.value))}
                        className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-slate-100 focus:border-cyan-500 text-center"
                      />
                    </td>

                    {/* UOM */}
                    <td className="p-3">
                      {isEditable ? (
                        <select
                          disabled={busy}
                          value={item.uom || ''}
                          onChange={(e) => handleItemFieldChange(idx, 'uom', e.target.value)}
                          className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:border-cyan-500 font-medium cursor-pointer"
                          title="تعديل وحدة القياس"
                        >
                          {item.uom && !DEFAULT_PR_UNIT_CODES.includes(item.uom) && (
                            <option value={item.uom}>{getUnitLabel(item.uom)}</option>
                          )}
                          {UNIT_OPTIONS.map((u) => (
                            <option key={u.value} value={u.value}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="px-2 py-1 rounded bg-slate-900 border border-slate-800 text-[11px] text-slate-300 font-mono">
                          {getUnitLabel(item.uom)}
                        </span>
                      )}
                    </td>

                    {/* Unit Price */}
                    <td className="p-3">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        required
                        disabled={!isEditable || busy}
                        value={item.unit_price}
                        onChange={(e) => handleItemFieldChange(idx, 'unit_price', Number(e.target.value))}
                        className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-cyan-300 focus:border-cyan-500 text-center"
                      />
                    </td>

                    {/* Line Total */}
                    <td className="p-3 font-mono font-bold text-xs">
                      <span className={isItemDiscounted ? 'text-slate-400 line-through text-[11px] block' : 'text-emerald-400'}>
                        {formatCleanNumber(item.line_total)} ج.م
                      </span>
                      {isItemDiscounted && (
                        <span className="text-emerald-400 text-xs block font-black">
                          {formatCleanNumber(discountedLineTotal)} ج.م
                        </span>
                      )}
                    </td>

                    {/* Delete Action */}
                    {isEditable && (
                      <td className="p-3 text-center">
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(idx)}
                          className="text-rose-400 hover:text-rose-300 font-bold p-1 text-sm transition-colors cursor-pointer"
                          title="حذف هذا البند"
                        >
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Existing Items Cards (Mobile) */}
        <div className="space-y-3 md:hidden">
          {items.map((item, idx) => {
            const grnQty = getReceivedQtyForPoItem(item.id);
            const isDifferentFromGrn = grnQty !== null && Number(item.quantity) !== Number(grnQty);
            const isItemDiscounted = discountType === 'SELECTED_ITEMS' && item.is_discount_applied;
            const discountedLineTotal = isItemDiscounted
              ? Math.max(0, item.line_total * (1 - (Number(discountPercentage) || 0) / 100))
              : item.line_total;

            return (
              <article
                key={`mobile-item-${item.id || idx}`}
                className={`rounded-2xl border p-4 space-y-3 ${
                  isItemDiscounted
                    ? 'border-amber-600/50 bg-slate-900/90'
                    : 'border-slate-800 bg-slate-900/80'
                }`}
              >
                <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-slate-300">
                      بند {idx + 1}
                    </span>
                    <span className="font-bold text-slate-200 text-xs">{item.item_description}</span>
                    <SupplementItemBadge
                      isSupplementary={item.is_supplementary}
                      batchNumber={item.supplement_batch}
                    />
                  </div>
                  {isEditable && (
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(idx)}
                      className="text-rose-400 hover:text-rose-300 font-bold text-sm"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {discountType === 'SELECTED_ITEMS' && (
                  <div className="flex items-center justify-between p-2 rounded-lg bg-amber-950/30 border border-amber-800/40">
                    <span className="text-[11px] font-bold text-amber-300">تطبيق الخصم على هذا البند:</span>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(item.is_discount_applied)}
                        onChange={() => handleItemDiscountToggle(idx)}
                        disabled={!isEditable || busy}
                        className="h-4 w-4 rounded accent-amber-500 cursor-pointer"
                      />
                      <span className="text-xs font-bold text-amber-200">
                        {item.is_discount_applied ? `محدد (${discountPercentage}%) ✓` : 'غير محدد'}
                      </span>
                    </label>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">رقم قطعة الأرض</label>
                    <input
                      type="text"
                      disabled={!isEditable || busy}
                      value={item.item_reference}
                      onChange={(e) => handleItemFieldChange(idx, 'item_reference', e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">المنطقة</label>
                    <input
                      type="text"
                      disabled={!isEditable || busy}
                      value={item.region}
                      onChange={(e) => handleItemFieldChange(idx, 'region', e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                    />
                  </div>
                </div>

                {isPendingActualPo && (
                  <div className="flex items-center justify-between bg-slate-950/70 p-2 rounded-lg border border-slate-800 text-xs">
                    <span className="text-slate-400">المستلم في GRN:</span>
                    {grnQty !== null ? (
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-cyan-300">{grnQty} {getUnitLabel(item.uom)}</span>
                        {isDifferentFromGrn && (
                          <button
                            type="button"
                            onClick={() => handleApplyGrnQty(idx, grnQty)}
                            className="text-[10px] text-indigo-400 underline font-semibold"
                          >
                            تطبيق الكمية
                          </button>
                        )}
                      </div>
                    ) : item.is_supplementary ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-950/80 text-amber-300 border border-amber-600/60">
                        ⚡ كمالة إضافية (بانتظار الاستلام بالموقع)
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs">
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">المورد</label>
                    {isEditable ? (
                      <select
                        disabled={busy}
                        value={item.supplier_id || supplierId || po?.supplier_id || ''}
                        onChange={(e) => handleItemFieldChange(idx, 'supplier_id', e.target.value ? Number(e.target.value) : null)}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-200 truncate cursor-pointer"
                      >
                        <option value="">— اختر المورد —</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.company_name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="p-1 text-xs text-slate-300 font-mono truncate">
                        {suppliers.find((s) => s.id === (item.supplier_id || po?.supplier_id))?.company_name || po?.supplier?.company_name || '—'}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">الكمية الفعلية</label>
                    <input
                      type="number"
                      step="any"
                      disabled={!isEditable || busy}
                      value={item.quantity}
                      onChange={(e) => handleItemFieldChange(idx, 'quantity', Number(e.target.value))}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">الوحدة</label>
                    {isEditable ? (
                      <select
                        disabled={busy}
                        value={item.uom || ''}
                        onChange={(e) => handleItemFieldChange(idx, 'uom', e.target.value)}
                        className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-xs text-slate-200"
                      >
                        {item.uom && !DEFAULT_PR_UNIT_CODES.includes(item.uom) && (
                          <option value={item.uom}>{getUnitLabel(item.uom)}</option>
                        )}
                        {UNIT_OPTIONS.map((u) => (
                          <option key={u.value} value={u.value}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="p-1 text-xs text-slate-300 font-mono">{getUnitLabel(item.uom)}</div>
                    )}
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">سعر الوحدة</label>
                    <input
                      type="number"
                      step="any"
                      disabled={!isEditable || busy}
                      value={item.unit_price}
                      onChange={(e) => handleItemFieldChange(idx, 'unit_price', Number(e.target.value))}
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300"
                    />
                  </div>
                </div>

                <div className="flex justify-between items-center bg-slate-950/60 p-2 rounded-lg border border-slate-800">
                  <span className="text-xs text-slate-400">إجمالي البند:</span>
                  <div className="text-left font-mono font-bold">
                    <span className={isItemDiscounted ? 'text-slate-400 line-through text-[11px] block' : 'text-emerald-400 text-sm'}>
                      {formatCleanNumber(item.line_total)} ج.م
                    </span>
                    {isItemDiscounted && (
                      <span className="text-emerald-400 text-sm block font-black">
                        {formatCleanNumber(discountedLineTotal)} ج.م
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        {/* ── Add New Item Row ── */}
        {isEditable && (
          <form onSubmit={handleAddItem} className="bg-slate-900/70 p-4 rounded-xl border border-dashed border-slate-700 space-y-3">
            <h4 className="text-xs font-bold text-slate-300">+ إضافة بند جديد إلى أمر الشراء</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-2 md:col-span-3">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">وصف البند الجديد *</label>
                <input
                  type="text"
                  placeholder="وصف البند الجديد *"
                  value={newItemDesc}
                  onChange={(e) => setNewItemDesc(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">المورد</label>
                <select
                  value={newItemSupplierId || supplierId || ''}
                  onChange={(e) => setNewItemSupplierId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 cursor-pointer truncate"
                >
                  <option value="">{supplierId ? '(المورد المعتمد)' : 'اختر المورد'}</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.company_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">رقم قطعة الأرض *</label>
                <input
                  type="text"
                  required
                  placeholder="رقم قطعة الأرض *"
                  value={newItemReference}
                  onChange={(e) => setNewItemReference(e.target.value)}
                  dir="ltr"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono"
                />
              </div>

              <div className="md:col-span-1">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">المنطقة *</label>
                <input
                  type="text"
                  required
                  placeholder="المنطقة *"
                  value={newItemRegion}
                  onChange={(e) => setNewItemRegion(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
                />
              </div>

              <div className="md:col-span-1">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">الكمية</label>
                <input
                  type="number"
                  min="0.001"
                  step="any"
                  value={newItemQty}
                  onChange={(e) => setNewItemQty(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono text-center"
                />
              </div>

              <div className="md:col-span-1">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">السعر (ج.م)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newItemPrice}
                  onChange={(e) => setNewItemPrice(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono text-center"
                />
              </div>

              <div className="md:col-span-1">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">الوحدة</label>
                <select
                  value={newItemUom}
                  onChange={(e) => setNewItemUom(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 cursor-pointer"
                >
                  {newItemUom && !DEFAULT_PR_UNIT_CODES.includes(newItemUom) && (
                    <option value={newItemUom}>{getUnitLabel(newItemUom)}</option>
                  )}
                  {UNIT_OPTIONS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2 md:col-span-1 flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs px-2 py-2 rounded-lg cursor-pointer"
                >
                  + إضافة
                </button>
              </div>
            </div>
          </form>
        )}

        {/* ── Finalization Notes & Calculated Totals Box ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end pt-4 border-t border-slate-800">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              {isPendingActualPo ? 'ملاحظات وتوجيهات الحسابات لأمر الشراء الفعلي' : 'ملاحظات أمر الشراء'}
            </label>
            <textarea
              rows={3}
              value={isPendingActualPo ? finalizationNotes : notes}
              onChange={(e) => isPendingActualPo ? setFinalizationNotes(e.target.value) : setNotes(e.target.value)}
              placeholder={isPendingActualPo ? 'اكتب أي توضيحات للإدارة المالية بشأن فروق الكميات أو الأسعار أو استلامات الموقع...' : 'أي ملاحظات إضافية...'}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 focus:border-cyan-500"
            />
          </div>

          <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 space-y-2.5 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>إجمالي أمر الشراء قبل الخصم:</span>
              <span className="font-mono font-bold text-slate-200">
                {formatCleanNumber(financials.subtotal)} ج.م
              </span>
            </div>

            {financials.discountType === 'SELECTED_ITEMS' && (
              <div className="flex justify-between text-amber-300">
                <span>إجمالي البنود المستهدفة بالخصم ({financials.targetedCount} بنود):</span>
                <span className="font-mono font-bold text-amber-200">
                  {formatCleanNumber(financials.targetedSubtotal)} ج.م
                </span>
              </div>
            )}

            {financials.discountAmount > 0 && (
              <div className="flex justify-between text-rose-300">
                <span>
                  قيمة الخصم ({financials.discountType === 'TOTAL' ? 'إجمالي' : 'بنود محددة'} {financials.discountPercentage}%):
                </span>
                <span className="font-mono font-black text-rose-300">
                  -{formatCleanNumber(financials.discountAmount)} ج.م
                </span>
              </div>
            )}

            <div className="flex justify-between items-center border-t border-slate-800 pt-2 text-sm font-bold">
              <span className="text-slate-100">الإجمالي النهائي بعد الخصم:</span>
              <span className="font-mono font-black text-emerald-400 text-lg">
                {formatCleanNumber(financials.grandTotal)} ج.م
              </span>
            </div>
          </div>
        </div>

        {/* ── إرفاق فاتورة الشراء / المورد (حفظ تلقائي في Google Drive بمجلد «فواتير») ── */}
        <div className="rounded-2xl border-2 border-amber-500/40 bg-gradient-to-r from-amber-950/20 via-slate-900 to-slate-950 p-4 shadow-lg space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-amber-500/20 pb-2">
            <div className="flex items-center gap-2">
              <span className="text-xl">🧾</span>
              <div>
                <h4 className="text-sm font-bold text-amber-300">
                  إرفاق فاتورة الشراء / المورد (تُحفظ في Google Drive بمجلد «فواتير»)
                </h4>
                <p className="text-[11px] text-slate-400">
                  يتم حفظها وأرشفتها تلقائياً على الدرايف، وتظهر فوراً للمحاسب في المطابقة والتقارير المالية كزر أصفر مباشر.
                </p>
              </div>
            </div>
            {po.has_invoice_attachment && (
              <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                {po.invoice_attachments && po.invoice_attachments.length > 0 ? (
                  po.invoice_attachments.map((att, idx) => (
                    <a
                      key={att.id || idx}
                      href={att.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 font-black text-xs px-3 py-1.5 shadow-sm transition-all whitespace-nowrap cursor-pointer"
                      title="استعراض الفاتورة من Google Drive"
                    >
                      <span>🧾</span>
                      <span>فاتورة #{idx + 1}: {att.file_name}</span>
                    </a>
                  ))
                ) : (po.invoice_photo_url || (po as any).invoice_photo_path) && (
                  <a
                    href={po.invoice_photo_url || `/api/v1/purchase-orders/${po.id}/invoice-photo`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 font-black text-xs px-3 py-1.5 shadow-sm transition-all whitespace-nowrap cursor-pointer"
                    title="استعراض الفاتورة المرفوعة حالياً"
                  >
                    <span>🔍</span>
                    <span>معاينة الفاتورة ({po.invoice_photo_name || 'ملف الفاتورة'})</span>
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <label className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 hover:border-amber-400 bg-slate-900/60 p-3 text-xs text-slate-300 hover:text-amber-200 cursor-pointer transition-colors">
              <span>📁</span>
              <span className="font-semibold">
                {invoiceFile ? `تم اختيار: ${invoiceFile.name} (${(invoiceFile.size / 1024).toFixed(0)} KB)` : 'اضغط لاختيار صورة الفاتورة أو ملف PDF...'}
              </span>
              <input
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setInvoiceFile(file);
                }}
              />
            </label>
            {invoiceFile && (
              <button
                type="button"
                onClick={() => setInvoiceFile(null)}
                className="px-3 py-2 text-xs font-bold text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 rounded-xl border border-rose-900/50 transition-colors cursor-pointer whitespace-nowrap"
              >
                ✕ إلغاء الاختيار
              </button>
            )}
          </div>
        </div>

        {/* ── Submit Action ── */}
        <div className="flex flex-wrap items-center justify-end gap-3 pt-4 border-t border-slate-800">
          {isEditable && (
            <button
              type="button"
              onClick={handleSaveAllChanges}
              disabled={busy}
              className="w-full sm:w-auto bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-sm min-h-[44px] px-7 py-3 rounded-xl shadow-lg shadow-cyan-600/30 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none active:scale-95"
            >
              {busy ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>جاري الحفظ...</span>
                </>
              ) : (
                <span>💾 حفظ كافة التعديلات</span>
              )}
            </button>
          )}

          {isPendingActualPo && (
            <button
              type="button"
              onClick={handleFinalizeActualPo}
              disabled={busy}
              className="w-full sm:w-auto bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white font-black text-sm min-h-[44px] px-8 py-3 rounded-xl shadow-xl shadow-emerald-950/50 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none active:scale-95"
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
          )}

          {isDraftOrReturned && (
            <button
              type="button"
              onClick={handleSubmitDraftToSite}
              disabled={busy}
              className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm min-h-[44px] px-6 py-3 rounded-xl shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none active:scale-95"
            >
              {busy ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>جاري الإرسال...</span>
                </>
              ) : (
                <span>حفظ وإرسال للاستلام بالموقع</span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* ── مودال تكبير ومعاينة صورة بون الميزان / إذن التوريد ── */}
      {previewPhotoUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-2 sm:p-4 backdrop-blur-sm animate-fade-in"
          dir="rtl"
          onClick={() => setPreviewPhotoUrl(null)}
        >
          <div
            className="relative max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-cyan-500/60 bg-slate-900 shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-base sm:text-lg">📷</span>
                <div>
                  <h3 className="text-xs sm:text-sm font-bold text-cyan-200">
                    صورة بون الميزان / إذن التوريد المرفق
                  </h3>
                  <p className="text-[10px] text-slate-400 font-mono">
                    إذن الاستلام: {latestReceipt?.receipt_number}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={previewPhotoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg bg-cyan-950 px-3 py-1.5 text-xs font-bold text-cyan-300 border border-cyan-700/60 hover:bg-cyan-900 transition-colors"
                  title="فتح الصورة في لسان جديد"
                >
                  ↗️ فتح بالحجم الكامل
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewPhotoUrl(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-lg font-black text-slate-300 hover:bg-slate-700 hover:text-white cursor-pointer"
                  title="إغلاق"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-3 sm:p-6 flex items-center justify-center bg-slate-950/60 min-h-[300px]">
              <img
                src={previewPhotoUrl}
                alt="صورة بون الميزان"
                className="max-h-[75vh] w-auto max-w-full rounded-xl object-contain shadow-md"
              />
            </div>

            <div className="flex items-center justify-between border-t border-slate-800 bg-slate-950/80 px-4 py-2.5 text-xs text-slate-400">
              <span>يمكنك تدقيق الأوزان والأختام قبل اعتماد أمر الشراء الفعلي.</span>
              <button
                type="button"
                onClick={() => setPreviewPhotoUrl(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {po && (
        <CreateWeighingGroupModal
          isOpen={weighingModalOpen}
          poId={po.id}
          poNumber={po.po_number}
          onClose={() => setWeighingModalOpen(false)}
          onSuccess={() => {
            setWeighingModalOpen(false);
            void loadData();
          }}
        />
      )}
    </div>
  );
};

export default EditPurchaseOrderPage;
