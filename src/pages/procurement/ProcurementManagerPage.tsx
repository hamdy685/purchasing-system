import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  approveProcurementPrApi,
  createDirectPoApi,
  getApprovedByProcurementPrsApi,
  getExecutivePendingRequestsApi,
  getPendingProcurementApprovalApi,
  getPendingQuoteRequestsApi,
  getProcurementAnalyticsApi,
  getProcurementDepartmentsApi,
  getProcurementCatalogItemsApi,
  rejectProcurementPrApi,
  resetProcurementPrRouteApi,
  ProcurementAnalyticsResponse,
  ProcurementCatalogItemOption,
  ProcurementDepartmentOption,
  DirectAccountingFinancialData,
} from '../../api/procurement';
import { getPurchaseOrderApi, getPurchaseOrdersApi, PurchaseOrderPaginationMeta } from '../../api/purchaseOrders';
import { createSupplierApi, deleteSupplierApi, getSuppliersApi, SupplierPayload, updateSupplierApi } from '../../api/suppliers';
import { PurchaseOrder, المورد } from '../../types/purchaseOrder';
import { PurchaseRequest } from '../../types/purchaseRequest';
import ActionRequiredInbox, { ActionInboxItem } from '../../components/dashboard/ActionRequiredInbox';
import PurchaseOrderPrintModal from '../../components/procurement/PurchaseOrderPrintModal';
import ReportPrintModal from '../../components/procurement/ReportPrintModal';
import SupplierModal from '../../components/procurement/SupplierModal';
import DirectPoModal from '../../components/procurement/DirectPoModal';
import DirectAccountingReviewModal from '../../components/procurement/DirectAccountingReviewModal';
import PurchaseQuotesModal from '../../components/procurement/PurchaseQuotesModal';
import FinalizeActualPoModal from '../../components/procurement/FinalizeActualPoModal';
import { toast } from '../../utils/toast';
import ThreeWayMatchPrintModal from '../../components/accounting/ThreeWayMatchPrintModal';
import { PrDetailsModal } from '../../components/procurement/PrDetailsModal';
import ProcurementCharts from '../../components/procurement/ProcurementCharts';
import { getUnitLabel } from '../../utils/units';
import { getSummaryParcels, getSummaryRegions, getSummaryQuantities, getItemsSummaryDisplay } from '../../utils/formatRequestSummary';
import { parseApiError } from '../../utils/apiError';
import ErrorMessage from '../../components/ErrorMessage';
import { TableSkeleton } from '../../components/ui/StateFeedback';
import TableFilterBar from '../../components/ui/TableFilterBar';
import PaginationControls from '../../components/ui/PaginationControls';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import { ActionConfirmationModal } from '../../components/common/ActionConfirmationModal';
import { Card, KpiCard } from '../../components/ui/Card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/Table';
import { getDefaultDateFrom, getTodayInputDate, isDefaultTodayRange } from '../../utils/dateFilters';
import { CurrencyDisplay } from '../../components/ui/CurrencyDisplay';
import QuickLauncherBar from '../../components/dashboard/QuickLauncherBar';
import { getSupplementsForPrApi, PrSupplementsResponse } from '../../api/supplements';
import { PurchaseRequestSupplement } from '../../types/supplement';
import { ProcurementSupplementProcessModal } from '../../components/supplements/ProcurementSupplementProcessModal';
import { formatDateTime24h } from '../../utils/dateTime';

const STATUS_LABELS: Record<string, string> = {
  PO_DRAFT: 'مسودة',
  ISSUED: 'تم الإصدار',
  PENDING_ACCOUNTING_REVIEW: 'بانتظار الحسابات',
  RETURNED_TO_PROCUREMENT: 'معاد للمشتريات',
  FINAL_APPROVED: 'اعتماد نهائي',
  REJECTED: 'مرفوض',
  APPROVED_BY_REVIEWER: 'معتمد من المراجع',
  PENDING_PROCUREMENT_APPROVAL: 'بانتظار اعتماد المشتريات',
  PENDING_ACCOUNTING_APPROVAL: 'بانتظار الموافقة المالية',
  APPROVED_BY_ACCOUNTING: 'معتمد ماليًا — جاهز للمشتريات',
  PENDING_QUOTE_RECOMMENDATIONS: 'بانتظار تجهيز عروض الأسعار',
  PENDING_EXECUTIVE_QUOTE_DECISION: 'بانتظار قرار العروض',
  APPROVED_BY_PROCUREMENT: 'معتمد من المشتريات',
  SUBMITTED: 'مقدم',
  UNDER_REVIEW: 'قيد المراجعة',
  DRAFT: 'مسودة طلب',
};

import { formatCleanNumber } from '../../utils/numberFormat';

const fmtDate = (value?: string | null) => value ? new Date(value).toLocaleDateString('ar-EG') : '—';
const fmtAmount = (value?: string | number | null) => formatCleanNumber(value);
const statusLabel = (status: string) => STATUS_LABELS[status] || status;
const reviewerName = (request: PurchaseRequest, departments: ProcurementDepartmentOption[]) => request.approval_history?.find((entry) => entry.action === 'APPROVED_BY_REVIEWER')?.actor?.name || request.assigned_reviewer?.name || departments.find((department) => department.id === request.department?.id || department.name === request.department?.name)?.manager?.name || '—';

type ProcurementQueueStage = 'PENDING_ROUTE' | 'QUOTE_SETUP' | 'READY_FOR_PO' | 'EXECUTIVE_PENDING';

type ProcurementQueueRow = {
  request: PurchaseRequest;
  stage: ProcurementQueueStage;
};

const QUEUE_STAGE_LABELS: Record<ProcurementQueueStage, string> = {
  PENDING_ROUTE: 'بانتظار اختيار المسار',
  QUOTE_SETUP: 'بانتظار تجهيز عروض الأسعار',
  READY_FOR_PO: 'جاهز لإنشاء أمر شراء',
  EXECUTIVE_PENDING: 'قرارات بانتظار المدير التنفيذي',
};

type ReportLine = {
  id?: number;
  item_id?: number | null;
  item_description?: string | null;
  item_name?: string | null;
  item_reference?: string | null;
  region?: string | null;
  uom?: string | null;
  quantity?: string | number | null;
  unit_price?: string | number | null;
  line_total?: string | number | null;
  grand_total?: string | number | null;
};

