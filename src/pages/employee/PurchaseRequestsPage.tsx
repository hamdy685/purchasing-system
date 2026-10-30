import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ErrorMessage from '../../components/ErrorMessage';
import { TableSkeleton } from '../../components/ui/StateFeedback';
import PurchaseRequestTable from '../../components/purchase-requests/PurchaseRequestTable';
import DeleteRequestDialog from '../../components/purchase-requests/DeleteRequestDialog';
import SubmitRequestDialog from '../../components/purchase-requests/SubmitRequestDialog';
import CancelRequestDialog from '../../components/purchase-requests/CancelRequestDialog';
import { useAuth } from '../../context/AuthContext';
import {
  cancelPurchaseRequestApi,
  deletePurchaseRequestApi,
  getOwnPurchaseRequestsApi,
  submitPurchaseRequestApi,
} from '../../api/purchaseRequests';
import { ApiError } from '../../types/api';
import { PurchaseRequest } from '../../types/purchaseRequest';
import { parseApiError } from '../../utils/apiError';
import { Button } from '../../components/ui/Button';
import TableFilterBar from '../../components/ui/TableFilterBar';
import { getDefaultDateFrom, getTodayInputDate } from '../../utils/dateFilters';

const EMPLOYEE_EDITABLE_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW']);
const EMPLOYEE_REVIEW_STATUSES = new Set(['UNDER_REVIEW']);
const EMPLOYEE_SUBMITTED_STATUSES = new Set(['SUBMITTED']);
const EMPLOYEE_APPROVED_STATUSES = new Set([
  'APPROVED_BY_REVIEWER',
  'PENDING_EXECUTIVE_APPROVAL',
  'PENDING_PROCUREMENT_APPROVAL',
  'APPROVED_BY_PROCUREMENT',
  'PENDING_ACCOUNTING_APPROVAL',
  'APPROVED_BY_ACCOUNTING',
  'PENDING_QUOTE_RECOMMENDATIONS',
  'PENDING_EXECUTIVE_QUOTE_DECISION',
  'ISSUED',
  'PO_ISSUED',
  'PO_APPROVED',
  'ACTUAL_PO_ISSUED',
  'PENDING_ACTUAL_PO',
  'COMPLETED',
]);

import { useRealtimeRefresh, emitAppDataUpdated } from '../../hooks/useRealtimeRefresh';

