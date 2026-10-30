import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import LoadingSpinner from '../LoadingSpinner';
import ErrorMessage from '../ErrorMessage';
import { parseApiError } from '../../utils/apiError';
import { formatCleanNumber } from '../../utils/numberFormat';
import {
  getOrderMasterDetailsApi,
  getRequestStageApi,
  forceUpdateOrderApi,
  moveRequestStageApi,
  ForceUpdateItemPayload,
  RequestStageOption,
} from '../../api/admin/masterOrders';

interface AdminForceEditModalProps {
  /** Purchase order to edit. When absent, only the request stage can be changed. */
  orderId?: number | null;
  /** Purchase request without an order (e.g. still under review, or cancelled). */
  requestId?: number | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ItemDraft {
  id?: number | null;
  supplier_id?: number | '' | null;
  item_description: string;
  item_reference: string;
  region: string;
  quantity: number | string;
  uom: string;
  unit_price: number | string;
  specifications: string;
  delete?: boolean;
}

/** Stages that come before the purchase order: moving there cancels the current order. */
const PRE_ORDER_STAGES = ['REQUESTER', 'REVIEWER', 'EXECUTIVE', 'PROCUREMENT', 'ACCOUNTING', 'PO_ISSUANCE', 'CANCELLED'];

const inputClass =
  'w-full min-w-0 rounded-lg border bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-amber-400 focus:outline-none disabled:opacity-60';

const fieldBorder = (hasError: boolean) => (hasError ? 'border-rose-500' : 'border-slate-700');

export const AdminForceEditModal: React.FC<AdminForceEditModalProps> = ({
  orderId,
  requestId,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [orderData, setOrderData] = useState<any>(null);
  const [requestData, setRequestData] = useState<any>(null);
  const [availableSuppliers, setAvailableSuppliers] = useState<any[]>([]);
  const [currentStage, setCurrentStage] = useState<{ value: string; label: string } | null>(null);
  const [stageOptions, setStageOptions] = useState<RequestStageOption[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [showAuditLogs, setShowAuditLogs] = useState<boolean>(false);

  const [targetStage, setTargetStage] = useState<string>('');
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [deliveryDate, setDeliveryDate] = useState<string>('');
  const [actualDeliveryDate, setActualDeliveryDate] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [financialNotes, setFinancialNotes] = useState<string>('');
  const [adminReason, setAdminReason] = useState<string>('');
  const [items, setItems] = useState<ItemDraft[]>([]);

  const hasOrder = Boolean(orderId);
  const docId = orderId || requestId;

  useEffect(() => {
    if (!isOpen || !docId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    loadDetails();

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, orderId, requestId]);

  const loadDetails = async () => {
    setLoading(true);
    setError(null);
    setFieldErrors({});
    setSuccessMsg(null);
    setTargetStage('');
    setAdminReason('');
    try {
      if (orderId) {
        const res = await getOrderMasterDetailsApi(orderId);
        const po = res.data.order;
        setOrderData(po);
        setRequestData(res.data.request || po.purchase_request || null);
        setAvailableSuppliers(res.data.available_suppliers || []);
        setCurrentStage(res.data.current_stage || null);
        setStageOptions(res.data.stage_options || []);
        setAuditLogs(res.data.audit_logs || []);

        setSupplierId(po.supplier_id || '');
        setDeliveryDate(po.delivery_date ? String(po.delivery_date).slice(0, 10) : '');
        setActualDeliveryDate(po.actual_delivery_date ? String(po.actual_delivery_date).slice(0, 10) : '');
        setNotes(po.notes || '');
        setFinancialNotes(po.financial_notes || '');
        setItems(
          (po.items || []).map((it: any) => ({
            id: it.id,
            supplier_id: it.supplier_id || po.supplier_id || '',
            item_description: it.item_description || '',
            item_reference: it.item_reference || '',
            region: it.region || '',
            quantity: it.quantity ?? 0,
            uom: it.uom || 'UNIT',
            unit_price: it.unit_price ?? 0,
            specifications: it.specifications || '',
            delete: false,
          }))
        );
      } else if (requestId) {
        const res = await getRequestStageApi(requestId);
        setOrderData(null);
        setRequestData(res.data.request);
        setCurrentStage(res.data.current_stage || null);
        setStageOptions(res.data.stage_options || []);
        setAuditLogs(res.data.audit_logs || []);
        setItems([]);
      }
    } catch (err: unknown) {
      setError(parseApiError(err).message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !docId) return null;

  const handleItemChange = (index: number, field: keyof ItemDraft, value: any) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleApplySupplierToAll = () => {
    if (!supplierId) return;
    setItems((prev) => prev.map((it) => ({ ...it, supplier_id: Number(supplierId) })));
  };

  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        id: null,
        supplier_id: supplierId ? Number(supplierId) : (availableSuppliers[0]?.id ?? ''),
        item_description: '',
        item_reference: prev[0]?.item_reference || '',
        region: prev[0]?.region || '',
        quantity: 1,
        uom: 'TON',
        unit_price: 0,
        specifications: '',
        delete: false,
      },
    ]);
  };

  const handleDeleteItem = (index: number) => {
    setItems((prev) => {
      if (!prev[index].id) return prev.filter((_, i) => i !== index);
      const next = [...prev];
      next[index] = { ...next[index], delete: !next[index].delete };
      return next;
    });
  };

  const activeItems = items.filter((it) => !it.delete);
  const grandTotal = activeItems.reduce(
    (acc, it) => acc + Math.round((Number(it.quantity) || 0) * (Number(it.unit_price) || 0) * 100) / 100,
    0
  );

  const selectedStage = stageOptions.find((opt) => opt.value === targetStage);
  const cancelsOrder = hasOrder && Boolean(targetStage) && PRE_ORDER_STAGES.includes(targetStage);
  const itemError = (index: number, field: string) => fieldErrors[`items.${index}.${field}`]?.[0];
  const itemErrors = (index: number) =>
    Object.entries(fieldErrors)
      .filter(([key]) => key.startsWith(`items.${index}.`))
      .flatMap(([, messages]) => messages);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminReason.trim()) {
      setError('اكتب سبب التعديل.');
      return;
    }
    if (!hasOrder && !targetStage) {
      setError('اختر المرحلة التي تريد نقل الطلب إليها.');
      return;
    }
    if (hasOrder && activeItems.length === 0) {
      setError('يجب الإبقاء على بند واحد على الأقل.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    setSuccessMsg(null);

    try {
      let message: string;
      if (orderId) {
        const formattedItems: ForceUpdateItemPayload[] = items.map((it) => ({
          id: it.id,
          supplier_id: it.supplier_id ? Number(it.supplier_id) : (supplierId ? Number(supplierId) : null),
          item_description: it.item_description,
          item_reference: it.item_reference || null,
          region: it.region || null,
          quantity: Number(it.quantity),
          uom: it.uom,
          unit_price: Number(it.unit_price),
          specifications: it.specifications || null,
          delete: it.delete || false,
        }));

        const res = await forceUpdateOrderApi(orderId, {
          supplier_id: supplierId ? Number(supplierId) : null,
          delivery_date: deliveryDate || null,
          actual_delivery_date: actualDeliveryDate || null,
          notes: notes || null,
          financial_notes: financialNotes || null,
          admin_reason: adminReason.trim(),
          sync_receipt: true,
          sync_pr: true,
          request_stage: targetStage || null,
          items: formattedItems,
        });
        message = res.message;
      } else {
        const res = await moveRequestStageApi(requestId!, {
          request_stage: targetStage,
          admin_reason: adminReason.trim(),
        });
        message = res.message;
      }

      setSuccessMsg(message);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1200);
    } catch (err: unknown) {
      const parsed = parseApiError(err);
      setError(parsed.message);
      setFieldErrors(parsed.errors || {});
    } finally {
      setSubmitting(false);
    }
  };

  const requestNumber = requestData?.request_number;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex min-h-screen items-center justify-center overflow-y-auto bg-slate-950/90 p-2 backdrop-blur-sm sm:p-4"
      dir="rtl"
    >
      <div className="flex max-h-[calc(100dvh-1rem)] min-h-0 w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl animate-fade-in">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-black text-slate-100">تعديل الطلب</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              {requestNumber && (
                <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono font-bold text-slate-200">{requestNumber}</span>
              )}
              {orderData?.po_number && (
                <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono font-bold text-amber-200">{orderData.po_number}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="إغلاق"
            className="shrink-0 rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 text-slate-200">
          {loading ? (
            <LoadingSpinner message="جاري تحميل بيانات الطلب..." />
          ) : (
            <form id="admin-force-edit-form" onSubmit={handleSubmit} className="space-y-5">
              {error && <ErrorMessage error={error} />}
              {successMsg && (
                <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/40 p-3 text-center text-sm font-bold text-emerald-300">
                  ✅ {successMsg}
                </div>
              )}

              {/* Stage */}
              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 sm:p-4">
                <h3 className="text-sm font-black text-slate-200">مرحلة الطلب</h3>
                <p className="text-sm text-slate-300">
                  الآن عند: <strong className="text-amber-300">{currentStage?.label || '—'}</strong>
                </p>
                <div>
                  <label htmlFor="admin-target-stage" className="mb-1.5 block text-xs font-bold text-slate-400">
                    نقل الطلب إلى
                  </label>
                  <select
                    id="admin-target-stage"
                    value={targetStage}
                    onChange={(e) => setTargetStage(e.target.value)}
                    className={`${inputClass} ${fieldBorder(Boolean(fieldErrors.request_stage))} font-bold`}
                  >
                    <option value="">بدون تغيير</option>
                    {stageOptions
                      .filter((opt) => !opt.current)
                      .map((opt) => (
                        <option key={opt.value} value={opt.value} disabled={!opt.available}>
                          {opt.available ? opt.label : `${opt.label} — ${opt.reason}`}
                        </option>
                      ))}
                  </select>
                </div>
                {selectedStage && cancelsOrder && targetStage !== 'CANCELLED' && (
                  <p className="text-xs text-amber-300">
                    سيُلغى أمر الشراء {orderData?.po_number} واستلاماته، ويظهر الطلب في مرحلة «{selectedStage.label}» كأنه وصل الآن.
                  </p>
                )}
                {targetStage === 'CANCELLED' && (
                  <p className="text-xs text-rose-300">سيُلغى الطلب وأوامر الشراء المرتبطة به. يمكن استعادته لاحقًا من نفس الشاشة.</p>
                )}
              </section>

              {hasOrder && (
                <>
                  {/* Order data */}
                  <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 sm:p-4">
                    <h3 className="text-sm font-black text-slate-200">بيانات أمر الشراء</h3>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="min-w-0 sm:col-span-2">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <label htmlFor="admin-supplier" className="text-xs font-bold text-slate-400">المورد</label>
                          {supplierId && (
                            <button
                              type="button"
                              onClick={handleApplySupplierToAll}
                              className="text-xs font-bold text-amber-400 underline hover:text-amber-300"
                            >
                              تطبيق على كل البنود
                            </button>
                          )}
                        </div>
                        <select
                          id="admin-supplier"
                          value={supplierId}
                          onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}
                          className={`${inputClass} ${fieldBorder(Boolean(fieldErrors.supplier_id))}`}
                        >
                          <option value="">— اختر المورد —</option>
                          {availableSuppliers.map((sup) => (
                            <option key={sup.id} value={sup.id}>
                              {sup.company_name || sup.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="min-w-0">
                        <label htmlFor="admin-delivery-date" className="mb-1.5 block text-xs font-bold text-slate-400">تاريخ التوريد المتفق عليه</label>
                        <input
                          id="admin-delivery-date"
                          type="date"
                          value={deliveryDate}
                          onChange={(e) => setDeliveryDate(e.target.value)}
                          className={`${inputClass} ${fieldBorder(Boolean(fieldErrors.delivery_date))}`}
                        />
                      </div>
                      <div className="min-w-0">
                        <label htmlFor="admin-actual-date" className="mb-1.5 block text-xs font-bold text-slate-400">تاريخ الاستلام الفعلي</label>
                        <input
                          id="admin-actual-date"
                          type="date"
                          value={actualDeliveryDate}
                          onChange={(e) => setActualDeliveryDate(e.target.value)}
                          className={`${inputClass} ${fieldBorder(Boolean(fieldErrors.actual_delivery_date))}`}
                        />
                      </div>
                      <div className="min-w-0">
                        <label htmlFor="admin-notes" className="mb-1.5 block text-xs font-bold text-slate-400">ملاحظات</label>
                        <textarea
                          id="admin-notes"
                          rows={2}
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          className={`${inputClass} border-slate-700`}
                        />
                      </div>
                      <div className="min-w-0">
                        <label htmlFor="admin-financial-notes" className="mb-1.5 block text-xs font-bold text-slate-400">ملاحظات مالية</label>
                        <textarea
                          id="admin-financial-notes"
                          rows={2}
                          value={financialNotes}
                          onChange={(e) => setFinancialNotes(e.target.value)}
                          className={`${inputClass} border-slate-700`}
                        />
                      </div>
                    </div>
                  </section>

                  {/* Items */}
                  <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 sm:p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-black text-slate-200">البنود</h3>
                      <Button type="button" variant="secondary" size="sm" onClick={handleAddItem} className="text-xs">
                        + إضافة بند
                      </Button>
                    </div>

                    <div className="space-y-3">
                      {items.map((it, idx) => {
                        const lineTotal = Math.round((Number(it.quantity) || 0) * (Number(it.unit_price) || 0) * 100) / 100;
                        const errors = itemErrors(idx);
                        return (
                          <div
                            key={`item-${it.id || `new-${idx}`}`}
                            data-testid="admin-item-card"
                            className={`rounded-lg border p-3 ${
                              errors.length ? 'border-rose-500/70' : 'border-slate-800'
                            } ${it.delete ? 'bg-rose-950/20 opacity-50' : 'bg-slate-900/50'}`}
                          >
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-slate-400">بند {idx + 1}</span>
                              <button
                                type="button"
                                onClick={() => handleDeleteItem(idx)}
                                className={`rounded px-2 py-1 text-xs font-bold hover:bg-slate-800 ${it.delete ? 'text-amber-300' : 'text-rose-300'}`}
                              >
                                {it.delete ? 'استعادة' : 'حذف'}
                              </button>
                            </div>

                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                              <div className="col-span-2 min-w-0">
                                <label className="mb-1 block text-[11px] text-slate-400">الصنف</label>
                                <input
                                  type="text"
                                  aria-label={`اسم الصنف للبند ${idx + 1}`}
                                  value={it.item_description}
                                  onChange={(e) => handleItemChange(idx, 'item_description', e.target.value)}
                                  disabled={it.delete}
                                  className={`${inputClass} ${fieldBorder(Boolean(itemError(idx, 'item_description')))} font-bold`}
                                />
                              </div>
                              <div className="col-span-2 min-w-0">
                                <label className="mb-1 block text-[11px] text-slate-400">المورد</label>
                                <select
                                  aria-label={`مورد البند ${idx + 1}`}
                                  value={it.supplier_id || ''}
                                  onChange={(e) => handleItemChange(idx, 'supplier_id', e.target.value ? Number(e.target.value) : '')}
                                  disabled={it.delete}
                                  className={`${inputClass} ${fieldBorder(Boolean(itemError(idx, 'supplier_id')))}`}
                                >
                                  <option value="">نفس مورد الأمر</option>
                                  {availableSuppliers.map((sup) => (
                                    <option key={sup.id} value={sup.id}>
                                      {sup.company_name || sup.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="min-w-0">
                                <label className="mb-1 block text-[11px] text-slate-400">رقم القطعة</label>
                                <input
                                  type="text"
                                  value={it.item_reference}
                                  onChange={(e) => handleItemChange(idx, 'item_reference', e.target.value)}
                                  disabled={it.delete}
                                  className={`${inputClass} ${fieldBorder(Boolean(itemError(idx, 'item_reference')))} font-mono`}
                                />
                              </div>
                              <div className="min-w-0">
                                <label className="mb-1 block text-[11px] text-slate-400">المنطقة</label>
                                <input
                                  type="text"
                                  value={it.region}
                                  onChange={(e) => handleItemChange(idx, 'region', e.target.value)}
                                  disabled={it.delete}
                                  className={`${inputClass} ${fieldBorder(Boolean(itemError(idx, 'region')))}`}
                                />
                              </div>
                              <div className="min-w-0">
                                <label className="mb-1 block text-[11px] text-slate-400">الكمية</label>
                                <input
                                  type="number"
                                  step="any"
                                  min="0"
                                  inputMode="decimal"
                                  aria-label={`كمية البند ${idx + 1}`}
                                  value={it.quantity}
                                  onChange={(e) => handleItemChange(idx, 'quantity', e.target.value)}
                                  disabled={it.delete}
                                  className={`${inputClass} ${fieldBorder(Boolean(itemError(idx, 'quantity')))} font-mono font-bold`}
                                />
                              </div>
                              <div className="min-w-0">
                                <label className="mb-1 block text-[11px] text-slate-400">الوحدة</label>
                                <input
                                  type="text"
                                  value={it.uom}
                                  onChange={(e) => handleItemChange(idx, 'uom', e.target.value)}
                                  disabled={it.delete}
                                  className={`${inputClass} ${fieldBorder(Boolean(itemError(idx, 'uom')))}`}
                                />
                              </div>
                              <div className="min-w-0">
                                <label className="mb-1 block text-[11px] text-slate-400">سعر الوحدة</label>
                                <input
                                  type="number"
                                  step="any"
                                  min="0"
                                  inputMode="decimal"
                                  value={it.unit_price}
                                  onChange={(e) => handleItemChange(idx, 'unit_price', e.target.value)}
                                  disabled={it.delete}
                                  className={`${inputClass} ${fieldBorder(Boolean(itemError(idx, 'unit_price')))} font-mono font-bold`}
                                />
                              </div>
                              <div className="min-w-0">
                                <span className="mb-1 block text-[11px] text-slate-400">الإجمالي</span>
                                <span className="block truncate py-2 font-mono text-sm font-black text-emerald-300">
                                  {formatCleanNumber(lineTotal)}
                                </span>
                              </div>
                            </div>

                            {errors.length > 0 && (
                              <ul className="mt-2 space-y-0.5 text-xs text-rose-300">
                                {errors.map((msg) => (
                                  <li key={msg}>{msg}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950 p-3">
                      <span className="text-xs font-bold text-slate-400">الإجمالي ({activeItems.length} بند)</span>
                      <span className="font-mono text-lg font-black text-emerald-400">{formatCleanNumber(grandTotal)} ج.م</span>
                    </div>
                  </section>
                </>
              )}

              {/* Reason */}
              <section className="space-y-1.5">
                <label htmlFor="admin-reason" className="block text-sm font-black text-slate-200">
                  سبب التعديل <span className="text-rose-400">*</span>
                </label>
                <textarea
                  id="admin-reason"
                  rows={2}
                  required
                  value={adminReason}
                  onChange={(e) => setAdminReason(e.target.value)}
                  placeholder="مثال: تصحيح الكمية بعد الوزنة"
                  className={`${inputClass} ${fieldBorder(Boolean(fieldErrors.admin_reason))}`}
                />
              </section>

              {auditLogs.length > 0 && (
                <section>
                  <button
                    type="button"
                    onClick={() => setShowAuditLogs(!showAuditLogs)}
                    className="text-xs font-bold text-slate-400 underline hover:text-slate-200"
                  >
                    {showAuditLogs ? 'إخفاء سجل التعديلات' : `سجل التعديلات (${auditLogs.length})`}
                  </button>
                  {showAuditLogs && (
                    <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto text-xs">
                      {auditLogs.map((log) => (
                        <li key={`log-${log.id}`} className="rounded border border-slate-800 bg-slate-900/60 p-2 text-slate-300">
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span className="font-bold text-amber-300">{log.actor?.name || 'مدير النظام'}</span>
                            <span className="font-mono text-[10px] text-slate-500">
                              {new Date(log.occurred_at || log.created_at).toLocaleString('ar-EG')}
                            </span>
                          </div>
                          <p className="mt-1 break-words">{log.description}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 bg-slate-950 px-4 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button
            type="submit"
            form="admin-force-edit-form"
            variant="warning"
            size="sm"
            isLoading={submitting}
            loadingText="جاري الحفظ..."
            disabled={loading}
            className="px-6 font-black"
          >
            حفظ
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};
