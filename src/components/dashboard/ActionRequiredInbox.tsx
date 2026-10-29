import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import QuickPeekDrawer, { PeekType } from '../ui/QuickPeekDrawer';
import { getSiteEngineerReceiverOptionsApi } from '../../api/purchaseRequests';
import { ReceiptRecord } from '../../api/purchaseReceipts';
import { QuickReceiptInspectionModal } from '../receipts/QuickReceiptInspectionModal';
import { FinalizeActualPoModal } from '../procurement/FinalizeActualPoModal';
import { getUnreadNotificationCountApi } from '../../api/notifications';
import { useAuth } from '../../context/AuthContext';
import { getUnitLabel } from '../../utils/units';
import { toast } from '../../utils/toast';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { formatRebarDisplay } from '../../utils/rebar';
import { formatDateTime24h } from '../../utils/dateTime';
import { PurchaseRequestType } from '../../types/purchaseRequest';
import { cachedGetData } from '../../api/client';

export interface ActionInboxItemDetail {
  description: string;
  quantity: number | string;
  uom?: string | null;
  parcel?: string | null;
  region?: string | null;
  unit_price?: number | string | null;
  line_total?: number | string | null;
  specifications?: string | null;
}

export interface ActionInboxItem {
  id: string | number;
  rawId: number;
  type: 'PR' | 'PO' | 'QUOTE' | 'INVOICE' | 'RECEIPT' | 'SUPPLEMENT' | 'OFFICE_RECEIPT' | 'ACCOUNTING_RECEIPT' | 'ACCOUNTING_INVOICE' | 'MATERIAL_TRANSFER';
  code: string;
  title: string;
  subtitle?: string;
  department?: string;
  target_department?: string;
  requester?: string;
  supplier?: string;
  amount?: number | string;
  urgency?: 'CRITICAL' | 'HIGH' | 'NORMAL';
  reason: string;
  actionUrl: string;
  actionLabel: string;
  timeAgo?: string;
  created_at?: string | null;
  
  // --- ID Disambiguation Fields ---
  receipt_id?: number | string;
  purchase_receipt_id?: number | string;
  rawReceipt?: ReceiptRecord;
  po_id?: number | string;
  purchase_order_id?: number | string;
  pr_id?: number | string;
  purchase_request_id?: number | string;

  // --- Rich Details Fields ---
  request_type?: PurchaseRequestType;
  date_needed?: string;
  priority?: 'NORMAL' | 'HIGH' | 'URGENT' | 'LOW' | string;
  parcel_number?: string;
  region?: string;
  items_summary?: string;
  items_count?: number;
  items_list?: ActionInboxItemDetail[];
  requires_warehouse_receipt?: boolean;
  next_actor?: string;
  purpose?: string | null;
  notes?: string | null;

  // --- Direct Action Callbacks ---
  onDirectApprove?: (
    item: ActionInboxItem,
    comment?: string,
    siteEngineerUserId?: number | null,
    requiresWarehouseReceipt?: boolean
  ) => Promise<void> | void;
  onDirectReject?: (item: ActionInboxItem, reason: string) => Promise<void> | void;
  onDirectSubmit?: (item: ActionInboxItem) => Promise<void> | void;
  onAction?: (item: ActionInboxItem) => void | Promise<void>;
  onPreviewReceipt?: (item: ActionInboxItem) => void;
  directApproveLabel?: string;
  directApproveClassName?: string;
  directApproveIcon?: React.ReactNode;
  directRejectLabel?: string;
  directRejectClassName?: string;
  requireApproveModal?: boolean;
  /** Optional document-status row (e.g. «إذن الاستلام» / «الفاتورة») rendered above the card actions. */
  documentSlot?: React.ReactNode;
  stageBadge?: {
    text: string;
    icon?: string;
    className?: string;
  };
}

/**
 * Safely resolves the actual Material Receipt ID.
 * Guarantees that only the genuine receipt primary key is extracted,
 * and strictly prevents leaking purchase order (po_id) or request (pr_id) IDs.
 */
export const resolveReceiptId = (item: ActionInboxItem): number | string | null => {
  if (item.receipt_id != null && item.receipt_id !== '') {
    return item.receipt_id;
  }
  if (item.purchase_receipt_id != null && item.purchase_receipt_id !== '') {
    return item.purchase_receipt_id;
  }
  if (item.type === 'RECEIPT' && item.rawId != null && Number(item.rawId) > 0) {
    return item.rawId;
  }
  if (typeof item.id === 'string') {
    const idMatch = item.id.match(/^receipt-(?:[a-zA-Z]+-)?(\d+)$/);
    if (idMatch) {
      return idMatch[1];
    }
  }
  if (item.actionUrl) {
    const queryMatch = item.actionUrl.match(/[?&](?:receipt_id|purchase_receipt_id)=(\d+)/);
    if (queryMatch) {
      return queryMatch[1];
    }
    const pathInspectMatch = item.actionUrl.match(/\/receipts\/(\d+)(?:\/inspect)?/);
    if (pathInspectMatch) {
      return pathInspectMatch[1];
    }
  }
  return null;
};

/**
 * Resolves the destination URL for an action item.
 * For Receipt inspection items, ensures the target URL points to the dedicated
 * inspection route (/receipts/{receipt_id}/inspect) using the actual receipt_id.
 */
export const resolveActionItemUrl = (item: ActionInboxItem): string => {
  if (item.type === 'OFFICE_RECEIPT') {
    const rawUrl = item.actionUrl || `/requests/${item.purchase_request_id || item.rawId}?confirm_office_po=${item.purchase_order_id || item.rawId}`;
    return rawUrl.replace('/employee/requests/', '/requests/');
  }

  const isReceipt =
    item.type === 'RECEIPT' ||
    item.actionLabel?.includes('إذن الاستلام') ||
    item.actionLabel?.includes('فحص واعتماد') ||
    (typeof item.id === 'string' && item.id.startsWith('receipt-'));

  if (isReceipt) {
    const receiptId = resolveReceiptId(item);
    if (receiptId) {
      // If actionUrl was poisoned with po_id or pr_id, or is missing / empty:
      const hasPoOrPrIdCorruption =
        !item.actionUrl ||
        item.actionUrl.includes('po_id=') ||
        item.actionUrl.includes('purchase_order_id=') ||
        item.actionUrl.includes('pr_id=') ||
        item.actionUrl.includes('/purchase-orders/');

      if (hasPoOrPrIdCorruption) {
        return `/receipts/${receiptId}/inspect`;
      }

      // If actionUrl already specifies the valid receipt inspection route or query with the real receiptId:
      if (
        item.actionUrl.includes(`/receipts/${receiptId}/inspect`) ||
        item.actionUrl.includes(`receipt_id=${receiptId}`)
      ) {
        return item.actionUrl;
      }

      // Default canonical inspection route
      return `/receipts/${receiptId}/inspect`;
    }
  }

  return item.actionUrl;
};

export interface ActionRequiredInboxProps {
  title?: string;
  description?: string;
  items: ActionInboxItem[];
  loading?: boolean;
  roleName?: string;
  onItemActionComplete?: () => void;
}

