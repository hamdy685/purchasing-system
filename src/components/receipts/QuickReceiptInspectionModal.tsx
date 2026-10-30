import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import {
  ReceiptRecord,
  getPurchaseReceiptByIdApi,
  approvePurchaseReceiptApi,
  getReceiptPhotoUrl,
} from '../../api/purchaseReceipts';
import { ActionInboxItem, resolveReceiptId } from '../dashboard/ActionRequiredInbox';
import { getUnitLabel } from '../../utils/units';
import { toast } from '../../utils/toast';
import { formatCleanQty } from '../../utils/numberFormat';
import { formatDateTime24h } from '../../utils/dateTime';
import { parseApiError } from '../../utils/apiError';

export interface QuickReceiptInspectionModalProps {
  isOpen: boolean;
  item: ActionInboxItem | null;
  onClose: () => void;
  onSuccess: (receiptId: number, receiptCode?: string) => void;
}

export const QuickReceiptInspectionModal: React.FC<QuickReceiptInspectionModalProps> = ({
  isOpen,
  item,
  onClose,
  onSuccess,
}) => {
  const [receipt, setReceipt] = useState<ReceiptRecord | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form states
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [itemNotes, setItemNotes] = useState<Record<number, string>>({});
  const [generalNotes, setGeneralNotes] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Photo Lightbox state
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);

  const receiptId = useMemo(() => {
    if (!item) return null;
    const raw = resolveReceiptId(item);
    return raw ? Number(raw) : null;
  }, [item]);

  // Fetch or populate receipt details whenever modal opens or item changes
  useEffect(() => {
    if (!isOpen || !item || !receiptId) {
      if (!isOpen) {
        setReceipt(null);
        setQuantities({});
        setItemNotes({});
        setGeneralNotes('');
        setSubmitError(null);
        setLoadError(null);
        setPreviewPhotoUrl(null);
      }
      return;
    }

    let isMounted = true;

    // If item already contains rawReceipt object, pre-fill instantly to avoid blank state
    if (item.rawReceipt) {
      setReceipt(item.rawReceipt);
      initializeForm(item.rawReceipt);
    }

    setIsLoading(true);
    setLoadError(null);
    setSubmitError(null);

    getPurchaseReceiptByIdApi(receiptId)
      .then((data) => {
        if (!isMounted) return;
        setReceipt(data);
        initializeForm(data);
      })
      .catch((err) => {
        if (!isMounted) return;
        // If we didn't have rawReceipt, show load error
        if (!item.rawReceipt) {
          setLoadError(parseApiError(err).message || 'تعذر تحميل بيانات إذن الاستلام.');
        }
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, item, receiptId]);

  const initializeForm = (rcpt: ReceiptRecord) => {
    const qMap: Record<number, string> = {};
    const nMap: Record<number, string> = {};

    (rcpt.items || []).forEach((it) => {
      qMap[it.id] = String(it.received_quantity ?? '');
      if (it.notes) {
        nMap[it.id] = it.notes;
      }
    });

    setQuantities((prev) => ({ ...qMap, ...prev }));
    setItemNotes((prev) => ({ ...nMap, ...prev }));
    if (rcpt.site_engineer_notes) {
      setGeneralNotes((prev) => (prev ? prev : (rcpt.site_engineer_notes || '')));
    }
  };

  const handleSetAllToWarehouseQty = () => {
    if (!receipt?.items) return;
    const nextQ: Record<number, string> = {};
    receipt.items.forEach((it) => {
      nextQ[it.id] = String(it.received_quantity ?? 0);
    });
    setQuantities(nextQ);
  };

  const handleQuantityChange = (itemId: number, val: string) => {
    setQuantities((prev) => ({
      ...prev,
      [itemId]: val,
    }));
    if (submitError) setSubmitError(null);
  };

  const handleItemNoteChange = (itemId: number, val: string) => {
    setItemNotes((prev) => ({
      ...prev,
      [itemId]: val,
    }));
  };

  const handleStepQuantity = (itemId: number, delta: number) => {
    const current = Number(quantities[itemId] || 0);
    const updated = Math.max(0, current + delta);
    handleQuantityChange(itemId, String(updated));
  };

  const handleSubmit = async () => {
    if (!receiptId) return;

    const receiptItems = receipt?.items || [];
    if (receiptItems.length === 0) {
      // If items list couldn't be loaded or receipt has no items, submit with general notes
      setIsSubmitting(true);
      setSubmitError(null);
      try {
        await approvePurchaseReceiptApi(receiptId, {
          site_engineer_notes: generalNotes.trim() || undefined,
        });
        const successMsg = `تم فحص واعتماد إذن الاستلام ${item?.code || receipt?.receipt_number || ''} بنجاح ✅`;
        toast.success(successMsg);
        onSuccess(receiptId, item?.code || receipt?.receipt_number);
        onClose();
      } catch (err) {
        setSubmitError(parseApiError(err).message || 'حدث خطأ أثناء اعتماد إذن الاستلام.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // Validate quantities
    const payloadItems: Array<{ id: number; received_quantity: number; notes?: string }> = [];
    for (const it of receiptItems) {
      const rawVal = quantities[it.id];
      if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') {
        setSubmitError(`يرجى إدخال الكمية المستلمة الفعلية للبند: "${it.purchase_order_item?.item_description || 'صنف'}"`);
        return;
      }

      const numVal = Number(rawVal);
      if (Number.isNaN(numVal) || numVal < 0) {
        setSubmitError(`قيمة الكمية غير صحيحة للبند: "${it.purchase_order_item?.item_description || 'صنف'}"`);
        return;
      }

      payloadItems.push({
        id: it.id,
        received_quantity: numVal,
        notes: itemNotes[it.id]?.trim() || undefined,
      });
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await approvePurchaseReceiptApi(receiptId, {
        site_engineer_notes: generalNotes.trim() || undefined,
        items: payloadItems,
      });

      const successMsg = `تم فحص واعتماد إذن الاستلام ${item?.code || receipt?.receipt_number || ''} بنجاح وإرساله للحسابات ✅`;
      toast.success(successMsg);
      onSuccess(receiptId, item?.code || receipt?.receipt_number);
      onClose();
    } catch (err) {
      setSubmitError(parseApiError(err).message || 'حدث خطأ أثناء اعتماد إذن الاستلام.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Metadata resolution
  const displayCode = item?.code || receipt?.receipt_number || `REC-${receiptId}`;
  const poNumber = receipt?.purchase_order?.po_number || item?.subtitle?.replace('لأمر الشراء', '').trim() || '';
  const supplierName =
    receipt?.purchase_order?.supplier?.company_name ||
    receipt?.supplier?.company_name ||
    item?.supplier ||
    '—';
  const departmentName =
    receipt?.purchase_request?.department?.name ||
    receipt?.purchase_order?.purchase_request?.department?.name ||
    item?.department ||
    '—';
  const parcelRef =
    item?.parcel_number ||
    receipt?.purchase_request?.parcel_reference ||
    receipt?.purchase_order?.purchase_request?.parcel_reference ||
    item?.items_list?.[0]?.parcel ||
    '—';
  const regionName =
    item?.region ||
    receipt?.purchase_request?.region ||
    receipt?.purchase_order?.purchase_request?.region ||
    item?.items_list?.[0]?.region ||
    '—';
  const rawDate = receipt?.received_at || receipt?.created_at || item?.created_at || item?.timeAgo;
  const dateFormatted = rawDate ? formatDateTime24h(rawDate) : null;
  const warehouseKeeperName = receipt?.warehouse_keeper?.name;
  const photoUrl = receipt ? getReceiptPhotoUrl(receipt) : '';

  const receiptItems = receipt?.items || [];
  const itemsCount = receiptItems.length || item?.items_count || 0;
  const actualReceiverName = receipt?.actual_receiver_name || receipt?.actual_receiver?.name || receipt?.receiver?.name;
  // The direct-supply note is written by the system, not the warehouse keeper; the header already says "توريد مباشر".
  const isSystemBypassNote = Boolean(receipt?.warehouse_notes?.includes('(Auto-Bypassed)'));

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={() => {
          if (!isSubmitting) onClose();
        }}
        title={`فحص واعتماد إذن الاستلام: ${displayCode}`}
        size="xl"
      >
        <div className="space-y-4 text-right" dir="rtl">
          {/* Top Info Context Banner */}
          <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-slate-900 via-emerald-950/20 to-slate-900 p-4 shadow-lg space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap border-b border-emerald-900/40 pb-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                {poNumber && (
                  <span className="text-xs font-bold text-slate-200 bg-slate-800/80 border border-slate-700 px-2.5 py-1 rounded-xl">
                    📑 أمر الشراء: <strong className="text-cyan-300 font-mono">{poNumber}</strong>
                  </span>
                )}
                {receipt?.receipt_type === 'REQUESTER_OFFICE' && (
                  <span className="text-xs font-black px-2.5 py-1 rounded-xl bg-indigo-950 text-indigo-300 border border-indigo-800/60">
                    🏢 مستلزمات مكتبية
                  </span>
                )}
                {!warehouseKeeperName && (
                  <span className="text-xs font-bold px-2.5 py-1 rounded-xl bg-amber-950/60 text-amber-300 border border-amber-700/50">
                    توريد مباشر للموقع
                  </span>
                )}
              </div>

              {dateFormatted && (
                <div className="text-[11px] font-bold text-slate-400 flex items-center gap-1 font-mono" dir="ltr">
                  <span>🕒</span>
                  <span>{dateFormatted}</span>
                </div>
              )}
            </div>

            {/* Quick Metadata Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-2.5 space-y-0.5">
                <span className="text-[10px] text-slate-400 block font-bold">قطعة الأرض</span>
                <span className="font-mono font-black text-cyan-300 truncate block">{parcelRef}</span>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-2.5 space-y-0.5">
                <span className="text-[10px] text-slate-400 block font-bold">المنطقة</span>
                <span className="font-bold text-amber-300 truncate block">{regionName}</span>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-2.5 space-y-0.5">
                <span className="text-[10px] text-slate-400 block font-bold">القسم</span>
                <span className="font-bold text-slate-200 truncate block">{departmentName}</span>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-2.5 space-y-0.5">
                <span className="text-[10px] text-slate-400 block font-bold">المورد</span>
                <span className="font-bold text-emerald-300 truncate block">{supplierName}</span>
              </div>
            </div>

            {(warehouseKeeperName || actualReceiverName) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
                {warehouseKeeperName && (
                  <span>أمين المخزن: <strong className="text-slate-200 font-bold">{warehouseKeeperName}</strong></span>
                )}
                {actualReceiverName && (
                  <span>المستلم الفعلي: <strong className="text-cyan-300 font-bold">{actualReceiverName}</strong></span>
                )}
              </div>
            )}
          </div>

          {/* Warehouse Notes Banner */}
          {receipt?.warehouse_notes && !isSystemBypassNote && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-200 shadow-sm">
              <div className="space-y-0.5">
                <strong className="text-amber-400 block font-bold">ملاحظات أمين المخزن:</strong>
                <p className="leading-relaxed">{receipt.warehouse_notes}</p>
              </div>
            </div>
          )}

          {/* Attached Receipt / Weight Photo Card */}
          {Boolean(photoUrl) && (
            <div className="rounded-xl border border-cyan-500/40 bg-cyan-950/20 p-3 space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-bold text-cyan-200 flex items-center gap-1.5">
                  <span>📷</span> صورة الاستلام
                </span>
                <button
                  type="button"
                  onClick={() => setPreviewPhotoUrl(photoUrl)}
                  className="text-xs font-bold text-cyan-300 hover:text-cyan-200 hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>🔍</span> عرض بالحجم الكامل
                </button>
              </div>
              <div>
                <div
                  onClick={() => setPreviewPhotoUrl(photoUrl)}
                  className="relative h-16 w-16 sm:h-20 sm:w-20 rounded-lg overflow-hidden border border-cyan-400/80 cursor-pointer shrink-0 shadow-md group"
                  title="اضغط للتكبير"
                >
                  <img
                    src={photoUrl}
                    alt="صورة استلام المخزن"
                    className="h-full w-full object-cover group-hover:scale-105 transition-transform"
                  />
                  <div className="absolute inset-0 bg-slate-950/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] font-bold text-white bg-slate-900/90 px-1.5 py-0.5 rounded">🔍</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Load Error Alert if any */}
          {loadError && (
            <div className="rounded-xl border border-rose-500/60 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-center justify-between gap-2">
              <span>⚠️ {loadError}</span>
              <button
                type="button"
                onClick={() => {
                  if (receiptId) {
                    setIsLoading(true);
                    setLoadError(null);
                    getPurchaseReceiptByIdApi(receiptId)
                      .then((data) => {
                        setReceipt(data);
                        initializeForm(data);
                      })
                      .catch((err) => {
                        setLoadError(parseApiError(err).message || 'تعذر تحميل بيانات إذن الاستلام.');
                      })
                      .finally(() => setIsLoading(false));
                  }
                }}
                className="text-xs font-bold underline hover:text-white"
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {/* Items Section Header */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <span className="text-base">📋</span>
              <h3 className="text-sm font-black text-slate-100">
                البنود
                <span className="mr-1.5 text-xs text-cyan-400 font-mono">({itemsCount})</span>
              </h3>
            </div>

            {receiptItems.length > 1 && (
              <button
                type="button"
                onClick={handleSetAllToWarehouseQty}
                className="text-xs font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-700/60 px-2.5 py-1 rounded-lg transition-colors cursor-pointer"
                title="ضبط جميع الكميات لتتطابق تماماً مع المسجل بالمخزن"
              >
                ✓ مطابقة كامل الكميات للمخزن
              </button>
            )}
          </div>

          {/* Items List */}
          {isLoading && receiptItems.length === 0 ? (
            <div className="p-8 text-center text-slate-400 space-y-2">
              <div className="h-8 w-8 mx-auto border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs font-bold">جاري تحميل بنود وتفاصيل إذن الاستلام...</p>
            </div>
          ) : receiptItems.length > 0 ? (
            <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1 pl-1">
              {receiptItems.map((it, idx) => {
                const poItem = it.purchase_order_item;
                const prItem = poItem?.pr_item;
                const itemName = poItem?.item_description || poItem?.item?.name || 'بند استلام';
                const uom = prItem?.uom || poItem?.uom || 'وحدة';
                const unitLabel = getUnitLabel(uom);
                const warehouseQty = Number(it.received_quantity ?? 0);
                const orderedQty = Number(it.ordered_quantity ?? poItem?.quantity ?? 0);
                const currentConfirmedQty = Number(quantities[it.id] ?? warehouseQty);

                const isExactMatch = !Number.isNaN(currentConfirmedQty) && currentConfirmedQty === warehouseQty;
                const isShortage = !Number.isNaN(currentConfirmedQty) && currentConfirmedQty < warehouseQty;
                const isExcess = !Number.isNaN(currentConfirmedQty) && currentConfirmedQty > warehouseQty;

                return (
                  <div
                    key={it.id}
                    className="rounded-2xl border border-slate-800 bg-slate-950/90 p-3.5 space-y-3 transition-all hover:border-slate-700 shadow-md"
                  >
                    {/* Item Top Bar */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5 flex-1 min-w-0">
                        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-300 font-black text-xs border border-emerald-500/40 shrink-0 mt-0.5">
                          #{idx + 1}
                        </span>
                        <div className="min-w-0">
                          <h4 className="text-xs sm:text-sm font-black text-slate-100 leading-tight">
                            {itemName}
                          </h4>
                          {((poItem?.item_reference && poItem.item_reference !== parcelRef) || (poItem?.region && poItem.region !== regionName)) && (
                            <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                              {poItem.item_reference && (
                                <span className="font-mono text-cyan-300">قطعة: {poItem.item_reference}</span>
                              )}
                              {poItem.region && (
                                <span className="text-amber-300">({poItem.region})</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Quantity Match Pill */}
                      {isExactMatch && (
                        <span className="text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-700/60 px-2 py-0.5 rounded-full shrink-0">
                          ✓ مطابقة تامة
                        </span>
                      )}
                      {isShortage && (
                        <span className="text-[10px] font-bold bg-amber-950 text-amber-300 border border-amber-700/60 px-2 py-0.5 rounded-full shrink-0">
                          ⚠️ استلام جزئي ({formatCleanQty(currentConfirmedQty)} من {formatCleanQty(warehouseQty)})
                        </span>
                      )}
                      {isExcess && (
                        <span className="text-[10px] font-bold bg-cyan-950 text-cyan-300 border border-cyan-700/60 px-2 py-0.5 rounded-full shrink-0">
                          ℹ️ كمية أكبر ({formatCleanQty(currentConfirmedQty)} من {formatCleanQty(warehouseQty)})
                        </span>
                      )}
                    </div>

                    {/* Quantities Row */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                      {/* Warehouse Recorded Qty */}
                      <div className="rounded-xl border border-slate-800/80 bg-slate-900/80 p-2.5 flex items-center justify-between gap-2">
                        <div>
                          <span className="text-[10px] text-slate-400 block font-bold">
                            {warehouseKeeperName ? 'كمية المخزن' : 'الكمية الموردة'}
                          </span>
                          {orderedQty !== warehouseQty && (
                            <span className="text-[10px] text-slate-500 font-mono">
                              أمر الشراء: {formatCleanQty(orderedQty)}
                            </span>
                          )}
                        </div>
                        <div className="font-mono font-black text-sm text-cyan-300 flex items-baseline gap-1">
                          <span>{formatCleanQty(warehouseQty)}</span>
                          <span className="text-xs text-slate-400 font-bold">{unitLabel}</span>
                        </div>
                      </div>

                      {/* Confirmed Actual Quantity Input */}
                      <div className="rounded-xl border border-emerald-500/50 bg-emerald-950/20 p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <label
                            htmlFor={`qty-input-${it.id}`}
                            className="font-black text-emerald-300 flex items-center gap-1"
                          >
                            الكمية المعتمدة
                          </label>
                          <span className="text-[10px] font-bold text-slate-400 font-mono">
                            {unitLabel}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleStepQuantity(it.id, -1)}
                            className="h-8 w-8 rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 font-black text-sm flex items-center justify-center shrink-0 cursor-pointer active:scale-95"
                            title="إنقاص 1"
                          >
                            −
                          </button>

                          <input
                            id={`qty-input-${it.id}`}
                            type="number"
                            min="0"
                            step="any"
                            value={quantities[it.id] ?? ''}
                            onChange={(e) => handleQuantityChange(it.id, e.target.value)}
                            placeholder="0"
                            className="flex-1 h-8 rounded-lg border border-emerald-500/60 bg-slate-950 px-2.5 text-center font-mono text-sm font-black text-emerald-200 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                          />

                          <button
                            type="button"
                            onClick={() => handleStepQuantity(it.id, 1)}
                            className="h-8 w-8 rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 font-black text-sm flex items-center justify-center shrink-0 cursor-pointer active:scale-95"
                            title="زيادة 1"
                          >
                            +
                          </button>

                          <button
                            type="button"
                            onClick={() => handleQuantityChange(it.id, String(warehouseQty))}
                            className="text-[10px] font-bold text-cyan-300 bg-cyan-950 border border-cyan-800/80 px-2 h-8 rounded-lg shrink-0 hover:bg-cyan-900/60"
                            title="مطابقة هذه الكمية للمخزن"
                          >
                            تطابق
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Per-Item Notes */}
                    <div>
                      <input
                        type="text"
                        placeholder="ملاحظات فحص أو مطابقة على هذا الصنف (اختياري)..."
                        value={itemNotes[it.id] ?? ''}
                        onChange={(e) => handleItemNoteChange(it.id, e.target.value)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-900/90 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            // Fallback if items couldn't be loaded
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-center text-xs text-slate-400">
              <p>سيتم اعتماد كامل بنود إذن الاستلام بناءً على محضر استلام المخزن.</p>
            </div>
          )}

          {/* General Inspection Report / Notes */}
          <div className="space-y-1.5 pt-1">
            <label className="block text-xs font-bold text-slate-300">
              ملاحظات الفحص (اختياري)
            </label>
            <textarea
              rows={2}
              value={generalNotes}
              onChange={(e) => setGeneralNotes(e.target.value)}
              placeholder="اكتب تقرير الفحص أو أي ملاحظات هندسية على المواد المستلمة بالموقع..."
              className="w-full rounded-xl border border-slate-700 bg-slate-950 p-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
            />
          </div>

          {/* Submit Error Alert */}
          {submitError && (
            <div className="rounded-xl border border-rose-500/80 bg-rose-950/40 p-3 text-xs text-rose-300 font-bold flex items-center gap-2">
              <span>⚠️</span>
              <span>{submitError}</span>
            </div>
          )}

          {/* Action Buttons Footer */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
            <Button
              variant="secondary"
              size="sm"
              disabled={isSubmitting}
              onClick={onClose}
              className="px-4 text-xs font-bold"
            >
              إلغاء
            </Button>

            <Button
              variant="success"
              size="sm"
              disabled={isSubmitting}
              isLoading={isSubmitting}
              onClick={handleSubmit}
              className="px-5 text-xs font-black bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/50 flex items-center gap-1.5"
            >
              <span>✓</span>
              <span>تأكيد الاعتماد والمطابقة الهندسية</span>
            </Button>
          </div>
        </div>
      </Modal>

      {/* Full Resolution Photo Lightbox Modal */}
      {previewPhotoUrl && (
        <Modal
          isOpen={Boolean(previewPhotoUrl)}
          onClose={() => setPreviewPhotoUrl(null)}
          title="معاينة صورة استلام وفحص المخزن"
          size="2xl"
        >
          <div className="space-y-3" dir="rtl">
            <div className="max-h-[75vh] overflow-auto rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center p-2">
              <img
                src={previewPhotoUrl}
                alt="معاينة مكبرة لصورة الاستلام"
                className="max-h-[70vh] w-auto max-w-full rounded-lg object-contain shadow-2xl"
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
              <span>📷 صورة بون الميزان وأختام التوريد المرفقة من المخزن</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPreviewPhotoUrl(null)}
              >
                إغلاق المعاينة
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};

export default QuickReceiptInspectionModal;