export const PurchaseRequestsPage: React.FC = () => {
  const { hasRole, hasPermission } = useAuth();
  const isProcurementOrAdmin = hasRole('procurement_manager') || hasRole('admin');
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get('status') || 'ALL';
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [activeFilter, setActiveFilter] = useState<string>(initialStatus);
  const [needsActionOnly, setNeedsActionOnly] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const todayInputDate = getTodayInputDate();
  const defaultDateFrom = getDefaultDateFrom();
  const [dateFrom, setDateFrom] = useState<string>(() => isProcurementOrAdmin ? '' : defaultDateFrom);
  const [dateTo, setDateTo] = useState<string>(() => isProcurementOrAdmin ? '' : todayInputDate);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Modals
  const [selectedSubmitPr, setSelectedSubmitPr] = useState<PurchaseRequest | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [selectedDeletePr, setSelectedDeletePr] = useState<PurchaseRequest | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [selectedCancelPr, setSelectedCancelPr] = useState<PurchaseRequest | null>(null);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);

  const fetchRequests = async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const data = await getOwnPurchaseRequestsApi();
      setRequests(data);
    } catch (err) {
      if (!silent) setError(parseApiError(err));
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests(false);
  }, []);

  useRealtimeRefresh(() => fetchRequests(true));

  const handleConfirmSubmit = async () => {
    if (!selectedSubmitPr) return;
    setIsSubmitting(true);
    try {
      await submitPurchaseRequestApi(selectedSubmitPr.id);
      setSelectedSubmitPr(null);
      emitAppDataUpdated();
      await fetchRequests(true);
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedDeletePr) return;
    setIsDeleting(true);
    try {
      await deletePurchaseRequestApi(selectedDeletePr.id);
      setSelectedDeletePr(null);
      emitAppDataUpdated();
      await fetchRequests(true);
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleConfirmCancel = async (reason: string) => {
    if (!selectedCancelPr) return;
    setIsCancelling(true);
    try {
      await cancelPurchaseRequestApi(selectedCancelPr.id, { reason });
      setSelectedCancelPr(null);
      emitAppDataUpdated();
      await fetchRequests(true);
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setIsCancelling(false);
    }
  };

  const handleOpenSubmitModal = React.useCallback((pr: PurchaseRequest) => {
    setSelectedSubmitPr(pr);
  }, []);

  const handleOpenDeleteModal = React.useCallback((pr: PurchaseRequest) => {
    setSelectedDeletePr(pr);
  }, []);

  const handleOpenCancelModal = React.useCallback((pr: PurchaseRequest) => {
    setSelectedCancelPr(pr);
  }, []);

  const requestNeedsAction = React.useCallback((request: PurchaseRequest) => {
    const canEdit = EMPLOYEE_EDITABLE_STATUSES.has(request.status) && hasPermission('purchase_request.edit_own');
    const canDelete = request.status === 'DRAFT' && hasPermission('purchase_request.edit_own');
    const canSubmit = request.status === 'DRAFT' && hasPermission('purchase_request.submit');
    const canCancel = ['REJECTED', 'RETURNED'].includes(request.status) && hasPermission('purchase_request.edit_own');
    return canEdit || canDelete || canSubmit || canCancel;
  }, [hasPermission]);

  const filteredRequests = React.useMemo(() => {
    return requests.filter((r) => {
      const matchesNeedsAction = !needsActionOnly || requestNeedsAction(r);
      const matchesFilter =
        activeFilter === 'ALL' ? true :
        activeFilter === 'PENDING' ? EMPLOYEE_REVIEW_STATUSES.has(r.status) :
        activeFilter === 'SUBMITTED' ? EMPLOYEE_SUBMITTED_STATUSES.has(r.status) :
        activeFilter === 'APPROVED' ? EMPLOYEE_APPROVED_STATUSES.has(r.status) :
        r.status === activeFilter;
      const searchableText = [
        r.request_number,
        r.department?.name,
        r.department?.code,
        r.target_department?.name,
        r.target_department?.code,
        r.requester?.name,
        r.assigned_reviewer?.name,
        r.status,
        ...(r.items || []).flatMap((item) => [item.item_reference, item.region, item.item_description]),
      ].filter(Boolean).join(' ').toLocaleLowerCase('ar-EG');
      const normalizedSearch = searchQuery.trim().toLocaleLowerCase('ar-EG');
      const matchesSearch = !normalizedSearch || searchableText.includes(normalizedSearch);
      const neededDate = r.date_needed || (r.created_at ? r.created_at.slice(0, 10) : '');
      const matchesFrom = !dateFrom || neededDate >= dateFrom;
      const matchesTo = !dateTo || neededDate <= dateTo;
      return matchesNeedsAction && matchesFilter && matchesSearch && matchesFrom && matchesTo;
    });
  }, [requests, needsActionOnly, requestNeedsAction, activeFilter, searchQuery, dateFrom, dateTo]);

  if (isLoading) {
    return <TableSkeleton rows={6} columns={5} className="min-h-[260px]" />;
  }

  // The default date window is not a filter the user chose, so it neither opens the filter panel nor counts as one.
  const isDefaultDateWindow = isProcurementOrAdmin
    ? !dateFrom && !dateTo
    : dateFrom === defaultDateFrom && dateTo === todayInputDate;
  const hasResultFilters = Boolean(searchQuery.trim() || !isDefaultDateWindow || activeFilter !== 'ALL' || needsActionOnly);

  const statusTab = (key: string, label: string, count: number) => ({
    key,
    label,
    count,
    active: activeFilter === key,
    onClick: () => setActiveFilter(key),
  });
  const statusTabs = [
    { key: 'ALL', label: 'الكل', count: requests.length, active: activeFilter === 'ALL' && !needsActionOnly, onClick: () => { setActiveFilter('ALL'); setNeedsActionOnly(false); } },
    { key: 'NEEDS_ACTION', label: 'يحتاج إجراء مني', count: requests.filter(requestNeedsAction).length, active: needsActionOnly, onClick: () => setNeedsActionOnly((current) => !current) },
    statusTab('DRAFT', 'مسودات', requests.filter((r) => r.status === 'DRAFT').length),
    statusTab('SUBMITTED', 'مُرسلة للمراجعة', requests.filter((r) => EMPLOYEE_SUBMITTED_STATUSES.has(r.status)).length),
    statusTab('PENDING', 'قيد المراجعة', requests.filter((r) => EMPLOYEE_REVIEW_STATUSES.has(r.status)).length),
    statusTab('APPROVED', 'معتمدة', requests.filter((r) => EMPLOYEE_APPROVED_STATUSES.has(r.status)).length),
    statusTab('REJECTED', 'مرفوضة', requests.filter((r) => r.status === 'REJECTED').length),
    statusTab('CANCELLED', 'ملغية', requests.filter((r) => r.status === 'CANCELLED').length),
  ].filter((tab) => tab.key === 'ALL' || tab.active || tab.count > 0);

  return (
    <div className="space-y-3.5" dir="rtl">
      {/* The layout header already names the page; on phones the floating + button creates a request. */}
      {hasPermission('purchase_request.create') && (
        <div className="hidden sm:flex justify-end">
          <Link to="/requests/create">
            <Button variant="primary" size="md">
              + طلب شراء جديد
            </Button>
          </Link>
        </div>
      )}

      <ErrorMessage error={error} onDismiss={() => setError(null)} />

      <TableFilterBar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="ابحث برقم الطلب أو الصنف أو القطعة أو المنطقة"
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        onClear={() => { setSearchQuery(''); setDateFrom(isProcurementOrAdmin ? '' : defaultDateFrom); setDateTo(isProcurementOrAdmin ? '' : todayInputDate); setActiveFilter('ALL'); setNeedsActionOnly(false); }}
        hasActiveFilters={hasResultFilters}
        resultCount={filteredRequests.length}
        totalCount={requests.length}
        resultLabel="طلب شراء"
      />

      {/* Status tabs: empty ones are hidden unless selected */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="تصفية حسب الحالة">
        {statusTabs.map((tab) => (
          <Button
            key={tab.key}
            variant={tab.active ? 'primary' : 'outline'}
            size="sm"
            className="!min-h-8 px-2.5 py-1 text-[11px]"
            onClick={tab.onClick}
            aria-pressed={tab.active}
          >
            {tab.label} ({tab.count})
          </Button>
        ))}
      </div>

      {/* Table Component */}
      <PurchaseRequestTable
        requests={filteredRequests}
        emptyMessage={hasResultFilters ? 'لا توجد طلبات مطابقة للفلاتر الحالية' : 'لا توجد طلبات شراء حالياً'}
        emptyDescription={hasResultFilters ? 'غيّر كلمة البحث أو التاريخ أو تبويب الحالة، أو استخدم «مسح كل الفلاتر» لعرض الطلبات.' : 'ابدأ بإنشاء أول طلب شراء جديد لمؤسستك.'}
        onOpenSubmitModal={handleOpenSubmitModal}
        onOpenDeleteModal={handleOpenDeleteModal}
        onOpenCancelModal={handleOpenCancelModal}
      />

      {/* Dialog Modals */}
      <SubmitRequestDialog
        isOpen={!!selectedSubmitPr}
        requestNumber={selectedSubmitPr?.request_number || ''}
        isSubmitting={isSubmitting}
        onConfirm={handleConfirmSubmit}
        onCancel={() => setSelectedSubmitPr(null)}
      />

      <DeleteRequestDialog
        isOpen={!!selectedDeletePr}
        requestNumber={selectedDeletePr?.request_number || ''}
        isDeleting={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setSelectedDeletePr(null)}
      />

      <CancelRequestDialog
        isOpen={!!selectedCancelPr}
        requestNumber={selectedCancelPr?.request_number || ''}
        isCancelling={isCancelling}
        onConfirm={handleConfirmCancel}
        onCancel={() => setSelectedCancelPr(null)}
      />
    </div>
  );
};

export default PurchaseRequestsPage;