class CardErrorBoundary extends React.Component<
  { children: React.ReactNode; fallbackCode?: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallbackCode?: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error rendering ActionInbox card:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="rounded-2xl border border-rose-900/50 bg-slate-950/80 p-4 text-xs text-rose-300 flex flex-col items-center justify-center gap-1 min-h-[140px]"
          dir="rtl"
        >
          <span>⚠️ تعذر عرض تفاصيل هذه المهمة</span>
          {this.props.fallbackCode && (
            <span className="font-mono text-[11px] text-slate-400">{this.props.fallbackCode}</span>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export const ActionRequiredInbox: React.FC<ActionRequiredInboxProps> = ({
  title = 'المهام والإجراءات المطلوبة منك الآن',
  description = 'جميع المعاملات والطلبات التي تتطلب تدخلك أو قرارك الفوري.',
  items = [],
  loading = false,
  roleName,
  onItemActionComplete,
}) => {
  const navigate = useNavigate();
  const { user, hasRole } = useAuth();
  const isReviewer = Boolean(
    hasRole('reviewer') ||
    roleName?.includes('قسم') ||
    roleName?.includes('مراجع')
  );
  const isGeneralManager = Boolean(
    hasRole('general_manager') ||
    hasRole('execution_manager') ||
    roleName?.includes('تنفيذ') ||
    roleName?.includes('مدير عام') ||
    roleName?.includes('general_manager')
  );

  const safeItems = Array.isArray(items) ? items : [];

  // Track optimistically dismissed items after fast modal action
  const [dismissedItemIds, setDismissedItemIds] = useState<Set<string | number>>(new Set());

  // Purchase Purpose Inspection Modal State (Mobile friendly)
  const [purposeModal, setPurposeModal] = useState<{
    isOpen: boolean;
    item: ActionInboxItem | null;
    loading: boolean;
    fullPurpose: string | null;
  }>({
    isOpen: false,
    item: null,
    loading: false,
    fullPurpose: null,
  });

  const handleOpenPurposeModal = async (item: ActionInboxItem) => {
    const prId = Number(item.rawId || item.pr_id || item.purchase_request_id || 0);
    const initialText = (item.purpose || item.notes || '').trim();

    if (initialText) {
      setPurposeModal({
        isOpen: true,
        item,
        loading: false,
        fullPurpose: initialText,
      });
      return;
    }

    setPurposeModal({
      isOpen: true,
      item,
      loading: true,
      fullPurpose: null,
    });

    try {
      if (prId > 0) {
        const res = await cachedGetData<{ data: any }>(`/purchase-requests/${prId}`);
        const pr = res?.data || res;
        const fetchedPurpose = (pr?.notes || pr?.purpose || pr?.justification || '').trim() || null;
        setPurposeModal({
          isOpen: true,
          item,
          loading: false,
          fullPurpose: fetchedPurpose,
        });
        item.purpose = fetchedPurpose;
        item.notes = fetchedPurpose;
      } else {
        setPurposeModal({
          isOpen: true,
          item,
          loading: false,
          fullPurpose: null,
        });
      }
    } catch (err) {
      console.error('Failed to fetch original purchase purpose:', err);
      setPurposeModal({
        isOpen: true,
        item,
        loading: false,
        fullPurpose: null,
      });
    }
  };

  // Lock body scroll and handle Escape key when Purpose Modal is open
  useEffect(() => {
    if (!purposeModal.isOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPurposeModal({ isOpen: false, item: null, loading: false, fullPurpose: null });
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [purposeModal.isOpen]);

  // Quick Receipt Inspection Modal State
  const [receiptInspectionModal, setReceiptInspectionModal] = useState<{
    isOpen: boolean;
    item: ActionInboxItem | null;
  }>({
    isOpen: false,
    item: null,
  });

  const isReceiptItem = (item: ActionInboxItem): boolean => {
    return (
      item.type === 'RECEIPT' ||
      Boolean(resolveReceiptId(item)) ||
      Boolean(item.actionLabel?.includes('إذن الاستلام')) ||
      Boolean(item.actionLabel?.includes('فحص واعتماد')) ||
      (typeof item.id === 'string' && item.id.startsWith('receipt-'))
    );
  };

  const isReceiptInspectionItem = (item: ActionInboxItem): boolean => {
    if (item.onPreviewReceipt) return false;
    if (item.directApproveLabel?.includes('تم التسجيل')) return false;
    if (item.requireApproveModal === false) return false;
    return isReceiptItem(item);
  };

  // Finalize Actual PO Modal State
  const [actualPoModal, setActualPoModal] = useState<{
    isOpen: boolean;
    poId: number | null;
    item: ActionInboxItem | null;
  }>({
    isOpen: false,
    poId: null,
    item: null,
  });

  const isActualPoItem = (item: ActionInboxItem): boolean => {
    return (
      item.type === 'PO' &&
      (String(item.id).startsWith('po-actual-') ||
        Boolean(item.actionLabel?.includes('أمر الشراء الفعلي')) ||
        Boolean(item.title?.includes('أمر الشراء الفعلي')))
    );
  };

  const visibleItems = React.useMemo(() => {
    return safeItems.filter((item) => {
      if (!item) return false;
      if (dismissedItemIds.has(item.id)) return false;
      if (item.rawId != null && dismissedItemIds.has(item.rawId)) return false;
      const rcptId = resolveReceiptId(item);
      if (
        rcptId != null &&
        (dismissedItemIds.has(rcptId) ||
          dismissedItemIds.has(Number(rcptId)) ||
          dismissedItemIds.has(String(rcptId)))
      ) {
        return false;
      }
      return true;
    });
  }, [safeItems, dismissedItemIds]);

  // Sort visible items newest to oldest (الأحدث للأقدم)
  const sortedItems = React.useMemo(() => {
    return [...visibleItems].sort((a, b) => {
      if (!a || !b) return 0;
      const rawDateA = a.created_at || (a.timeAgo && /^\d{4}-\d{2}-\d{2}/.test(a.timeAgo) ? a.timeAgo : null);
      const rawDateB = b.created_at || (b.timeAgo && /^\d{4}-\d{2}-\d{2}/.test(b.timeAgo) ? b.timeAgo : null);

      if (rawDateA && rawDateB) {
        const timeA = new Date(rawDateA).getTime();
        const timeB = new Date(rawDateB).getTime();
        if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
          return timeB - timeA; // Newest first
        }
      } else if (rawDateB && !rawDateA) {
        return 1;
      } else if (rawDateA && !rawDateB) {
        return -1;
      }

      return (Number(b.rawId) || 0) - (Number(a.rawId) || 0);
    });
  }, [visibleItems]);

  // Drawer Peek State
  const [peekState, setPeekState] = useState<{ isOpen: boolean; type: PeekType; id: number | null }>({
    isOpen: false,
    type: 'PR',
    id: null,
  });

  // Direct Action Modals State
  const [approveModal, setApproveModal] = useState<{
    isOpen: boolean;
    item: ActionInboxItem | null;
    comment: string;
    isSubmitting: boolean;
  }>({
    isOpen: false,
    item: null,
    comment: '',
    isSubmitting: false,
  });

  const [receiverOptions, setReceiverOptions] = useState<{
    siteEngineers: Array<{ id: number; name: string; department_name?: string }>;
    otherUsers: Array<{ id: number; name: string; role_name?: string; department_name?: string }>;
  }>({ siteEngineers: [], otherUsers: [] });
  const [selectedEngineerId, setSelectedEngineerId] = useState<number | string>('');
  const [receiverError, setReceiverError] = useState<string | null>(null);
  const [isLoadingReceivers, setIsLoadingReceivers] = useState(false);

  useEffect(() => {
    if (approveModal.isOpen && approveModal.item?.type === 'PR' && isReviewer) {
      setIsLoadingReceivers(true);
      setReceiverError(null);
      setSelectedEngineerId('');
      getSiteEngineerReceiverOptionsApi()
        .then((res) => {
          setReceiverOptions({
            siteEngineers: res.site_engineers || [],
            otherUsers: res.other_users || [],
          });
        })
        .catch(() => {})
        .finally(() => setIsLoadingReceivers(false));
    } else if (!approveModal.isOpen) {
      setSelectedEngineerId('');
      setReceiverError(null);
    }
  }, [approveModal.isOpen, approveModal.item, isReviewer]);

  const [requiresWarehouseReceipt, setRequiresWarehouseReceipt] = useState<boolean>(true);

  const [rejectModal, setRejectModal] = useState<{
    isOpen: boolean;
    item: ActionInboxItem | null;
    reason: string;
    isSubmitting: boolean;
    error?: string;
  }>({
    isOpen: false,
    item: null,
    reason: '',
    isSubmitting: false,
  });

  const [directApprovingId, setDirectApprovingId] = useState<string | number | null>(null);
  const [directSubmittingId, setDirectSubmittingId] = useState<string | number | null>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => {
      setToastMessage((cur) => (cur?.text === text ? null : cur));
    }, 4000);
  };

  const handleApproveClick = (item: ActionInboxItem) => {
    // If it's a direct recording action (e.g. "تم التسجيل" by accountant) or explicitly does not require modal:
    if (
      item.onDirectApprove &&
      (item.directApproveLabel?.includes('تم التسجيل') ||
        item.requireApproveModal === false ||
        Boolean(item.onPreviewReceipt))
    ) {
      handleDirectApprove(item);
      return;
    }

    if (isReceiptInspectionItem(item)) {
      setReceiptInspectionModal({ isOpen: true, item });
      return;
    }
    const needsModal = item.requireApproveModal ?? (isReviewer && item.type === 'PR');
    if (needsModal) {
      setSelectedEngineerId('');
      setRequiresWarehouseReceipt(item.requires_warehouse_receipt ?? true);
      setReceiverError(null);
      setApproveModal({ isOpen: true, item, comment: '', isSubmitting: false });
    } else {
      handleDirectApprove(item);
    }
  };

  const handleDirectApprove = async (item: ActionInboxItem) => {
    if (!item.onDirectApprove || directApprovingId === item.id) return;
    setDirectApprovingId(item.id);
    try {
      await item.onDirectApprove(item);
      setDismissedItemIds((prev) => {
        const next = new Set(prev);
        if (item.id != null) next.add(item.id);
        if (item.rawId != null) next.add(item.rawId);
        const rcptId = resolveReceiptId(item);
        if (rcptId != null) {
          next.add(rcptId);
          next.add(Number(rcptId));
          next.add(String(rcptId));
        }
        return next;
      });
      const isRecorded = item.directApproveLabel?.includes('تم التسجيل');
      const msg = isRecorded ? 'تم التسجيل بنجاح ✅' : `تم اعتماد ${item.code} بنجاح ✅`;
      toast.success(msg);
      showToast(msg, 'success');
      onItemActionComplete?.();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'حدث خطأ أثناء اعتماد الطلب';
      toast.error(msg);
      showToast(msg, 'error');
    } finally {
      setDirectApprovingId(null);
    }
  };

  const handleOpenPeek = (item: ActionInboxItem) => {
    if (item.type === 'PR' || item.type === 'PO') {
      setPeekState({
        isOpen: true,
        type: item.type,
        id: item.rawId,
      });
    } else {
      navigate(item.actionUrl);
    }
  };

  const handleConfirmDirectApprove = async () => {
    if (!approveModal.item?.onDirectApprove || approveModal.isSubmitting) return;
    if (approveModal.item.type === 'PR' && isReviewer && !selectedEngineerId) {
      setReceiverError('يرجى اختيار مهندس الموقع / مسؤول الاستلام أولاً قبل تأكيد الاعتماد.');
      return;
    }
    setReceiverError(null);
    setApproveModal((prev) => ({ ...prev, isSubmitting: true }));
    try {
      await approveModal.item.onDirectApprove(
        approveModal.item,
        approveModal.comment,
        isReviewer && selectedEngineerId ? Number(selectedEngineerId) : undefined,
        isReviewer ? requiresWarehouseReceipt : undefined
      );
      const isSupplement = Boolean(
        approveModal.item.request_type === 'COMPLEMENTARY' ||
        approveModal.item.type === 'SUPPLEMENT' ||
        approveModal.item.title?.includes('كمالة') ||
        approveModal.item.stageBadge?.text?.includes('كمالة')
      );
      const msg = isSupplement
        ? `تم اعتماد طلب الكمالة ${approveModal.item.code} وتوجيهه مباشرة لمدير المشتريات بنجاح ⚡`
        : `تم اعتماد ${approveModal.item.code} وتحديد مسار الاستلام بنجاح ✅`;
      setDismissedItemIds((prev) => {
        const next = new Set(prev);
        if (approveModal.item?.id != null) next.add(approveModal.item.id);
        if (approveModal.item?.rawId != null) next.add(approveModal.item.rawId);
        return next;
      });
      toast.success(msg);
      showToast(msg, 'success');
      setApproveModal({ isOpen: false, item: null, comment: '', isSubmitting: false });
      onItemActionComplete?.();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'حدث خطأ أثناء اعتماد الطلب';
      toast.error(msg);
      showToast(msg, 'error');
      setApproveModal((prev) => ({ ...prev, isSubmitting: false }));
    }
  };

  const handleConfirmDirectReject = async () => {
    if (!rejectModal.item?.onDirectReject) return;
    if (!rejectModal.reason.trim()) {
      setRejectModal((prev) => ({ ...prev, error: 'يرجى كتابة سبب الرفض أو الإعادة أولاً' }));
      return;
    }
    setRejectModal((prev) => ({ ...prev, isSubmitting: true, error: undefined }));
    try {
      await rejectModal.item.onDirectReject(rejectModal.item, rejectModal.reason.trim());
      setDismissedItemIds((prev) => {
        const next = new Set(prev);
        if (rejectModal.item?.id != null) next.add(rejectModal.item.id);
        if (rejectModal.item?.rawId != null) next.add(rejectModal.item.rawId);
        return next;
      });
      showToast(`تم تسجيل الرفض/الإعادة للمعاملة ${rejectModal.item.code}`, 'success');
      setRejectModal({ isOpen: false, item: null, reason: '', isSubmitting: false });
      onItemActionComplete?.();
    } catch (err: any) {
      setRejectModal((prev) => ({
        ...prev,
        isSubmitting: false,
        error: err?.response?.data?.message || err?.message || 'حدث خطأ أثناء الرفض',
      }));
    }
  };

  const handleDirectSubmit = async (item: ActionInboxItem) => {
    if (!item.onDirectSubmit) return;
    setDirectSubmittingId(item.id);
    try {
      await item.onDirectSubmit(item);
      showToast(`تم إرسال الطلب ${item.code} للمراجعة بنجاح 🚀`, 'success');
      onItemActionComplete?.();
    } catch (err: any) {
      showToast(err?.response?.data?.message || err?.message || 'حدث خطأ أثناء إرسال الطلب', 'error');
    } finally {
      setDirectSubmittingId(null);
    }
  };

  const handleReceiptInspectionSuccess = (receiptId: number, receiptCode?: string) => {
    setDismissedItemIds((prev) => {
      const next = new Set(prev);
      next.add(receiptId);
      next.add(Number(receiptId));
      next.add(String(receiptId));
      if (receiptInspectionModal.item?.id != null) next.add(receiptInspectionModal.item.id);
      if (receiptInspectionModal.item?.rawId != null) next.add(receiptInspectionModal.item.rawId);
      return next;
    });

    onItemActionComplete?.();
    getUnreadNotificationCountApi().catch(() => {});

    const msg = `تم فحص واعتماد إذن الاستلام ${receiptCode || receiptId} بنجاح وإرساله للحسابات ✅`;
    showToast(msg, 'success');
    setReceiptInspectionModal({ isOpen: false, item: null });
  };

  const handleActualPoSuccess = (poNumber?: string) => {
    if (actualPoModal.item) {
      setDismissedItemIds((prev) => {
        const next = new Set(prev);
        if (actualPoModal.item?.id != null) next.add(actualPoModal.item.id);
        if (actualPoModal.item?.rawId != null) next.add(actualPoModal.item.rawId);
        if (actualPoModal.poId != null) {
          next.add(actualPoModal.poId);
          next.add(`po-actual-${actualPoModal.poId}`);
        }
        return next;
      });
      onItemActionComplete?.();
      getUnreadNotificationCountApi().catch(() => {});
    }

    const msg = `تم إصدار أمر الشراء الفعلي ${poNumber ? `(${poNumber}) ` : ''}بنجاح واعتماده وإرساله للإدارة المالية ✅`;
    showToast(msg, 'success');
    setActualPoModal({ isOpen: false, poId: null, item: null });
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-cyan-800/40 bg-slate-900/90 p-5 shadow-xl animate-pulse" dir="rtl">
        <div className="h-6 w-64 bg-slate-800 rounded mb-2"></div>
        <div className="h-4 w-96 bg-slate-800/60 rounded mb-4"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="h-48 bg-slate-800/40 rounded-xl"></div>
          <div className="h-48 bg-slate-800/40 rounded-xl"></div>
          <div className="h-48 bg-slate-800/40 rounded-xl"></div>
        </div>
      </div>
    );
  }

  const hasItems = visibleItems.length > 0;

  return (
    <>
      <div
        className={`rounded-2xl border-2 transition-all p-4 sm:p-5 shadow-xl space-y-4 ${
          hasItems
            ? 'border-cyan-500/60 bg-gradient-to-r from-slate-900 via-slate-900/95 to-cyan-950/25 shadow-cyan-950/40'
            : 'border-slate-800 bg-slate-900/60'
        }`}
        dir="rtl"
      >
        {/* Header Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-3">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-xl font-black shadow-inner ${
                hasItems
                  ? 'bg-cyan-500/20 border border-cyan-400/40 text-cyan-300 animate-pulse'
                  : 'bg-slate-800 text-slate-400 border border-slate-700'
              }`}
            >
              {hasItems ? '⚡' : '✅'}
            </span>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-lg font-black text-slate-100">{title}</h2>
                {hasItems ? (
                  <span className="rounded-full bg-rose-500 text-white px-3 py-0.5 text-xs font-black shadow-md shadow-rose-600/40 animate-bounce">
                    {visibleItems.length} {visibleItems.length === 1 ? 'مهمة تنتظر قرارك' : 'مهام تنتظر قرارك'}
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2.5 py-0.5 text-xs font-bold">
                    لا توجد معلقات حالياً
                  </span>
                )}
                {roleName && (
                  <span className="text-[11px] font-bold text-slate-400 bg-slate-800 px-2 py-0.5 rounded-lg border border-slate-700 hidden sm:inline-block">
                    {roleName}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">{description}</p>
            </div>
          </div>
        </div>

        {/* Action Items List */}
        {hasItems ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-1">
            {sortedItems.map((item) => {
              if (!item) return null;
              const isUrgent = item.urgency === 'CRITICAL' || item.urgency === 'HIGH' || item.priority === 'HIGH' || item.priority === 'URGENT';
              const canPeek = item.type === 'PR' || item.type === 'PO';
              const isOffice = item.request_type === 'OFFICE_SUPPLIES';
              const isSubmitting = directSubmittingId === item.id;

              // Aggregate all unique parcels & regions for this transaction
              const allParcels = [
                item.parcel_number,
                ...(Array.isArray(item.items_list) ? item.items_list : []).map((i) => i?.parcel),
              ].filter(Boolean) as string[];
              const uniqueParcels = Array.from(new Set(allParcels.map((p) => String(p).trim()).filter(Boolean)));
              const parcel = uniqueParcels.length > 0 ? uniqueParcels.join('، ') : '';

              const allRegions = [
                item.region,
                ...(Array.isArray(item.items_list) ? item.items_list : []).map((i) => i?.region),
              ].filter(Boolean) as string[];
              const uniqueRegions = Array.from(new Set(allRegions.map((r) => String(r).trim()).filter(Boolean)));
              const region = isOffice ? 'مقر الشركة' : (uniqueRegions.length > 0 ? uniqueRegions.join('، ') : '');

              // Deduplicate title: If title is identical to first item name, use justification/subtitle or clean category
              const firstItemDesc = item.items_list?.[0]?.description?.trim();
              const isTitleSameAsItem = Boolean(firstItemDesc && item.title?.trim() === firstItemDesc);

              let displayTitle = item.title;
              let displaySubtitle = item.subtitle;

              if (isTitleSameAsItem) {
                if (item.subtitle && item.subtitle.trim() !== firstItemDesc) {
                  displayTitle = item.subtitle;
                  displaySubtitle = undefined;
                } else {
                  displayTitle = isOffice ? 'طلب مستلزمات مكتبية' : 'طلب مواد مشروعات';
                  displaySubtitle = undefined;
                }
              } else if (displaySubtitle && displayTitle && displaySubtitle.trim() === displayTitle.trim()) {
                displaySubtitle = undefined;
              }

              const itemDateDisplay = item.created_at
                ? formatDateTime24h(item.created_at)
                : (item.timeAgo && /^\d{4}-\d{2}-\d{2}/.test(item.timeAgo) ? formatDateTime24h(item.timeAgo) : (item.timeAgo || null));

              return (
                <CardErrorBoundary key={`${item.type || 'TASK'}-${item.id || item.rawId || Math.random()}`} fallbackCode={item.code}>
                  <div
                    onClick={() => {
                      if (item.onPreviewReceipt) {
                        item.onPreviewReceipt(item);
                        return;
                      }
                      if (item.onAction) {
                        item.onAction(item);
                        return;
                      }
                      if (isReceiptInspectionItem(item)) {
                        setReceiptInspectionModal({ isOpen: true, item });
                        return;
                      }
                      const targetUrl = resolveActionItemUrl(item);
                      if (targetUrl) navigate(targetUrl);
                    }}
                  className={`rounded-2xl border p-4 flex flex-col justify-between gap-3.5 transition-all hover:shadow-2xl cursor-pointer ${
                    isUrgent
                      ? 'border-amber-500/70 bg-slate-950/95 shadow-amber-950/20 ring-1 ring-amber-500/30'
                      : 'border-slate-800 bg-slate-950/85 hover:border-cyan-500/60'
                  }`}
                >
                  <div className="space-y-3">
                    {/* Top Row: Code, Location Badge & Date */}
                    <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono text-xs font-black text-cyan-300 bg-cyan-950/90 border border-cyan-700/60 px-2 py-0.5 rounded-lg">
                          {item.code}
                        </span>

                        {item.stageBadge ? (
                          <span
                            className={`text-[11px] font-black px-2.5 py-0.5 rounded-lg border flex items-center gap-1 shadow-xs ${
                              item.stageBadge.className || 'bg-slate-800 text-slate-200 border-slate-700'
                            }`}
                          >
                            {item.stageBadge.icon && <span>{item.stageBadge.icon}</span>}
                            <span>{item.stageBadge.text}</span>
                          </span>
                        ) : item.type === 'RECEIPT' ? (
                          <span className="text-[11px] font-black px-2.5 py-0.5 rounded-lg border flex items-center gap-1 bg-emerald-950/80 text-emerald-300 border-emerald-800/60 shadow-xs">
                            <span>📦</span>
                            <span>إذن استلام مواد</span>
                          </span>
                        ) : item.type === 'SUPPLEMENT' ? (
                          <span className="text-[11px] font-black px-2.5 py-0.5 rounded-lg border flex items-center gap-1 bg-purple-950/80 text-purple-300 border-purple-800/60 shadow-xs">
                            <span>➕</span>
                            <span>كمالة عاجلة</span>
                          </span>
                        ) : item.type === 'QUOTE' ? (
                          <span className="text-[11px] font-black px-2.5 py-0.5 rounded-lg border flex items-center gap-1 bg-amber-950/80 text-amber-300 border-amber-800/60 shadow-xs">
                            <span>⚖️</span>
                            <span>ترشيح أسعار</span>
                          </span>
                        ) : item.type === 'MATERIAL_TRANSFER' ? (
                          <span className="text-[11px] font-black px-2.5 py-0.5 rounded-lg border flex items-center gap-1 bg-teal-950/80 text-teal-300 border-teal-800/60 shadow-xs">
                            <span>🚚</span>
                            <span>طلب نقل خامات</span>
                          </span>
                        ) : null}

                        {item.type === 'MATERIAL_TRANSFER' ? (
                          <span className="text-[11px] font-bold bg-teal-950/70 text-teal-300 border border-teal-700/60 px-2.5 py-1 rounded-xl flex items-center gap-1.5 shadow-sm">
                            <span>🔄</span>
                            <span>مناقلة مواد بين المشروعات</span>
                          </span>
                        ) : isOffice ? (
                          <span className="text-[11px] font-bold bg-indigo-950/90 text-indigo-300 border border-indigo-800/70 px-2.5 py-1 rounded-xl flex items-center gap-1">
                            <span>🏢</span> مستلزمات مكتبية للمقر
                          </span>
                        ) : (
                          <span className="text-[11px] font-bold bg-amber-950/60 text-amber-300 border border-amber-700/60 px-2.5 py-1 rounded-xl flex items-center gap-1.5 shadow-sm">
                            <span>🏗️</span>
                            <span className="text-slate-400">قطعة:</span>
                            <strong className="font-mono font-bold text-cyan-300">{parcel || '—'}</strong>
                            <span className="text-amber-500/70">•</span>
                            <span className="text-slate-400">المنطقة:</span>
                            <strong className="font-bold text-amber-300">{region || '—'}</strong>
                          </span>
                        )}

                        {isUrgent && (
                          <span className="text-[10px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/40 px-2 py-0.5 rounded-lg animate-pulse">
                            🔥 عاجل
                          </span>
                        )}
                      </div>

                      {itemDateDisplay && (
                        <div
                          className="flex items-center gap-1.5 text-[11px] font-mono text-slate-300 bg-slate-900/90 border border-slate-700/70 px-2.5 py-1 rounded-lg shrink-0 shadow-xs"
                          title={item.type === 'RECEIPT' ? 'تاريخ ووقت استلام المواد بالمخزن' : 'تاريخ ووقت تقديم الطلب'}
                        >
                          <span className="text-amber-400 font-sans text-xs">🕒</span>
                          <span className="text-slate-400 text-[10px] font-sans">
                            {item.type === 'RECEIPT' ? 'تاريخ الاستلام:' : 'تاريخ الطلب:'}
                          </span>
                          <span className="font-bold text-slate-100 tracking-tight" dir="ltr">{itemDateDisplay}</span>
                        </div>
                      )}
                    </div>

                    {/* Title & Subtitle */}
                    {(displayTitle || displaySubtitle) && (
                      <div>
                        {displayTitle && (
                          <h4 className="text-sm font-black text-slate-100 leading-snug">
                            {displayTitle}
                          </h4>
                        )}
                        {displaySubtitle && (
                          <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                            {displaySubtitle}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Line Items List (Mandatory 4 Fields: الصنف والكمية) */}
                    {Array.isArray(item.items_list) && item.items_list.length > 0 ? (
                      <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-2.5 space-y-1.5 text-xs">
                        <div className="text-[11px] font-bold text-slate-300 flex items-center justify-between pb-1 border-b border-slate-800/60">
                          <span className="flex items-center gap-1.5 text-cyan-400 font-bold">
                            <span>📦</span> {item.type === 'RECEIPT' ? 'بنود الاستلام الفعلي' : (item.type === 'PO' ? 'بنود أمر الشراء الفعلي' : (item.type === 'INVOICE' ? 'بنود الفاتورة' : (item.type === 'SUPPLEMENT' ? 'بنود طلب الكمالة' : 'بنود الطلب')))} ({item.items_list.length}):
                          </span>
                          {item.items_count && item.items_count > item.items_list.length && (
                            <span className="text-[10px] text-slate-500">+{item.items_count - item.items_list.length} أصناف أخرى</span>
                          )}
                        </div>
                        <div className="space-y-1.5 max-h-56 overflow-y-auto custom-select-scrollbar pr-0.5">
                          {item.items_list.map((it, idx) => {
                            if (!it) return null;
                            const unitLabel = getUnitLabel(it.uom || '');
                            const hasPrice = it.unit_price !== undefined && it.unit_price !== null && Number(it.unit_price) > 0;
                            const unitPriceNum = hasPrice ? Number(it.unit_price) : 0;
                            const qtyNum = Number(it.quantity) || 0;
                            // Calculate line total strictly from actual quantity * unit price
                            const lineTotalNum = hasPrice && qtyNum > 0
                              ? Math.round(qtyNum * unitPriceNum * 100) / 100
                              : (it.line_total !== undefined && it.line_total !== null && Number(it.line_total) > 0
                                ? Number(it.line_total)
                                : 0);
                            const itDesc = (it.description && String(it.description).trim()) || 'صنف غير مسمى';

                            return (
                              <div
                                key={idx}
                                className="flex flex-col gap-1.5 text-xs py-2 px-2.5 rounded-lg bg-slate-950/70 border border-slate-800/80 hover:border-slate-700/80 transition-colors"
                              >
                                {/* السطر الأول: اسم ووصف الصنف بالكامل دون أي اقتطاع + إجمالي البند إن وجد */}
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex items-start gap-1.5 min-w-0 flex-1">
                                    <span className="text-cyan-400 font-black mt-0.5 select-none shrink-0">•</span>
                                    <span className="font-bold text-slate-100 text-xs sm:text-sm leading-snug break-words">
                                      {itDesc}
                                    </span>
                                  </div>
                                  {hasPrice && lineTotalNum > 0 && (
                                    <span className="font-mono font-black text-emerald-400 text-xs shrink-0 whitespace-nowrap bg-emerald-950/70 border border-emerald-800/60 px-1.5 py-0.5 rounded shadow-xs">
                                      {formatCleanNumber(lineTotalNum)} ج.م
                                    </span>
                                  )}
                                </div>

                                {/* السطر الثاني: شارات الكمية والوحدة وسعر الوحدة بشكل متناسق */}
                                <div className="flex items-center gap-1.5 text-[11px] flex-wrap pr-3 text-slate-400">
                                  <span className="font-mono font-bold text-amber-300 bg-amber-950/40 border border-amber-800/50 px-1.5 py-0.5 rounded">
                                    الكمية: {formatRebarDisplay(it.quantity, it.uom, it.specifications || it.description) || `${formatCleanQty(it.quantity)} ${unitLabel}`}
                                  </span>

                                  {hasPrice && (
                                    <span className="font-mono text-cyan-300 text-[10px] sm:text-[11px] bg-cyan-950/60 border border-cyan-800/50 px-1.5 py-0.5 rounded font-bold">
                                      السعر: {formatCleanNumber(unitPriceNum)} ج.م / {unitLabel}
                                    </span>
                                  )}

                                  {it.parcel && (
                                    <span className="text-slate-400 text-[10px] bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded">
                                      قطعة: {it.parcel}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-2.5 space-y-1 text-xs">
                        <div className="text-[11px] font-bold text-slate-300 flex items-center justify-between pb-1 border-b border-slate-800/60">
                          <span className="flex items-center gap-1.5 text-cyan-400 font-bold">
                            <span>📦</span> الصنف المطلوب:
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs py-1.5 px-2.5 rounded-lg bg-slate-950/60 border border-slate-800/70">
                          <span className="font-semibold text-slate-100 truncate">
                            {item.items_summary || displayTitle || 'بند المعاملة'}
                          </span>
                          {item.amount !== undefined && Number(item.amount) > 0 && (
                            <span className="font-mono font-bold text-emerald-300 text-xs shrink-0">
                              {formatCleanNumber(item.amount)} ج.م
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Meta Bar: Requester, Department, Date Needed, Amount, Supplier */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-300 bg-slate-900/50 border border-slate-800/70 rounded-xl px-3 py-2">
                      {item.requester && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500">👤 الطالب:</span>
                          <strong className="font-semibold text-slate-200">{item.requester}</strong>
                          {item.department && (
                            <span className="text-slate-400 text-[11px]">({item.department})</span>
                          )}
                        </div>
                      )}

                      {item.target_department && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500">🏢 القسم المستهدف:</span>
                          <span className="px-2 py-0.5 rounded-md text-[11px] font-black bg-cyan-950/80 border border-cyan-700/60 text-cyan-300">
                            {item.target_department}
                          </span>
                        </div>
                      )}

                      {itemDateDisplay && (
                        <div className="flex items-center gap-1.5 font-mono text-[11px]">
                          <span className="text-slate-500 font-sans">
                            🕒 {item.type === 'RECEIPT' ? 'تاريخ ووقت الاستلام:' : 'تاريخ ووقت الطلب:'}
                          </span>
                          <strong className="text-cyan-300 font-bold tracking-tight" dir="ltr">{itemDateDisplay}</strong>
                        </div>
                      )}

                      {item.date_needed && (
                        <div className="flex items-center gap-1.5 font-mono text-[11px]">
                          <span className="text-slate-500 font-sans">📅 الاحتياج:</span>
                          <strong className="text-amber-300 font-bold">{item.date_needed}</strong>
                        </div>
                      )}

                      {item.amount !== undefined && Number(item.amount) > 0 && (
                        <div className="flex items-center gap-1.5 font-mono font-bold text-emerald-400">
                          <span className="text-slate-500 font-sans font-normal">💰 القيمة:</span>
                          <span>{formatCleanNumber(item.amount)} ج.م</span>
                        </div>
                      )}

                      {item.supplier && item.title !== item.supplier && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500">🤝 المورد:</span>
                          <strong className="font-semibold text-slate-200">{item.supplier}</strong>
                        </div>
                      )}
                    </div>

                    {/* Operational Reason */}
                    {item.reason && (
                      <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-950/20 px-3 py-2 text-xs font-medium text-amber-200">
                        <span className="font-bold text-amber-400 shrink-0">⚡ المطلوب:</span>
                        <span className="truncate">{item.reason}</span>
                      </div>
                    )}

                    {/* Next Actor & Overdue Status Bar */}
                    {(() => {
                      const isOverdue = Boolean(item.date_needed && item.date_needed < new Date().toISOString().slice(0, 10));
                      const isComplementary = Boolean(
                        item.request_type === 'COMPLEMENTARY' ||
                        item.type === 'SUPPLEMENT' ||
                        item.title?.includes('كمالة') ||
                        item.stageBadge?.text?.includes('كمالة')
                      );

                      const defaultNextActor = item.next_actor || (
                        isComplementary ? 'مدير المشتريات (تنفيذ فوري مباشر دون مالية أو تنفيذي)' :
                        item.type === 'PR' ? (isReviewer ? 'المدير العام للاعتماد النهائي' : 'إدارة المشتريات') :
                        item.type === 'SUPPLEMENT' ? 'إدارة المشتريات للتسعير وإصدار أمر التوريد' :
                        item.type === 'QUOTE' ? 'المدير العام لاعتماد الترسية' :
                        item.type === 'PO' ? 'المستودع والموقع للاستلام' :
                        item.type === 'RECEIPT' ? 'إدارة الحسابات لتسجيل الفاتورة' : undefined
                      );

                      if (!defaultNextActor && !isOverdue) return null;

                      return (
                        <div className="flex items-center justify-between gap-2 text-[11px] pt-1.5 border-t border-slate-800/60 flex-wrap">
                          {defaultNextActor && (
                            <span className="text-cyan-300 font-medium flex items-center gap-1">
                              <span className="text-slate-500 font-normal">⏭️ المسؤول التالي:</span>
                              <strong className="text-cyan-300 font-bold">{defaultNextActor}</strong>
                            </span>
                          )}
                          {isOverdue && (
                            <span className="text-rose-300 font-bold bg-rose-950/70 border border-rose-800/70 px-2 py-0.5 rounded-lg flex items-center gap-1 shrink-0 animate-pulse text-[10px]">
                              <span>⏳</span>
                              <span>متأخر عن تاريخ الاحتياج</span>
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Actions Toolbar on the Card */}
                  <div className="space-y-2 pt-2 border-t border-slate-800/80">
                    {item.documentSlot}

                    {/* Top Action Row: Direct Approve & Direct Reject (if provided) */}
                    {(item.onDirectApprove || item.onDirectReject || item.onDirectSubmit) && (
                      <div className={`flex items-center gap-2 ${(directApprovingId || isSubmitting) ? 'pointer-events-none opacity-60' : ''}`}>
                        {item.onDirectApprove && (
                          <Button
                            variant="success"
                            size="sm"
                            disabled={directApprovingId === item.id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleApproveClick(item);
                            }}
                            className={`flex-1 text-xs font-black text-white shadow-md transition-all ${
                              item.directApproveClassName || 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/40'
                            }`}
                          >
                            <span>{item.directApproveIcon ?? '✓'}</span>
                            <span>{directApprovingId === item.id ? 'جاري الاعتماد...' : (item.directApproveLabel || 'اعتماد فوري')}</span>
                          </Button>
                        )}

                        {item.onDirectSubmit && (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={isSubmitting}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDirectSubmit(item);
                            }}
                            className="flex-1 text-xs font-black shadow-md shadow-cyan-950/40"
                          >
                            <span>{isSubmitting ? 'جاري الإرسال...' : '🚀 إرسال للاعتماد'}</span>
                          </Button>
                        )}

                        {item.onDirectReject && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRejectModal({ isOpen: true, item, reason: '', isSubmitting: false, error: undefined });
                            }}
                            className={`text-xs font-bold px-3 transition-all ${
                              item.directRejectClassName || 'bg-rose-950/80 text-rose-300 border-rose-800/60 hover:bg-rose-900/80'
                            }`}
                          >
                            <span>✕</span>
                            <span>{item.directRejectLabel || 'رفض'}</span>
                          </Button>
                        )}
                      </div>
                    )}

                    {/* Bottom Action Row: Detailed Review + Quick Peek / Preview Receipt */}
                    <div className="flex items-center gap-2">
                      <Button
                        variant={(!item.onDirectApprove && !item.onDirectSubmit) ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (item.onAction) {
                            item.onAction(item);
                            return;
                          }
                          if (isReceiptInspectionItem(item)) {
                            setReceiptInspectionModal({ isOpen: true, item });
                            return;
                          }
                          if (isActualPoItem(item)) {
                            const poId = Number(item.rawId || item.po_id || item.purchase_order_id || 0);
                            if (poId > 0) {
                              setActualPoModal({ isOpen: true, poId, item });
                              return;
                            }
                          }
                          const targetUrl = resolveActionItemUrl(item);
                          if (targetUrl) navigate(targetUrl);
                        }}
                        className={`flex-1 text-xs font-bold ${
                          (!item.onDirectApprove && !item.onDirectSubmit)
                            ? 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black shadow-md shadow-cyan-950/50'
                            : 'bg-slate-900 border-slate-700 hover:border-cyan-500/60 hover:text-cyan-300'
                        }`}
                      >
                        <span>{item.actionLabel}</span>
                        <span className="mr-1">←</span>
                      </Button>

                      {item.onPreviewReceipt && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            item.onPreviewReceipt!(item);
                          }}
                          className="rounded-xl border border-cyan-700/60 bg-cyan-950/70 hover:bg-cyan-900/90 px-3.5 py-1.5 text-xs font-bold text-cyan-200 hover:text-white transition-all cursor-pointer shrink-0 flex items-center gap-1.5 shadow-sm"
                          title="معاينة إذن الاستلام والدورة المستندية (طلب الشراء • أمر الشراء الفعلي • إذن الاستلام)"
                        >
                          <span>👁️</span>
                          <span>معاينة الإذن</span>
                        </button>
                      )}

                      {/* For General Manager: Replace معاينة entirely with الغرض من الشراء */}
                      {isGeneralManager && (item.type === 'PR' || item.type === 'QUOTE' || canPeek) && !item.onPreviewReceipt && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleOpenPurposeModal(item);
                          }}
                          className="rounded-xl border border-amber-500/60 bg-amber-950/80 hover:bg-amber-900/90 text-amber-200 hover:text-white px-3.5 py-1.5 text-xs font-bold transition-all cursor-pointer shrink-0 flex items-center gap-1.5 shadow-sm active:scale-95"
                          title="الغرض من الشراء الأصلي الذي أدخله مقدم الطلب"
                        >
                          <span>🎯</span>
                          <span>الغرض من الشراء</span>
                        </button>
                      )}

                      {/* For Other Roles: Standard معاينة */}
                      {!isGeneralManager && canPeek && !item.onPreviewReceipt && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenPeek(item);
                          }}
                          className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-bold text-slate-300 hover:border-cyan-500/60 hover:bg-slate-800 hover:text-cyan-300 transition-colors cursor-pointer shrink-0"
                          title="معاينة سريعة لكافة التفاصيل"
                        >
                          <span>👁️</span>
                          <span className="mr-1">معاينة</span>
                        </button>
                      )}

                      {/* For Other Reviewers/Officials: Also provide الغرض من الشراء button on PR/QUOTE items */}
                      {!isGeneralManager && (item.type === 'PR' || item.type === 'QUOTE') && !item.onPreviewReceipt && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleOpenPurposeModal(item);
                          }}
                          className="rounded-xl border border-amber-600/50 bg-amber-950/40 hover:bg-amber-900/70 text-amber-300 hover:text-white px-2.5 py-1.5 text-xs font-bold transition-all cursor-pointer shrink-0 flex items-center gap-1 shadow-xs"
                          title="الغرض من الشراء الأصلي الذي أدخله مقدم الطلب"
                        >
                          <span>🎯</span>
                          <span>الغرض</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </CardErrorBoundary>
            );
          })}
          </div>
        ) : (
          <div className="p-8 text-center text-slate-400 space-y-2">
            <span className="text-3xl block">🎉</span>
            <p className="text-sm font-bold text-slate-200">أنت على دراية تامة بكل المعاملات!</p>
            <p className="text-xs text-slate-500">لا توجد طلبات أو موافقات معلقة بانتظار قرارك الآن.</p>
          </div>
        )}
      </div>

      {/* Direct Approval Modal */}
      <Modal
        isOpen={approveModal.isOpen}
        onClose={() => !approveModal.isSubmitting && setApproveModal((prev) => ({ ...prev, isOpen: false }))}
        title={`تأكيد الاعتماد السريع: ${approveModal.item?.code || ''}`}
        size="md"
      >
        <div className="space-y-4" dir="rtl">
          <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/30 p-3.5 text-xs text-emerald-200">
            {(() => {
              const isSupplement = Boolean(
                approveModal.item?.request_type === 'COMPLEMENTARY' ||
                approveModal.item?.type === 'SUPPLEMENT' ||
                approveModal.item?.title?.includes('كمالة') ||
                approveModal.item?.stageBadge?.text?.includes('كمالة')
              );
              return (
                <>
                  <p className="font-bold text-sm text-emerald-300 mb-1">
                    {isSupplement ? '⚡ تأكيد اعتماد طلب الكمالة وتوجيهه الفوري للمشتريات' : 'هل أنت متأكد من اعتماد هذا الطلب فوراً؟'}
                  </p>
                  <p className="text-slate-300">
                    {isSupplement
                      ? 'سيتم اعتماد طلب الكمالة ونقله مباشرة إلى مدير المشتريات (مسار سريع دون المرور بالمالية أو التنفيذي) للتسعير وإصدار أمر الشراء فوراً ⚡'
                      : 'سيتم تسجيل اعتمادك ونقل الطلب تلقائياً إلى المرحلة التالية في دورة العمل.'}
                  </p>
                </>
              );
            })()}
            {approveModal.item && (
              <div className="mt-2.5 pt-2 border-t border-emerald-800/40 text-slate-200 space-y-1 font-mono">
                <div>• المعاملة: <strong>{approveModal.item.title}</strong></div>
                {approveModal.item.department && <div>• القسم: {approveModal.item.department}</div>}
                {(approveModal.item.created_at || approveModal.item.timeAgo) && (
                  <div>• تاريخ ووقت التقديم: <strong dir="ltr">{formatDateTime24h(approveModal.item.created_at || approveModal.item.timeAgo)}</strong></div>
                )}
              </div>
            )}
          </div>

          {approveModal.item?.type === 'PR' && isReviewer && (
            <div className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5">
                  مهندس الموقع / مسؤول استلام المواد بالموقع <span className="text-rose-400">*</span>
                </label>
                {isLoadingReceivers ? (
                  <div className="text-slate-400 text-xs py-2">جاري تحميل قائمة المهندسين والمستلمين...</div>
                ) : (
                  <select
                    value={selectedEngineerId}
                    onChange={(e) => {
                      setSelectedEngineerId(e.target.value ? Number(e.target.value) : '');
                      setReceiverError(null);
                    }}
                    className={`w-full rounded-xl border p-2.5 text-xs text-slate-100 outline-none font-bold transition-all ${
                      receiverError
                        ? 'border-rose-500 bg-rose-950/40 ring-1 ring-rose-500 focus:border-rose-400'
                        : 'border-slate-700 bg-slate-950 focus:border-emerald-400'
                    }`}
                  >
                    <option value="">-- اختر مهندس الموقع --</option>
                    {receiverOptions.siteEngineers.length > 0 && (
                      <optgroup label="👷 مهندسو الموقع الأساسيون">
                        {receiverOptions.siteEngineers.map((eng) => (
                          <option key={`se-${eng.id}`} value={eng.id}>
                            {eng.name} {eng.department_name ? `(${eng.department_name})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {receiverOptions.otherUsers.length > 0 && (
                      <optgroup label="👥 مستخدمو النظام الآخرون (تفويض أي دور آخر)">
                        {receiverOptions.otherUsers.map((u) => (
                          <option key={`other-${u.id}`} value={u.id}>
                            {u.name} — {u.role_name || 'مستخدم'} {u.department_name ? `(${u.department_name})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
                {receiverError && (
                  <p className="mt-1.5 flex items-center gap-1 text-xs text-rose-400 font-bold">
                    <span>⚠️</span> {receiverError}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-slate-400">
                  الشخص المختار سيتولى مراجعة إذن الاستلام واعتماده بالموقع فور توريد الأصناف.
                </p>
              </div>

              {/* خيار استلام وفحص المخزن (عم سلامة) */}
              <div className="rounded-xl border border-slate-700/80 bg-slate-950/80 p-3.5 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <span className="text-xl shrink-0 mt-0.5">🏬</span>
                    <div>
                      <span className="font-bold text-slate-100 text-xs block">
                        استلام وفحص بالمخزن (عم سلامة)
                      </span>
                      <span className="text-[11px] text-slate-400 block mt-0.5 leading-relaxed">
                        {requiresWarehouseReceipt
                          ? 'نعم (الافتراضي) — يمر أمر الشراء على عم سلامة في المخزن لاستلام البضاعة وفحصها وإصدار إذن الاستلام.'
                          : 'لا (توريد مباشر) — يتم توريد البضاعة مباشرة للموقع لمهندس الموقع دون المرور على المخزن أو إشعار عم سلامة.'}
                      </span>
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={requiresWarehouseReceipt}
                      onChange={(e) => setRequiresWarehouseReceipt(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>
                <div className="flex items-center gap-2 pt-2 border-t border-slate-800 text-[11px]">
                  <span className={`px-2.5 py-0.5 rounded-full font-bold text-[10px] ${requiresWarehouseReceipt ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'}`}>
                    {requiresWarehouseReceipt ? '✅ يمر على عم سلامة في المخزن' : '⚡ توريد مباشر للموقع (يتخطى عم سلامة)'}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1.5">
              ملاحظات أو تعليق الاعتماد (اختياري):
            </label>
            <textarea
              value={approveModal.comment}
              onChange={(e) => setApproveModal((prev) => ({ ...prev, comment: e.target.value }))}
              placeholder="اكتب أي توجيهات أو ملاحظات للاعتماد..."
              rows={3}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-xs text-slate-100 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <Button
              variant="secondary"
              size="sm"
              disabled={approveModal.isSubmitting}
              onClick={() => setApproveModal((prev) => ({ ...prev, isOpen: false }))}
            >
              إلغاء
            </Button>
            <Button
              variant="success"
              size="sm"
              disabled={approveModal.isSubmitting}
              onClick={handleConfirmDirectApprove}
              className="font-bold bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              {approveModal.isSubmitting ? 'جاري الاعتماد...' : '✓ تأكيد الاعتماد الفوري'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Direct Rejection Modal */}
      <Modal
        isOpen={rejectModal.isOpen}
        onClose={() => !rejectModal.isSubmitting && setRejectModal((prev) => ({ ...prev, isOpen: false }))}
        title={`رفض أو إعادة المعاملة: ${rejectModal.item?.code || ''}`}
        size="md"
      >
        <div className="space-y-4" dir="rtl">
          <div className="rounded-xl border border-rose-800/40 bg-rose-950/30 p-3.5 text-xs text-rose-200">
            <p className="font-bold text-sm text-rose-300 mb-1">
              سيتم رفض أو إعادة هذا الطلب لمقدمه
            </p>
            <p className="text-slate-300">
              يرجى توضيح سبب الرفض بالتفصيل لمقدم الطلب ليتمكن من معالجته.
            </p>
            {rejectModal.item && (
              <div className="mt-2.5 pt-2 border-t border-rose-800/40 text-slate-200 space-y-1 font-mono text-xs">
                <div>• المعاملة: <strong>{rejectModal.item.title || rejectModal.item.code}</strong></div>
                {(rejectModal.item.created_at || rejectModal.item.timeAgo) && (
                  <div>• تاريخ ووقت التقديم: <strong dir="ltr">{formatDateTime24h(rejectModal.item.created_at || rejectModal.item.timeAgo)}</strong></div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1.5">
              سبب الرفض أو الإعادة <span className="text-rose-400">*</span>
            </label>
            <textarea
              value={rejectModal.reason}
              onChange={(e) => setRejectModal((prev) => ({ ...prev, reason: e.target.value, error: undefined }))}
              placeholder="اكتب سبب الرفض الإلزامي هنا..."
              rows={3}
              className={`w-full rounded-xl border p-3 text-xs text-slate-100 outline-none ${
                rejectModal.error
                  ? 'border-rose-500 bg-rose-950/20'
                  : 'border-slate-700 bg-slate-950 focus:border-rose-400 focus:ring-1 focus:ring-rose-400'
              }`}
            />
            {rejectModal.error && (
              <p className="text-[11px] text-rose-400 mt-1 font-bold">⚠️ {rejectModal.error}</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <Button
              variant="secondary"
              size="sm"
              disabled={rejectModal.isSubmitting}
              onClick={() => setRejectModal((prev) => ({ ...prev, isOpen: false }))}
            >
              إلغاء
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={rejectModal.isSubmitting}
              onClick={handleConfirmDirectReject}
              className="font-bold bg-rose-600 hover:bg-rose-500 text-white"
            >
              {rejectModal.isSubmitting ? 'جاري الرفض...' : '✕ تأكيد الرفض والإعادة'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Floating Action Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl shadow-2xl text-xs font-bold transition-all duration-300 backdrop-blur-md animate-fade-in ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950/95 border border-emerald-500/80 text-emerald-100 shadow-emerald-950/50'
              : 'bg-rose-950/95 border border-rose-500/80 text-rose-100 shadow-rose-950/50'
          }`}
        >
          <span>{toastMessage.text}</span>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="mr-2 text-slate-400 hover:text-white transition-colors cursor-pointer text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {/* Quick Receipt Inspection Modal */}
      <QuickReceiptInspectionModal
        isOpen={receiptInspectionModal.isOpen}
        item={receiptInspectionModal.item}
        onClose={() => setReceiptInspectionModal({ isOpen: false, item: null })}
        onSuccess={handleReceiptInspectionSuccess}
      />

      {/* Fast Finalize Actual PO Modal */}
      {actualPoModal.isOpen && (
        <FinalizeActualPoModal
          isOpen={actualPoModal.isOpen}
          poId={actualPoModal.poId}
          onClose={() => setActualPoModal({ isOpen: false, poId: null, item: null })}
          onSuccess={handleActualPoSuccess}
        />
      )}

      {/* ── Purchase Purpose Inspection Modal (Centered in Viewport across Mobile/Tablet/Desktop via Portal) ── */}
      {purposeModal.isOpen && purposeModal.item && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[99999] flex min-h-[100dvh] items-center justify-center p-3 sm:p-4 md:p-6 bg-slate-950/85 backdrop-blur-md overflow-y-auto"
          dir="rtl"
          onClick={() => setPurposeModal({ isOpen: false, item: null, loading: false, fullPurpose: null })}
          role="dialog"
          aria-modal="true"
          aria-labelledby="purpose-modal-title"
        >
          <div
            className="relative my-auto w-full max-w-[94vw] sm:max-w-md md:max-w-lg rounded-2xl sm:rounded-3xl border border-amber-500/50 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-4 sm:p-5 shadow-2xl shadow-black/90 flex flex-col gap-3.5 max-h-[88dvh] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header: Title, Code Badge, and Close Button × */}
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xl sm:text-2xl select-none shrink-0">🎯</span>
                <div className="min-w-0">
                  <h3 id="purpose-modal-title" className="text-sm sm:text-base font-black text-slate-100 truncate">
                    الغرض من الشراء
                  </h3>
                  <span className="font-mono text-[11px] font-bold text-cyan-400 bg-cyan-950/80 border border-cyan-800/60 px-2 py-0.5 rounded-md inline-block mt-0.5">
                    {purposeModal.item.code || `PR-${purposeModal.item.rawId}`}
                  </span>
                </div>
              </div>

              {/* Mobile touch-friendly × close button */}
              <button
                type="button"
                onClick={() => setPurposeModal({ isOpen: false, item: null, loading: false, fullPurpose: null })}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-850 hover:bg-rose-950/50 text-xl font-black text-slate-300 hover:border-rose-500/60 hover:text-rose-300 transition-all cursor-pointer active:scale-95"
                aria-label="إغلاق النافذة"
                title="إغلاق"
              >
                ×
              </button>
            </div>

            {/* Requester & Department Metadata Bar */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300 bg-slate-950/60 border border-slate-800/80 rounded-xl px-3 py-2">
              {purposeModal.item.requester && (
                <div className="flex items-center gap-1.5 truncate">
                  <span className="text-slate-500">👤 مقدم الطلب:</span>
                  <strong className="text-slate-100 font-bold truncate">{purposeModal.item.requester}</strong>
                </div>
              )}
              {purposeModal.item.department && (
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  <span>🏢</span>
                  <span>({purposeModal.item.department})</span>
                </div>
              )}
            </div>

            {/* Purpose Body Content */}
            <div className="flex-1 overflow-y-auto custom-select-scrollbar rounded-xl border border-slate-800/90 bg-slate-950/90 p-3.5 sm:p-4 text-slate-100 min-h-[110px] max-h-[46vh]">
              {purposeModal.loading ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs text-amber-300 animate-pulse">
                  <span className="text-2xl animate-spin">⏳</span>
                  <span>جاري تحميل الغرض الأصلي للطلب من السيرفر...</span>
                </div>
              ) : purposeModal.fullPurpose ? (
                <p className="text-xs sm:text-sm font-medium leading-relaxed whitespace-pre-wrap break-words select-text text-slate-200">
                  {purposeModal.fullPurpose}
                </p>
              ) : (
                <div className="flex flex-col items-center justify-center gap-1.5 py-6 text-xs text-slate-400 text-center">
                  <span>ℹ️</span>
                  <span>لم يتم العثور على نص مسجل للغرض من الشراء في هذا الطلب.</span>
                </div>
              )}
            </div>

            {/* Read-Only Safety Badge */}
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300/90 font-medium select-none">
              <span className="text-sm">🔒</span>
              <span>نص أصلي للقراءة فقط كما حرره الطالب (غير قابل للتعديل أثناء المراجعة أو الاعتماد).</span>
            </div>

            {/* Footer Action Bar */}
            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                onClick={() => setPurposeModal({ isOpen: false, item: null, loading: false, fullPurpose: null })}
                className="w-full sm:w-auto px-5 py-2 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 transition-all cursor-pointer active:scale-95"
              >
                إغلاق النافذة
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default ActionRequiredInbox;
export const PendingActions = ActionRequiredInbox;