export const ProcurementManagerPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = usePersistedState<number>('procurement.active-tab.v1', 0);
  const [pendingPrs, setPendingPrs] = useState<PurchaseRequest[]>([]);
  const [executivePendingPrs, setExecutivePendingPrs] = useState<PurchaseRequest[]>([]);
  const [quotePrs, setQuotePrs] = useState<PurchaseRequest[]>([]);
  const [approvedPrs, setApprovedPrs] = useState<PurchaseRequest[]>([]);
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [pendingActualPos, setPendingActualPos] = useState<PurchaseOrder[]>([]);
  const [cyclePrintPo, setCyclePrintPo] = useState<PurchaseOrder | null>(null);
  const [actualPoSearch, setActualPoSearch] = useState<string>('');
  const [poPage, setPoPage] = useState(1);
  const [poMeta, setPoMeta] = useState<PurchaseOrderPaginationMeta>({ current_page: 1, from: null, last_page: 1, per_page: 15, to: null, total: 0 });
  const [poDetails, setPoDetails] = useState<Record<number, PurchaseOrder>>({});
  const [suppliers, setSuppliers] = useState<المورد[]>([]);
  const [departments, setDepartments] = useState<ProcurementDepartmentOption[]>([]);
  const [catalogItems, setCatalogItems] = useState<ProcurementCatalogItemOption[]>([]);
  const [analytics, setAnalytics] = useState<ProcurementAnalyticsResponse | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoadedRef = useRef(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const today = getTodayInputDate();
  const defaultDateFrom = getDefaultDateFrom();
  const [queueSearch, setQueueSearch] = usePersistedState('procurement.queue-search.v1', '');
  const [queueDepartment, setQueueDepartment] = usePersistedState('procurement.queue-department.v1', 'ALL');
  const [queueRoute, setQueueRoute] = usePersistedState('procurement.queue-route.v1', 'ALL');
  const [queueStage, setQueueStage] = useState<string>('ALL');
  const [queueDateFrom, setQueueDateFrom] = usePersistedState('procurement.queue-date-from.v1', defaultDateFrom);
  const [queueDateTo, setQueueDateTo] = usePersistedState('procurement.queue-date-to.v1', today);
  const [poSearch, setPoSearch] = usePersistedState('procurement.po-search.v1', '');
  const [poStatus, setPoStatus] = usePersistedState('procurement.po-status.v1', 'ALL');
  const [poSupplier, setPoSupplier] = usePersistedState('procurement.po-supplier.v1', 'ALL');
  const [poDateFrom, setPoDateFrom] = usePersistedState('procurement.po-date-from.v3', defaultDateFrom);
  const [poDateTo, setPoDateTo] = usePersistedState('procurement.po-date-to.v3', today);
  const [supplierSearch, setSupplierSearch] = usePersistedState('procurement.supplier-search.v1', '');
  const [supplierStatus, setSupplierStatus] = usePersistedState('procurement.supplier-status.v1', 'ALL');
  const [reportPeriod, setReportPeriod] = usePersistedState('procurement.report-period.v1', 'all');
  const [reportStatus, setReportStatus] = usePersistedState('procurement.report-status.v1', '');
  const [reportDateFrom, setReportDateFrom] = usePersistedState('procurement.report-date-from.v3', defaultDateFrom);
  const [reportDateTo, setReportDateTo] = usePersistedState('procurement.report-date-to.v3', today);
  const [reportDepartment, setReportDepartment] = usePersistedState('procurement.report-department.v1', 'ALL');
  const [reportSupplier, setReportSupplier] = usePersistedState('procurement.report-supplier.v1', 'ALL');
  const [reportItem, setReportItem] = usePersistedState('procurement.report-item.v1', 'ALL');
  const [reportSearch, setReportSearch] = usePersistedState('procurement.report-search.v1', '');
  const ignoreDefaultPoDateForSearch = Boolean(poSearch.trim()) && isDefaultTodayRange(poDateFrom, poDateTo);

  const [directPoOpen, setDirectPoOpen] = useState(false);
  const [quoteRequest, setQuoteRequest] = useState<PurchaseRequest | null>(null);
  const [selectedPrintPo, setSelectedPrintPo] = useState<PurchaseOrder | null>(null);
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<المورد | null>(null);
  const [supplierToDelete, setSupplierToDelete] = useState<المورد | null>(null);
  const [deletingSupplier, setDeletingSupplier] = useState(false);
  const [reportPrintOpen, setReportPrintOpen] = useState(false);
  const [directAccountingRequest, setDirectAccountingRequest] = useState<PurchaseRequest | null>(null);
  const [directAccountingSubmitting, setDirectAccountingSubmitting] = useState(false);
  const [directAccountingError, setDirectAccountingError] = useState<string | null>(null);
  const [selectedPrForDetails, setSelectedPrForDetails] = useState<PurchaseRequest | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // ── Supplement Fast-Track Modal State ──
  const [supplementModalOpen, setSupplementModalOpen] = useState(false);
  const [supplementModalPr, setSupplementModalPr] = useState<PurchaseRequest | null>(null);
  const [supplementModalData, setSupplementModalData] = useState<PurchaseRequestSupplement | null>(null);
  const [supplementLoading, setSupplementLoading] = useState(false);
  const [finalizePoId, setFinalizePoId] = useState<number | null>(null);
  const [procurementActionModal, setProcurementActionModal] = useState<{
    isOpen: boolean;
    type: 'reject' | 'revert';
    request: PurchaseRequest;
  } | null>(null);

  useEffect(() => {
    const stateObj = location.state as { successMessage?: string; successMsg?: string } | null;
    const msg = stateObj?.successMessage || stateObj?.successMsg;
    if (msg) {
      setSuccessBanner(msg);
      toast.success(msg);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  useEffect(() => {
    try {
      localStorage.removeItem('procurement.queue-stage.v1');
    } catch (_) {}
  }, []);

  useEffect(() => {
    const path = location.pathname;
    const tabParam = searchParams.get('tab');
    if (tabParam === 'approved-quotes' || tabParam === '2') setActiveTab(2);
    else if (tabParam === 'actual-pos' || tabParam === '5') setActiveTab(5);
    else if (path.includes('/purchase-requests')) setActiveTab(0);
    else if (path.includes('/purchase-orders')) setActiveTab(1);
    else if (path.includes('/suppliers')) setActiveTab(3);
    else if (path.includes('/reports')) setActiveTab(4);
    else if (tabParam !== 'actual-pos' && tabParam !== '5') setActiveTab(0);
  }, [location.pathname, searchParams]);

  // ── Supplement Deep-Link Handler ──
  // When navigating from notification with ?openSupplement=<prId>, auto-open the fast-track modal
  useEffect(() => {
    const openSupplementPrId = searchParams.get('openSupplement');
    if (openSupplementPrId && !supplementModalOpen) {
      const prId = Number(openSupplementPrId);
      if (prId > 0) {
        setSupplementLoading(true);
        // Find the PR in pending queue, or use a minimal object
        const targetPr = [...pendingPrs, ...quotePrs, ...approvedPrs].find(pr => pr.id === prId);
        void (async () => {
          try {
            const supplementsResp = await getSupplementsForPrApi(prId);
            const pendingSupplement = (supplementsResp.data || []).find(
              (s) => ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED', 'SUBMITTED'].includes(s.status)
            );
            if (pendingSupplement && targetPr) {
              setSupplementModalPr(targetPr);
              setSupplementModalData(pendingSupplement);
              setSupplementModalOpen(true);
            }
          } catch (err) {
            console.error('Failed to load supplement for deep link:', err);
          } finally {
            setSupplementLoading(false);
            // Clear the query param to prevent re-opening on refresh
            const newParams = new URLSearchParams(searchParams);
            newParams.delete('openSupplement');
            setSearchParams(newParams, { replace: true });
          }
        })();
      }
    }
  }, [searchParams, pendingPrs, quotePrs, approvedPrs]);

  const loadData = async () => {
    const isInitialLoad = !hasLoadedRef.current;
    if (isInitialLoad) setLoading(true);
    else setRefreshing(true);
    setPageError(null);
    const loadErrors: string[] = [];
    const safeLoad = async <T,>(label: string, loader: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await loader;
      } catch (error) {
        loadErrors.push(`${label}: ${parseApiError(error).message}`);
        return fallback;
      }
    };

    try {
      const [pending, executivePending, quotePending, approved, ordersPage, actualOrdersPage, supplierData, departmentData, catalogData, report] = await Promise.all([
        safeLoad('طلبات الاعتماد', getPendingProcurementApprovalApi(), []),
        safeLoad('قرارات المدير التنفيذي', getExecutivePendingRequestsApi(), []),
        safeLoad('عروض الأسعار', getPendingQuoteRequestsApi(), []),
        safeLoad('الطلبات المعتمدة', getApprovedByProcurementPrsApi(), []),
        safeLoad('أوامر الشراء', getPurchaseOrdersApi({
          page: poPage,
          per_page: 15,
          ...(poSearch.trim() ? { search: poSearch.trim() } : {}),
          ...(poStatus !== 'ALL' ? { status: poStatus } : {}),
          ...(poSupplier !== 'ALL' ? { supplier_id: Number(poSupplier) } : {}),
          ...(poDateFrom && !ignoreDefaultPoDateForSearch ? { date_from: poDateFrom } : {}),
          ...(poDateTo && !ignoreDefaultPoDateForSearch ? { date_to: poDateTo } : {}),
        }), null),
        safeLoad('أوامر الشراء الفعلية', getPurchaseOrdersApi({
          status: 'PENDING_ACTUAL_PO',
          per_page: 50,
        }), null),
        safeLoad('الموردون', getSuppliersApi(), []),
        safeLoad('الأقسام', getProcurementDepartmentsApi(), []),
        safeLoad('كتالوج الأصناف', getProcurementCatalogItemsApi(), []),
        safeLoad('تحليلات المشتريات', getProcurementAnalyticsApi(reportPeriod, reportStatus || undefined), null),
      ]);

      setPendingPrs(pending || []);
      setExecutivePendingPrs(executivePending || []);
      setQuotePrs(quotePending || []);
      setApprovedPrs(approved || []);
      setPos(ordersPage?.data || []);
      setPendingActualPos(actualOrdersPage?.data || []);
      if (ordersPage?.meta) setPoMeta(ordersPage.meta);
      setSuppliers(supplierData || []);
      setDepartments(departmentData || []);
      setCatalogItems(catalogData || []);
      setAnalytics(report);
      if (report) setAnalyticsError(null);
      if (loadErrors.length) {
        const message = `تعذر تحميل بعض بيانات لوحة المشتريات: ${loadErrors.join(' — ')}`;
        setPageError(message);
        if (!report) setAnalyticsError(loadErrors.find((error) => error.startsWith('تحليلات المشتريات')) || null);
      }
    } catch (error) {
      setPageError(parseApiError(error).message);
    } finally {
      if (isInitialLoad) {
        hasLoadedRef.current = true;
        setLoading(false);
      }
      setRefreshing(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  useRealtimeRefresh(() => { void loadData(); });

  useEffect(() => {
    const requestId = Number(searchParams.get('open') || 0);
    if (!requestId || loading) return;
    const request = [...pendingPrs, ...quotePrs, ...approvedPrs].find((item) => item.id === requestId);
    if (!request) return;
    setActiveTab(0);
    setQueueSearch(request.request_number);
    setSearchParams((current) => {
      current.delete('open');
      return current;
    }, { replace: true });
  }, [loading, pendingPrs, quotePrs, approvedPrs, searchParams, setSearchParams]);

  useEffect(() => {
    if (!hasLoadedRef.current) return;
    let cancelled = false;
    setRefreshing(true);
    getPurchaseOrdersApi({
      page: poPage,
      per_page: 15,
      ...(poSearch.trim() ? { search: poSearch.trim() } : {}),
      ...(poStatus !== 'ALL' ? { status: poStatus } : {}),
      ...(poSupplier !== 'ALL' ? { supplier_id: Number(poSupplier) } : {}),
      ...(poDateFrom ? { date_from: poDateFrom } : {}),
      ...(poDateTo ? { date_to: poDateTo } : {}),
    })
      .then((result) => { if (!cancelled) { setPos(result.data || []); setPoMeta(result.meta); } })
      .catch((error) => { if (!cancelled) { const message = parseApiError(error).message; setPageError(message); } })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, [poPage, poSearch, poStatus, poSupplier, poDateFrom, poDateTo]);

  const handleStartQuotes = async (request: PurchaseRequest) => {
    setRefreshing(true);
    try {
      const response = await approveProcurementPrApi(request.id, { use_quotes: true });
      await loadData();
      setQuoteRequest(response.data || request);
      setSuccessBanner(response.message || 'تم بدء مرحلة عروض الأسعار بنجاح.');
    } catch (error) {
      setPageError(parseApiError(error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleReject = (request: PurchaseRequest) => {
    setProcurementActionModal({
      isOpen: true,
      type: 'reject',
      request,
    });
  };

  const handleRevertRoute = (request: PurchaseRequest) => {
    setProcurementActionModal({
      isOpen: true,
      type: 'revert',
      request,
    });
  };

  const handleExecuteProcurementAction = async () => {
    if (!procurementActionModal) return;
    const { type, request } = procurementActionModal;
    setProcurementActionModal(null);
    setRefreshing(true);
    try {
      if (type === 'reject') {
        await rejectProcurementPrApi(request.id, 'تم الرفض بواسطة مدير المشتريات');
        setSuccessBanner(`تم رفض طلب الشراء ${request.request_number} بنجاح.`);
      } else {
        const response = await resetProcurementPrRouteApi(request.id);
        setSuccessBanner(response.message || 'تم التراجع عن مسار عروض الأسعار وإعادة الطلب لقسم اختيار المسار بنجاح.');
      }
      await loadData();
    } catch (error) {
      setPageError(parseApiError(error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSendDirectToAccounting = async (request: PurchaseRequest, financialData: DirectAccountingFinancialData) => {
    setDirectAccountingSubmitting(true);
    setDirectAccountingError(null);
    try {
      const response = await approveProcurementPrApi(request.id, {
        use_quotes: false,
        financial_data: financialData,
      });
      setDirectAccountingRequest(null);
      setDirectAccountingError(null);
      setSuccessBanner(response.message || 'تم إرسال الطلب بنجاح إلى المدير التنفيذي للاعتماد.');
      await loadData();
    } catch (error) {
      const errMessage = parseApiError(error).message;
      setDirectAccountingError(errMessage);
      setPageError(errMessage);
    } finally {
      setDirectAccountingSubmitting(false);
    }
  };

  const handlePrintPo = async (po: PurchaseOrder) => {
    setRefreshing(true);
    try {
      const fullPo = await getPurchaseOrderApi(po.id);
      setSelectedPrintPo(fullPo);
    } catch (error) {
      setPageError(parseApiError(error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const openAddSupplier = () => { setEditingSupplier(null); setSupplierModalOpen(true); };
  const openEditSupplier = (supplier: المورد) => { setEditingSupplier(supplier); setSupplierModalOpen(true); };
  const deleteSupplier = (supplier: المورد) => { setSupplierToDelete(supplier); };
  const confirmDeleteSupplier = async () => {
    if (!supplierToDelete) return;
    setDeletingSupplier(true);
    try {
      await deleteSupplierApi(supplierToDelete.id);
      setSupplierToDelete(null);
      await loadData();
    } catch (error) {
      setPageError(parseApiError(error).message);
    } finally {
      setDeletingSupplier(false);
    }
  };

  const retryAnalytics = async () => { await loadData(); };
  const clearPoFilters = () => { setPoSearch(''); setPoStatus('ALL'); setPoSupplier('ALL'); setPoDateFrom(defaultDateFrom); setPoDateTo(today); setPoPage(1); };
  const clearSupplierFilters = () => { setSupplierSearch(''); setSupplierStatus('ALL'); };
  const clearReportFilters = () => { setReportSearch(''); setReportDepartment('ALL'); setReportSupplier('ALL'); setReportItem('ALL'); setReportDateFrom(defaultDateFrom); setReportDateTo(today); };

  const exportReportCsv = () => {
    if (!filteredReportPos.length) return;
    const headers = ['رقم الأمر', 'التاريخ', 'المورد', 'القسم', 'الإجمالي'];
    const rows = filteredReportPos.map(po => [
      po.po_number,
      fmtDate(po.updated_at),
      po.supplier?.company_name || '—',
      po.department?.name || po.purchase_request?.department?.name || '—',
      po.grand_total
    ]);
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", `procurement_report_${today}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getSelectedQuote = (request: PurchaseRequest) => request.selected_quote || request.quotes?.find((quote) => (quote as typeof quote & { is_selected?: boolean }).is_selected || quote.status === 'SELECTED');
  const getReportItems = (po: PurchaseOrder): ReportLine[] => {
    if (po.items?.length) return po.items;
    if (po.purchase_request?.items?.length) return po.purchase_request.items;
    return [];
  };

  const containsText = (text: string | null | undefined, search: string) => !search || (text || '').toLocaleLowerCase('ar-EG').includes(search.toLocaleLowerCase('ar-EG'));

  const hasActiveSupplement = (req: PurchaseRequest) =>
    Boolean(
      req.supplements?.some((s: any) =>
        ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED', 'SUBMITTED'].includes(s.status)
      )
    );

  const queueRows = useMemo((): ProcurementQueueRow[] => {
    const seenIds = new Set<number>();
    const rows: ProcurementQueueRow[] = [];

    // 1. Ready for PO: all approved PRs + requests with reviewer-approved supplements
    // Complementary requests go straight to direct PO creation (READY_FOR_PO) without GM or Accounting pre-approvals!
    approvedPrs.forEach((request) => {
      seenIds.add(request.id);
      rows.push({ request, stage: 'READY_FOR_PO' });
    });

    // 2. Quote Setup
    quotePrs.forEach((request) => {
      if (!seenIds.has(request.id)) {
        if (hasActiveSupplement(request)) {
          seenIds.add(request.id);
          rows.push({ request, stage: 'READY_FOR_PO' });
        } else {
          seenIds.add(request.id);
          rows.push({ request, stage: 'QUOTE_SETUP' });
        }
      }
    });

    // 3. Pending Route
    pendingPrs.forEach((request) => {
      if (!seenIds.has(request.id)) {
        if (hasActiveSupplement(request) || request.request_type === 'COMPLEMENTARY') {
          seenIds.add(request.id);
          rows.push({ request, stage: 'READY_FOR_PO' });
        } else {
          seenIds.add(request.id);
          rows.push({ request, stage: 'PENDING_ROUTE' });
        }
      }
    });

    // 4. Executive Pending (Awaiting GM preliminary approval or final pricing decision)
    executivePendingPrs.forEach((request) => {
      if (!seenIds.has(request.id)) {
        seenIds.add(request.id);
        rows.push({ request, stage: 'EXECUTIVE_PENDING' });
      }
    });

    return rows;
  }, [pendingPrs, executivePendingPrs, quotePrs, approvedPrs]);

  const pendingCount = useMemo(() => queueRows.filter((r) => r.stage === 'PENDING_ROUTE').length, [queueRows]);
  const executivePendingCount = useMemo(() => queueRows.filter((r) => r.stage === 'EXECUTIVE_PENDING').length, [queueRows]);
  const quoteCount = useMemo(() => queueRows.filter((r) => r.stage === 'QUOTE_SETUP').length, [queueRows]);
  const readyForPoCount = useMemo(() => queueRows.filter((r) => r.stage === 'READY_FOR_PO').length, [queueRows]);
  const totalTasksCount = queueRows.length;

  const filteredQueueRows = useMemo(() => queueRows.filter(({ request, stage }) => {
    const search = queueSearch.trim();
    const pendingSupplement = request.supplements?.find(
      (s: any) => ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED', 'SUBMITTED'].includes(s.status)
    );
    const matchesSearch = !search ||
      containsText(request.request_number, search) ||
      containsText(request.requester?.name, search) ||
      containsText(request.department?.name, search) ||
      containsText(request.target_department?.name, search) ||
      (pendingSupplement && (
        containsText('كمالة', search) ||
        containsText('تكميلي', search) ||
        containsText(pendingSupplement.reviewer?.name, search) ||
        containsText(pendingSupplement.notes, search) ||
        pendingSupplement.items?.some((it: any) => containsText(it.item_description, search))
      )) ||
      request.items?.some(item => containsText(item.item?.name || item.item_description, search) || containsText(item.item_reference, search) || containsText(item.region, search));

    const matchesDept = queueDepartment === 'ALL' || request.department?.id === Number(queueDepartment) || request.department?.name === queueDepartment;
    const isDirect = request.procurement_route === 'DIRECT' || Boolean(pendingSupplement) || request.request_type === 'COMPLEMENTARY';

    let matchesRoute = true;
    if (queueRoute === 'ALL') {
      matchesRoute = true;
    } else if (queueRoute === 'SUPPLEMENT') {
      matchesRoute = Boolean(pendingSupplement) || request.request_type === 'COMPLEMENTARY';
    } else if (queueRoute === 'DIRECT') {
      matchesRoute = isDirect;
    } else if (queueRoute === 'QUOTES') {
      matchesRoute = request.procurement_route === 'QUOTES' && !pendingSupplement && request.request_type !== 'COMPLEMENTARY';
    } else if (queueRoute === 'UNDECIDED') {
      matchesRoute = !request.procurement_route && !pendingSupplement && request.request_type !== 'COMPLEMENTARY';
    }

    const matchesStage = queueStage === 'ALL' || stage === queueStage;
    const reqDate = String(pendingSupplement?.created_at || request.updated_at || request.created_at || '').slice(0, 10);
    const matchesDate = Boolean(pendingSupplement) || ((!queueDateFrom || reqDate >= queueDateFrom) && (!queueDateTo || reqDate <= queueDateTo));

    return matchesSearch && matchesDept && matchesRoute && matchesStage && matchesDate;
  }), [queueRows, queueSearch, queueDepartment, queueRoute, queueStage, queueDateFrom, queueDateTo]);

  const filteredPos = pos;
  const filteredSuppliers = suppliers.filter(s => {
    const search = supplierSearch.trim();
    const matchesSearch = !search || containsText(s.company_name, search) || containsText(s.code, search) || containsText(s.email, search) || containsText(s.phone, search);
    const matchesStatus = supplierStatus === 'ALL' || (supplierStatus === 'active' ? s.is_active : !s.is_active);
    return matchesSearch && matchesStatus;
  });

  const filteredReportPos = useMemo(() => {
    return pos.filter((po) => {
      const search = reportSearch.trim();
      const matchesSearch = !search || containsText(po.po_number, search) || containsText(po.supplier?.company_name, search) || containsText(po.department?.name || po.purchase_request?.department?.name, search) || containsText(po.requested_by?.name || po.purchase_request?.requester?.name, search);
      const matchesDept = reportDepartment === 'ALL' || po.department?.id === Number(reportDepartment) || po.department?.name === reportDepartment || po.purchase_request?.department?.id === Number(reportDepartment);
      const matchesSup = reportSupplier === 'ALL' || po.supplier_id === Number(reportSupplier);
      const matchesItem = reportItem === 'ALL' || po.items?.some((item) => item.item_id === Number(reportItem));
      const poDate = String(po.updated_at || '').slice(0, 10);
      const matchesDate = (!reportDateFrom || poDate >= reportDateFrom) && (!reportDateTo || poDate <= reportDateTo);
      return matchesSearch && matchesDept && matchesSup && matchesItem && matchesDate;
    });
  }, [pos, reportSearch, reportDepartment, reportSupplier, reportItem, reportDateFrom, reportDateTo]);

  const isActualPo = (po: any) =>
    Boolean(po.finalized_at) ||
    ['APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'].includes(po.status) ||
    (po.status === 'ISSUED' && Boolean(po.finalized_at));

  const reportTotals = useMemo(() => {
    const actualPos = filteredReportPos.filter(isActualPo);
    const totalValue = actualPos.reduce((sum, po) => sum + Number(po.grand_total || 0), 0);
    const totalQuantity = actualPos.reduce((sum, po) => sum + getReportItems(po).reduce((s, i) => s + Number(i.quantity || 0), 0), 0);
    const supplierCount = new Set(actualPos.map(po => po.supplier?.company_name || 'غير محدد')).size;
    return { totalValue, totalQuantity, supplierCount, averageValue: actualPos.length ? totalValue / actualPos.length : 0 };
  }, [filteredReportPos]);

  const reportDepartmentBreakdown = useMemo(() => {
    const map: Record<string, { name: string, count: number, total: number }> = {};
    filteredReportPos.forEach(po => {
      const name = po.department?.name || po.purchase_request?.department?.name || 'غير محدد';
      if (!map[name]) map[name] = { name, count: 0, total: 0 };
      map[name].count++;
      map[name].total += Number(po.grand_total || 0);
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [filteredReportPos]);

  const reportSupplierBreakdown = useMemo(() => {
    const map: Record<string, { name: string, count: number, total: number }> = {};
    filteredReportPos.forEach(po => {
      const name = po.supplier?.company_name || 'غير محدد';
      if (!map[name]) map[name] = { name, count: 0, total: 0 };
      map[name].count++;
      map[name].total += Number(po.grand_total || 0);
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [filteredReportPos]);

  const departmentOptions = departments.map(d => ({ value: String(d.id), label: d.name }));
  const supplierOptions = suppliers.map(s => ({ value: String(s.id), label: s.company_name }));
  const poStatuses = Array.from(new Set(pos.map(po => po.status)));

  const handleScrollToQueue = (stage: ProcurementQueueStage | 'ALL') => {
    setActiveTab(0);
    setQueueStage(stage);
    setTimeout(() => {
      const el = document.getElementById('procurement-queue-section');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 50);
  };

  const selectedQuotePrs = approvedPrs.filter(
    (pr) => Boolean(getSelectedQuote(pr)) && !(pr.issued_purchase_orders_count && pr.issued_purchase_orders_count > 0)
  );

  const procurementActionItems: ActionInboxItem[] = useMemo(() => {
    const items: ActionInboxItem[] = [];

    // 1. Actual POs pending issuance (Critical)
    pendingActualPos.forEach((po) => {
      const itemsList = po.items?.map((it: any) => ({
        description: it.item_description || it.item?.name || 'بند توريد',
        quantity: Number(it.quantity ?? it.actual_quantity ?? 0),
        uom: it.uom,
        unit_price: it.unit_price,
        line_total: it.line_total,
        specifications: it.specifications,
        parcel: it.item_reference,
        region: it.region,
      })) || [];

      items.push({
        id: `po-actual-${po.id}`,
        rawId: po.id,
        type: 'PO',
        code: po.po_number,
        title: `📦 إذن الاستلام معتمد — مطلوب إصدار أمر الشراء الفعلي (${po.supplier?.company_name || 'المورد'})`,
        subtitle: 'الموقع أتم الاستلام — يرجى مطابقة وتعديل الأسعار والكميات لإصدار الأمر الفعلي للإدارة المالية',
        department: po.department?.name || po.purchase_request?.department?.name,
        supplier: po.supplier?.company_name,
        amount: Number(po.grand_total || 0),
        urgency: 'CRITICAL',
        reason: 'تم استلام البضاعة واعتماد إذن الاستلام بالموقع — أمر الشراء بانتظار إصدار الأمر الفعلي من المشتريات لإرساله للإدارة المالية.',
        actionUrl: `/procurement/purchase-orders/${po.id}/edit`,
        actionLabel: '⚡ إصدار أمر الشراء الفعلي',
        onAction: () => {
          setFinalizePoId(po.id);
        },
        created_at: po.purchase_request?.created_at || po.created_at || undefined,
        timeAgo: (po.purchase_request?.created_at || po.created_at || po.updated_at) ? formatDateTime24h(po.purchase_request?.created_at || po.created_at || po.updated_at) : undefined,
        items_count: itemsList.length,
        items_list: itemsList,
      });
    });

    // 2. Returned POs from Accounting / GM
    pos.filter((p) => p.status === 'RETURNED_TO_PROCUREMENT').forEach((po) => {
      items.push({
        id: `po-ret-${po.id}`,
        rawId: po.id,
        type: 'PO',
        code: po.po_number,
        title: `أمر شراء معاد — ${po.supplier?.company_name || po.po_number}`,
        subtitle: 'معاد من الإدارة أو الحسابات لإعادة التدقيق والمراجعة',
        department: po.department?.name || po.purchase_request?.department?.name,
        supplier: po.supplier?.company_name,
        amount: Number(po.grand_total || 0),
        urgency: 'CRITICAL',
        reason: 'أمر شراء معاد من الحسابات/الإدارة يتطلب التعديل والمراجعة قبل إعادة الإرسال',
        actionUrl: `/procurement/purchase-orders/${po.id}/edit`,
        actionLabel: 'تعديل وإعادة إرسال الأمر',
        created_at: po.created_at || undefined,
        timeAgo: po.created_at ? formatDateTime24h(po.created_at) : undefined,
        items_count: po.items?.length || 0,
        items_list: po.items?.map((it: any) => ({
          description: it.item_description || it.item?.name || 'بند',
          quantity: it.quantity,
          uom: it.uom,
          unit_price: it.unit_price,
          line_total: it.line_total,
          parcel: it.item_reference,
          region: it.region,
        })),
      });
    });

    // 3. Approved PRs waiting for PO issuance
    approvedPrs.forEach((pr) => {
      items.push({
        id: `pr-app-${pr.id}`,
        rawId: pr.id,
        type: 'PR',
        code: pr.request_number,
        title: pr.justification || (pr.request_type === 'OFFICE_SUPPLIES' ? 'طلب مستلزمات مكتبية' : 'طلب مواد مشروعات'),
        subtitle: 'معتمد وجاهز لإصدار أمر الشراء فوراً',
        department: pr.department?.name,
        requester: pr.requester?.name,
        amount: pr.total_estimated_cost ? Number(pr.total_estimated_cost) : undefined,
        urgency: pr.priority === 'HIGH' || pr.priority === 'URGENT' ? 'HIGH' : 'NORMAL',
        reason: 'طلب شراء معتمد بالكامل — بانتظار إصدار أمر الشراء (PO) وتعميده للمورد',
        actionUrl: `/procurement/purchase-orders/create?pr=${pr.id}`,
        actionLabel: '📄 إصدار أمر الشراء (PO)',
        created_at: pr.created_at,
        timeAgo: pr.created_at ? formatDateTime24h(pr.created_at) : undefined,
        request_type: pr.request_type,
        date_needed: pr.date_needed || undefined,
        priority: pr.priority,
        parcel_number: pr.items?.[0]?.item_reference || undefined,
        region: pr.items?.[0]?.region || undefined,
        items_count: pr.items?.length || 0,
        items_list: pr.items?.map((it) => ({
          description: it.item_description || it.item?.name || 'صنف',
          quantity: it.quantity,
          uom: it.uom,
          parcel: it.item_reference,
          region: it.region,
          unit_price: it.estimated_unit_price,
          line_total: it.estimated_line_total,
        })),
      });
    });

    // 4. Pending Route PRs
    pendingPrs.forEach((pr) => {
      items.push({
        id: `pr-pending-${pr.id}`,
        rawId: pr.id,
        type: 'PR',
        code: pr.request_number,
        title: pr.justification || (pr.request_type === 'OFFICE_SUPPLIES' ? 'طلب مستلزمات مكتبية' : 'طلب مواد مشروعات'),
        subtitle: 'بانتظار تحديد مسار التوريد أو إصدار أمر الشراء المباشر',
        department: pr.department?.name,
        requester: pr.requester?.name,
        amount: pr.total_estimated_cost ? Number(pr.total_estimated_cost) : undefined,
        urgency: pr.priority === 'HIGH' || pr.priority === 'URGENT' ? 'HIGH' : 'NORMAL',
        reason: 'طلب معتمد محال للمشتريات لتحديد المسار (شراء مباشر أو طرح عروض أسعار)',
        actionUrl: `/procurement/purchase-orders/create?pr=${pr.id}`,
        actionLabel: 'تحديد مسار / إصدار PO',
        created_at: pr.created_at,
        timeAgo: pr.created_at ? formatDateTime24h(pr.created_at) : undefined,
        request_type: pr.request_type,
        date_needed: pr.date_needed || undefined,
        priority: pr.priority,
        parcel_number: pr.items?.[0]?.item_reference || undefined,
        region: pr.items?.[0]?.region || undefined,
        items_count: pr.items?.length || 0,
        items_list: pr.items?.map((it) => ({
          description: it.item_description || it.item?.name || 'صنف',
          quantity: it.quantity,
          uom: it.uom,
          parcel: it.item_reference,
          region: it.region,
          unit_price: it.estimated_unit_price,
          line_total: it.estimated_line_total,
        })),
      });
    });

    // 5. Quote PRs
    quotePrs.forEach((pr) => {
      items.push({
        id: `pr-quote-${pr.id}`,
        rawId: pr.id,
        type: 'QUOTE',
        code: pr.request_number,
        title: pr.justification || 'عروض أسعار بانتظار التسجيل والتجهيز',
        subtitle: 'مسار منافسة — يتطلب إدخال عروض الأسعار المقدمة من الموردين',
        department: pr.department?.name,
        requester: pr.requester?.name,
        amount: pr.total_estimated_cost ? Number(pr.total_estimated_cost) : undefined,
        urgency: 'HIGH',
        reason: 'طلب بمسار المنافسة يحتاج تسجيل عروض أسعار الموردين ورفع التوصيات',
        actionUrl: `/procurement?tab=0`,
        actionLabel: '🏷️ تجهيز عروض الأسعار',
        created_at: pr.created_at,
        timeAgo: pr.created_at ? formatDateTime24h(pr.created_at) : undefined,
        request_type: pr.request_type,
        items_count: pr.items?.length || 0,
        items_list: pr.items?.map((it) => ({
          description: it.item_description || it.item?.name || 'صنف',
          quantity: it.quantity,
          uom: it.uom,
          parcel: it.item_reference,
          region: it.region,
        })),
      });
    });

    // 6. Executive Pending PRs
    executivePendingPrs.forEach((pr) => {
      const isAlreadyPriced = pr.procurement_route === 'DIRECT';
      items.push({
        id: `pr-exec-${pr.id}`,
        rawId: pr.id,
        type: 'PR',
        code: pr.request_number,
        title: pr.justification || (pr.request_type === 'OFFICE_SUPPLIES' ? 'طلب مستلزمات مكتبية' : 'طلب مواد مشروعات'),
        subtitle: isAlreadyPriced ? 'تم التسعير وبانتظار اعتماد المدير التنفيذي النهائي' : 'بانتظار المدير التنفيذي — متاح لك التسعير المباشر والتخطي فوراً',
        department: pr.department?.name,
        requester: pr.requester?.name,
        amount: pr.total_estimated_cost ? Number(pr.total_estimated_cost) : undefined,
        urgency: pr.priority === 'HIGH' || pr.priority === 'URGENT' ? 'HIGH' : 'NORMAL',
        reason: isAlreadyPriced ? 'طلب مسعر بانتظار الاعتماد النهائي من الإدارة التنفيذية' : 'طلب شراء بانتظار المدير التنفيذي مع إمكانية التسعير المباشر وتجاوز الاعتماد المبدئي',
        actionUrl: `/procurement?open=${pr.id}`,
        actionLabel: isAlreadyPriced ? '👁️ مراجعة الطلب' : '🏷️ تسعير وتخطي للاعتماد',
        onAction: () => {
          if (!isAlreadyPriced) {
            setDirectAccountingError(null);
            setDirectAccountingRequest(pr);
          } else {
            setSelectedPrForDetails(pr);
          }
        },
        created_at: pr.created_at,
        timeAgo: pr.created_at ? formatDateTime24h(pr.created_at) : undefined,
        request_type: pr.request_type,
        date_needed: pr.date_needed || undefined,
        priority: pr.priority,
        parcel_number: pr.items?.[0]?.item_reference || undefined,
        region: pr.items?.[0]?.region || undefined,
        items_count: pr.items?.length || 0,
        items_list: pr.items?.map((it) => ({
          description: it.item_description || it.item?.name || 'صنف',
          quantity: it.quantity,
          uom: it.uom,
          parcel: it.item_reference,
          region: it.region,
          unit_price: it.estimated_unit_price,
          line_total: it.estimated_line_total,
        })),
      });
    });

    return items;
  }, [pendingActualPos, pos, approvedPrs, pendingPrs, quotePrs, executivePendingPrs]);

  if (loading) return <div className="min-h-[400px] p-8"><TableSkeleton rows={8} columns={6} /></div>;

  return (
    <div className="space-y-6 animate-fade-in" dir="rtl">
      {/* ── التنقل: المهام اللي عليها شغل بعددها، وبعدها روابط باقي الأقسام ── */}
      <nav aria-label="أقسام المشتريات" className="space-y-2.5">
        <div className="grid grid-cols-3 gap-2">
          {[
            {
              key: 'pending',
              label: 'الطلبات المعلقة',
              count: queueRows.length,
              active: activeTab === 0,
              onClick: () => navigate('/procurement/purchase-requests'),
            },
            {
              key: 'approved-quotes',
              label: 'الأسعار المعتمدة',
              count: selectedQuotePrs.length,
              active: activeTab === 2,
              onClick: () => { setActiveTab(2); setSearchParams({ tab: 'approved-quotes' }, { replace: true }); },
            },
            {
              key: 'actual-pos',
              label: 'الأوامر الفعلية',
              count: pendingActualPos.length,
              active: activeTab === 5,
              onClick: () => { setActiveTab(5); setSearchParams({ tab: 'actual-pos' }, { replace: true }); },
            },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={tab.onClick}
              aria-current={tab.active ? 'page' : undefined}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-2.5 text-center transition-colors cursor-pointer ${
                tab.active
                  ? 'border-amber-500 bg-amber-500/15'
                  : tab.count > 0
                  ? 'border-slate-700 bg-slate-900/80 hover:border-amber-500/60'
                  : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
              }`}
            >
              <span className={`font-mono text-xl font-black leading-none ${
                tab.active ? 'text-amber-300' : tab.count > 0 ? 'text-slate-50' : 'text-slate-500'
              }`}>
                {tab.count}
              </span>
              <span className={`w-full text-[11px] font-bold leading-4 sm:text-xs ${
                tab.active ? 'text-amber-200' : tab.count > 0 ? 'text-slate-200' : 'text-slate-500'
              }`}>
                {tab.label}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs font-bold">
          {[
            { key: 'pos', label: 'أرشيف أوامر الشراء', active: activeTab === 1, to: '/procurement/purchase-orders' },
            { key: 'suppliers', label: 'الموردين', active: activeTab === 3, to: '/procurement/suppliers' },
            { key: 'reports', label: 'التقارير', active: activeTab === 4, to: '/procurement/reports' },
          ].map((link) => (
            <button
              key={link.key}
              type="button"
              onClick={() => navigate(link.to)}
              aria-current={link.active ? 'page' : undefined}
              className={`py-1 underline-offset-4 transition-colors cursor-pointer hover:underline ${
                link.active ? 'text-amber-300 underline' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {link.label}
            </button>
          ))}
        </div>
      </nav>

      {successBanner && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200 shadow-lg shadow-emerald-950/40">
          <div className="flex items-center gap-2">
            <span className="text-lg">✅</span>
            <span className="font-bold">{successBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessBanner(null)}
            className="text-emerald-400 hover:text-emerald-200 text-xs font-bold px-2 py-1 rounded-lg border border-emerald-500/30 hover:bg-emerald-900/40 transition-colors"
          >
            إغلاق ✕
          </button>
        </div>
      )}

      {pageError && <ErrorMessage error={pageError} onDismiss={() => setPageError(null)} onRetry={() => void loadData()} />}

      {/* ── صندوق المهام والإجراءات المطلوبة منك الآن (4 Cards Grid) ── */}
      <div className="rounded-2xl border-2 border-cyan-500/30 bg-gradient-to-r from-slate-900 via-cyan-950/20 to-slate-900 p-4 sm:p-5 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-cyan-900/40 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-600/30 border border-cyan-500/50 text-cyan-300 text-lg font-black shadow-inner">
              ⚡
            </span>
            <div>
              <h2 className="text-base font-black text-slate-100 flex items-center gap-2">
                المهام والإجراءات المطلوبة منك الآن
                {totalTasksCount > 0 && (
                  <span className="rounded-full bg-cyan-500 text-slate-950 px-2.5 py-0.5 text-xs font-black">
                    {totalTasksCount} طلبات تحتاج إجراءات مشتريات
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                طلبات الشراء المعتمدة المحالة لقسم المشتريات لاختيار المسار وتجهيز العروض وإصدار أوامر الشراء.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5 pt-1">
          {/* Card 1: قرارات بانتظار المدير التنفيذي */}
          <div className="rounded-xl border border-purple-500/40 bg-gradient-to-b from-purple-950/30 to-slate-950/80 p-3.5 flex flex-col justify-between gap-3 hover:border-purple-400 hover:shadow-lg hover:shadow-purple-950/40 transition-all">
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-purple-200 font-bold flex items-center gap-1.5">
                  <span className="text-base">👑</span> بانتظار المدير التنفيذي
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
                  executivePendingCount > 0
                    ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                    : 'bg-slate-800 text-slate-400'
                }`}>
                  {executivePendingCount} طلب
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 leading-5">
                تقدر تسعّرها مباشرة من غير ما تستنى الاعتماد المبدئي
              </p>
            </div>
            <button
              type="button"
              className="w-full text-xs font-black bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-700 hover:from-purple-500 hover:to-indigo-500 text-white py-2.5 rounded-xl shadow-md transition-all cursor-pointer flex items-center justify-center gap-1.5"
              onClick={() => handleScrollToQueue('EXECUTIVE_PENDING')}
            >
              <span>عرض طلبات المدير التنفيذي ({executivePendingCount})</span>
              <span>←</span>
            </button>
          </div>

          {/* Card 2: تحديد مسار التوريد */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 flex flex-col justify-between gap-3 hover:border-amber-500/60 transition-colors">
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-200 font-bold flex items-center gap-1.5">
                  <span>🧭</span> تحديد مسار التوريد
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${pendingCount > 0 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-slate-800 text-slate-400'}`}>
                  {pendingCount} طلب بانتظار المسار
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 leading-5">
                طلبات معتمدة تتطلب اختيار مسار الشراء المباشر أو جمع عروض أسعار
              </p>
            </div>
            <button
              type="button"
              className="w-full text-xs font-bold border border-slate-700 bg-slate-900/90 hover:bg-slate-800 text-slate-200 py-2.5 rounded-xl transition-all cursor-pointer"
              onClick={() => handleScrollToQueue('PENDING_ROUTE')}
            >
              عرض طلبات تحديد المسار ({pendingCount}) ←
            </button>
          </div>

          {/* Card 2: جمع وتجهيز عروض الأسعار */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 flex flex-col justify-between gap-3 hover:border-indigo-500/60 transition-colors">
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-200 font-bold flex items-center gap-1.5">
                  <span>🏷️</span> جمع وتجهيز عروض الأسعار
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${quoteCount > 0 ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40' : 'bg-slate-800 text-slate-400'}`}>
                  {quoteCount} طلب بانتظار العروض
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 leading-5">
                طلبات بمسار المنافسة تحتاج تسجيل عروض أسعار الموردين ورفع التوصيات
              </p>
            </div>
            <button
              type="button"
              className="w-full text-xs font-bold border border-slate-700 bg-slate-900/90 hover:bg-slate-800 text-slate-200 py-2.5 rounded-xl transition-all cursor-pointer"
              onClick={() => handleScrollToQueue('QUOTE_SETUP')}
            >
              تجهيز عروض الأسعار ({quoteCount}) ←
            </button>
          </div>

          {/* Card 3: جاهزة لإصدار أمر شراء (PO) */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 flex flex-col justify-between gap-3 hover:border-emerald-500/60 transition-colors">
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-200 font-bold flex items-center gap-1.5">
                  <span>📄</span> جاهزة لإصدار أمر شراء (PO)
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${readyForPoCount > 0 ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-slate-800 text-slate-400'}`}>
                  {readyForPoCount} طلب جاهز للـ PO
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 leading-5">
                طلبات معتمدة بالكامل وجاهزة لإنشاء وإصدار أمر الشراء فوراً.
              </p>
            </div>
            <button
              type="button"
              className="w-full text-xs font-black bg-amber-500 hover:bg-amber-400 text-slate-950 py-2.5 rounded-xl shadow-md transition-all cursor-pointer"
              onClick={() => handleScrollToQueue('READY_FOR_PO')}
            >
              إنشاء أوامر الشراء ({readyForPoCount}) ←
            </button>
          </div>

          {/* Card 4: إصدار أمر الشراء الفعلي */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5 flex flex-col justify-between gap-3 hover:border-indigo-500/60 transition-colors">
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-200 font-bold flex items-center gap-1.5">
                  <span>⚡</span> إصدار أمر الشراء الفعلي
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${pendingActualPos.length > 0 ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40' : 'bg-slate-800 text-slate-400'}`}>
                  {pendingActualPos.length} أمر بانتظار الفعلي
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 leading-5">
                أذونات استلام معتمدة بالموقع تحتاج مطابقة الكميات والأسعار وإصدار الأمر الفعلي للإدارة المالية
              </p>
            </div>
            <button
              type="button"
              className="w-full text-xs font-black bg-amber-500 hover:bg-amber-400 text-slate-950 py-2.5 rounded-xl shadow-md transition-all cursor-pointer"
              onClick={() => {
                if (pendingActualPos.length > 0) {
                  const el = document.getElementById('pending-actual-pos-window');
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  else {
                    setActiveTab(5);
                    setSearchParams({ tab: 'actual-pos' }, { replace: true });
                  }
                } else {
                  setActiveTab(5);
                  setSearchParams({ tab: 'actual-pos' }, { replace: true });
                }
              }}
            >
              إصدار أوامر الشراء الفعلية ({pendingActualPos.length}) ←
            </button>
          </div>
        </div>
      </div>

      {/* ── نافذة أوامر الشراء الفعلية بانتظار الإصدار (Actual PO Window) ── */}
      {activeTab === 0 && pendingActualPos.length > 0 && (
        <div id="pending-actual-pos-window" className="rounded-2xl border-2 border-indigo-500/60 bg-gradient-to-r from-indigo-950/60 via-slate-900 to-slate-950 p-4 sm:p-5 shadow-2xl space-y-4 animate-fade-in scroll-mt-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-indigo-900/50 pb-3">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-600/30 border border-indigo-500/50 text-indigo-300 text-2xl font-black shadow-inner">
                📦
              </span>
              <div>
                <h3 className="text-sm sm:text-base font-black text-indigo-200 flex items-center gap-2">
                  <span>أوامر شراء معتمدة الاستلام — بانتظار إصدار أمر الشراء الفعلي (Actual PO)</span>
                  <span className="rounded-full bg-emerald-500 text-slate-950 px-2.5 py-0.5 text-xs font-black font-mono animate-pulse">
                    {pendingActualPos.length} أمر جاهز
                  </span>
                </h3>
                <p className="text-xs text-slate-300 mt-0.5">
                  تم فحص واعتماد الاستلام بالموقع من قبل أمين المخزن ومهندس الموقع. بصفتك إدارة المشتريات، راجع الكميات والأسعار واعتمد الأمر الفعلي لإرساله للإدارة المالية.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setActiveTab(5);
                setSearchParams({ tab: 'actual-pos' }, { replace: true });
              }}
              className="text-xs font-bold border-indigo-700/60 text-indigo-300 hover:bg-indigo-950 shrink-0 cursor-pointer"
            >
              عرض الجدول الكامل ({pendingActualPos.length}) ←
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {pendingActualPos.map((po) => {
              const latestReceipt = po.receipts?.[0];
              const itemsCount = po.items?.length || 0;
              return (
                <div
                  key={`pending-actual-card-${po.id}`}
                  className="rounded-xl border border-indigo-500/40 bg-slate-950/90 p-4 flex flex-col justify-between gap-3 hover:border-indigo-400 hover:shadow-indigo-950/40 transition-all shadow-md group"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-base font-black text-cyan-300">
                        {po.po_number}
                      </span>
                      <span className="rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-2.5 py-0.5 text-[11px] font-black">
                        {po.purchase_request?.request_type === 'OFFICE_SUPPLIES' || latestReceipt?.receipt_type === 'REQUESTER_OFFICE' ? 'استلام مكتبي معتمد' : 'استلام معتمد بالموقع'}
                      </span>
                    </div>

                    <div className="text-xs text-slate-300 font-bold">
                      🏢 المورد: <span className="text-slate-100">{po.supplier?.company_name || '—'}</span>
                    </div>

                    {po.purchase_request && (
                      <div className="text-xs text-slate-400 flex items-center justify-between">
                        <span>📋 الطلب: <strong className="font-mono text-cyan-400">{po.purchase_request.request_number}</strong></span>
                        {po.department?.name && <span className="text-[11px] text-slate-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-md">{po.department.name}</span>}
                      </div>
                    )}

                    {(po.purchase_request?.created_at || po.created_at) && (
                      <div className="text-[11px] font-mono text-slate-300 flex items-center gap-1.5 bg-slate-900/60 border border-slate-800 px-2.5 py-1 rounded-lg">
                        <span className="text-slate-500 font-sans">🕒 تاريخ ووقت الطلب:</span>
                        <strong className="text-cyan-300 tracking-tight" dir="ltr">{formatDateTime24h(po.purchase_request?.created_at || po.created_at)}</strong>
                      </div>
                    )}

                    {(() => {
                      const parcel = po.purchase_request?.parcel_reference || po.items?.find((i: any) => i.item_reference)?.item_reference;
                      const region = po.purchase_request?.region || po.items?.find((i: any) => i.region)?.region;
                      return (
                        <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2 text-xs space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400 text-[11px]">📦 ملخص البنود:</span>
                            <span className="text-slate-100 font-bold truncate max-w-[180px]">{getItemsSummaryDisplay(po.items as any)}</span>
                          </div>
                          {(parcel || region) && (
                            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/80">
                              <span className="text-cyan-400 font-mono font-bold text-[11px]">🏷️ قطعة: {parcel || '—'}</span>
                              <span className="text-amber-300 text-[11px]">📍 {region || '—'}</span>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {latestReceipt && (
                      <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5 text-[11px] text-slate-300 space-y-1">
                        <div className="flex items-center justify-between">
                          <span>📑 إذن الاستلام:</span>
                          <strong className="text-amber-300 font-mono text-xs">{latestReceipt.receipt_number}</strong>
                        </div>
                        {latestReceipt.site_engineer && (
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400">👷 معتمد الموقع:</span>
                            <strong className="text-slate-200">{latestReceipt.site_engineer.name}</strong>
                          </div>
                        )}
                        {latestReceipt.receiver && !latestReceipt.site_engineer && (
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400">👤 مستلم المقر:</span>
                            <strong className="text-slate-200">{latestReceipt.receiver.name}</strong>
                          </div>
                        )}
                        {latestReceipt.warehouse_keeper && (
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400">📦 أمين المخزن:</span>
                            <strong className="text-slate-300">{latestReceipt.warehouse_keeper.name}</strong>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-800">
                      <span className="text-slate-400">{itemsCount} بنود توريد</span>
                      <span className="font-mono font-black text-emerald-400 text-sm">
                        {fmtAmount(po.grand_total)} ج.م
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1 border-t border-slate-900">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => navigate(`/procurement/purchase-orders/${po.id}/edit`)}
                      className="w-full text-xs font-black bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 text-white shadow-md shadow-emerald-950/40 flex items-center justify-center gap-1.5 py-2.5 rounded-xl cursor-pointer"
                    >
                      <span>⚡</span> إصدار أمر الشراء الفعلي
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setCyclePrintPo(po)}
                      className="text-xs text-cyan-300 border-cyan-800/60 hover:bg-cyan-950/50 px-2.5 py-2.5 rounded-xl shrink-0 cursor-pointer"
                      title="طباعة ومعاينة الدورة (3 في 1)"
                    >
                      🖨️
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => navigate(`/procurement/purchase-orders/${po.id}`)}
                      className="text-xs text-slate-300 hover:text-white px-2.5 py-2.5 rounded-xl shrink-0 cursor-pointer"
                      title="عرض تفاصيل أمر الشراء"
                    >
                      🔍
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 0 && (
        <section id="procurement-queue-section" className="space-y-4 scroll-mt-6">
          <div className="flex flex-col gap-3 border-b border-slate-800 pb-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-base font-bold text-cyan-300">طابور طلبات المشتريات الموحد ({filteredQueueRows.length} من {queueRows.length})</h2>
              <p className="mt-1 text-xs leading-6 text-slate-400">كل الطلبات الواردة للمشتريات في جدول واحد. يوضح الجدول المسار والمرحلة الحالية، ويعرض الإجراء المتاح حسب حالة الطلب.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
              <button
                type="button"
                onClick={() => setQueueStage(queueStage === 'EXECUTIVE_PENDING' ? 'ALL' : 'EXECUTIVE_PENDING')}
                className={`rounded-full border px-3 py-1.5 transition-all cursor-pointer ${
                  queueStage === 'EXECUTIVE_PENDING'
                    ? 'border-purple-400 bg-purple-500/20 text-purple-200 ring-2 ring-purple-500/30 font-black'
                    : 'border-purple-700/50 bg-purple-950/30 text-purple-300 hover:border-purple-500/60'
                }`}
              >
                👑 قرارات المدير التنفيذي: {executivePendingCount}
              </button>
              <button
                type="button"
                onClick={() => setQueueStage(queueStage === 'PENDING_ROUTE' ? 'ALL' : 'PENDING_ROUTE')}
                className={`rounded-full border px-3 py-1.5 transition-all cursor-pointer ${
                  queueStage === 'PENDING_ROUTE'
                    ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200 ring-2 ring-cyan-500/30 font-black'
                    : 'border-cyan-700/50 bg-cyan-950/30 text-cyan-300 hover:border-cyan-500/60'
                }`}
              >
                اختيار المسار: {queueRows.filter((row) => row.stage === 'PENDING_ROUTE').length}
              </button>
              <button
                type="button"
                onClick={() => setQueueStage(queueStage === 'QUOTE_SETUP' ? 'ALL' : 'QUOTE_SETUP')}
                className={`rounded-full border px-3 py-1.5 transition-all cursor-pointer ${
                  queueStage === 'QUOTE_SETUP'
                    ? 'border-amber-400 bg-amber-500/20 text-amber-200 ring-2 ring-amber-500/30 font-black'
                    : 'border-amber-700/50 bg-amber-950/30 text-amber-300 hover:border-amber-500/60'
                }`}
              >
                تجهيز العروض: {queueRows.filter((row) => row.stage === 'QUOTE_SETUP').length}
              </button>
              <button
                type="button"
                onClick={() => setQueueStage(queueStage === 'READY_FOR_PO' ? 'ALL' : 'READY_FOR_PO')}
                className={`rounded-full border px-3 py-1.5 transition-all cursor-pointer ${
                  queueStage === 'READY_FOR_PO'
                    ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200 ring-2 ring-emerald-500/30 font-black'
                    : 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300 hover:border-emerald-500/60'
                }`}
              >
                جاهز لأمر الشراء: {queueRows.filter((row) => row.stage === 'READY_FOR_PO').length}
              </button>
              {pendingActualPos.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const el = document.getElementById('pending-actual-pos-window');
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    else {
                      setActiveTab(5);
                      setSearchParams({ tab: 'actual-pos' }, { replace: true });
                    }
                  }}
                  className="rounded-full border border-indigo-500/80 bg-indigo-950/50 px-3 py-1.5 text-indigo-300 hover:bg-indigo-900/60 shadow-sm shadow-indigo-950/40 cursor-pointer animate-pulse font-black"
                >
                  ⚡ أوامر الشراء الفعلية: {pendingActualPos.length}
                </button>
              )}
            </div>
          </div>

          <TableFilterBar
            buttonsFirst={true}
            searchValue={queueSearch}
            onSearchChange={setQueueSearch}
            searchPlaceholder="بحث برقم الطلب أو الموظف أو القسم أو الصنف أو رقم قطعة الأرض أو المنطقة..."
            selects={[
              { label: 'القسم المصدر', value: queueDepartment, onChange: setQueueDepartment, options: [{ value: 'ALL', label: 'كل الأقسام' }, ...departmentOptions] },
              { label: 'مسار الشراء', value: queueRoute, onChange: setQueueRoute, options: [{ value: 'ALL', label: 'كل المسارات' }, { value: 'UNDECIDED', label: 'لم يتم تحديده' }, { value: 'DIRECT', label: 'شراء مباشر' }, { value: 'QUOTES', label: 'عروض أسعار' }, { value: 'SUPPLEMENT', label: '⚡ مسار طلب كمالة مباشر' }] },
              { label: 'مرحلة التنفيذ', value: queueStage, onChange: setQueueStage, options: [{ value: 'ALL', label: 'كل المراحل' }, { value: 'EXECUTIVE_PENDING', label: '👑 قرارات بانتظار المدير التنفيذي' }, { value: 'PENDING_ROUTE', label: QUEUE_STAGE_LABELS.PENDING_ROUTE }, { value: 'QUOTE_SETUP', label: QUEUE_STAGE_LABELS.QUOTE_SETUP }, { value: 'READY_FOR_PO', label: QUEUE_STAGE_LABELS.READY_FOR_PO }] },
            ]}
            dateFrom={queueDateFrom}
            dateTo={queueDateTo}
            onDateFromChange={setQueueDateFrom}
            onDateToChange={setQueueDateTo}
            onClear={() => { setQueueSearch(''); setQueueDepartment('ALL'); setQueueRoute('ALL'); setQueueStage('ALL'); setQueueDateFrom(defaultDateFrom); setQueueDateTo(today); }}
            hasActiveFilters={Boolean(queueSearch || queueDepartment !== 'ALL' || queueRoute !== 'ALL' || queueStage !== 'ALL' || queueDateFrom !== defaultDateFrom || queueDateTo !== today)}
            resultCount={filteredQueueRows.length}
            totalCount={queueRows.length}
            resultLabel="طلب"
          />

          {/* Unified Cards View - 100% width, ZERO horizontal scroll */}
          {filteredQueueRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-12 text-center text-slate-400">
              <span className="text-3xl block mb-2">📋</span>
              <p className="text-sm font-bold text-slate-300">
                {queueRows.length ? 'لم نجد طلبات مطابقة للفلاتر الحالية.' : 'لا توجد طلبات واردة للمشتريات ضمن الفترة المحددة.'}
              </p>
              <p className="text-xs text-slate-500 mt-1">جرّب مسح الفلاتر أو تغيير نطاق البحث.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredQueueRows.map(({ request, stage }) => {
                const pendingSupplement = request.supplements?.find(
                  (s: any) => ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED', 'SUBMITTED'].includes(s.status)
                );
                const suppItems = pendingSupplement?.items || [];
                const activeItems = suppItems.length > 0 ? suppItems : (request.items || []);
                const itemNames = getItemsSummaryDisplay(activeItems);
                const suppParcels = suppItems.map((it: any) => it.item_reference).filter(Boolean);
                const suppRegions = suppItems.map((it: any) => it.region).filter(Boolean);
                const parcelsDisplay = suppParcels.length > 0 ? Array.from(new Set(suppParcels)).join('، ') : getSummaryParcels(request);
                const regionsDisplay = suppRegions.length > 0 ? Array.from(new Set(suppRegions)).join('، ') : getSummaryRegions(request);
                const quantitiesInfo = getSummaryQuantities(suppItems.length > 0 ? suppItems : request.items);
                const supplier = request.direct_supplier?.company_name || getSelectedQuote(request)?.supplier?.company_name;
                const isComplementaryRequest = request.request_type === 'COMPLEMENTARY';
                const isAnySupplement = Boolean(pendingSupplement) || isComplementaryRequest;
                const stageClass = stage === 'PENDING_ROUTE' 
                  ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' 
                  : stage === 'QUOTE_SETUP' 
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' 
                  : stage === 'EXECUTIVE_PENDING'
                  ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
                const route = isAnySupplement
                  ? '⚡ شراء مباشر (كمالة)'
                  : stage === 'EXECUTIVE_PENDING'
                  ? (request.procurement_route === 'DIRECT' ? '⚡ شراء مباشر مسعر' : '⏳ بانتظار الاعتماد المبدئي')
                  : request.procurement_route === 'DIRECT' 
                  ? 'شراء مباشر' 
                  : request.procurement_route === 'QUOTES' 
                  ? 'عروض أسعار' 
                  : 'لم يحدد المسار';

                return (
                  <article
                    key={`${stage}-${request.id}`}
                    className={`rounded-2xl border p-4 sm:p-5 shadow-lg transition-all space-y-4 ${
                      isAnySupplement
                        ? 'border-amber-500/60 bg-gradient-to-b from-slate-900 via-amber-950/20 to-slate-950 shadow-amber-950/30'
                        : stage === 'EXECUTIVE_PENDING'
                        ? 'border-purple-500/60 bg-gradient-to-b from-slate-900 via-purple-950/20 to-slate-950 shadow-purple-950/30 hover:border-purple-400'
                        : 'border-slate-800/90 bg-gradient-to-b from-slate-900/90 to-slate-950/90 hover:border-slate-700'
                    }`}
                  >
                    {/* Header Row */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="font-mono text-base font-black text-cyan-300">
                          {request.request_number}
                        </span>
                        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${stageClass}`}>
                          {QUEUE_STAGE_LABELS[stage]}
                        </span>
                        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                          pendingSupplement
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                            : stage === 'EXECUTIVE_PENDING'
                            ? 'bg-purple-500/20 text-purple-300 border-purple-500/50'
                            : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}>
                          {route}
                        </span>
                        {request.priority && request.priority !== 'NORMAL' && (
                          <span className="rounded-full bg-rose-500/20 border border-rose-500/40 px-2 py-0.5 text-[11px] font-bold text-rose-300">
                            عاجل
                          </span>
                        )}
                        {stage === 'EXECUTIVE_PENDING' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-purple-500/25 to-indigo-600/25 border border-purple-500/50 px-3 py-1 text-xs font-black text-purple-200 shadow-sm shadow-purple-500/20">
                            <span>👑</span>
                            <span>
                              {request.procurement_route === 'DIRECT'
                                ? 'طلب تم تسعيره وهو بانتظار موافقة المدير التنفيذي النهائية للتحويل للحسابات'
                                : 'بانتظار موافقة المدير التنفيذي المبدئية — يمكنك التسعير وتخطي الاعتماد المبدئي مباشرة'}
                            </span>
                          </span>
                        )}
                        {pendingSupplement && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-500/25 to-amber-600/25 border border-amber-500/50 px-3 py-1 text-xs font-black text-amber-300 animate-pulse shadow-sm shadow-amber-500/20">
                            <span>⚡</span>
                            <span>كمالة دفعة #{pendingSupplement.batch_number} معتمدة ({pendingSupplement.reviewer?.name || 'م. مصطفى رئيس قسم التراخيص'})</span>
                          </span>
                        )}
                        {isComplementaryRequest && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-500/25 to-amber-600/25 border border-amber-500/50 px-3 py-1 text-xs font-black text-amber-300 shadow-sm shadow-amber-500/20">
                            <span>⚡</span>
                            <span>طلب كمالة مستقل معتمد (مسار سريع)</span>
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 self-start sm:self-auto">
                        <button
                          type="button"
                          onClick={() => setSelectedPrForDetails(request)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-600/50 bg-cyan-950/40 hover:bg-cyan-900/60 px-3 py-1.5 text-xs font-bold text-cyan-200 transition-colors shadow-sm cursor-pointer"
                        >
                          <span>👁️</span>
                          <span>عرض تفاصيل الطلب كاملة</span>
                        </button>
                        <span className="font-mono text-xs text-slate-300 bg-slate-950/80 border border-slate-800 px-2.5 py-1 rounded-lg flex items-center gap-1.5 shadow-xs" title="تاريخ ووقت تقديم الطلب">
                          <span className="text-amber-400 text-xs">🕒</span>
                          <span dir="ltr">{formatDateTime24h(request.created_at)}</span>
                        </span>
                      </div>
                    </div>

                    {/* Content Grid - 100% width, no horizontal scrolling */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                      {/* Column 1: Departments */}
                      <div className="rounded-xl border border-slate-800/60 bg-slate-950/50 p-3 space-y-1.5">
                        <div className="text-[11px] text-slate-400 font-semibold">الجهة والقسم:</div>
                        <div className="font-bold text-slate-200 truncate" title={request.department?.name || 'غير محدد'}>
                          المصدر: <span className="text-slate-100">{request.department?.name || (request.requester as any)?.department?.name || 'غير محدد'}</span>
                        </div>
                        <div className="font-bold text-cyan-300 truncate" title={request.target_department?.name || 'غير محدد'}>
                          المستهدف: <span>{request.target_department?.name || request.department?.name || 'غير محدد'}</span>
                        </div>
                      </div>

                      {/* Column 2: Requester & Reviewer */}
                      <div className="rounded-xl border border-slate-800/60 bg-slate-950/50 p-3 space-y-1.5">
                        <div className="text-[11px] text-slate-400 font-semibold">مقدم الطلب ورئيس القسم:</div>
                        <div className="text-slate-300 truncate">
                          مقدم الطلب: <strong className="text-slate-100 font-semibold">{request.requester?.name || '—'}</strong>
                        </div>
                        <div className="text-slate-300 truncate">
                          المراجع: <strong className="text-emerald-300 font-bold">{pendingSupplement?.reviewer?.name || reviewerName(request, departments)}</strong>
                        </div>
                      </div>

                      {/* Column 3: Items & Quantities */}
                      <div className="rounded-xl border border-slate-800/60 bg-slate-950/50 p-3 space-y-1.5">
                        <div className="text-[11px] text-slate-400 font-semibold">الأصناف والكميات:</div>
                        <div className="font-bold text-slate-100 line-clamp-1" title={itemNames}>
                          {itemNames}
                        </div>
                        <div className="text-amber-300 font-mono font-bold" title={quantitiesInfo.tooltip}>
                          {quantitiesInfo.display}
                          {quantitiesInfo.subtext && <span className="text-[10px] text-slate-400 font-normal mr-1">{quantitiesInfo.subtext}</span>}
                        </div>
                      </div>

                      {/* Column 4: Location & Delivery Date */}
                      <div className="rounded-xl border border-slate-800/60 bg-slate-950/50 p-3 space-y-1.5">
                        <div className="text-[11px] text-slate-400 font-semibold">الموقع والموعد:</div>
                        <div className="text-slate-300 truncate">
                          الموقع: <strong className="font-mono text-cyan-300">{parcelsDisplay}</strong> {regionsDisplay !== '—' && `• ${regionsDisplay}`}
                        </div>
                        <div className="text-slate-300">
                          تاريخ الاحتياج: <strong className="font-mono text-amber-300 font-bold">{request.date_needed || '—'}</strong>
                        </div>
                        {supplier && (
                          <div className="text-emerald-300 truncate font-semibold">
                            المورد: {supplier}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Action Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/60">
                      <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-cyan-400" />
                        <span>الحالة: <strong className="text-slate-200">{statusLabel(request.status)}</strong></span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {/* ── Supplement Fast-Track Button (replaces standard quote buttons) ── */}
                        {pendingSupplement ? (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => {
                                setSupplementModalPr(request);
                                setSupplementModalData(pendingSupplement as unknown as PurchaseRequestSupplement);
                                setSupplementModalOpen(true);
                              }}
                              className="font-black bg-gradient-to-r from-amber-500 via-amber-600 to-amber-700 hover:from-amber-400 hover:to-amber-600 text-slate-950 shadow-lg shadow-amber-800/30 border border-amber-400/30"
                            >
                              ⚡ إنشاء أمر شراء مباشر (كمالة)
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => handleReject(request)}
                            >
                              رفض
                            </Button>
                          </>
                        ) : isComplementaryRequest ? (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => navigate(`/procurement/purchase-orders/create?pr=${request.id}&returnUrl=${encodeURIComponent('/procurement')}`, { state: { returnTo: '/procurement' } })}
                              className="font-black bg-gradient-to-r from-amber-500 via-amber-600 to-amber-700 hover:from-amber-400 hover:to-amber-600 text-slate-950 shadow-lg shadow-amber-800/30 border border-amber-400/30"
                            >
                              ⚡ إنشاء أمر شراء مباشر (كمالة)
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => handleReject(request)}
                            >
                              رفض
                            </Button>
                          </>
                        ) : (
                          <>
                            {stage === 'EXECUTIVE_PENDING' && (
                              <>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => {
                                    setDirectAccountingError(null);
                                    setDirectAccountingRequest(request);
                                  }}
                                  className="font-black bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-md shadow-purple-950/40 flex items-center gap-1.5"
                                >
                                  <span>🏷️</span>
                                  <span>{request.procurement_route === 'DIRECT' ? 'تعديل بيانات التسعير' : 'تسعير مباشر وتخطي الاعتماد المبدئي'}</span>
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => void handleStartQuotes(request)}
                                  className="font-bold border-cyan-700/60 text-cyan-200 hover:bg-cyan-950/50 flex items-center gap-1"
                                >
                                  <span>🎯</span>
                                  <span>بدء عروض الأسعار</span>
                                </Button>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() => handleReject(request)}
                                >
                                  رفض
                                </Button>
                              </>
                            )}
                            {stage === 'PENDING_ROUTE' && (
                              <>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => void handleStartQuotes(request)}
                                  className="font-bold shadow-md shadow-cyan-900/30"
                                >
                                  🎯 بدء عروض الأسعار
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                    setDirectAccountingError(null);
                                    setDirectAccountingRequest(request);
                                  }}
                                  className="font-bold border-amber-700/60 text-amber-200 hover:bg-amber-950/50"
                                >
                                  👤 إرسال للمدير التنفيذي للاعتماد
                                </Button>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() => handleReject(request)}
                                >
                                  رفض
                                </Button>
                              </>
                            )}
                            {stage === 'QUOTE_SETUP' && (
                              <>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => setQuoteRequest(request)}
                                  className="font-bold bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-900/30"
                                >
                                  📝 إدخال عروض الأسعار
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => void handleRevertRoute(request)}
                                  className="font-bold border-amber-600/70 text-amber-300 hover:bg-amber-950/50 flex items-center gap-1 shadow-sm"
                                  title="التراجع عن عروض الأسعار والعودة لقسم اختيار المسار / الشراء المباشر"
                                >
                                  <span>↩️</span>
                                  <span>تراجع لاختيار المسار / شراء مباشر</span>
                                </Button>
                              </>
                            )}
                            {stage === 'READY_FOR_PO' && (
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => navigate(`/procurement/purchase-orders/create?pr=${request.id}${getSelectedQuote(request)?.id ? `&quote=${getSelectedQuote(request)?.id}` : ''}&returnUrl=${encodeURIComponent('/procurement')}`, { state: { returnTo: '/procurement' } })}
                                className="font-bold bg-emerald-600 hover:bg-emerald-500 text-slate-950 shadow-md shadow-emerald-900/30"
                              >
                                📑 إنشاء أمر الشراء
                              </Button>
                            )}
                          </>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setSelectedPrForDetails(request)}
                          className="text-xs"
                        >
                          🔍 التفاصيل الكاملة
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === 2 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="text-base font-bold text-amber-300">أسعار اعتمدها المدير التنفيذي — جاهزة لإنشاء أمر شراء ({selectedQuotePrs.length})</h2><span className="text-xs text-slate-400">المورد والسعر ورقم قطعة الأرض مأخوذة من الطلب والعرض المعتمد</span></div>
          <div className="hidden min-w-0 md:block"><Table><TableHeader><TableRow><TableHead className="whitespace-nowrap">رقم الطلب</TableHead><TableHead className="whitespace-nowrap">ملخص البنود</TableHead><TableHead className="whitespace-nowrap">رقم قطعة الأرض</TableHead><TableHead className="whitespace-nowrap">المنطقة</TableHead><TableHead className="whitespace-nowrap">الكمية والوحدة</TableHead><TableHead className="whitespace-nowrap">المورد المختار</TableHead><TableHead className="whitespace-nowrap">تاريخ الاحتياج</TableHead><TableHead className="whitespace-nowrap">سعر الوحدة</TableHead><TableHead className="whitespace-nowrap">الإجمالي</TableHead><TableHead className="whitespace-nowrap">الإجراء</TableHead></TableRow></TableHeader><TableBody>{selectedQuotePrs.length === 0 ? <TableRow><TableCell colSpan={10} className="py-10 text-center text-slate-400">لا توجد أسعار معتمدة تنتظر إنشاء أمر شراء.</TableCell></TableRow> : selectedQuotePrs.map((request) => { const item = request.items?.[0]; const quote = getSelectedQuote(request); const itemSummary = getItemsSummaryDisplay(request.items); const parcelRef = request.parcel_reference || item?.item_reference || '—'; const regionName = request.region || item?.region || '—'; const qtyDisplay = item?.quantity ? `${item.quantity} ${getUnitLabel(item.uom)}` : '—'; return <TableRow key={request.id}><TableCell className="whitespace-nowrap font-mono font-bold text-cyan-300">{request.request_number}</TableCell><TableCell className="max-w-[200px] font-bold text-slate-100">{itemSummary}</TableCell><TableCell className="whitespace-nowrap font-mono font-bold text-cyan-300">{parcelRef}</TableCell><TableCell className="text-slate-200">{regionName}</TableCell><TableCell className="whitespace-nowrap font-mono text-amber-300 font-bold">{qtyDisplay}</TableCell><TableCell className="max-w-[180px] font-bold">{quote?.supplier?.company_name || '—'}</TableCell><TableCell className="whitespace-nowrap font-mono font-bold text-amber-300">{request.date_needed || '—'}</TableCell><TableCell className="whitespace-nowrap font-mono font-bold text-amber-300">{quote?.unit_price || '—'} ج.م</TableCell><TableCell className="whitespace-nowrap font-mono font-bold text-emerald-300">{quote?.total_amount || '—'} ج.م</TableCell><TableCell><Button variant="primary" size="sm" className="whitespace-nowrap" onClick={() => navigate(`/procurement/purchase-orders/create?pr=${request.id}&quote=${quote?.id || ''}&returnUrl=${encodeURIComponent('/procurement?tab=approved-quotes')}`, { state: { returnTo: '/procurement?tab=approved-quotes' } })}>إنشاء أمر شراء</Button></TableCell></TableRow>; })}</TableBody></Table></div><div className="space-y-3 md:hidden">{selectedQuotePrs.length === 0 ? <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-400">لا توجد أسعار معتمدة تنتظر إنشاء أمر شراء.</div> : selectedQuotePrs.map((request) => { const item = request.items?.[0]; const quote = getSelectedQuote(request); const itemSummary = getItemsSummaryDisplay(request.items); const parcelRef = request.parcel_reference || item?.item_reference || '—'; const regionName = request.region || item?.region || '—'; const qtyDisplay = item?.quantity ? `${item.quantity} ${getUnitLabel(item.uom)}` : '—'; return <article key={`mobile-approved-quote-${request.id}`} className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/80 p-4"><div className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0 break-normal font-mono text-sm font-black text-cyan-300">{request.request_number}</span><span className="shrink-0 text-[11px] text-amber-300">سعر معتمد</span></div><dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 text-xs min-[420px]:grid-cols-2"><div className="min-[420px]:col-span-2"><dt className="text-slate-500">ملخص البنود</dt><dd className="mt-1 break-normal font-bold leading-6 text-slate-100">{itemSummary}</dd></div><div><dt className="text-slate-500">قطعة الأرض</dt><dd className="mt-1 break-normal font-mono font-bold text-cyan-300">{parcelRef}</dd></div><div><dt className="text-slate-500">المنطقة</dt><dd className="mt-1 break-normal text-slate-300">{regionName}</dd></div><div><dt className="text-slate-500">الكمية والوحدة</dt><dd className="mt-1 font-mono font-bold text-amber-300">{qtyDisplay}</dd></div><div><dt className="text-slate-500">تاريخ الاحتياج</dt><dd className="mt-1 font-mono font-bold text-amber-300">{request.date_needed || '—'}</dd></div><div><dt className="text-slate-500">المورد المختار</dt><dd className="mt-1 break-normal font-bold leading-6 text-slate-100">{quote?.supplier?.company_name || 'غير محدد'}</dd></div><div><dt className="text-slate-500">سعر الوحدة</dt><dd className="mt-1 whitespace-nowrap font-mono font-bold text-amber-300">{quote?.unit_price || '—'} ج.م</dd></div><div className="min-[420px]:col-span-2"><dt className="text-slate-500">الإجمالي</dt><dd className="mt-1 whitespace-nowrap font-mono font-bold text-emerald-300">{quote?.total_amount || '—'} ج.م</dd></div></dl><Button variant="primary" size="sm" className="mt-4 w-full whitespace-nowrap" onClick={() => navigate(`/procurement/purchase-orders/create?pr=${request.id}&quote=${quote?.id || ''}&returnUrl=${encodeURIComponent('/procurement?tab=approved-quotes')}`, { state: { returnTo: '/procurement?tab=approved-quotes' } })}>إنشاء أمر شراء</Button></article>; })}</div>
        </section>
      )}

      {activeTab === 1 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="text-base font-bold text-cyan-300">أرشيف أوامر الشراء ({poMeta.total})</h2>
<Button variant="primary" size="sm" onClick={() => setDirectPoOpen(true)}>+ طلب شراء مباشر</Button></div>
          <TableFilterBar
            searchValue={poSearch}
            onSearchChange={(value) => { setPoSearch(value); setPoPage(1); }}
            searchPlaceholder="بحث برقم أمر الشراء أو الطلب أو المورد أو القسم..."
            selects={[
              { label: 'الحالة', value: poStatus, onChange: (value) => { setPoStatus(value); setPoPage(1); }, options: [{ value: 'ALL', label: 'كل الحالات' }, ...poStatuses.map((status) => ({ value: status, label: statusLabel(status) }))] },
              { label: 'المورد', value: poSupplier, onChange: (value) => { setPoSupplier(value); setPoPage(1); }, options: [{ value: 'ALL', label: 'كل الموردين' }, ...supplierOptions] },
            ]}
            dateFrom={poDateFrom}
            dateTo={poDateTo}
            onDateFromChange={(value) => { setPoDateFrom(value); setPoPage(1); }}
            onDateToChange={(value) => { setPoDateTo(value); setPoPage(1); }}
            onClear={clearPoFilters}
            hasActiveFilters={Boolean(poSearch || poStatus !== 'ALL' || poSupplier !== 'ALL' || poDateFrom !== defaultDateFrom || poDateTo !== today)}
            resultCount={filteredPos.length}
            totalCount={poMeta.total}
            resultLabel="أمر شراء"
          />
          <div className="hidden min-w-0 md:block"><Table><TableHeader><TableRow><TableHead className="whitespace-nowrap">رقم الأمر</TableHead><TableHead className="whitespace-nowrap">رقم الطلب</TableHead><TableHead className="whitespace-nowrap">المورد</TableHead><TableHead className="whitespace-nowrap">القسم</TableHead><TableHead className="whitespace-nowrap">مقدم الطلب</TableHead><TableHead className="whitespace-nowrap">رئيس القسم</TableHead><TableHead className="whitespace-nowrap">ملخص البنود</TableHead><TableHead className="whitespace-nowrap">قطعة الأرض</TableHead><TableHead className="whitespace-nowrap">المنطقة</TableHead><TableHead className="whitespace-nowrap">الوحدة</TableHead><TableHead className="whitespace-nowrap">الكمية</TableHead><TableHead className="whitespace-nowrap">المبلغ</TableHead><TableHead className="whitespace-nowrap">الحالة</TableHead><TableHead className="whitespace-nowrap">التاريخ</TableHead><TableHead className="whitespace-nowrap text-center">إجراء</TableHead></TableRow></TableHeader><TableBody>{filteredPos.length === 0 ? <TableRow><TableCell colSpan={15} className="py-8 text-center text-slate-400">{poMeta.total ? 'لم نجد أوامر شراء مطابقة للفلاتر الحالية.' : 'لا توجد أوامر شراء متاحة.'}</TableCell></TableRow> : filteredPos.map((po) => { const item = getReportItems(po)[0]; return <TableRow key={po.id}><TableCell className="whitespace-nowrap font-mono font-bold text-cyan-300">{po.po_number}</TableCell><TableCell className="whitespace-nowrap font-mono">{po.purchase_request?.request_number || 'شراء مباشر'}</TableCell><TableCell className="max-w-[180px] font-bold">{po.supplier?.company_name || '—'}</TableCell><TableCell className="max-w-[160px]">{po.department?.name || po.purchase_request?.department?.name || '—'}</TableCell><TableCell className="max-w-[160px]">{poDetails[po.id]?.requested_by?.name || po.requested_by?.name || po.purchase_request?.requester?.name || '—'}</TableCell><TableCell className="max-w-[160px]">{poDetails[po.id]?.department_approver?.name || po.department_approver?.name || '—'}</TableCell><TableCell className="max-w-[180px] font-bold text-slate-100">{getItemsSummaryDisplay(po.items as any)}</TableCell><TableCell className="whitespace-nowrap font-mono font-bold text-cyan-300">{po.purchase_request?.parcel_reference || item?.item_reference || '—'}</TableCell><TableCell>{po.purchase_request?.region || item?.region || '—'}</TableCell><TableCell className="whitespace-nowrap">{getUnitLabel(item?.uom)}</TableCell><TableCell className="whitespace-nowrap font-mono text-amber-300 font-bold">{item?.quantity || '—'}</TableCell><TableCell className="whitespace-nowrap"><CurrencyDisplay amount={po.grand_total} amountClassName="font-mono font-bold text-emerald-300" /></TableCell><TableCell className="whitespace-nowrap">{statusLabel(po.status)}</TableCell><TableCell className="whitespace-nowrap font-mono">{fmtDate(po.updated_at)}</TableCell><TableCell className="text-center"><div className="flex justify-center gap-2"><Button variant="secondary" size="sm" className="whitespace-nowrap" onClick={() => navigate(`/procurement/purchase-orders/${po.id}`)}>عرض</Button><Button variant="outline" size="sm" className="whitespace-nowrap" onClick={() => void handlePrintPo(po)}>طباعة</Button></div></TableCell></TableRow>; })}</TableBody></Table></div><div className="space-y-3 md:hidden">{filteredPos.length === 0 ? <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-400">{poMeta.total ? 'لم نجد أوامر شراء مطابقة للفلاتر الحالية.' : 'لا توجد أوامر شراء متاحة.'}</div> : filteredPos.map((po) => { const item = getReportItems(po)[0]; return <article key={`mobile-po-${po.id}`} className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/80 p-4"><div className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0 break-normal font-mono text-sm font-black text-cyan-300">{po.po_number}</span><span className="shrink-0 text-[11px] text-slate-400">{statusLabel(po.status)}</span></div><dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 text-xs min-[420px]:grid-cols-2"><div><dt className="text-slate-500">رقم الطلب</dt><dd className="mt-1 break-normal font-mono text-slate-300">{po.purchase_request?.request_number || 'شراء مباشر'}</dd></div><div><dt className="text-slate-500">المورد</dt><dd className="mt-1 break-normal font-bold leading-6 text-slate-100">{po.supplier?.company_name || 'غير محدد'}</dd></div><div><dt className="text-slate-500">القسم</dt><dd className="mt-1 break-normal text-slate-300">{po.department?.name || po.purchase_request?.department?.name || 'غير محدد'}</dd></div><div><dt className="text-slate-500">مقدم الطلب</dt><dd className="mt-1 break-normal text-slate-300">{poDetails[po.id]?.requested_by?.name || po.requested_by?.name || po.purchase_request?.requester?.name || 'غير محدد'}</dd></div><div className="min-[420px]:col-span-2"><dt className="text-slate-500">ملخص البنود</dt><dd className="mt-1 break-normal font-bold leading-6 text-slate-100">{getItemsSummaryDisplay(po.items as any)}</dd></div><div><dt className="text-slate-500">قطعة الأرض</dt><dd className="mt-1 break-normal font-mono text-cyan-300 font-bold">{po.purchase_request?.parcel_reference || item?.item_reference || 'بدون رقم'}</dd></div><div><dt className="text-slate-500">المنطقة والكمية</dt><dd className="mt-1 break-normal text-slate-300">{po.purchase_request?.region || item?.region || 'غير محددة'} — {item?.quantity || '—'} {getUnitLabel(item?.uom)}</dd></div><div><dt className="text-slate-500">المبلغ</dt><dd className="mt-1 whitespace-nowrap"><CurrencyDisplay amount={po.grand_total} amountClassName="font-mono font-bold text-emerald-300" /></dd></div><div><dt className="text-slate-500">التاريخ</dt><dd className="mt-1 whitespace-nowrap font-mono text-slate-300">{fmtDate(po.updated_at)}</dd></div></dl><div className="mt-4 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2"><Button variant="secondary" size="sm" className="w-full whitespace-nowrap" onClick={() => navigate(`/procurement/purchase-orders/${po.id}`)}>عرض الأمر</Button><Button variant="outline" size="sm" className="w-full whitespace-nowrap" onClick={() => void handlePrintPo(po)}>طباعة</Button></div></article>; })}</div>
          <PaginationControls
            currentPage={poMeta.current_page}
            lastPage={poMeta.last_page}
            from={poMeta.from}
            to={poMeta.to}
            total={poMeta.total}
            onPageChange={setPoPage}
            disabled={refreshing}
          />
        </section>
      )}

      {activeTab === 3 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="text-base font-bold text-cyan-300">إدارة الموردين ({suppliers.length})</h2><Button variant="primary" size="sm" onClick={openAddSupplier}>+ إضافة مورد</Button></div>
          <TableFilterBar
            searchValue={supplierSearch}
            onSearchChange={setSupplierSearch}
            searchPlaceholder="بحث باسم المورد أو الكود أو البريد أو الهاتف..."
            selects={[{ label: 'الحالة', value: supplierStatus, onChange: setSupplierStatus, options: [{ value: 'ALL', label: 'كل الموردين' }, { value: 'active', label: 'نشط' }, { value: 'inactive', label: 'غير نشط' }] }]}
            onClear={clearSupplierFilters}
            hasActiveFilters={Boolean(supplierSearch || supplierStatus !== 'ALL')}
            resultCount={filteredSuppliers.length}
            totalCount={suppliers.length}
            resultLabel="مورد"
          />
          <div className="hidden min-w-0 md:block"><Table><TableHeader><TableRow><TableHead className="whitespace-nowrap">الكود</TableHead><TableHead className="whitespace-nowrap">اسم المورد</TableHead><TableHead className="whitespace-nowrap">مسؤول التواصل</TableHead><TableHead className="whitespace-nowrap">الهاتف والبريد</TableHead><TableHead className="whitespace-nowrap">الحالة</TableHead><TableHead className="whitespace-nowrap text-center">الإجراءات</TableHead></TableRow></TableHeader><TableBody>{filteredSuppliers.length === 0 ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-slate-400">{suppliers.length ? 'لم نجد موردين مطابقين للفلاتر الحالية.' : 'لا يوجد موردون مسجلون.'}</TableCell></TableRow> : filteredSuppliers.map((supplier) => <TableRow key={supplier.id}><TableCell className="whitespace-nowrap font-mono text-cyan-300">{supplier.code || `SUP-${supplier.id}`}</TableCell><TableCell className="max-w-[200px] font-bold">{supplier.company_name}</TableCell><TableCell>{supplier.contact_name || '—'}</TableCell><TableCell><div dir="ltr" className="whitespace-nowrap font-mono text-xs">{supplier.phone || '—'}</div><div className="break-normal text-xs text-slate-400">{supplier.email || '—'}</div></TableCell><TableCell className="whitespace-nowrap">{supplier.is_active ? 'نشط' : 'غير نشط'}</TableCell><TableCell className="text-center"><div className="flex justify-center gap-2"><Button variant="secondary" size="sm" className="whitespace-nowrap" onClick={() => openEditSupplier(supplier)}>تعديل</Button><Button variant="danger" size="sm" className="whitespace-nowrap" onClick={() => void deleteSupplier(supplier)}>حذف</Button></div></TableCell></TableRow>)}</TableBody></Table></div><div className="space-y-3 md:hidden">{filteredSuppliers.length === 0 ? <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-400">{suppliers.length ? 'لم نجد موردين مطابقين للفلاتر الحالية.' : 'لا يوجد موردون مسجلون.'}</div> : filteredSuppliers.map((supplier) => <article key={`mobile-supplier-${supplier.id}`} className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/80 p-4"><div className="flex min-w-0 items-start justify-between gap-3"><span className="min-w-0 break-normal font-bold text-slate-100">{supplier.company_name}</span><span className="shrink-0 text-[11px] text-cyan-300">{supplier.is_active ? 'نشط' : 'غير نشط'}</span></div><p className="mt-1 break-normal font-mono text-xs text-cyan-300">{supplier.code || `SUP-${supplier.id}`}</p><dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 text-xs min-[420px]:grid-cols-2"><div><dt className="text-slate-500">مسؤول التواصل</dt><dd className="mt-1 break-normal leading-6 text-slate-300">{supplier.contact_name || 'غير محدد'}</dd></div><div><dt className="text-slate-500">الهاتف</dt><dd dir="ltr" className="mt-1 whitespace-nowrap font-mono text-slate-300">{supplier.phone || '—'}</dd></div><div className="min-[420px]:col-span-2"><dt className="text-slate-500">البريد الإلكتروني</dt><dd className="mt-1 break-all text-slate-300">{supplier.email || '—'}</dd></div></dl><div className="mt-4 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2"><Button variant="secondary" size="sm" className="w-full whitespace-nowrap" onClick={() => openEditSupplier(supplier)}>تعديل المورد</Button><Button variant="danger" size="sm" className="w-full whitespace-nowrap" onClick={() => void deleteSupplier(supplier)}>حذف المورد</Button></div></article>)}</div>
        </section>
      )}

      {activeTab === 4 && !analytics && (
        <Card className="space-y-4 border-amber-500/30 bg-amber-950/10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/10 text-xl">📊</div>
          <div>
            <h2 className="text-base font-bold text-slate-100">{analyticsError ? 'تعذر تحميل التقرير' : 'جاري تحميل التقرير'}</h2>
            <p className="mt-2 text-xs leading-6 text-slate-400">{analyticsError || 'يتم تجهيز مؤشرات المشتريات والرسومات، انتظر لحظات ثم حاول مرة أخرى.'}</p>
          </div>
          <Button variant="primary" size="sm" onClick={() => void retryAnalytics()} disabled={refreshing}>
            {refreshing ? 'جاري المحاولة...' : 'إعادة تحميل التقرير'}
          </Button>
        </Card>
      )}

      {activeTab === 4 && analytics && (
        <section className="space-y-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-bold text-cyan-300">التقارير والتحليلات الفورية</h2>
              <p className="mt-1 text-xs text-slate-400">تحليل أحدث أوامر الشراء حسب الفترة والقسم والمورد والصنف، بدون ضرائب أو خصومات.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"><option value="all">كل الفترات</option><option value="30">آخر 30 يومًا</option><option value="90">آخر 90 يومًا</option><option value="180">آخر 180 يومًا</option></select>
              <select value={reportStatus} onChange={(event) => setReportStatus(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"><option value="">كل الحالات</option>{poStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select>
              <Button variant="secondary" size="sm" onClick={exportReportCsv} disabled={!filteredReportPos.length}>تصدير CSV</Button>
              <Button variant="primary" size="sm" onClick={() => setReportPrintOpen(true)}>طباعة التقرير</Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6"><KpiCard title="أوامر الشراء" value={filteredReportPos.length} accentColor="cyan" /><KpiCard title="إجمالي أوامر الشراء الفعلية" value={<CurrencyDisplay amount={reportTotals.totalValue} amountClassName="font-mono text-emerald-300" />} accentColor="emerald" /><KpiCard title="إجمالي الكمية" value={reportTotals.totalQuantity.toLocaleString('ar-EG')} accentColor="amber" /><KpiCard title="متوسط الأمر" value={<CurrencyDisplay amount={reportTotals.averageValue} amountClassName="font-mono text-cyan-300" />} accentColor="cyan" /><KpiCard title="الموردون" value={reportTotals.supplierCount} accentColor="purple" /><KpiCard title="بانتظار الحسابات" value={analytics.metrics.pending_accounting_count} accentColor="rose" /></div>
          <TableFilterBar
            searchValue={reportSearch}
            onSearchChange={setReportSearch}
            searchPlaceholder="بحث برقم الأمر أو المورد أو القسم أو الموظف..."
            selects={[
              { label: 'القسم', value: reportDepartment, onChange: setReportDepartment, options: [{ value: 'ALL', label: 'كل الأقسام' }, ...departmentOptions] },
              { label: 'المورد', value: reportSupplier, onChange: setReportSupplier, options: [{ value: 'ALL', label: 'كل الموردين' }, ...supplierOptions] },
              { label: 'الصنف', value: reportItem, onChange: setReportItem, options: [{ value: 'ALL', label: 'كل الأصناف' }, ...catalogItems.map((item) => ({ value: String(item.id), label: item.name }))] },
            ]}
            dateFrom={reportDateFrom}
            dateTo={reportDateTo}
            onDateFromChange={setReportDateFrom}
            onDateToChange={setReportDateTo}
            onClear={clearReportFilters}
            hasActiveFilters={Boolean(reportSearch || reportDepartment !== 'ALL' || reportSupplier !== 'ALL' || reportItem !== 'ALL' || reportDateFrom !== defaultDateFrom || reportDateTo !== today)}
            resultCount={filteredReportPos.length}
            totalCount={analytics.metrics.purchase_orders_count}
            resultLabel="أمر في التقرير"
          />
          <ProcurementCharts orders={filteredReportPos} />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card><h3 className="mb-3 font-bold text-slate-100">توزيع الإنفاق حسب الأقسام</h3><Table><TableHeader><TableRow><TableHead>القسم</TableHead><TableHead>عدد الأوامر</TableHead><TableHead>الإجمالي</TableHead></TableRow></TableHeader><TableBody>{reportDepartmentBreakdown.length === 0 ? <TableRow><TableCell colSpan={3} className="py-6 text-center text-slate-500">لا توجد بيانات ضمن الفلاتر.</TableCell></TableRow> : reportDepartmentBreakdown.map((item) => <TableRow key={item.name}><TableCell className="font-bold">{item.name}</TableCell><TableCell>{item.count}</TableCell><TableCell className="font-mono text-emerald-300">{fmtAmount(item.total)} ج.م</TableCell></TableRow>)}</TableBody></Table></Card>
            <Card><h3 className="mb-3 font-bold text-slate-100">أبرز الموردين</h3><Table><TableHeader><TableRow><TableHead>المورد</TableHead><TableHead>عدد الأوامر</TableHead><TableHead>الإجمالي</TableHead></TableRow></TableHeader><TableBody>{reportSupplierBreakdown.length === 0 ? <TableRow><TableCell colSpan={3} className="py-6 text-center text-slate-500">لا توجد بيانات ضمن الفلاتر.</TableCell></TableRow> : reportSupplierBreakdown.map((item) => <TableRow key={item.name}><TableCell className="font-bold">{item.name}</TableCell><TableCell>{item.count}</TableCell><TableCell className="font-mono text-emerald-300">{fmtAmount(item.total)} ج.م</TableCell></TableRow>)}</TableBody></Table></Card>
          </div>
          <Card><h3 className="mb-3 font-bold text-slate-100">تفاصيل أحدث أوامر الشراء</h3><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>رقم الأمر</TableHead><TableHead>القسم</TableHead><TableHead>المورد</TableHead><TableHead>اسم الصنف</TableHead><TableHead>رقم قطعة الأرض</TableHead><TableHead>المنطقة</TableHead><TableHead>الوحدة</TableHead><TableHead>الكمية</TableHead><TableHead>الإجمالي</TableHead></TableRow></TableHeader><TableBody>{filteredReportPos.length === 0 ? <TableRow><TableCell colSpan={9} className="py-6 text-center text-slate-500">لا توجد أوامر مطابقة للفلاتر الحالية.</TableCell></TableRow> : filteredReportPos.flatMap((po) => getReportItems(po).map((item) => <TableRow key={`${po.id}-${item.id || item.item_reference}`}>
<TableCell className="font-mono text-cyan-300">{po.po_number}</TableCell><TableCell>{po.department?.name || po.purchase_request?.department?.name || '—'}</TableCell><TableCell>{po.supplier?.company_name || '—'}</TableCell><TableCell className="font-bold">{item.item_description || '—'}</TableCell><TableCell className="font-mono">{item.item_reference || '—'}</TableCell><TableCell>{item.region || '—'}</TableCell><TableCell>{getUnitLabel(item.uom)}</TableCell><TableCell>{item.quantity || '—'}</TableCell><TableCell className="font-mono text-emerald-300">{fmtAmount(item.grand_total)} ج.م</TableCell></TableRow>))}</TableBody></Table></div></Card>
        </section>
      )}

      {activeTab === 5 && (
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-black text-indigo-300 flex items-center gap-2">
                <span>⚡ أوامر الشراء الفعلية — بانتظار المراجعة والإصدار للإدارة المالية ({pendingActualPos.length})</span>
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                هذه الأوامر تم فحص واستلام بضاعتها بالموقع واعتماد إذن الاستلام نهائياً. يرجى مراجعة الكميات والأسعار وإصدار الأمر الفعلي النهائي ليتمكن المحاسب من مطابقة الفاتورة والصرف.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadData()}
                disabled={refreshing}
                className="text-xs"
              >
                {refreshing ? 'جاري التحديث...' : '🔄 تحديث'}
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <input
              type="text"
              placeholder="بحث برقم الأمر، رقم الطلب، المورد، إذن الاستلام..."
              value={actualPoSearch}
              onChange={(e) => setActualPoSearch(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-2.5 text-xs text-slate-200 focus:border-indigo-400 focus:outline-none"
            />

            {(() => {
              const filteredActualPos = pendingActualPos.filter((po) => {
                if (!actualPoSearch.trim()) return true;
                const term = actualPoSearch.trim().toLowerCase();
                const latestReceipt = po.receipts?.[0];
                return (
                  po.po_number.toLowerCase().includes(term) ||
                  (po.supplier?.company_name && po.supplier.company_name.toLowerCase().includes(term)) ||
                  (po.purchase_request?.request_number && po.purchase_request.request_number.toLowerCase().includes(term)) ||
                  (latestReceipt?.receipt_number && latestReceipt.receipt_number.toLowerCase().includes(term))
                );
              });

              if (filteredActualPos.length === 0) {
                return (
                  <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-12 text-center text-slate-400 space-y-2">
                    <span className="text-3xl block">📦</span>
                    <p className="text-sm font-bold text-slate-300">
                      {pendingActualPos.length === 0
                        ? 'لا توجد أوامر شراء بانتظار الإصدار الفعلي حالياً.'
                        : 'لم نجد أوامر مطابقة لكلمات البحث.'}
                    </p>
                    <p className="text-xs text-slate-500">
                      تظهر هنا أوامر الشراء فور فحصها واعتمادها هندسياً في الموقع من قبل مهندسي الموقع.
                    </p>
                  </div>
                );
              }

              return (
                <div className="space-y-3">
                  {filteredActualPos.map((po) => {
                    const latestReceipt = po.receipts?.[0];
                    return (
                      <article
                        key={`actual-po-row-${po.id}`}
                        className="rounded-2xl border border-indigo-500/40 bg-gradient-to-b from-slate-900/90 to-slate-950/90 p-4 sm:p-5 shadow-xl hover:border-indigo-400 transition-all space-y-4"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="font-mono text-lg font-black text-cyan-300">
                              {po.po_number}
                            </span>
                            <span className="rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-3 py-0.5 text-xs font-black">
                              بانتظار أمر الشراء الفعلي
                            </span>
                            {po.purchase_request && (
                              <span className="rounded-full bg-slate-800 border border-slate-700 px-3 py-0.5 text-xs font-bold text-slate-300">
                                الطلب: <strong className="font-mono text-cyan-400">{po.purchase_request.request_number}</strong>
                              </span>
                            )}
                            {po.department?.name && (
                              <span className="rounded-full bg-slate-800 border border-slate-700 px-3 py-0.5 text-xs font-bold text-slate-300">
                                {po.department.name}
                              </span>
                            )}
                            {(po.items?.some((i) => i.is_supplementary) || (po.purchase_request as any)?.supplements?.some((s: any) => s.status === 'APPROVED' || s.status === 'COMPLETED')) && (
                              <span className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 px-3 py-0.5 text-xs font-black flex items-center gap-1 shadow-sm">
                                <span>⚡</span>
                                <span>يتضمن ملحق كمالة معتمد</span>
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => setFinalizePoId(po.id)}
                              className="font-black text-xs bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 text-white shadow-lg shadow-emerald-950/50 flex items-center gap-1.5 px-4 py-2 cursor-pointer"
                            >
                              <span>⚡</span> مراجعة وإصدار الأمر الفعلي ←
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setCyclePrintPo(po)}
                              className="text-xs text-cyan-300 border-cyan-800/60 hover:bg-cyan-950/50 cursor-pointer"
                              title="طباعة الدورة (3 في 1)"
                            >
                              🖨️ طباعة الدورة
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => navigate(`/procurement/purchase-orders/${po.id}`)}
                              className="text-xs cursor-pointer"
                            >
                              🔍 التفاصيل
                            </Button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
                          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                            <span className="text-slate-400 block text-[11px]">المورد</span>
                            <span className="font-bold text-slate-100 text-sm mt-0.5 block">{po.supplier?.company_name || '—'}</span>
                          </div>

                          <div className="rounded-xl border border-cyan-800/60 bg-cyan-950/20 p-3">
                            <span className="text-cyan-400 block text-[11px] font-bold">رقم قطعة الأرض والمنطقة</span>
                            <span className="font-mono font-black text-cyan-200 text-sm mt-0.5 block">
                              🏷️ {po.purchase_request?.parcel_reference || po.items?.find((i: any) => i.item_reference)?.item_reference || 'غير محددة'}
                            </span>
                            <span className="text-amber-300 font-sans text-xs mt-0.5 block">
                              📍 {po.purchase_request?.region || po.items?.find((i: any) => i.region)?.region || 'غير محددة'}
                            </span>
                          </div>

                          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                            <span className="text-slate-400 block text-[11px]">إذن الاستلام المعتمد (GRN)</span>
                            <span className="font-mono font-bold text-amber-300 text-sm mt-0.5 block">{latestReceipt?.receipt_number || '—'}</span>
                          </div>

                          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                            <span className="text-slate-400 block text-[11px]">المعتمد بالموقع</span>
                            <span className="font-bold text-slate-200 text-xs mt-0.5 block">
                              {latestReceipt?.site_engineer?.name ? `👷 ${latestReceipt.site_engineer.name}` : '—'}
                              {latestReceipt?.warehouse_keeper?.name && <span className="text-slate-400 block text-[10px]">📦 أمين المخزن: {latestReceipt.warehouse_keeper.name}</span>}
                            </span>
                          </div>

                          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3 flex flex-col justify-between">
                            <span className="text-slate-400 block text-[11px]">الإجمالي المبدئي للأمر</span>
                            <span className="font-mono font-black text-emerald-400 text-base mt-0.5 block">
                              {fmtAmount(po.grand_total)} ج.م
                            </span>
                          </div>
                        </div>

                        {po.items && po.items.length > 0 && (
                          <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 p-3 space-y-1.5">
                            <div className="text-[11px] font-bold text-slate-400 flex items-center justify-between">
                              <span>بنود التوريد المستلمة ({po.items.length}):</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {po.items.map((it: any, idx: number) => (
                                <span
                                  key={`po-item-badge-${it.id || idx}`}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-slate-200"
                                >
                                  <span>📦</span>
                                  <strong className="text-white">{it.item_description || it.item?.name || 'بند'}</strong>
                                  <span className="text-cyan-300 font-mono font-bold">({it.quantity} {getUnitLabel(it.uom)})</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </section>
      )}

      <PurchaseQuotesModal isOpen={Boolean(quoteRequest)} request={quoteRequest} suppliers={suppliers} onClose={() => { setQuoteRequest(null); void loadData(); }} onSupplierCreated={(supplier) => setSuppliers(current => current.some(item => item.id === supplier.id) ? current : [...current, supplier])} onSuccess={() => { setQuoteRequest(null); void loadData(); }} />
      <DirectPoModal isOpen={directPoOpen} onClose={() => setDirectPoOpen(false)} onSuccess={() => { setActiveTab(0); void loadData(); }} />
      {selectedPrintPo && <PurchaseOrderPrintModal po={selectedPrintPo} isOpen={true} onClose={() => setSelectedPrintPo(null)} />}
      <SupplierModal supplier={editingSupplier} isOpen={supplierModalOpen} onClose={() => { setSupplierModalOpen(false); setEditingSupplier(null); }} onSuccess={() => void loadData()} />
      <DirectAccountingReviewModal
        request={directAccountingRequest}
        suppliers={Array.isArray(suppliers) ? suppliers : []}
        isOpen={Boolean(directAccountingRequest)}
        onConfirm={(financialData) => { if (directAccountingRequest) void handleSendDirectToAccounting(directAccountingRequest, financialData); }}
        onClose={() => { if (!directAccountingSubmitting) { setDirectAccountingRequest(null); setDirectAccountingError(null); } }}
        isSubmitting={directAccountingSubmitting}
        apiError={directAccountingError}
      />
      <ConfirmDialog
        isOpen={Boolean(supplierToDelete)}
        title="تأكيد حذف المورد"
        message={supplierToDelete ? `هل أنت متأكد من حذف المورد «${supplierToDelete.company_name}»؟` : ''}
        confirmLabel="حذف المورد"
        onConfirm={() => void confirmDeleteSupplier()}
        onClose={() => setSupplierToDelete(null)}
        isLoading={deletingSupplier}
      />
      <ReportPrintModal data={analytics} isOpen={reportPrintOpen} onClose={() => setReportPrintOpen(false)} />
      <PrDetailsModal
        pr={selectedPrForDetails}
        isOpen={Boolean(selectedPrForDetails)}
        onClose={() => setSelectedPrForDetails(null)}
        onPrUpdated={(updatedPr) => {
          setSelectedPrForDetails(updatedPr);
          void loadData();
        }}
        onCreatePo={(prId) => {
          setSelectedPrForDetails(null);
          navigate(`/procurement/purchase-orders/create?pr=${prId}&returnUrl=${encodeURIComponent('/procurement')}`, { state: { returnTo: '/procurement' } });
        }}
      />

      {/* ── Supplement Fast-Track Modal ── */}
      {supplementModalOpen && supplementModalPr && supplementModalData && (
        <ProcurementSupplementProcessModal
          request={supplementModalPr}
          supplement={supplementModalData}
          isOpen={supplementModalOpen}
          onClose={() => {
            setSupplementModalOpen(false);
            setSupplementModalPr(null);
            setSupplementModalData(null);
          }}
          onSuccess={() => {
            setSupplementModalOpen(false);
            setSuccessBanner('✅ تم إصدار ملحق التوريد بنجاح وإنشاء أمر الشراء التكميلي.');
            setSupplementModalPr(null);
            setSupplementModalData(null);
            void loadData();
          }}
        />
      )}

      {/* Supplement deep-link loading overlay */}
      {supplementLoading && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-500/30 bg-slate-950 p-8 shadow-2xl">
            <span className="text-3xl animate-spin">⚡</span>
            <span className="text-sm font-bold text-amber-300">جارٍ تحميل بيانات الكمالة...</span>
          </div>
        </div>
      )}

      {/* 3-in-1 Combined Cycle Print Modal */}
      {cyclePrintPo && (
        <ThreeWayMatchPrintModal
          po={cyclePrintPo}
          isOpen={Boolean(cyclePrintPo)}
          onClose={() => setCyclePrintPo(null)}
        />
      )}

      {/* Fast Finalize Actual PO Modal */}
      <FinalizeActualPoModal
        isOpen={Boolean(finalizePoId)}
        poId={finalizePoId}
        onClose={() => setFinalizePoId(null)}
        onSuccess={() => {
          setFinalizePoId(null);
          void loadData();
        }}
      />

      {/* Sovereign Action Confirmation Modal */}
      {procurementActionModal && (
        <ActionConfirmationModal
          isOpen={procurementActionModal.isOpen}
          onClose={() => setProcurementActionModal(null)}
          onConfirm={() => void handleExecuteProcurementAction()}
          isLoading={refreshing}
          title={procurementActionModal.type === 'reject' ? 'تأكيد رفض طلب الشراء' : 'تأكيد التراجع عن مسار عروض الأسعار'}
          subtitle={`طلب شراء رقم ${procurementActionModal.request.request_number}`}
          confirmLabel={procurementActionModal.type === 'reject' ? 'حسناً، تأكيد الرفض' : 'حسناً، تراجع وإعادة للمسار'}
          cancelLabel="رجوع"
          confirmVariant={procurementActionModal.type === 'reject' ? 'danger' : 'warning'}
          documentType="PURCHASE_REQUEST"
          documentCode={procurementActionModal.request.request_number}
          department={procurementActionModal.request.department?.name}
          itemsCount={procurementActionModal.request.items?.length}
          alerts={[
            {
              type: 'warning',
              title: procurementActionModal.type === 'reject' ? 'إيقاف إجراءات الشراء للطلب' : 'إعادة تعيين مسار الشراء',
              message: procurementActionModal.type === 'reject'
                ? 'سيتم رفض الطلب نهائياً وإخطار صاحب الطلب بسبب الرفض.'
                : 'سيتم إلغاء حالة عروض الأسعار وإعادة الطلب لمرحلة تحديد المسار المباشر أو التوجيه من جديد.',
            }
          ]}
          promptQuestion={
            procurementActionModal.type === 'reject'
              ? `أنت على وشك رفض طلب الشراء رقم (${procurementActionModal.request.request_number})، هل ترغب في المتابعة؟`
              : `أنت على وشك التراجع عن مسار عروض الأسعار للطلب (${procurementActionModal.request.request_number}) وإعادته لاختيار المسار، هل ترغب في المتابعة؟`
          }
        />
      )}
    </div>
  );
};

export default ProcurementManagerPage;
