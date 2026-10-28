import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { TableSkeleton } from '../../components/ui/StateFeedback';
import ErrorMessage from '../../components/ErrorMessage';
import { parseApiError } from '../../utils/apiError';
import { getUnitLabel } from '../../utils/units';
import TableFilterBar from '../../components/ui/TableFilterBar';
import { getDefaultDateFrom, getTodayInputDate, isDefaultTodayRange } from '../../utils/dateFilters';
import {
  approvePurchaseReceiptApi,
  createPurchaseReceiptApi,
  cancelPurchaseReceiptApi,
  getAssignedReceiptsApi,
  getPurchaseReceiptArchiveApi,
  getPurchaseReceiptByIdApi,
  getWarehouseReceiptQueueApi,
  updatePurchaseReceiptApi,
  ReceiptPurchaseOrder,
  ReceiptRecord,
  getReceiptPhotoUrl,
} from '../../api/purchaseReceipts';
import { useAuth } from '../../context/AuthContext';
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh';
import { SupplementItemBadge } from '../../components/common/SupplementItemBadge';
import ActionRequiredInbox, { ActionInboxItem } from '../../components/dashboard/ActionRequiredInbox';
import { formatDateTime24h } from '../../utils/dateTime';
import SiteReceiptItemsTable from '../../components/receipts/SiteReceiptItemsTable';

interface ReceiptColorTheme {
  border: string;
  cardBg: string;
  headerBg: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  accentText: string;
  itemBorder: string;
  inputBorder: string;
  colorTitle: string;
  icon: string;
}

const RECEIPT_COLOR_PALETTES: ReceiptColorTheme[] = [
  {
    border: 'border-cyan-500/70 shadow-cyan-950/40',
    cardBg: 'bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950',
    headerBg: 'bg-slate-900/95 border-cyan-800/60',
    badgeBg: 'bg-cyan-500',
    badgeText: 'text-slate-950',
    badgeBorder: 'border-cyan-400',
    accentText: 'text-cyan-300',
    itemBorder: 'border-slate-800 bg-slate-900/60',
    inputBorder: 'border-cyan-500/60 focus:ring-cyan-400',
    colorTitle: 'إذن استلام مواد',
    icon: '📦',
  },
  {
    border: 'border-amber-500/70 shadow-amber-950/40',
    cardBg: 'bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950',
    headerBg: 'bg-slate-900/95 border-amber-800/60',
    badgeBg: 'bg-amber-500',
    badgeText: 'text-slate-950',
    badgeBorder: 'border-amber-400',
    accentText: 'text-amber-300',
    itemBorder: 'border-slate-800 bg-slate-900/60',
    inputBorder: 'border-amber-500/60 focus:ring-amber-400',
    colorTitle: 'إذن استلام مواد',
    icon: '🏗️',
  },
];

const getReceiptTheme = (index: number): ReceiptColorTheme => {
  return RECEIPT_COLOR_PALETTES[index % RECEIPT_COLOR_PALETTES.length];
};

type ReceiptMode = 'warehouse' | 'site';
type ActiveTab = 'QUEUE' | 'ARCHIVE';

