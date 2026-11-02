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
import SiteReceiptItemCards from './SiteReceiptItemCards';
import { toast } from '../../utils/toast';
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
    '';
  const parcelRef =
    item?.parcel_number ||
    receipt?.purchase_request?.parcel_reference ||
    receipt?.purchase_order?.purchase_request?.parcel_reference ||
    item?.items_list?.[0]?.parcel ||
    '';
  const regionName =
    item?.region ||
    receipt?.purchase_request?.region ||
    receipt?.purchase_order?.purchase_request?.region ||
    item?.items_list?.[0]?.region ||
    '';
  const rawDate = receipt?.received_at || receipt?.created_at || item?.created_at || item?.timeAgo;
  const dateFormatted = rawDate ? formatDateTime24h(rawDate) : null;
  const photoUrl = receipt ? getReceiptPhotoUrl(receipt) : '';
  const tag =
    receipt?.receipt_type === 'REQUESTER_OFFICE' ? '🏢 مستلزمات مكتبية'
    : receipt && !receipt.warehouse_keeper ? '🏗️ توريد مباشر للموقع'
    : null;

  const receiptItems = receipt?.items || [];
  // The direct-supply note is written by the system, not the warehouse keeper; the tag already says "توريد مباشر".
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
        <div className="space-y-3 text-right" dir="rtl">
          <div className="space-y-1.5 border-b border-slate-800 pb-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              {poNumber && (
                <h3 className="text-base font-black text-slate-100">
                  أمر شراء <span className="font-mono">#{poNumber}</span>
                </h3>
              )}
              {dateFormatted && <span className="font-mono text-xs text-slate-400" dir="ltr">{dateFormatted}</span>}
            </div>
            <p className="text-sm font-bold text-slate-200">
              {[supplierName, parcelRef && `قطعة ${parcelRef}`, regionName && `منطقة ${regionName}`].filter(Boolean).join(' · ')}
            </p>
            {tag && (
              <span className="inline-block rounded-lg border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs font-bold text-slate-200">{tag}</span>
            )}
            {receipt?.warehouse_notes && !isSystemBypassNote && (
              <p className="text-xs text-amber-200">📝 {receipt.warehouse_notes}</p>
            )}
            {Boolean(photoUrl) && (
              <button
                type="button"
                onClick={() => setPreviewPhotoUrl(photoUrl)}
                className="flex w-full items-center gap-3 rounded-xl border border-slate-700 bg-slate-950 p-2 text-right cursor-pointer"
              >
                <img src={photoUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg bg-slate-800 object-cover" />
                <span className="text-sm font-bold text-cyan-300">📷 صورة الاستلام — اضغط للتكبير</span>
              </button>
            )}
          </div>

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

          {isLoading && receiptItems.length === 0 ? (
            <div className="p-8 text-center text-slate-400">
              <div className="h-8 w-8 mx-auto border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : receipt && receiptItems.length > 0 ? (
            <SiteReceiptItemCards
              receipt={receipt}
              keyOf={(id) => String(id)}
              quantities={quantities}
              onQuantityChange={(key, val) => handleQuantityChange(Number(key), val)}
              itemNotes={itemNotes}
              onItemNoteChange={(key, val) => handleItemNoteChange(Number(key), val)}
            />
          ) : (
            <p className="text-center text-xs text-slate-400">سيتم اعتماد كل البنود كما سجلها المخزن.</p>
          )}

          <textarea
            rows={2}
            value={generalNotes}
            onChange={(e) => setGeneralNotes(e.target.value)}
            placeholder="ملاحظات (اختياري)"
            aria-label="ملاحظات"
            className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-400"
          />

          {submitError && (
            <p className="rounded-xl border border-rose-500/80 bg-rose-950/40 p-3 text-xs font-bold text-rose-300">⚠️ {submitError}</p>
          )}

          <Button
            variant="success"
            size="lg"
            disabled={isSubmitting}
            isLoading={isSubmitting}
            onClick={handleSubmit}
            className="w-full font-black text-base bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3.5 rounded-2xl flex items-center justify-center gap-2"
          >
            ✅ اعتماد الاستلام
          </Button>
        </div>
      </Modal>

      {/* Full Resolution Photo Lightbox Modal */}
      {previewPhotoUrl && (
        <Modal
          isOpen={Boolean(previewPhotoUrl)}
          onClose={() => setPreviewPhotoUrl(null)}
          title="صورة الاستلام"
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
          </div>
        </Modal>
      )}
    </>
  );
};

export default QuickReceiptInspectionModal;