export const PurchaseReceiptPage: React.FC<{ mode: ReceiptMode }> = ({ mode }) => {
  const { hasRole } = useAuth();
  const isReviewer = hasRole('reviewer');
  const isWarehouseKeeper = mode === 'warehouse' || hasRole('warehouse_keeper');
  const [activeTab, setActiveTab] = useState<ActiveTab>('QUEUE');
  const [orders, setOrders] = useState<ReceiptPurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);
  const [archiveReceipts, setArchiveReceipts] = useState<ReceiptRecord[]>([]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [actualReceivers, setActualReceivers] = useState<Record<number, string>>({});
  const [receiptPhotos, setReceiptPhotos] = useState<Record<number, { base64: string; name: string } | null>>({});
  const [scaleTicketWeights, setScaleTicketWeights] = useState<Record<number, string>>({});
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);
  const [expandedArchiveId, setExpandedArchiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handlePhotoCapture = (orderId: number, file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('يرجى اختيار ملف صورة صالح (JPG, PNG, WebP).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      setReceiptPhotos((prev) => ({ ...prev, [orderId]: { base64, name: file.name } }));
    };
    reader.readAsDataURL(file);
  };

  // A ticket on consolidated "حديد" lines: the receiver enters the steel quantity on the item itself,
  // and the scale net weight is an optional, separate measurement.
  const isConsolidatedSteelTicket = (order: ReceiptPurchaseOrder, wg?: { items?: Array<{ purchase_order_item_id: number }> } | null) =>
    Boolean(wg?.items?.length) &&
    (wg?.items || []).every((wgItem) =>
      (order.items || []).some((item) => item.id === wgItem.purchase_order_item_id && item.is_consolidated_steel)
    );

  const handleScaleWeightChange = (order: ReceiptPurchaseOrder, totalWeightStr: string) => {
    setScaleTicketWeights((prev) => ({ ...prev, [order.id]: totalWeightStr }));
  };

  const today = getTodayInputDate();
  const defaultDateFrom = getDefaultDateFrom();
  const { id: paramReceiptId } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const targetReceiptId = paramReceiptId || searchParams.get('receipt_id') || searchParams.get('purchase_receipt_id');
  const targetPoId = searchParams.get('po_id') || searchParams.get('purchase_order_id');
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(today);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      if (mode === 'warehouse') {
        const [queueData, archiveData] = await Promise.all([
          getWarehouseReceiptQueueApi(),
          getPurchaseReceiptArchiveApi().catch(() => []),
        ]);
        const validOrders = (queueData || []).filter(
          (o) => (o.items && o.items.length > 0) || (o.weighing_groups && o.weighing_groups.length > 0)
        );
        setOrders(validOrders);
        setArchiveReceipts(archiveData || []);
      } else {
        const [assignedData, archiveData] = await Promise.all([
          getAssignedReceiptsApi(),
          getPurchaseReceiptArchiveApi().catch(() => []),
        ]);
        let finalReceipts = Array.isArray(assignedData) ? [...assignedData] : [];
        let finalArchive = Array.isArray(archiveData) ? [...archiveData] : [];

        // If targetReceiptId is specified, ensure it is loaded even if pagination or initial filters missed it
        if (targetReceiptId) {
          const numId = Number(targetReceiptId);
          if (!isNaN(numId) && !finalReceipts.some((r) => r.id === numId) && !finalArchive.some((r) => r.id === numId)) {
            try {
              const targetedReceipt = await getPurchaseReceiptByIdApi(numId);
              if (targetedReceipt) {
                if (['PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED'].includes(targetedReceipt.status)) {
                  finalReceipts = [targetedReceipt, ...finalReceipts];
                } else {
                  finalArchive = [targetedReceipt, ...finalArchive];
                }
              }
            } catch {
              // ignore fetch failure for individual receipt
            }
          }
        }

        setReceipts(finalReceipts);
        setArchiveReceipts(finalArchive);
      }
    } catch (err) {
      if (!silent) setError(parseApiError(err).message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, [mode]);

  useRealtimeRefresh(() => {
    void load(true);
  });

  // Auto-focus on receipt_id or po_id from route param or deep-link
  useEffect(() => {
    if (targetReceiptId) {
      const match = [...receipts, ...archiveReceipts].find((r) => String(r.id) === String(targetReceiptId));
      if (match) {
        if (match.receipt_number) {
          setSearchTerm(match.receipt_number);
        }
        const isArchived = archiveReceipts.some((r) => String(r.id) === String(targetReceiptId));
        if (isArchived) {
          setActiveTab('ARCHIVE');
          setExpandedArchiveId(match.id);
        } else {
          setActiveTab('QUEUE');
        }

        setTimeout(() => {
          const el = document.getElementById(`receipt-card-${match.id}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 120);
      }
    } else if (targetPoId) {
      if (mode === 'warehouse') {
        const orderMatch = orders.find((o) => String(o.id) === String(targetPoId));
        if (orderMatch?.po_number) {
          setSearchTerm(orderMatch.po_number);
        }
      } else {
        const receiptMatch = [...receipts, ...archiveReceipts].find(
          (r) => String(r.purchase_order_id) === String(targetPoId) || String(r.purchase_order?.id) === String(targetPoId)
        );
        if (receiptMatch) {
          if (receiptMatch.receipt_number) {
            setSearchTerm(receiptMatch.receipt_number);
          }
          const isArchived = archiveReceipts.some((r) => String(r.id) === String(receiptMatch.id));
          if (isArchived) {
            setActiveTab('ARCHIVE');
            setExpandedArchiveId(receiptMatch.id);
          } else {
            setActiveTab('QUEUE');
          }

          setTimeout(() => {
            const el = document.getElementById(`receipt-card-${receiptMatch.id}`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 120);
        }
      }
    }
  }, [targetReceiptId, targetPoId, receipts, archiveReceipts, orders, mode]);

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase('ar-EG');
  const ignoreDefaultDateForSearch = Boolean(normalizedSearch) && isDefaultTodayRange(dateFrom, dateTo);
  const matchesFilter = (
    text: string,
    value: string,
    isQueueItem = false,
    itemId?: number | string,
    itemPoId?: number | string
  ) => {
    // 1. Direct match for targetReceiptId: ALWAYS keep targeted receipt visible regardless of filters
    if (targetReceiptId && itemId && String(itemId) === String(targetReceiptId)) {
      return true;
    }
    // 2. Direct match for targetPoId fallback
    if (targetPoId && itemPoId && String(itemPoId) === String(targetPoId)) {
      return true;
    }
    const textMatches = !normalizedSearch || text.toLocaleLowerCase('ar-EG').includes(normalizedSearch);
    if (!textMatches) return false;
    if (isQueueItem && isDefaultTodayRange(dateFrom, dateTo)) {
      return true;
    }
    return ignoreDefaultDateForSearch || ((!dateFrom || value >= dateFrom) && (!dateTo || value <= dateTo));
  };

  const visibleOrders = orders.filter((order) => {
    // Hide empty orders with 0 items and no weighing groups
    const hasItems = order.items && order.items.length > 0;
    const hasWeighing = order.weighing_groups && order.weighing_groups.length > 0;
    if (!hasItems && !hasWeighing) {
      return false;
    }

    return matchesFilter(
      [
        String(order.id),
        order.po_number,
        order.purchase_request?.request_number,
        order.supplier?.company_name,
        order.purchase_request?.department?.name,
        order.purchase_request?.requester?.name,
        order.purchase_request?.project_name,
      ]
        .filter(Boolean)
        .join(' '),
      String(order.created_at || order.purchase_request?.created_at || '').slice(0, 10),
      true,
      undefined,
      order.id,
    );
  });

  const visibleReceipts = receipts.filter((receipt) =>
    matchesFilter(
      [
        String(receipt.id),
        receipt.receipt_number,
        receipt.purchase_order?.po_number,
        receipt.purchase_order?.id ? String(receipt.purchase_order.id) : '',
        receipt.supplier?.company_name,
        receipt.supplier_name,
        receipt.purchase_order?.supplier?.company_name,
        receipt.purchase_order?.purchase_request?.department?.name,
        receipt.warehouse_keeper?.name,
        receipt.is_internal_warehouse ? 'المخزن الداخلي' : '',
      ]
        .filter(Boolean)
        .join(' '),
      String(receipt.received_at || receipt.created_at || '').slice(0, 10),
      true,
      receipt.id,
      receipt.purchase_order_id || receipt.purchase_order?.id,
    ),
  );

  const visibleArchive = archiveReceipts.filter((receipt) =>
    matchesFilter(
      [
        String(receipt.id),
        receipt.receipt_number,
        receipt.purchase_order?.po_number,
        receipt.purchase_order?.id ? String(receipt.purchase_order.id) : '',
        receipt.supplier?.company_name,
        receipt.supplier_name,
        receipt.purchase_order?.supplier?.company_name,
        receipt.purchase_order?.purchase_request?.department?.name,
        receipt.warehouse_keeper?.name,
        receipt.site_engineer?.name,
        receipt.warehouse_notes,
        receipt.site_engineer_notes,
        receipt.is_internal_warehouse ? 'المخزن الداخلي' : '',
      ]
        .filter(Boolean)
        .join(' '),
      String(receipt.received_at || receipt.created_at || '').slice(0, 10),
      false,
      receipt.id,
      receipt.purchase_order_id || receipt.purchase_order?.id,
    ),
  );

  const siteEngineerActionItems: ActionInboxItem[] = React.useMemo(() => {
    if (mode !== 'site') return [];

    return receipts.map((r) => {
      const itemsList = r.items?.map((it) => ({
        description: it.purchase_order_item?.item_description || 'بند استلام',
        quantity: Number(it.received_quantity || 0),
        uom: it.purchase_order_item?.uom,
        parcel: it.purchase_order_item?.item_reference,
      })) || [];

      return {
        id: `receipt-${r.id}`,
        rawId: r.id,
        receipt_id: r.id,
        rawReceipt: r,
        po_id: r.purchase_order_id || r.purchase_order?.id,
        type: 'RECEIPT' as const,
        code: r.receipt_number,
        title: r.purchase_order?.items?.[0]?.item_description || `إذن استلام ${r.receipt_number}`,
        subtitle: r.purchase_order ? `لأمر الشراء ${r.purchase_order.po_number}` : undefined,
        department: r.purchase_request?.department?.name || r.purchase_order?.purchase_request?.department?.name,
        supplier: r.purchase_order?.supplier?.company_name || r.supplier?.company_name,
        urgency: 'CRITICAL' as const,
        reason: 'تم استلام المواد بالمخزن وبانتظار معاينتك ومطابقتك الهندسية بالموقع',
        actionUrl: `/receipts/${r.id}/inspect`,
        actionLabel: 'فحص واعتماد إذن الاستلام',
        created_at: r.created_at || undefined,
        timeAgo: r.created_at ? formatDateTime24h(r.created_at) : undefined,
        items_count: itemsList.length,
        items_list: itemsList,
        directApproveLabel: isReviewer ? 'اعتماد الاستلام الفني' : 'اعتماد الاستلام الهندسي',
      };
    });
  }, [mode, receipts, isReviewer]);

  const submitWarehouseReceipt = async (order: ReceiptPurchaseOrder) => {
    const activeWg = order.weighing_groups?.find((wg) => wg.status === 'PENDING_RECEIPT');
    let scaleWeightVal: number | undefined;

    const consolidatedTicket = isConsolidatedSteelTicket(order, activeWg);

    if (activeWg && consolidatedTicket) {
      const rawScaleVal = (scaleTicketWeights[order.id] ?? '').trim();
      if (rawScaleVal !== '') {
        const scaleWeight = parseFloat(rawScaleVal);
        if (isNaN(scaleWeight) || scaleWeight <= 0) {
          setError('وزن كارتة البسكول يجب أن يكون رقماً أكبر من صفر أو يُترك فارغاً.');
          return;
        }
        scaleWeightVal = scaleWeight;
      }
    }

    if (activeWg && !consolidatedTicket) {
      const rawScaleVal = scaleTicketWeights[order.id];
      const scaleWeight = parseFloat(rawScaleVal !== undefined && rawScaleVal.trim() !== '' ? rawScaleVal : String(activeWg.total_ordered_weight));
      if (isNaN(scaleWeight) || scaleWeight <= 0) {
        setError('يرجى إدخال وزن ميزان البسكول بالطن في المربع الإجمالي (أكبر من صفر).');
        return;
      }
      scaleWeightVal = scaleWeight;
      (order.items || []).forEach((item) => {
        quantities[`${order.id}-${item.id}`] = String(item.quantity || 0);
      });
      scaleTicketWeights[order.id] = String(scaleWeight);
    } else {
      const hasUnentered = (order.items || []).some((item) => {
        const q = quantities[`${order.id}-${item.id}`];
        return q === undefined || q === null || q.trim() === '';
      });

      if (hasUnentered) {
        setError('يرجى إدخال الكميات المستلمة فعلياً لجميع الأصناف قبل تأكيد الاستلام.');
        return;
      }
    }

    const items = (order.items || []).map((item) => ({
      purchase_order_item_id: item.id,
      received_quantity: Number(quantities[`${order.id}-${item.id}`] ?? item.quantity ?? 0),
      notes: itemNotes[`${order.id}-${item.id}`] || undefined,
    }));

    if (items.some((item) => Number.isNaN(item.received_quantity) || item.received_quantity < 0)) {
      setError('يرجى إدخال كميات مستلمة صحيحة لكل بند.');
      return;
    }

    setSaving(order.id);
    setError(null);
    setSuccessMessage(null);
    try {
      const photo = receiptPhotos[order.id];
      const actualReceiverName = actualReceivers[order.id]?.trim() || undefined;

      const createdReceipt = await createPurchaseReceiptApi(order.id, { 
        items, 
        warehouse_notes: notes[order.id],
        photo_base64: photo?.base64,
        photo_name: photo?.name,
        actual_receiver_name: actualReceiverName,
        weighing_group_id: activeWg?.id,
        scale_ticket_weight: scaleWeightVal,
      });
      const driveFileName = createdReceipt?.photo_name;
      setSuccessMessage(
        driveFileName
          ? `تم تسجيل استلام أمر الشراء ${order.po_number} ورفع الملف إلى Google Drive بالاسم الموحد:\n${driveFileName}`
          : `تم تسجيل استلام أمر الشراء ${order.po_number} وإرساله للمستلم/مهندس الموقع للفحص والاعتماد.`
      );
      await load();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setSaving(null);
    }
  };

  const approveReceipt = async (receipt: ReceiptRecord) => {
    const isWeighing = Boolean(receipt.weighing_group || receipt.receipt_type === 'STEEL_WEIGHING_GROUP');
    const items = (receipt.items || []).map((item) => ({
      id: item.id,
      received_quantity: isWeighing
        ? Number(item.received_quantity ?? item.ordered_quantity ?? 0)
        : Number(quantities[`receipt-${receipt.id}-${item.id}`] ?? item.received_quantity),
      notes: itemNotes[`receipt-${receipt.id}-${item.id}`] || undefined,
    }));

    if (items.some((item) => Number.isNaN(item.received_quantity) || item.received_quantity < 0)) {
      setError('يرجى إدخال كميات مستلمة صحيحة قبل الاعتماد.');
      return;
    }

    setSaving(receipt.id);
    setError(null);
    try {
      await approvePurchaseReceiptApi(receipt.id, {
        site_engineer_notes: notes[receipt.id],
        items,
      });
      setSuccessMessage(`تم اعتماد إذن الاستلام ${receipt.receipt_number} وإرساله للمشتريات لإصدار أمر الشراء الفعلي.`);
      await load();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setSaving(null);
    }
  };

  const handleCancelReceipt = async (receipt: ReceiptRecord) => {
    if (!confirm(`هل أنت متأكد من إلغاء إذن الاستلام ${receipt.receipt_number} وإعادة أمر الشراء ${receipt.purchase_order?.po_number || ''} للمخزن لإعادة الاستلام كوزنة مجمعة جديدة؟`)) return;
    setSaving(receipt.id);
    setError(null);
    try {
      await cancelPurchaseReceiptApi(receipt.id);
      setSuccessMessage(`تم إلغاء إذن الاستلام ${receipt.receipt_number} بنجاح وإعادة أمر الشراء لطابور التوريد بالمخزن.`);
      await load();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <TableSkeleton rows={5} columns={6} className="min-h-[360px]" />;

  return (
    <div className="space-y-6" dir="rtl">
      {/* ── Page Header Banner ── */}
      <div
        className={`rounded-2xl border-2 p-4 sm:p-6 shadow-xl space-y-3 ${
          mode === 'warehouse'
            ? 'border-amber-500/40 bg-gradient-to-r from-slate-900 via-amber-950/20 to-slate-900'
            : 'border-emerald-500/40 bg-gradient-to-r from-slate-900 via-emerald-950/20 to-slate-900'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3">
            <span
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl font-black shadow-inner ${
                mode === 'warehouse'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
              }`}
            >
              {mode === 'warehouse' ? '📦' : '🏗️'}
            </span>
            <div>
              <h1 className="text-lg sm:text-xl font-black text-slate-100 flex items-center gap-2.5 flex-wrap">
                {mode === 'warehouse'
                  ? 'مهام وأرشيف استلام المواد بالمخزن'
                  : isReviewer
                  ? 'إذن استلام المواد — فحص واعتماد الاستلام الميداني'
                  : 'إذن استلام المواد — فحص واعتماد الاستلام'}
                {(mode === 'warehouse' ? orders.length : receipts.length) > 0 && (
                  <span
                    className={`rounded-full px-3 py-0.5 text-xs font-black ${
                      mode === 'warehouse' ? 'bg-amber-500 text-slate-950' : 'bg-emerald-500 text-slate-950'
                    }`}
                  >
                    {(mode === 'warehouse' ? orders.length : receipts.length)} أمر بانتظار الفحص
                  </span>
                )}
              </h1>
              <p className="text-xs sm:text-sm text-slate-400 mt-1">
                {mode === 'warehouse'
                  ? 'قم بفحص بضاعة الموردين ومطابقة الأصناف والمواصفات، وسجل الكميات المستلمة أو راجع أرشيف الاستلامات المعتمدة.'
                  : isReviewer
                  ? 'راجع استلام المخزن وافحص المواد فنياً وهندسياً للتأكد من مطابقتها قبل الاعتماد النهائي وإرسالها للمشتريات لإصدار أمر الشراء الفعلي.'
                  : 'راجع استلام المخزن وافحص المواد هندسياً وفنياً في الموقع للتأكد من مطابقتها قبل الاعتماد النهائي وإرسالها للمشتريات لإصدار أمر الشراء الفعلي.'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {successMessage && (
        <div className="rounded-xl border border-emerald-700/60 bg-emerald-950/50 p-4 text-sm font-bold text-emerald-300 flex items-center justify-between animate-fade-in">
          <div className="flex items-center gap-2">
            <span>✅</span>
            <span>{successMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="text-xs text-emerald-400 hover:text-white cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      )}

      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}

      {/* ── مهام وإجراءات فحص الاستلام المطلوبة (Action Inbox) ── */}
      {mode === 'site' && (
        <ActionRequiredInbox
          title="المهام والإجراءات المطلوبة منك الآن"
          description={
            isReviewer
              ? 'أذونات استلام المواد الواردة من المخزن لأقسامك والتي تقف على فحصك ومطابقتك واعتمادك الفني.'
              : 'أذونات الاستلام الواردة من المخزن والتي تقف على فحصك واعتمادك الفني والهندسي في الموقع.'
          }
          roleName={isReviewer ? 'المراجع الفني / فحص الاستلام' : 'مهندس الموقع / مسؤول الاستلام الفني'}
          onItemActionComplete={() => void load(true)}
          items={siteEngineerActionItems}
        />
      )}

      {/* ── Main Navigation Tabs ── */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('QUEUE')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs sm:text-sm transition-all cursor-pointer ${
            activeTab === 'QUEUE'
              ? mode === 'warehouse'
                ? 'bg-amber-500 text-slate-950 font-black shadow-lg shadow-amber-950/40'
                : 'bg-emerald-600 text-white font-black shadow-lg shadow-emerald-950/40'
              : 'bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>📦 مهام الاستلام المعلقة</span>
          <span
            className={`px-2.5 py-0.5 rounded-full text-xs font-black ${
              activeTab === 'QUEUE'
                ? 'bg-slate-950/20 text-current'
                : (mode === 'warehouse' ? orders.length : receipts.length) > 0
                ? 'bg-amber-500 text-slate-950'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            {mode === 'warehouse' ? orders.length : receipts.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('ARCHIVE')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs sm:text-sm transition-all cursor-pointer ${
            activeTab === 'ARCHIVE'
              ? 'bg-cyan-600 text-white font-black shadow-lg shadow-cyan-950/40'
              : 'bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <span>🗄️ أرشيف استلام المواد</span>
          <span className="px-2.5 py-0.5 rounded-full text-xs bg-slate-800 text-slate-300">
            {archiveReceipts.length}
          </span>
        </button>
      </div>

      <TableFilterBar
        searchValue={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder={
          activeTab === 'ARCHIVE'
            ? 'بحث في الأرشيف برقم الإذن، أمر الشراء، المورد، أمين المخزن، مهندس الموقع...'
            : mode === 'warehouse'
            ? 'بحث برقم أمر الشراء، رقم الطلب، المورد، القسم، الصنف...'
            : 'بحث برقم إذن الاستلام، أمر الشراء، المورد، القسم...'
        }
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        onClear={() => {
          setSearchTerm('');
          setDateFrom(defaultDateFrom);
          setDateTo(today);
        }}
        hasActiveFilters={Boolean(searchTerm || dateFrom !== defaultDateFrom || dateTo !== today)}
        resultCount={
          activeTab === 'ARCHIVE'
            ? visibleArchive.length
            : mode === 'warehouse'
            ? visibleOrders.length
            : visibleReceipts.length
        }
      />

      {/* ── TAB 1: PENDING QUEUE ── */}
      {activeTab === 'QUEUE' && (
        <>
          {mode === 'warehouse' ? (
            /* Warehouse Keeper Pending Orders Queue - Ultra Simple Color-Coded Interface */
            visibleOrders.length > 0 ? (
              <div className="space-y-8">
                {visibleOrders.map((order, orderIdx) => {
                  const isSavingThis = saving === order.id;
                  const theme = getReceiptTheme(orderIdx);
                  const pendingSupplement = order.purchase_request?.supplements?.find(
                    (s) => ['PENDING_PROCUREMENT_APPROVAL', 'SUBMITTED', 'REVIEWER_APPROVED'].includes(s.status)
                  );
                  const isLockedBySupplement = Boolean(pendingSupplement);

                  return (
                    <div
                      key={order.id}
                      className={`p-5 sm:p-7 space-y-6 border-3 ${theme.border} ${theme.cardBg} shadow-2xl rounded-3xl transition-all`}
                    >
                      {/* 1. Header: Big Distinct Color Ribbon & Supplier Info */}
                      <div className={`rounded-2xl border-2 ${theme.headerBg} p-4 sm:p-5 space-y-4`}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className={`px-4 py-1.5 rounded-xl font-black text-sm sm:text-base border-2 ${theme.badgeBg} ${theme.badgeText} ${theme.badgeBorder} shadow-md flex items-center gap-1.5`}>
                              <span>{theme.icon}</span>
                              <span>{theme.colorTitle}</span>
                            </span>

                            <span className="font-mono text-base sm:text-lg font-black text-white bg-slate-950 border border-slate-700 px-3.5 py-1.5 rounded-xl shadow-inner">
                              أمر شراء #{order.po_number}
                            </span>

                            {order.purchase_request && (
                              <span className="text-xs sm:text-sm font-bold text-slate-300 bg-slate-900 border border-slate-700 px-3 py-1 rounded-lg">
                                طلب توريد #{order.purchase_request.request_number}
                              </span>
                            )}
                            {Boolean(order.is_supplementary || order.items?.some((i) => i.is_supplementary) || order.notes?.includes('كمالة')) && (
                              <span className="text-xs sm:text-sm font-black text-amber-300 bg-amber-950/90 border border-amber-500/80 px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-md">
                                <span>⚡</span>
                                <span>طلب كمالة معتمد</span>
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-950/80 border border-amber-600/70 text-amber-300 text-xs sm:text-sm font-black shadow-sm">
                              <span>🔒</span>
                              <span>استلام أعمى: يُسجل المستلم الكميات الفعلية بعد انتهاء الصبة والتوريد</span>
                            </span>

                            {!isLockedBySupplement && (
                              <Link
                                to="/requests/supplements"
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-amber-500/60 hover:border-amber-400 text-amber-300 text-xs sm:text-sm font-black transition-all shadow-sm"
                                title="إنشاء طلب كمالة (كميات إضافية) لهذا الطلب قبل إتمام الاستلام"
                              >
                                <span>➕</span>
                                <span>طلب كمالة</span>
                              </Link>
                            )}
                          </div>
                        </div>

                        {/* Large Clear Info Callouts */}
                        {(() => {
                          const orderParcel =
                            order.purchase_request?.parcel_reference ||
                            order.items?.find((i) => i.item_reference || i.pr_item?.item_reference)?.item_reference ||
                            order.items?.find((i) => i.item_reference || i.pr_item?.item_reference)?.pr_item?.item_reference ||
                            null;

                          const orderRegion =
                            order.purchase_request?.region ||
                            order.items?.find((i) => i.region || i.pr_item?.region)?.region ||
                            order.items?.find((i) => i.region || i.pr_item?.region)?.pr_item?.region ||
                            null;

                          return (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm sm:text-base pt-1">
                              <div className="flex items-center gap-3 text-slate-100 bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800">
                                <span className="text-3xl shrink-0">
                                  {order.supplier?.company_name === 'المخزن الداخلي' ? '🏛️' : '🏢'}
                                </span>
                                <div>
                                  <span className="text-slate-400 block text-xs font-bold">المورد صاحب البضاعة:</span>
                                  <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                    <span className="font-black text-base sm:text-lg text-white block">
                                      {order.supplier?.company_name || 'مورد غير محدد'}
                                    </span>
                                    {order.supplier?.company_name === 'المخزن الداخلي' && (
                                      <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full bg-purple-950 text-purple-300 border border-purple-600/70 shadow-sm">
                                        صرف من رصيد الشركة (سعر 0)
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-3 text-slate-100 bg-slate-950/80 p-3.5 rounded-2xl border border-slate-800">
                                <span className="text-3xl shrink-0">📍</span>
                                <div>
                                  <span className="text-slate-400 block text-xs font-bold">المشروع / موقع التوريد:</span>
                                  <span className="font-black text-base sm:text-lg text-cyan-300 block mt-0.5">
                                    {order.purchase_request?.project_name || order.purchase_request?.department?.name || 'المخزن الرئيسي'}
                                  </span>
                                </div>
                              </div>

                              {/* Parcel Reference Callout */}
                              <div className="flex items-center gap-3 text-slate-100 bg-slate-950/80 p-3.5 rounded-2xl border border-cyan-800/70 shadow-sm">
                                <span className="text-3xl shrink-0">🏷️</span>
                                <div>
                                  <span className="text-cyan-400 block text-xs font-bold">رقم قطعة الأرض:</span>
                                  <span className="font-mono font-black text-base sm:text-lg text-cyan-200 block mt-0.5">
                                    {orderParcel || 'غير مسجل'}
                                  </span>
                                </div>
                              </div>

                              {/* Region Callout */}
                              <div className="flex items-center gap-3 text-slate-100 bg-slate-950/80 p-3.5 rounded-2xl border border-amber-800/70 shadow-sm">
                                <span className="text-3xl shrink-0">📍</span>
                                <div>
                                  <span className="text-amber-400 block text-xs font-bold">المنطقة الجغرافية:</span>
                                  <span className="font-black text-base sm:text-lg text-amber-200 block mt-0.5">
                                    {orderRegion || 'غير مسجلة'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>

                      {/* Supplement In-Progress Warning Callout */}
                      {isLockedBySupplement && (
                        <div className="rounded-2xl border-2 border-amber-500/80 bg-gradient-to-r from-amber-950/70 via-slate-950 to-amber-950/60 p-4 sm:p-5 space-y-2.5 shadow-2xl text-amber-200">
                          <div className="flex items-center gap-2.5 font-black text-sm sm:text-base text-amber-300">
                            <span className="text-2xl animate-pulse">⏳</span>
                            <span>الاستلام مقفول مؤقتاً — يوجد طلب كمالة قيد المشتريات (دفعة #{pendingSupplement?.batch_number})</span>
                          </div>
                          <p className="text-xs sm:text-sm text-slate-200 leading-relaxed font-medium">
                            قام مهندس الموقع بطلب كميات إضافية (كمالة) على هذا الطلب، والطلب الآن قيد التسعير والتحميل على أمر الشراء الحالي #{order.po_number} لدى إدارة المشتريات (م. أحمد).
                            <span className="block text-amber-300 mt-1 font-bold">
                              🚫 تنبيه: لا يمكن استلام المواد بالموقع أو بالمخزن إلا بعد أن ينتهي المهندس أحمد من تسعير البنود وتحميلها على أمر الشراء.
                            </span>
                          </p>
                        </div>
                      )}

                      {/* ── Active Steel Weighing Group Card (ميزان بسكول) ── */}
                      {(() => {
                        const activeWeighingGroup = order.weighing_groups?.find((wg) => wg.status === 'PENDING_RECEIPT');
                        if (!activeWeighingGroup) return null;

                        if (isConsolidatedSteelTicket(order, activeWeighingGroup)) {
                          return (
                            <div className="rounded-3xl border-2 border-indigo-500/80 bg-gradient-to-br from-indigo-950/70 via-slate-950 to-slate-900 p-4 sm:p-5 shadow-2xl space-y-3" data-testid="steel-ticket-card">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h4 className="text-base sm:text-lg font-black text-white">
                                  ⚖️ كارتة ميزان الحديد — {activeWeighingGroup.group_number}
                                </h4>
                                <span className="px-3 py-1 rounded-xl text-xs font-black bg-slate-900/90 text-indigo-300 border border-indigo-500/40 font-mono">
                                  المطلوب: {activeWeighingGroup.total_ordered_weight} طن
                                </span>
                              </div>
                              <p className="text-xs text-indigo-200/80">
                                اكتب كمية الحديد المستلمة في بند «حديد» بالأسفل مرة واحدة. وزن الكارتة يُسجَّل للمرجعية فقط ولا يغيّر الكمية المستلمة.
                              </p>
                              <label className="block space-y-1.5">
                                <span className="text-xs sm:text-sm font-black text-indigo-200">الوزن الصافي من كارتة البسكول (اختياري):</span>
                                <div className="relative">
                                  <input
                                    type="number"
                                    step="0.001"
                                    min="0"
                                    placeholder="مثال: 70.800"
                                    aria-label="الوزن الصافي من كارتة البسكول"
                                    value={scaleTicketWeights[order.id] ?? ''}
                                    onChange={(e) => handleScaleWeightChange(order, e.target.value)}
                                    className="w-full h-12 rounded-xl border-2 border-indigo-400 bg-slate-900/90 px-3 text-lg font-black text-indigo-100 placeholder:text-slate-500 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                                  />
                                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-indigo-300 bg-indigo-950/80 px-2 py-0.5 rounded-md pointer-events-none">
                                    طن
                                  </span>
                                </div>
                              </label>
                            </div>
                          );
                        }

                        const enteredWeight = parseFloat(
                          scaleTicketWeights[order.id] !== undefined
                            ? scaleTicketWeights[order.id]
                            : String(activeWeighingGroup.total_ordered_weight || '')
                        );
                        const orderedWeight = Number(activeWeighingGroup.total_ordered_weight) || 0;
                        const hasEntered = !isNaN(enteredWeight) && enteredWeight > 0;
                        const diff = hasEntered ? Math.round((enteredWeight - orderedWeight) * 1000) / 1000 : 0;
                        const isMatch = hasEntered && Math.abs(diff) < 0.001;
                        const isShortage = hasEntered && diff < -0.001;

                        const unitPrice = Number(activeWeighingGroup.unit_price || activeWeighingGroup.items?.[0]?.unit_price || 0);
                        const totalCalculatedValue = hasEntered ? Math.round(enteredWeight * unitPrice * 100) / 100 : Math.round(orderedWeight * unitPrice * 100) / 100;

                        return (
                          <div className="rounded-3xl border-2 border-indigo-500/80 bg-gradient-to-br from-indigo-950/70 via-slate-950 to-slate-900 p-5 sm:p-6 shadow-2xl space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-500/30 pb-3">
                              <div className="flex items-center gap-3">
                                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-300 text-2xl border border-indigo-500/50 shadow-inner shrink-0">
                                  ⚖️
                                </span>
                                <div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <h4 className="text-base sm:text-lg font-black text-white">
                                      وزنة حديد مجمعة (ميزان بسكول) — {activeWeighingGroup.group_number}
                                    </h4>
                                    <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-indigo-500/20 text-indigo-300 border border-indigo-500/50">
                                      {activeWeighingGroup.items?.length || 0} بنود مجمعة
                                    </span>
                                  </div>
                                  <p className="text-xs text-indigo-200/80 mt-0.5">
                                    المورد: <strong className="text-white">{order.supplier?.company_name || '—'}</strong> | يتم استلام الشحنة كوزنة واحدة وإجمالي كمية واحدة دون توزيع نسبي.
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-3 flex-wrap">
                                <div className="bg-slate-900/90 border border-indigo-500/40 px-3.5 py-1.5 rounded-xl font-mono text-xs sm:text-sm">
                                  <span className="text-slate-400">سعر الطن الموحد: </span>
                                  <strong className="text-amber-300 font-black">{unitPrice.toLocaleString('en-US')} ج.م</strong>
                                </div>
                                <div className="bg-slate-900/90 border border-indigo-500/40 px-3.5 py-1.5 rounded-xl font-mono text-xs sm:text-sm">
                                  <span className="text-slate-400">إجمالي الطلب: </span>
                                  <strong className="text-indigo-300 font-black">{activeWeighingGroup.total_ordered_weight} طن</strong>
                                </div>
                              </div>
                            </div>

                            {/* Scale Weight Input, Total Financial Value, and Difference */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                              <div className="space-y-1.5">
                                <label className="text-xs sm:text-sm font-black text-indigo-200 flex items-center gap-1.5">
                                  <span>🚚</span>
                                  <span>الكمية المستلمة فعلياً (ميزان بسكول):</span>
                                </label>
                                <div className="relative">
                                  <input
                                    type="number"
                                    step="0.001"
                                    min="0"
                                    placeholder="مثال: 5.800"
                                    value={scaleTicketWeights[order.id] ?? String(activeWeighingGroup.total_ordered_weight || '')}
                                    onChange={(e) => handleScaleWeightChange(order, e.target.value)}
                                    className="w-full h-12 rounded-xl border-2 border-indigo-400 bg-slate-900/90 px-3 text-lg font-black text-indigo-100 placeholder:text-slate-500 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                                  />
                                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-indigo-300 bg-indigo-950/80 px-2 py-0.5 rounded-md pointer-events-none">
                                    طن
                                  </span>
                                </div>
                              </div>

                              {/* Real-time Calculated Total Financial Value */}
                              <div className="space-y-1.5">
                                <label className="text-xs sm:text-sm font-black text-emerald-300 block">
                                  إجمالي قيمة الشحنة الفعلية:
                                </label>
                                <div className="h-12 flex items-center justify-between px-4 rounded-xl border-2 border-emerald-500/60 bg-emerald-950/50 font-black text-emerald-200">
                                  <span className="text-xs font-mono text-emerald-300/80">
                                    {hasEntered ? enteredWeight : orderedWeight} طن × {unitPrice.toLocaleString('en-US')}
                                  </span>
                                  <span className="font-mono text-base text-emerald-300 font-black">
                                    {totalCalculatedValue.toLocaleString('en-US')} ج.م
                                  </span>
                                </div>
                              </div>

                              {/* Difference Indicator */}
                              <div className="space-y-1.5">
                                <label className="text-xs sm:text-sm font-black text-slate-300 block">
                                  حالة المطابقة مع أمر الشراء:
                                </label>
                                {!hasEntered ? (
                                  <div className="h-12 flex items-center px-4 rounded-xl border border-dashed border-slate-700 bg-slate-900/60 text-xs text-slate-400 font-medium">
                                    أدخل وزن البسكول لحساب الفارق تلقائياً...
                                  </div>
                                ) : (
                                  <div
                                    className={`h-12 flex items-center justify-between px-4 rounded-xl border-2 font-black text-xs sm:text-sm shadow-md ${
                                      isMatch
                                        ? 'border-emerald-500/70 bg-emerald-950/60 text-emerald-300'
                                        : isShortage
                                        ? 'border-amber-500/80 bg-amber-950/60 text-amber-300'
                                        : 'border-cyan-500/80 bg-cyan-950/60 text-cyan-300'
                                    }`}
                                  >
                                    <span>
                                      {isMatch ? '✅ مطابق تماماً' : isShortage ? '⚠️ عجز في التوريد' : '📈 زيادة في التوريد'}
                                    </span>
                                    <span className="font-mono text-base dir-ltr">
                                      {diff > 0 ? `+${diff}` : diff} طن
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {/* 2. Items List: Ultra Simple Big Visual Cards (Hidden if order has an active Weighing Group) */}
                      <div className="space-y-4">
                        {!order.weighing_groups?.some((wg) => wg.status === 'PENDING_RECEIPT' && !isConsolidatedSteelTicket(order, wg)) && (
                          <>
                            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                              <h4 className="text-sm sm:text-base font-black text-slate-100 flex items-center gap-2">
                                <span>📦</span>
                                <span>الأصناف المطلوب استلامها في هذا الإذن ({order.items?.length || 0} صنف):</span>
                              </h4>
                            </div>

                            {order.shipment_groups && order.shipment_groups.length > 0 && (
                              <div className="space-y-2">
                                {order.shipment_groups.map((sg) => (
                                  <div
                                    key={sg.id}
                                    className={`rounded-2xl border-2 p-3.5 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs ${
                                      sg.status === 'RECEIVED'
                                        ? 'border-emerald-500/60 bg-emerald-950/40 text-emerald-200'
                                        : sg.status === 'PARTIALLY_RECEIVED'
                                        ? 'border-cyan-500/60 bg-cyan-950/40 text-cyan-200'
                                        : 'border-amber-500/60 bg-gradient-to-r from-amber-950/40 via-slate-900 to-slate-950 text-amber-200'
                                    }`}
                                  >
                                    <div className="flex items-center gap-3">
                                      <span className="text-2xl">🚚</span>
                                      <div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span className="font-black text-sm text-white">
                                            شحنة مشتركة ({sg.group_number}): {sg.group_name}
                                          </span>
                                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-current">
                                            {sg.status === 'RECEIVED'
                                              ? '✅ مستلمة بالكامل'
                                              : sg.status === 'PARTIALLY_RECEIVED'
                                              ? '⏳ مستلمة جزئياً'
                                              : '⏳ قيد التوريد بالموقع'}
                                          </span>
                                          {sg.vehicle_plate_number && (
                                            <span className="font-mono text-[10px] bg-slate-800 border border-slate-700 px-2 py-0.5 rounded text-amber-300">
                                              لوحة: {sg.vehicle_plate_number}
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-slate-300 mt-1 flex items-center gap-3 flex-wrap">
                                          {sg.driver_name && <span>السائق: {sg.driver_name}</span>}
                                          {sg.driver_phone && <span className="font-mono">هاتف: {sg.driver_phone}</span>}
                                          <span>عدد البنود: {sg.items?.length || sg.items_count || 0}</span>
                                          {sg.notes && <span className="text-slate-400">ملاحظات: {sg.notes}</span>}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="space-y-4">
                          {(order.items || []).map((item, idx) => {
                            const key = `${order.id}-${item.id}`;
                            const val = quantities[key] ?? '';
                            const numVal = parseFloat(val) || 0;

                            const itemParcel =
                              item.item_reference ||
                              item.pr_item?.item_reference ||
                              order.purchase_request?.parcel_reference ||
                              null;

                            const itemRegion =
                              item.region ||
                              item.pr_item?.region ||
                              order.purchase_request?.region ||
                              null;

                            return (
                              <div
                                key={item.id}
                                className={`rounded-2xl border-2 ${theme.itemBorder} bg-slate-950/90 p-4 sm:p-5 space-y-4 shadow-xl`}
                              >
                                {/* Item Title & Number */}
                                <div className="flex items-start justify-between gap-3">
                                  <div className="space-y-1 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${theme.badgeBg} ${theme.badgeText} font-black text-base shrink-0 shadow-md`}>
                                        {idx + 1}
                                      </span>
                                      <h4 className="text-base sm:text-xl font-black text-white flex items-center gap-2 flex-wrap">
                                        <span>{item.item_description || item.item?.name}</span>
                                        <SupplementItemBadge
                                          isSupplementary={item.is_supplementary}
                                          batchNumber={item.supplement_batch}
                                        />
                                        {item.shipment_group && (
                                          <span className="text-xs font-bold text-amber-300 bg-amber-950 border border-amber-500/60 px-2.5 py-0.5 rounded-xl flex items-center gap-1 shadow-sm">
                                            <span>🚚</span>
                                            <span>شحنة: {item.shipment_group.group_number}</span>
                                          </span>
                                        )}
                                      </h4>
                                    </div>
                                    {item.specifications && (
                                      <p className="text-xs sm:text-sm text-slate-300 leading-relaxed pr-10">
                                        المواصفات: <strong className="text-slate-100">{item.specifications}</strong>
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {/* Plot & Region Badges on Item */}
                                {(itemParcel || itemRegion) && (
                                  <div className="flex items-center gap-2 flex-wrap text-xs sm:text-sm">
                                    {itemParcel && (
                                      <span className="inline-flex items-center gap-1.5 font-mono text-cyan-200 bg-cyan-950 border border-cyan-700/80 px-3 py-1 rounded-xl font-black shadow-sm">
                                        <span>🏷️</span> قطعة الأرض: {itemParcel}
                                      </span>
                                    )}
                                    {itemRegion && (
                                      <span className="inline-flex items-center gap-1.5 text-amber-200 bg-amber-950 border border-amber-700/80 px-3 py-1 rounded-xl font-black shadow-sm">
                                        <span>📍</span> المنطقة: {itemRegion}
                                      </span>
                                    )}
                                  </div>
                                )}

                                {/* Blind Receiving Callout (Ordered quantity is hidden for audit accuracy) */}
                                <div className="rounded-2xl border border-slate-700/70 bg-gradient-to-r from-slate-900 via-slate-950 to-slate-900 p-3.5 flex items-center gap-3 shadow-md">
                                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/20 text-amber-300 text-lg border border-amber-500/40 shrink-0">
                                    📝
                                  </span>
                                  <div className="flex-1">
                                    <span className="text-xs text-slate-300 block">
                                      الوحدة المطلوبة للاستلام: <strong className="text-white font-mono text-sm">{getUnitLabel(item.pr_item?.uom || item.uom || '')}</strong>
                                    </span>
                                    {item.pr_item?.quantity && (
                                      <span className="text-xs text-cyan-300 font-bold block mt-0.5">
                                        الكمية المطلوبة بالموقع: <strong className="font-mono text-white text-sm">{item.pr_item.quantity} {getUnitLabel(item.pr_item?.uom || item.uom || '')}</strong>
                                      </span>
                                    )}
                                    <span className="text-[11px] text-amber-300 font-bold block mt-0.5">
                                      ⚠️ يرجى إدخال الكمية المستلمة فعلياً بوحدة ({getUnitLabel(item.pr_item?.uom || item.uom || '')}) كما طلبها مهندس الموقع.
                                    </span>
                                  </div>
                                </div>

                                {/* Received Quantity Input Section */}
                                <div className="rounded-2xl border-2 border-emerald-500/80 bg-emerald-950/30 p-4 sm:p-5 space-y-3 shadow-inner">
                                  <div className="flex items-center justify-between">
                                    <label htmlFor={`qty-${key}`} className="text-sm sm:text-base font-black text-emerald-300 flex items-center gap-2">
                                      <span className="text-lg">📥</span>
                                      <span>الكمية المستلمة فعلياً في الموقع بعد انتهاء الصبة:</span>
                                    </label>
                                    <span className="text-xs font-bold text-emerald-300 bg-emerald-950 border border-emerald-500/50 px-2.5 py-0.5 rounded-full">
                                      اكتب الرقم هنا 👇
                                    </span>
                                  </div>

                                  <div className="space-y-2.5">
                                    <div className="relative flex items-center">
                                      <input
                                        id={`qty-${key}`}
                                        type="number"
                                        min="0"
                                        step="any"
                                        placeholder="اكتب الكمية المستلمة بالأرقام..."
                                        value={val}
                                        onChange={(e) => setQuantities({ ...quantities, [key]: e.target.value })}
                                        className="w-full h-14 rounded-2xl border-2 border-emerald-400 bg-slate-900/95 pl-24 pr-4 text-xl sm:text-2xl font-black text-emerald-200 placeholder:text-slate-500 placeholder:text-sm sm:placeholder:text-base placeholder:font-normal focus:border-emerald-300 focus:bg-slate-900 focus:ring-4 focus:ring-emerald-500/30 focus:outline-none transition-all shadow-inner"
                                      />
                                      {/* Unit badge pinned inside input */}
                                      <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-emerald-950/90 border border-emerald-500/50 px-3 py-1.5 rounded-xl pointer-events-none">
                                        <span className="text-xs sm:text-sm font-black text-emerald-300">
                                          {getUnitLabel(item.pr_item?.uom || item.uom || '')}
                                        </span>
                                      </div>
                                    </div>

                                    {/* Action Buttons: Clearly labeled pill buttons, not input boxes */}
                                    <div className="flex items-center justify-between pt-1">
                                      <span className="text-[11px] text-slate-400 font-medium">أزرار ضغط سريعة (ليست للكتابة):</span>
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          tabIndex={-1}
                                          onClick={() => {
                                            const next = Math.max(0, numVal - 1);
                                            setQuantities({ ...quantities, [key]: String(next) });
                                          }}
                                          className="h-8 px-3.5 rounded-full bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-200 border border-slate-600 font-bold text-xs flex items-center gap-1.5 cursor-pointer transition select-none active:scale-95 shadow-sm"
                                          title="إنقاص الكمية بمقدار 1"
                                        >
                                          <span className="text-sm font-black">-1</span>
                                          <span>إنقاص</span>
                                        </button>

                                        <button
                                          type="button"
                                          tabIndex={-1}
                                          onClick={() => {
                                            const next = numVal + 1;
                                            setQuantities({ ...quantities, [key]: String(next) });
                                          }}
                                          className="h-8 px-3.5 rounded-full bg-emerald-900/60 hover:bg-emerald-800/80 active:bg-emerald-700 text-emerald-200 border border-emerald-600/70 font-bold text-xs flex items-center gap-1.5 cursor-pointer transition select-none active:scale-95 shadow-sm"
                                          title="زيادة الكمية بمقدار 1"
                                        >
                                          <span className="text-sm font-black">+1</span>
                                          <span>زيادة</span>
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                {/* Simple Notes */}
                                <div className="pt-1">
                                  <input
                                    type="text"
                                    placeholder="أي ملاحظة على هذا الصنف (اختياري)..."
                                    value={itemNotes[key] || ''}
                                    onChange={(e) => setItemNotes({ ...itemNotes, [key]: e.target.value })}
                                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-xs sm:text-sm text-slate-200 focus:border-cyan-400 focus:outline-none"
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}

                        {/* General Order Notes */}
                        <div className="space-y-1.5 pt-2">
                          <label className="text-xs sm:text-sm font-bold text-slate-300">ملاحظات عامة على الاستلام (اختياري):</label>
                          <textarea
                            rows={2}
                            value={notes[order.id] || ''}
                            onChange={(e) => setNotes({ ...notes, [order.id]: e.target.value })}
                            placeholder="مثال: تم فحص البضاعة ومطابقة الأختام، البضاعة سليمة وبحالة جيدة..."
                            className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-xs sm:text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
                          />
                        </div>

                        {/* Actual Receiver in Site */}
                        <div className="space-y-1.5 pt-2">
                          <label className="text-xs sm:text-sm font-bold text-slate-300 flex items-center justify-between">
                            <span>👤 المستلم الفعلي في الموقع (اختياري):</span>
                            <span className="text-[11px] text-slate-400 font-normal">اسم الشخص أو المهندس الذي استلم الشحنة على الأرض</span>
                          </label>
                          <input
                            type="text"
                            value={actualReceivers[order.id] || ''}
                            onChange={(e) => setActualReceivers({ ...actualReceivers, [order.id]: e.target.value })}
                            placeholder="مثال: م. أيمن ماهر / اسم المستلم الميداني..."
                            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-xs sm:text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
                          />
                        </div>

                        {/* 3. Camera / Photo Attachment (Ultra Simple Big Button) */}
                        <div className="rounded-2xl border-2 border-dashed border-cyan-500/70 bg-cyan-950/30 p-4 sm:p-5 space-y-4 shadow-lg">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex items-center gap-3">
                              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-500/20 text-cyan-300 text-3xl border border-cyan-500/40 shrink-0">
                                📷
                              </span>
                              <div>
                                <h5 className="text-sm sm:text-base font-black text-cyan-200 flex items-center gap-2">
                                  <span>تصوير بون الميزان أو وزنة الحديد / بوليصة الاستلام</span>
                                  <span className="text-xs font-bold text-amber-300 bg-amber-950/80 border border-amber-800/60 px-2 py-0.5 rounded-md">
                                    (اختياري)
                                  </span>
                                </h5>
                                <p className="text-xs text-slate-300 mt-0.5">
                                  التقط صورة واضحة بالكاميرا ليراها مهندس الموقع والمحاسب مباشرة مع إذن الصرف.
                                </p>
                              </div>
                            </div>
                            {receiptPhotos[order.id] && (
                              <button
                                type="button"
                                onClick={() => setReceiptPhotos((prev) => ({ ...prev, [order.id]: null }))}
                                className="text-xs font-bold text-rose-300 hover:text-white bg-rose-950/90 border border-rose-700 px-3.5 py-1.5 rounded-xl cursor-pointer shadow-md"
                              >
                                ✕ حذف الصورة وإعادة التصوير
                              </button>
                            )}
                          </div>

                          {receiptPhotos[order.id] ? (
                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 bg-slate-950 p-4 rounded-2xl border-2 border-emerald-500/80 shadow-xl">
                              <div
                                onClick={() => setPreviewPhotoUrl(receiptPhotos[order.id]!.base64)}
                                className="relative h-28 w-28 sm:h-32 sm:w-32 rounded-2xl overflow-hidden border-2 border-emerald-400 cursor-pointer group shrink-0 shadow-lg"
                              >
                                <img
                                  src={receiptPhotos[order.id]!.base64}
                                  alt="صورة الاستلام"
                                  className="h-full w-full object-cover group-hover:scale-105 transition-transform"
                                />
                                <div className="absolute inset-0 bg-slate-950/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <span className="text-xs font-black text-white bg-slate-900/90 px-2.5 py-1 rounded-lg">🔍 تكبير</span>
                                </div>
                              </div>
                              <div className="space-y-2 text-xs flex-1">
                                <div className="font-black text-emerald-400 text-base flex items-center gap-2">
                                  <span>✅</span>
                                  <span>تم التقاط صورة بون الميزان بنجاح!</span>
                                </div>
                                <p className="text-slate-300 text-xs sm:text-sm">
                                  الملف المختار: {receiptPhotos[order.id]!.name}
                                </p>
                                <div className="p-2.5 rounded-xl bg-slate-900/90 border border-emerald-500/30 text-xs space-y-1 text-right">
                                  <div className="text-emerald-300 font-bold flex items-center gap-1.5">
                                    <span>🏷️</span>
                                    <span>بيانات التسمية الموحدة لـ Google Drive:</span>
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-300 text-[11px] pt-1">
                                    <div><span className="text-slate-400">القطعة:</span> {order.purchase_request?.parcel_reference || (order.purchase_request as any)?.land_parcel?.parcel_reference || order.items?.[0]?.item_reference || 'غير محدد'}</div>
                                    <div><span className="text-slate-400">المنطقة:</span> {order.purchase_request?.region || order.items?.[0]?.region || 'غير محدد'}</div>
                                    <div><span className="text-slate-400">البند:</span> {order.items?.length === 1 ? (order.items[0].item?.name || order.items[0].item_description) : 'متعدد البنود'}</div>
                                    <div><span className="text-slate-400">المورد:</span> {order.supplier?.company_name || (order.supplier as any)?.name || 'غير محدد'}</div>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setPreviewPhotoUrl(receiptPhotos[order.id]!.base64)}
                                  className="text-xs sm:text-sm font-black text-cyan-400 hover:text-cyan-300 underline inline-flex items-center gap-1 cursor-pointer pt-1"
                                >
                                  <span>👁️</span> اضغط هنا لمعاينة الصورة بالحجم الكامل المكبر
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-1">
                              {/* Option 1: Direct Native Camera Launch on Phone/Tablet */}
                              <label
                                htmlFor={`receipt-camera-capture-${order.id}`}
                                className="flex items-center justify-center gap-3.5 p-4 sm:p-5 rounded-2xl border-2 border-cyan-400 hover:border-cyan-300 bg-cyan-950/60 hover:bg-cyan-900/70 cursor-pointer transition-all text-right group shadow-lg active:scale-98"
                              >
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-500/20 text-cyan-300 text-3xl border border-cyan-400 group-hover:scale-110 transition-transform">
                                  📸
                                </div>
                                <div className="space-y-1 flex-1">
                                  <span className="text-sm sm:text-base font-black text-cyan-100 group-hover:text-white block">
                                    فتح الكاميرا والتقاط صورة الميزان فوراً
                                  </span>
                                  <span className="block text-xs text-slate-300">
                                    تشغيل كاميرا الهاتف مباشرة وتصوير الورقة
                                  </span>
                                </div>
                                <input
                                  id={`receipt-camera-capture-${order.id}`}
                                  type="file"
                                  accept="image/*"
                                  capture="environment"
                                  className="hidden"
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) handlePhotoCapture(order.id, file);
                                    e.target.value = '';
                                  }}
                                />
                              </label>

                              {/* Option 2: Gallery / Files Picker */}
                              <label
                                htmlFor={`receipt-gallery-picker-${order.id}`}
                                className="flex items-center justify-center gap-3.5 p-4 sm:p-5 rounded-2xl border-2 border-slate-700 hover:border-cyan-400 bg-slate-900/80 hover:bg-slate-900 cursor-pointer transition-all text-right group shadow-lg active:scale-98"
                              >
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-800 text-slate-300 text-3xl border border-slate-700 group-hover:scale-110 transition-transform">
                                  📁
                                </div>
                                <div className="space-y-1 flex-1">
                                  <span className="text-sm sm:text-base font-black text-slate-200 group-hover:text-cyan-300 block">
                                    اختيار صورة من الهاتف أو الملفات
                                  </span>
                                  <span className="block text-xs text-slate-400">
                                    تحميل صورة تم التقاطها مسبقاً
                                  </span>
                                </div>
                                <input
                                  id={`receipt-gallery-picker-${order.id}`}
                                  type="file"
                                  accept="image/*"
                                  className="hidden"
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) handlePhotoCapture(order.id, file);
                                    e.target.value = '';
                                  }}
                                />
                              </label>
                            </div>
                          )}
                        </div>

                        {/* 4. Giant Confirm & Submit Button */}
                        <div className="pt-4 border-t border-slate-800 space-y-2">
                          <Button
                            variant={isLockedBySupplement ? "secondary" : "success"}
                            size="lg"
                            isLoading={isSavingThis}
                            disabled={isLockedBySupplement || isSavingThis}
                            onClick={() => submitWarehouseReceipt(order)}
                            className={`w-full font-black text-base sm:text-xl py-4 rounded-2xl shadow-2xl flex items-center justify-center gap-3 transition-all ${
                              isLockedBySupplement
                                ? 'bg-slate-800/90 text-amber-300/80 border-2 border-amber-600/50 cursor-not-allowed shadow-none'
                                : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-950/80 cursor-pointer active:scale-98'
                            }`}
                          >
                            <span className="text-2xl">{isLockedBySupplement ? '⏳' : '✅'}</span>
                            <span>
                              {isLockedBySupplement
                                ? `الاستلام مقفول مؤقتاً — بانتظار استكمال أمر الشراء للكمالة لدى م. أحمد`
                                : `تأكيد واعتماد الاستلام النهائي للموقع (أمر #${order.po_number}) ونقله للحسابات`}
                            </span>
                          </Button>
                          <p className="text-center text-xs sm:text-sm font-bold text-slate-400">
                            {isLockedBySupplement
                              ? '⚠️ تم قفل الاستلام تلقائياً حتى يقوم مدير المشتريات (م. أحمد) بتسعير بنود الكمالة وتحميلها على أمر الشراء.'
                              : '💡 ضغطة واحدة لحفظ إذن الاستلام نهائياً ونقله للإدارة المالية والحسابات للمطابقة والصرف فور انتهاء الصبة.'}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-12 text-center text-slate-400 space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60">
                <span className="text-4xl block">📦</span>
                <p className="text-base font-bold text-slate-200">لا توجد مهام استلام معلقة حالياً بالمخزن</p>
                <p className="text-xs text-slate-500">
                  تظهر هنا أوامر الشراء الصادرة للموردين فور اعتمادها، لتسجيل استلام المواد بالمخزن. يمكنك الاطلاع على الاستلامات السابقة من تبويب «أرشيف استلام المواد».
                </p>
              </div>
            )
          ) : (
            /* Site Engineer Pending Receipts Queue */
            visibleReceipts.length > 0 ? (
              <div className="space-y-6">
                {visibleReceipts.map((receipt) => {
                  const isSavingThis = saving === receipt.id;

                  const isTargeted = Boolean(targetReceiptId && String(receipt.id) === String(targetReceiptId));

                  return (
                    <Card
                      id={`receipt-card-${receipt.id}`}
                      key={receipt.id}
                      className={`p-4 sm:p-6 space-y-5 border-2 ${
                        isTargeted
                          ? 'border-cyan-400 ring-4 ring-cyan-500/30 bg-slate-900 shadow-cyan-950/60'
                          : 'border-emerald-500/50 bg-slate-900/95'
                      } shadow-2xl rounded-2xl transition-all`}
                    >
                      {/* Header */}
                      <div className="space-y-3 border-b border-slate-800 pb-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="font-mono text-base sm:text-lg font-black text-emerald-300 bg-emerald-950 border border-emerald-700 px-3.5 py-1.5 rounded-xl shadow-inner">
                              {receipt.receipt_number}
                            </span>
                            <span className="text-xs sm:text-sm font-bold text-slate-300 bg-slate-800 border border-slate-700 px-3 py-1 rounded-lg">
                              أمر شراء: <span className="font-mono text-cyan-300">{receipt.purchase_order?.po_number}</span>
                            </span>
                            {Boolean(
                              (receipt as any).is_supplementary ||
                              (receipt.purchase_order as any)?.is_supplementary ||
                              receipt.items?.some((i) => i.purchase_order_item?.is_supplementary) ||
                              receipt.purchase_order?.items?.some((i) => i.is_supplementary) ||
                              receipt.purchase_order?.notes?.includes('كمالة')
                            ) && (
                              <span className="text-xs sm:text-sm font-black text-amber-300 bg-amber-950/90 border border-amber-500/80 px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-md">
                                <span>⚡</span>
                                <span>طلب كمالة معتمد</span>
                              </span>
                            )}
                            {receipt.receipt_type === 'SITE_DIRECT' && (
                              <span className="text-xs sm:text-sm font-black text-amber-200 bg-amber-950/90 border border-amber-500/80 px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-md">
                                <span>🏗️</span>
                                <span>توريد مباشر لموقع المباني (استلام مباشر بالموقع دون مرور بالمخزن)</span>
                              </span>
                            )}
                            {receipt.receipt_type === 'REQUESTER_OFFICE' && (
                              <span className="text-xs sm:text-sm font-black text-indigo-200 bg-indigo-950/90 border border-indigo-500/80 px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-md">
                                <span>🏢</span>
                                <span>توريد مستلزمات مكتبية (استلام وتأكيد مباشر في مقر الشركة)</span>
                              </span>
                            )}
                            {(receipt.is_internal_warehouse || receipt.supplier?.company_name === 'المخزن الداخلي' || receipt.purchase_order?.supplier?.company_name === 'المخزن الداخلي') && (
                              <span className="text-xs sm:text-sm font-black text-purple-200 bg-purple-950/90 border border-purple-500/80 px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-md">
                                <span>🏛️</span>
                                <span>صرف من رصيد المخزن الداخلي (بضاعة متواجدة مسبقاً - سعر 0)</span>
                              </span>
                            )}
                            {receipt.weighing_group && (
                              <span className="text-xs sm:text-sm font-black text-indigo-200 bg-indigo-950/90 border border-indigo-500/80 px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-md">
                                <span>⚖️</span>
                                <span>وزنة حديد مجمعة ({receipt.weighing_group.group_number})</span>
                              </span>
                            )}
                          </div>
                        </div>

                        {(() => {
                          const receiptParcel =
                            receipt.purchase_order?.purchase_request?.parcel_reference ||
                            receipt.purchase_request?.parcel_reference ||
                            receipt.items?.find((i) => i.purchase_order_item?.item_reference || i.purchase_order_item?.pr_item?.item_reference)?.purchase_order_item?.item_reference ||
                            receipt.items?.find((i) => i.purchase_order_item?.item_reference || i.purchase_order_item?.pr_item?.item_reference)?.purchase_order_item?.pr_item?.item_reference ||
                            null;

                          const receiptRegion =
                            receipt.purchase_order?.purchase_request?.region ||
                            receipt.purchase_request?.region ||
                            receipt.items?.find((i) => i.purchase_order_item?.region || i.purchase_order_item?.pr_item?.region)?.purchase_order_item?.region ||
                            receipt.items?.find((i) => i.purchase_order_item?.region || i.purchase_order_item?.pr_item?.region)?.purchase_order_item?.pr_item?.region ||
                            null;

                          const isInternal = receipt.is_internal_warehouse || receipt.supplier?.company_name === 'المخزن الداخلي' || receipt.purchase_order?.supplier?.company_name === 'المخزن الداخلي';
                          const supplierName = receipt.supplier?.company_name || receipt.supplier_name || receipt.purchase_order?.supplier?.company_name || (isInternal ? 'المخزن الداخلي' : 'مورد غير محدد');

                          return (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs sm:text-sm pt-1">
                              <div className="flex items-center gap-2 text-slate-200 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80">
                                <span className="text-base">{isInternal ? '🏛️' : '🏢'}</span>
                                <div>
                                  <span className="text-slate-400 block text-[11px]">المورد:</span>
                                  <span className="font-bold text-slate-100">{supplierName}</span>
                                </div>
                              </div>

                              {receipt.receipt_type === 'SITE_DIRECT' ? (
                                <div className="flex items-center gap-2 text-indigo-200 bg-indigo-950/50 p-2.5 rounded-xl border border-indigo-700/60">
                                  <span className="text-base">🏗️</span>
                                  <div>
                                    <span className="text-indigo-400 block text-[11px] font-bold">مسار التوريد:</span>
                                    <span className="font-bold text-white">مباشر للموقع من المورد</span>
                                  </div>
                                </div>
                              ) : receipt.warehouse_keeper ? (
                                <div className="flex items-center gap-2 text-amber-300 bg-amber-950/40 p-2.5 rounded-xl border border-amber-800/50">
                                  <span className="text-base">📦</span>
                                  <div>
                                    <span className="text-amber-400/80 block text-[11px]">أمين المخزن:</span>
                                    <span className="font-bold">{receipt.warehouse_keeper.name}</span>
                                  </div>
                                </div>
                              ) : null}

                              {/* Parcel Reference Callout */}
                              <div className="flex items-center gap-2 text-cyan-200 bg-cyan-950/40 p-2.5 rounded-xl border border-cyan-800/50">
                                <span className="text-base">🏷️</span>
                                <div>
                                  <span className="text-cyan-400/80 block text-[11px] font-bold">رقم قطعة الأرض:</span>
                                  <span className="font-mono font-black text-cyan-300 text-xs sm:text-sm">{receiptParcel || 'غير مسجل'}</span>
                                </div>
                              </div>

                              {/* Region Callout */}
                              <div className="flex items-center gap-2 text-amber-200 bg-amber-950/40 p-2.5 rounded-xl border border-amber-800/50">
                                <span className="text-base">📍</span>
                                <div>
                                  <span className="text-amber-400/80 block text-[11px] font-bold">المنطقة:</span>
                                  <span className="font-black text-amber-300 text-xs sm:text-sm">{receiptRegion || 'غير مسجلة'}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {receipt.warehouse_notes && (
                          <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-3 text-xs sm:text-sm text-amber-200">
                            <strong className="text-amber-400">ملاحظات أمين المخزن: </strong>
                            {receipt.warehouse_notes}
                          </div>
                        )}

                        {/* Attached Photo Display for Site Engineer */}
                        {Boolean(receipt.photo_url || receipt.photo_path) && (
                          <div className="rounded-2xl border-2 border-cyan-500/50 bg-cyan-950/25 p-4 space-y-3 shadow-md">
                            <div className="flex items-center justify-between flex-wrap gap-2">
                              <span className="text-xs sm:text-sm font-black text-cyan-200 flex items-center gap-2">
                                <span>📷</span> صورة فحص واستلام المخزن (بون الميزان / وزنة الحديد المرفقة):
                              </span>
                              <div className="flex items-center gap-3">
                                {Boolean(receipt.photo_path?.includes('drive.google.com') || receipt.photo_url?.includes('drive.google.com')) && (
                                  <a
                                    href={receipt.photo_path?.includes('drive.google.com') ? receipt.photo_path : receipt.photo_url!}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs font-bold text-emerald-400 hover:text-emerald-300 underline inline-flex items-center gap-1"
                                  >
                                    <span>📁</span> فتح في Google Drive ↗
                                  </a>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(receipt))}
                                  className="text-xs font-bold text-cyan-400 hover:text-cyan-300 underline inline-flex items-center gap-1 cursor-pointer"
                                >
                                  <span>🔍</span> عرض بالحجم الكامل
                                </button>
                              </div>
                            </div>
                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3.5 bg-slate-950/90 p-3 rounded-xl border border-slate-800">
                              <div
                                onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(receipt))}
                                className="relative h-24 w-24 sm:h-28 sm:w-28 rounded-xl overflow-hidden border-2 border-cyan-400/80 cursor-pointer shrink-0 shadow-lg group"
                              >
                                <img
                                  src={getReceiptPhotoUrl(receipt)}
                                  alt="صورة الاستلام الميداني"
                                  className="h-full w-full object-cover group-hover:scale-105 transition-transform"
                                />
                                <div className="absolute inset-0 bg-slate-950/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <span className="text-xs font-bold text-white bg-slate-900/90 px-2 py-1 rounded">🔍 تكبير</span>
                                </div>
                              </div>
                              <div className="text-xs space-y-1.5 flex-1">
                                <p className="font-black text-slate-100 text-sm">
                                  صورة موثقة بواسطة أمين المخزن أثناء استلام الشحنة
                                </p>
                                <p className="text-slate-300">
                                  يمكنك مطابقة بون الميزان وأختام الحديد ومطابقتها هندسياً قبل تأكيد الاعتماد النهائي.
                                </p>
                                <button
                                  type="button"
                                  onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(receipt))}
                                  className="text-xs font-bold text-cyan-400 hover:underline cursor-pointer"
                                >
                                  اضغط هنا لمعاينة الصورة المكبرة ←
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Items Cards */}
                      <div className="space-y-4">
                        {receipt.weighing_group || receipt.receipt_type === 'STEEL_WEIGHING_GROUP' ? (
                          (() => {
                            const wg = receipt.weighing_group;
                            const totalOrd = Number(wg?.total_ordered_weight || receipt.items?.reduce((s, i) => s + Number(i.ordered_quantity || 0), 0) || 0);
                            const totalRec = Number(wg?.total_received_weight || receipt.items?.reduce((s, i) => s + Number(i.received_quantity || 0), 0) || 0);
                            const unitPrice = Number(wg?.unit_price || wg?.items?.[0]?.unit_price || receipt.items?.[0]?.purchase_order_item?.unit_price || 0);
                            const totalVal = Math.round(totalRec * unitPrice * 100) / 100;
                            const diff = Math.round((totalRec - totalOrd) * 1000) / 1000;

                            return (
                              <div className="rounded-2xl border-2 border-indigo-500/80 bg-slate-950/95 p-5 sm:p-6 space-y-4 shadow-xl">
                                <div className="flex items-center justify-between gap-3 flex-wrap border-b border-indigo-500/30 pb-3">
                                  <div className="flex items-center gap-3">
                                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-300 text-2xl border border-indigo-500/40 shrink-0">
                                      ⚖️
                                    </span>
                                    <div>
                                      <h4 className="text-base sm:text-lg font-black text-white">
                                        وزنة حديد مجمعة (ميزان بسكول) — {wg?.group_number || 'شحنة موحدة'}
                                      </h4>
                                      <p className="text-xs text-indigo-200/80 mt-0.5">
                                        تم استلام الشحنة كوزنة واحدة وإجمالي كمية واحدة دون توزيع نسبي.
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className={`px-3 py-1 rounded-xl text-xs font-black border ${
                                      Math.abs(diff) < 0.001
                                        ? 'bg-emerald-950/80 border-emerald-500/70 text-emerald-300'
                                        : diff > 0
                                        ? 'bg-cyan-950/80 border-cyan-500/70 text-cyan-300'
                                        : 'bg-amber-950/80 border-amber-500/70 text-amber-300'
                                    }`}>
                                      {Math.abs(diff) < 0.001 ? '✅ مطابق تماماً' : diff > 0 ? `📈 زيادة توريد (+${diff} طن)` : `⚠️ عجز توريد (${diff} طن)`}
                                    </span>
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs sm:text-sm">
                                  <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-1">
                                    <span className="text-slate-400 block text-xs">إجمالي الكمية المطلوبة:</span>
                                    <strong className="text-base font-black text-indigo-300">{totalOrd} طن</strong>
                                  </div>
                                  <div className="rounded-xl border border-emerald-500/50 bg-emerald-950/40 p-3.5 space-y-1">
                                    <span className="text-emerald-400 block text-xs">إجمالي الكمية المستلمة (بسكول):</span>
                                    <strong className="text-base font-black text-emerald-300">{totalRec} طن</strong>
                                  </div>
                                  <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-1">
                                    <span className="text-slate-400 block text-xs">سعر طن الفاتورة الموحد:</span>
                                    <strong className="text-base font-black text-amber-300">{unitPrice.toLocaleString('en-US')} ج.م</strong>
                                  </div>
                                  <div className="rounded-xl border border-cyan-500/50 bg-cyan-950/40 p-3.5 space-y-1">
                                    <span className="text-cyan-400 block text-xs">إجمالي القيمة المالية المستلمة:</span>
                                    <strong className="text-base font-black text-cyan-300">{totalVal.toLocaleString('en-US')} ج.م</strong>
                                  </div>
                                </div>
                              </div>
                            );
                          })()
                        ) : (
                          <>
                            <h4 className="text-xs sm:text-sm font-black text-emerald-300 flex items-center gap-2">
                              <span>{receipt.receipt_type === 'REQUESTER_OFFICE' ? '🏢' : '🏗️'}</span>
                              <span>
                                {receipt.receipt_type === 'REQUESTER_OFFICE'
                                  ? `بنود المستلزمات المكتبية المطلوب استلامها وفحصها (${receipt.items?.length || 0} صنف):`
                                  : `بنود الاستلام المطلوب فحصها هندسياً (${receipt.items?.length || 0} بنود):`}
                              </span>
                            </h4>

                        <SiteReceiptItemsTable
                          receipt={receipt}
                          quantities={quantities}
                          onQuantityChange={(key, val) =>
                            setQuantities((prev) => ({ ...prev, [key]: val }))
                          }
                          itemNotes={itemNotes}
                          onItemNoteChange={(key, val) =>
                            setItemNotes((prev) => ({ ...prev, [key]: val }))
                          }
                          isReviewer={isReviewer}
                        />
                      </>
                    )}

                        {/* General Site Notes */}
                        <div className="space-y-1.5 pt-2">
                          <label className="text-xs sm:text-sm font-bold text-slate-300">
                            {receipt.receipt_type === 'REQUESTER_OFFICE'
                              ? 'ملاحظات المستلم الفعلي (اختياري):'
                              : isReviewer
                              ? 'ملاحظات واعتماد المراجع الفني / رئيس القسم (اختياري):'
                              : 'ملاحظات واعتماد مهندس الموقع (اختياري):'}
                          </label>
                          <textarea
                            rows={2}
                            value={notes[receipt.id] || ''}
                            onChange={(e) => setNotes({ ...notes, [receipt.id]: e.target.value })}
                            placeholder={
                              receipt.receipt_type === 'REQUESTER_OFFICE'
                                ? 'ملاحظاتك على استلام وفحص المستلزمات المكتبية...'
                                : isReviewer
                                ? 'ملاحظات المراجع الفني على استلام وفحص ومطابقة المواد...'
                                : 'ملاحظات مهندس الموقع على استلام وفحص المواد بالموقع...'
                            }
                            className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-xs sm:text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
                          />
                        </div>

                        {/* Big Submit Button */}
                        <div className="pt-3 border-t border-slate-800 flex flex-col sm:flex-row items-center gap-3">
                          <Button
                            variant="success"
                            size="lg"
                            isLoading={isSavingThis}
                            onClick={() => approveReceipt(receipt)}
                            className="flex-1 w-full font-black text-base sm:text-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3.5 rounded-2xl shadow-xl shadow-emerald-950/60 flex items-center justify-center gap-2 cursor-pointer"
                          >
                            <span>✓</span>{' '}
                            {receipt.receipt_type === 'REQUESTER_OFFICE'
                              ? 'اعتماد استلام المستلزمات المكتبية وإرساله للمشتريات لإصدار أمر الشراء الفعلي'
                              : isReviewer
                              ? 'اعتماد ومطابقة إذن الاستلام وإرساله للمشتريات لإصدار أمر الشراء الفعلي'
                              : 'اعتماد مطابق للموقع وإرسال للمشتريات لإصدار أمر الشراء الفعلي'}
                          </Button>
                          <Button
                            variant="secondary"
                            size="lg"
                            isLoading={isSavingThis}
                            onClick={() => handleCancelReceipt(receipt)}
                            className="w-full sm:w-auto font-bold text-xs sm:text-sm border border-red-500/50 hover:bg-red-950/50 text-red-300 py-3.5 px-5 rounded-2xl flex items-center justify-center gap-1.5 cursor-pointer"
                            title="إلغاء هذا الإذن المعلق وإعادة أمر الشراء للمخزن لإعادة استلامه كوزنة مجمعة"
                          >
                            <span>↩️</span>
                            <span>إلغاء وإعادة للمخزن</span>
                          </Button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <div className="p-12 text-center text-slate-400 space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60">
                <span className="text-4xl block">🏗️</span>
                <p className="text-base font-bold text-slate-200">لا توجد أذونات استلام بانتظار الاعتماد الميداني</p>
                <p className="text-xs text-slate-500">
                  تظهر هنا أذونات الاستلام المسجلة من أمين المخزن لاعتمادها هندسياً قبل إرسالها للمشتريات لإصدار أمر الشراء الفعلي.
                </p>
              </div>
            )
          )}
        </>
      )}

      {/* ── TAB 2: MATERIALS RECEIPT ARCHIVE (أرشيف استلام المواد) ── */}
      {activeTab === 'ARCHIVE' && (
        <div className="space-y-4 animate-fade-in">
          {visibleArchive.length > 0 ? (
            visibleArchive.map((receipt) => {
              const isExpanded = expandedArchiveId === receipt.id;
              const isApproved = receipt.status === 'APPROVED';
              const isPendingSite = receipt.status === 'PENDING_SITE_ENGINEER';

              const isTargeted = Boolean(targetReceiptId && String(receipt.id) === String(targetReceiptId));

              return (
                <Card
                  id={`receipt-card-${receipt.id}`}
                  key={`archive-${receipt.id}`}
                  className={`p-4 sm:p-6 space-y-4 border rounded-2xl transition-all ${
                    isTargeted
                      ? 'border-cyan-400 ring-4 ring-cyan-500/30 bg-slate-900 shadow-cyan-950/60'
                      : isApproved
                      ? 'border-emerald-800/70 bg-slate-900/90'
                      : 'border-slate-800 bg-slate-900/80'
                  }`}
                >
                  {/* Top Summary Bar */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-mono text-sm sm:text-base font-black text-cyan-300 bg-cyan-950 border border-cyan-800/80 px-3 py-1 rounded-xl">
                        {receipt.receipt_number}
                      </span>
                      {receipt.purchase_order && (
                        <span className="text-xs sm:text-sm font-bold text-slate-300">
                          أمر شراء: <span className="font-mono text-cyan-400">{receipt.purchase_order.po_number}</span>
                        </span>
                      )}
                      {(receipt.items?.some((i) => i.purchase_order_item?.is_supplementary) || receipt.purchase_order?.items?.some((i) => i.is_supplementary)) && (
                        <span className="text-xs font-black px-2.5 py-0.5 rounded-full border bg-amber-950/80 text-amber-300 border-amber-600/70 shadow-sm flex items-center gap-1">
                          <span>⚡</span>
                          <span>ملحق كمالة</span>
                        </span>
                      )}
                      <span className="text-xs sm:text-sm text-slate-300 flex items-center gap-1.5 flex-wrap">
                        <span>
                          {receipt.is_internal_warehouse || receipt.supplier?.company_name === 'المخزن الداخلي' || receipt.purchase_order?.supplier?.company_name === 'المخزن الداخلي' ? '🏛️' : '🏢'}
                        </span>
                        <span>
                          {receipt.supplier?.company_name || receipt.supplier_name || receipt.purchase_order?.supplier?.company_name || (receipt.is_internal_warehouse ? 'المخزن الداخلي' : 'مورد غير محدد')}
                        </span>
                        {(receipt.is_internal_warehouse || receipt.supplier?.company_name === 'المخزن الداخلي' || receipt.purchase_order?.supplier?.company_name === 'المخزن الداخلي') && (
                          <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-purple-950 text-purple-300 border border-purple-700/60 shadow-sm">
                            بضاعة مخزن داخلي (سعر 0)
                          </span>
                        )}
                      </span>
                      {receipt.receipt_type === 'SITE_DIRECT' && (
                        <span className="text-xs font-black px-2.5 py-0.5 rounded-full border bg-amber-950/80 text-amber-300 border-amber-600/70 shadow-sm flex items-center gap-1">
                          <span>🏗️</span>
                          <span>توريد مباشر لموقع المباني</span>
                        </span>
                      )}
                      {receipt.weighing_group && (
                        <span className="text-xs font-black px-2.5 py-0.5 rounded-full border bg-indigo-950/80 text-indigo-300 border-indigo-600/70 shadow-sm flex items-center gap-1">
                          <span>⚖️</span>
                          <span>وزنة حديد {receipt.weighing_group.group_number}</span>
                        </span>
                      )}
                      <span
                        className={`text-xs font-bold px-3 py-1 rounded-full border ${
                          isApproved
                            ? 'bg-emerald-950 text-emerald-300 border-emerald-800/60'
                            : isPendingSite
                            ? 'bg-amber-950 text-amber-300 border-amber-800/60'
                            : 'bg-slate-800 text-slate-300 border-slate-700'
                        }`}
                      >
                        {isApproved ? '✓ معتمد ومطابق (جاهز للحسابات)' : isPendingSite ? '⏳ بانتظار اعتماد مهندس الموقع' : receipt.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setExpandedArchiveId(isExpanded ? null : receipt.id)}
                        className="text-xs sm:text-sm font-bold rounded-xl"
                      >
                        {isExpanded ? 'إخفاء التفاصيل' : 'عرض التفاصيل والبنود ←'}
                      </Button>
                    </div>
                  </div>

                  {/* Parcel Reference & Region Badges */}
                  {(() => {
                    const archiveParcel =
                      receipt.purchase_order?.purchase_request?.parcel_reference ||
                      receipt.purchase_request?.parcel_reference ||
                      receipt.items?.find((i) => i.purchase_order_item?.item_reference || i.purchase_order_item?.pr_item?.item_reference)?.purchase_order_item?.item_reference ||
                      receipt.items?.find((i) => i.purchase_order_item?.item_reference || i.purchase_order_item?.pr_item?.item_reference)?.purchase_order_item?.pr_item?.item_reference ||
                      null;

                    const archiveRegion =
                      receipt.purchase_order?.purchase_request?.region ||
                      receipt.purchase_request?.region ||
                      receipt.items?.find((i) => i.purchase_order_item?.region || i.purchase_order_item?.pr_item?.region)?.purchase_order_item?.region ||
                      receipt.items?.find((i) => i.purchase_order_item?.region || i.purchase_order_item?.pr_item?.region)?.purchase_order_item?.pr_item?.region ||
                      null;

                    return (archiveParcel || archiveRegion) ? (
                      <div className="flex items-center gap-2 flex-wrap text-xs pt-1">
                        {archiveParcel && (
                          <span className="inline-flex items-center gap-1.5 font-mono text-cyan-200 bg-cyan-950/80 border border-cyan-800/60 px-3 py-1 rounded-xl font-bold">
                            <span>🏷️</span> قطعة الأرض: {archiveParcel}
                          </span>
                        )}
                        {archiveRegion && (
                          <span className="inline-flex items-center gap-1.5 text-amber-200 bg-amber-950/80 border border-amber-800/60 px-3 py-1 rounded-xl font-bold">
                            <span>📍</span> المنطقة: {archiveRegion}
                          </span>
                        )}
                      </div>
                    ) : null;
                  })()}

                  {/* Audit Trail & Sign-offs Banner */}
                  {(() => {
                    const passedWarehouse = Boolean(receipt.warehouse_keeper || receipt.warehouse_received_at || (receipt.warehouse_keeper_user_id && receipt.receipt_type !== 'SITE_DIRECT'));
                    const actualReceiverName = receipt.site_engineer?.name || receipt.actual_receiver_name || receipt.receiver?.name || receipt.purchase_order?.purchase_request?.site_engineer?.name || 'مهندس الموقع';
                    return (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs sm:text-sm">
                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 space-y-1.5">
                          <div className="flex items-center justify-between text-slate-400 font-bold">
                            <span>📦 أمين المخزن:</span>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black border ${passedWarehouse ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : 'bg-amber-950 text-amber-300 border-amber-800'}`}>
                              {passedWarehouse ? '✅ مر على المخزن' : '⚡ لم يمر على المخزن'}
                            </span>
                          </div>
                          <p className="text-slate-100 font-bold text-sm sm:text-base flex items-center gap-1.5">
                            {passedWarehouse ? (
                              <span>{receipt.warehouse_keeper?.name ? `تم الاستلام والتفريغ بواسطة: ${receipt.warehouse_keeper.name}` : 'تم الاستلام والتفريغ بالمخزن (عم سلامة)'}</span>
                            ) : (
                              <span className="text-amber-300">توريد مباشر للموقع (لم يمر على عم سلامة)</span>
                            )}
                          </p>
                          {receipt.warehouse_notes && (
                            <p className="text-amber-300 text-xs sm:text-sm bg-amber-950/30 p-2.5 rounded-lg border border-amber-900/40 mt-1">
                              «{receipt.warehouse_notes}»
                            </p>
                          )}
                        </div>

                        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 space-y-1.5">
                          <div className="flex items-center justify-between text-slate-400 font-bold">
                            <span>👷 مهندس الموقع / الاستلام:</span>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black border ${isApproved ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : 'bg-amber-950 text-amber-300 border-amber-800'}`}>
                              {isApproved ? '✓ استلم فعلياً' : '⏳ قيد الاستلام والمطابقة'}
                            </span>
                          </div>
                          <p className="text-slate-100 font-bold text-sm sm:text-base">
                            {actualReceiverName}
                          </p>
                          {receipt.site_engineer_notes && (
                            <p className="text-emerald-300 text-xs sm:text-sm bg-emerald-950/30 p-2.5 rounded-lg border border-emerald-900/40 mt-1">
                              «{receipt.site_engineer_notes}»
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Photo in Archive View */}
                  {Boolean(receipt.photo_url || receipt.photo_path) && (
                    <div className="rounded-xl border border-cyan-500/40 bg-cyan-950/20 p-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <img
                          src={getReceiptPhotoUrl(receipt)}
                          alt="صورة الاستلام"
                          onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(receipt))}
                          className="h-14 w-14 rounded-lg object-cover border border-cyan-500/60 cursor-pointer shrink-0 hover:scale-105 transition-transform"
                        />
                        <div className="text-xs">
                          <p className="font-bold text-cyan-200">📷 مرفق صورة إذن الاستلام / بون الميزان</p>
                          <p className="text-slate-400 text-[11px]">تم توثيق الصورة وحفظها مع سجل الاستلام.</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPreviewPhotoUrl(getReceiptPhotoUrl(receipt))}
                        className="text-xs font-bold text-cyan-400 hover:underline shrink-0 cursor-pointer"
                      >
                        معاينة الصورة 🔍
                      </button>
                    </div>
                  )}

                  {/* Expanded Items Cards in Archive */}
                  {isExpanded && (
                    <div className="space-y-3 pt-3 border-t border-slate-800 animate-fade-in">
                      {receipt.weighing_group || receipt.receipt_type === 'STEEL_WEIGHING_GROUP' ? (
                        (() => {
                          const wg = receipt.weighing_group;
                          const totalOrd = Number(wg?.total_ordered_weight || receipt.items?.reduce((s, i) => s + Number(i.ordered_quantity || 0), 0) || 0);
                          const totalRec = Number(wg?.total_received_weight || receipt.items?.reduce((s, i) => s + Number(i.received_quantity || 0), 0) || 0);
                          const unitPrice = Number(wg?.unit_price || wg?.items?.[0]?.unit_price || receipt.items?.[0]?.purchase_order_item?.unit_price || 0);
                          const totalVal = Math.round(totalRec * unitPrice * 100) / 100;

                          return (
                            <div className="rounded-2xl border-2 border-indigo-500/80 bg-slate-950/90 p-4 sm:p-5 space-y-3">
                              <div className="flex items-center justify-between flex-wrap gap-2 border-b border-indigo-500/30 pb-2.5">
                                <span className="font-black text-sm text-white flex items-center gap-2">
                                  <span>⚖️</span>
                                  <span>وزنة حديد مجمعة (ميزان بسكول) — {wg?.group_number || 'شحنة موحدة'}</span>
                                </span>
                                <span className="text-xs font-mono font-bold text-indigo-300 bg-indigo-950/80 px-2.5 py-0.5 rounded-lg border border-indigo-700/60">
                                  بند استلام موحد
                                </span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs sm:text-sm">
                                <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800">
                                  <span className="text-slate-400 block text-xs">إجمالي الكمية المطلوبة:</span>
                                  <strong className="text-indigo-300 font-black text-sm">{totalOrd} طن</strong>
                                </div>
                                <div className="bg-emerald-950/40 p-3 rounded-xl border border-emerald-500/40">
                                  <span className="text-emerald-400 block text-xs">إجمالي الكمية المستلمة (بسكول):</span>
                                  <strong className="text-emerald-300 font-black text-sm">{totalRec} طن</strong>
                                </div>
                                <div className="bg-cyan-950/40 p-3 rounded-xl border border-cyan-500/40">
                                  <span className="text-cyan-400 block text-xs">سعر طن الفاتورة والإجمالي:</span>
                                  <strong className="text-cyan-300 font-black text-sm">
                                    {unitPrice.toLocaleString('en-US')} ج.م / طن = {totalVal.toLocaleString('en-US')} ج.م
                                  </strong>
                                </div>
                              </div>
                            </div>
                          );
                        })()
                      ) : (
                        <>
                          <h4 className="text-xs sm:text-sm font-bold text-slate-300">تفاصيل البنود والكميات المسجلة في هذا الإذن:</h4>
                          {isWarehouseKeeper ? (
                            <div className="space-y-2.5">
                              {(receipt.items || []).map((item, idx) => (
                                <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 space-y-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-mono text-cyan-400 font-bold text-xs">#{idx + 1}</span>
                                      <span className="font-black text-sm text-slate-100 flex items-center gap-2 flex-wrap">
                                        <span>{item.purchase_order_item?.item_description || item.purchase_order_item?.item?.name}</span>
                                        <SupplementItemBadge
                                          isSupplementary={item.purchase_order_item?.is_supplementary}
                                          batchNumber={item.purchase_order_item?.supplement_batch}
                                        />
                                        {item.purchase_order_item?.shipment_group && (
                                          <span className="text-[10px] font-bold text-amber-300 bg-amber-950/80 border border-amber-600/50 px-2 py-0.5 rounded flex items-center gap-1 shadow-sm">
                                            <span>🚚</span>
                                            <span>شحنة: {item.purchase_order_item.shipment_group.group_number}</span>
                                          </span>
                                        )}
                                      </span>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 flex-wrap text-xs">
                                    {(item.purchase_order_item?.item_reference || item.purchase_order_item?.pr_item?.item_reference || receipt.purchase_order?.purchase_request?.parcel_reference || receipt.purchase_request?.parcel_reference) && (
                                      <span className="font-mono text-cyan-300 bg-cyan-950/80 border border-cyan-800/60 px-2.5 py-0.5 rounded-lg font-bold">
                                        قطعة الأرض: {item.purchase_order_item?.item_reference || item.purchase_order_item?.pr_item?.item_reference || receipt.purchase_order?.purchase_request?.parcel_reference || receipt.purchase_request?.parcel_reference}
                                      </span>
                                    )}
                                    {(item.purchase_order_item?.region || item.purchase_order_item?.pr_item?.region || receipt.purchase_order?.purchase_request?.region || receipt.purchase_request?.region) && (
                                      <span className="text-amber-300 bg-amber-950/80 border border-amber-800/60 px-2.5 py-0.5 rounded-lg font-bold">
                                        المنطقة: {item.purchase_order_item?.region || item.purchase_order_item?.pr_item?.region || receipt.purchase_order?.purchase_request?.region || receipt.purchase_request?.region}
                                      </span>
                                    )}
                                  </div>

                                  {(() => {
                                    const poItem = item.purchase_order_item;
                                    const prItem = poItem?.pr_item;
                                    const poQty = Number(poItem?.quantity || 0);
                                    const prQty = Number(prItem?.quantity || 0);
                                    const isDiffUom = Boolean(prItem?.uom && poItem?.uom && prItem.uom !== poItem.uom && poQty > 0 && prQty > 0);
                                    const displayReceivedQty = isDiffUom
                                      ? (Number(item.received_quantity) > poQty * 2 ? Number(item.received_quantity) : Math.round(Number(item.received_quantity) * (prQty / poQty)))
                                      : item.received_quantity;
                                    const displayUom = prItem?.uom || poItem?.uom || '';

                                    return (
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                                        <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800 flex items-center justify-between text-xs sm:text-sm">
                                          <span className="text-slate-400 font-bold flex items-center gap-1.5">
                                            <span>📋</span> الكمية المطلوبة بأمر الشراء:
                                          </span>
                                          <span className="font-mono font-black text-cyan-300 text-sm sm:text-base">
                                            {item.ordered_quantity ?? poItem?.quantity ?? '—'} {getUnitLabel(poItem?.uom || '')}
                                            {isDiffUom && prItem?.quantity && (
                                              <span className="block text-[11px] font-normal text-slate-400">
                                                ({prItem.quantity} {getUnitLabel(displayUom)})
                                              </span>
                                            )}
                                          </span>
                                        </div>
                                        <div className="bg-emerald-950/40 p-3 rounded-xl border border-emerald-800/60 flex items-center justify-between text-xs sm:text-sm">
                                          <span className="text-emerald-300 font-bold flex items-center gap-1.5">
                                            <span>✓</span> الكمية الفعلية المستلمة:
                                          </span>
                                          <span className="font-mono font-black text-emerald-200 text-sm sm:text-base">
                                            {displayReceivedQty} {getUnitLabel(displayUom)}
                                            {isDiffUom && (
                                              <span className="block text-[11px] font-normal text-slate-400">
                                                (ما يعادل {item.received_quantity} {getUnitLabel(poItem?.uom || '')})
                                              </span>
                                            )}
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })()}
                                  {item.notes && (
                                    <p className="text-xs text-slate-400 bg-slate-900/60 p-2 rounded-lg">
                                      ملاحظات: {item.notes}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <SiteReceiptItemsTable
                              receipt={receipt}
                              readOnly={true}
                            />
                          )}
                        </>
                      )}
                </div>
              )}
                </Card>
              );
            })
          ) : (
            <div className="p-12 text-center text-slate-400 space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60">
              <span className="text-4xl block">🗄️</span>
              <p className="text-base font-bold text-slate-200">لا توجد سجلات في أرشيف الاستلام حتى الآن</p>
              <p className="text-xs text-slate-500">
                يتم أرشفة وحفظ كل إذن استلام فور تسجيله من أمين المخزن واعتماده من مهندس الموقع لتوثيق دورة الاستلام بالكامل.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Full-Screen Image Preview Modal */}
      {previewPhotoUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm animate-fade-in"
          onClick={() => setPreviewPhotoUrl(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] w-full bg-slate-950 rounded-2xl border border-slate-700 p-2 overflow-hidden shadow-2xl flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full flex items-center justify-between p-3 border-b border-slate-800 text-slate-100">
              <span className="font-black text-sm flex items-center gap-2">
                <span>📷</span> معاينة صورة بون الميزان / استلام المخزن
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
                alt="معاينة كاملة لصورة إذن الاستلام الميداني أو بون الميزان"
                className="max-h-[70vh] max-w-full object-contain rounded-lg shadow-inner"
              />
            </div>
            <div className="p-3 w-full border-t border-slate-800 text-center">
              <a
                href={previewPhotoUrl}
                target="_blank"
                rel="noreferrer"
                download="receipt-photo.jpg"
                className="text-xs font-bold text-cyan-400 hover:underline inline-flex items-center gap-1.5"
              >
                <span>📥</span> فتح في نافذة مستقلة / تحميل الصورة
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PurchaseReceiptPage;
