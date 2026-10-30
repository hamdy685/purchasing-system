import React, { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import LoadingSpinner from '../../components/LoadingSpinner';
import ErrorMessage from '../../components/ErrorMessage';
import { parseApiError } from '../../utils/apiError';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { exportToCsv } from '../../utils/exportCsv';
import {
  getMasterOrdersApi,
  MasterOrderRow,
  MasterOrdersStats,
} from '../../api/admin/masterOrders';
import { AdminForceEditModal } from '../../components/admin/AdminForceEditModal';
import { AdminForceDeleteModal } from '../../components/admin/AdminForceDeleteModal';

export const AdminMasterOrdersPage: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Data
  const [orders, setOrders] = useState<MasterOrderRow[]>([]);
  const [stats, setStats] = useState<MasterOrdersStats | null>(null);
  const [departments, setDepartments] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: number; company_name: string; name: string; code: string }>>([]);

  // Filters
  const [search, setSearch] = useState<string>('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [deptFilter, setDeptFilter] = useState<string>('');
  const [supplierFilter, setSupplierFilter] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  // Selected Order for Force Edit Modal
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
  const [isForceModalOpen, setIsForceModalOpen] = useState<boolean>(false);

  // Selected Order for Force Delete Modal
  const [orderToDelete, setOrderToDelete] = useState<MasterOrderRow | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState<boolean>(false);
  const [deleteSuccessAlert, setDeleteSuccessAlert] = useState<string | null>(null);

  // Expanded items row state
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

  const fetchOrders = async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const res = await getMasterOrdersApi({
        search: search.trim() || undefined,
        stage: stageFilter !== 'all' ? stageFilter : undefined,
        department_id: deptFilter || undefined,
        supplier_id: supplierFilter || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        per_page: 'all',
      });

      setOrders(res.data || []);
      setStats(res.stats || null);
      if (res.lookups) {
        setDepartments(res.lookups.departments || []);
        setSuppliers(res.lookups.suppliers || []);
      }
    } catch (err: unknown) {
      console.error('[AdminMasterOrdersPage] Error fetching master orders:', err);
      const parsed = parseApiError(err);
      const anyErr = err as any;
      const detailedMsg = anyErr?.response?.data?.message || anyErr?.response?.data?.error || parsed.message;
      setError(detailedMsg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [stageFilter, deptFilter, supplierFilter, dateFrom, dateTo]);

  // Debounced search trigger
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchOrders(true);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const handleOpenForceEdit = (order: MasterOrderRow) => {
    setSelectedOrderId(order.order_id ?? null);
    setSelectedRequestId(order.order_id ? null : order.request_id);
    setIsForceModalOpen(true);
  };

  const handleOpenForceDelete = (order: MasterOrderRow) => {
    setOrderToDelete(order);
    setIsDeleteModalOpen(true);
  };

  const handleDeleteSuccess = (deletedKey: string, message: string) => {
    // Optimistic removal: remove immediately from state
    setOrders((prev) => prev.filter((o) => o.unique_key !== deletedKey));
    setDeleteSuccessAlert(message);
    setTimeout(() => setDeleteSuccessAlert(null), 7000);
    // Refresh silently in background to update counts & stats
    fetchOrders(true);
  };

  const handleResetFilters = () => {
    setSearch('');
    setStageFilter('all');
    setDeptFilter('');
    setSupplierFilter('');
    setDateFrom('');
    setDateTo('');
  };

  const handleExportCsv = () => {
    if (orders.length === 0) return;
    const headers = [
      'رقم أمر الشراء',
      'رقم طلب الشراء',
      'القسم',
      'مقدم الطلب',
      'المورد',
      'رقم القطعة / الموقع',
      'المنطقة',
      'حالة الدورة الحالية',
      'الإجمالي المالي',
      'أمر فعلي؟',
      'رقم إذن الاستلام',
      'تاريخ الإنشاء',
    ];

    const rows = orders.map((o) => [
      o.po_number,
      o.pr_number,
      o.department?.name || '—',
      o.requester?.name || '—',
      o.supplier?.name || '—',
      o.project_site?.parcel_reference || '—',
      o.project_site?.region || '—',
      o.cycle_stage_label,
      o.grand_total,
      o.is_actual_po ? 'نعم' : 'لا',
      o.receipt?.receipt_number || '—',
      o.created_at ? o.created_at.slice(0, 10) : '—',
    ]);

    exportToCsv({
      filename: `ashbiliya_master_orders_${new Date().toISOString().slice(0, 10)}.csv`,
      headers,
      rows,
    });
  };

  // Stage Badge Renderer
  const renderStageBadge = (order: MasterOrderRow) => {
    const colorClasses: Record<string, string> = {
      emerald: 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300',
      cyan: 'bg-cyan-950/70 border-cyan-500/50 text-cyan-300',
      amber: 'bg-amber-950/70 border-amber-500/50 text-amber-300',
      purple: 'bg-purple-950/70 border-purple-500/50 text-purple-300',
      blue: 'bg-blue-950/70 border-blue-500/50 text-blue-300',
      indigo: 'bg-indigo-950/70 border-indigo-500/50 text-indigo-300',
      sky: 'bg-sky-950/70 border-sky-500/50 text-sky-300',
      rose: 'bg-rose-950/70 border-rose-500/50 text-rose-300',
    };

    const colorCls = colorClasses[order.cycle_stage_color] || 'bg-slate-800 border-slate-700 text-slate-300';

    return (
      <div className="space-y-1">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-black border ${colorCls} shadow-sm`}>
          <span className="h-2 w-2 rounded-full bg-current animate-pulse" />
          {order.cycle_stage_label}
        </span>
        <div className="text-[10px] text-slate-400 font-medium">
          عند: <strong className="text-slate-300">{order.responsible_party}</strong>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in" dir="rtl">
      {/* ── Header ── */}
      <div className="pb-4 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-500/40 bg-gradient-to-br from-amber-500/20 via-amber-600/10 to-transparent text-2xl shadow-inner">
              🎛️
            </span>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-slate-100 flex items-center gap-2">
                مركز التحكم الشامل في الطلبات (Master Orders Control)
              </h1>
              <p className="text-xs sm:text-sm text-slate-400 font-medium mt-0.5">
                لوحة القيادة السيادية لمدير النظام — مراقبة وتعديل كافة المعاملات في أي مرحلة وتجاوز القيود الإجرائية
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 self-start md:self-auto">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchOrders(true)}
            isLoading={refreshing}
            className="text-xs h-9 border-slate-700 text-slate-200"
          >
            🔄 تحديث البيانات
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={orders.length === 0}
            className="text-xs h-9 border-slate-700 text-emerald-300 hover:border-emerald-500/50"
          >
            📊 تصدير Excel (CSV)
          </Button>
          <Link to="/admin">
            <Button variant="ghost" size="sm" className="text-xs h-9 text-slate-400 hover:text-white">
              ⚙️ لوحة الإدارة
            </Button>
          </Link>
        </div>
      </div>

      {deleteSuccessAlert && (
        <div className="rounded-xl border border-emerald-500/60 bg-emerald-950/60 p-4 text-emerald-200 text-xs sm:text-sm font-bold flex items-center justify-between shadow-lg shadow-emerald-950/40 animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="text-lg">✅</span>
            <span>{deleteSuccessAlert}</span>
          </div>
          <button
            type="button"
            onClick={() => setDeleteSuccessAlert(null)}
            className="text-emerald-400 hover:text-emerald-100 font-bold px-2 py-1 text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {error && <ErrorMessage error={error} />}

      {/* ── KPI Cards (Interactive Filter Bar) ── */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <button
            type="button"
            onClick={() => setStageFilter('all')}
            className={`rounded-xl border p-3 text-right transition-all cursor-pointer ${
              stageFilter === 'all'
                ? 'border-amber-400 bg-amber-950/40 shadow-lg shadow-amber-950/40'
                : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
            }`}
          >
            <span className="text-[11px] font-bold text-slate-400 block">إجمالي المعاملات</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-xl font-mono font-black text-slate-100">{stats.total_count}</span>
              <span className="text-xs text-slate-400 font-bold">معاملة</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setStageFilter('invoiced')}
            className={`rounded-xl border p-3 text-right transition-all cursor-pointer ${
              stageFilter === 'invoiced'
                ? 'border-emerald-400 bg-emerald-950/40 shadow-lg shadow-emerald-950/40'
                : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
            }`}
          >
            <span className="text-[11px] font-bold text-emerald-400 block">مسقط بالحسابات</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-xl font-mono font-black text-emerald-300">{stats.invoiced_count}</span>
              <span className="text-xs text-emerald-400 font-bold">مكتمل</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setStageFilter('actual_po_issued')}
            className={`rounded-xl border p-3 text-right transition-all cursor-pointer ${
              stageFilter === 'actual_po_issued'
                ? 'border-cyan-400 bg-cyan-950/40 shadow-lg shadow-cyan-950/40'
                : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
            }`}
          >
            <span className="text-[11px] font-bold text-cyan-400 block">أمر فعلي معتمد</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-xl font-mono font-black text-cyan-300">{stats.actual_po_count}</span>
              <span className="text-xs text-cyan-400 font-bold">جاهز للمطابقة</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setStageFilter('pending_actual_po')}
            className={`rounded-xl border p-3 text-right transition-all cursor-pointer ${
              stageFilter === 'pending_actual_po'
                ? 'border-amber-400 bg-amber-950/40 shadow-lg shadow-amber-950/40'
                : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
            }`}
          >
            <span className="text-[11px] font-bold text-amber-400 block">بانتظار الأمر الفعلي</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-xl font-mono font-black text-amber-300">{stats.pending_actual_po_count}</span>
              <span className="text-xs text-amber-400 font-bold">بالموقع</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setStageFilter('grn_pending')}
            className={`rounded-xl border p-3 text-right transition-all cursor-pointer ${
              stageFilter === 'grn_pending'
                ? 'border-purple-400 bg-purple-950/40 shadow-lg shadow-purple-950/40'
                : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
            }`}
          >
            <span className="text-[11px] font-bold text-purple-400 block">بانتظار فحص الاستلام</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-xl font-mono font-black text-purple-300">{stats.grn_pending_count}</span>
              <span className="text-xs text-purple-400 font-bold">قيد الفحص</span>
            </div>
          </button>

          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-right">
            <span className="text-[11px] font-bold text-slate-400 block">إجمالي القيمة المالية الفعلية</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-lg font-mono font-black text-emerald-400">
                {formatCleanNumber(stats.total_financial_value)}
              </span>
              <span className="text-xs text-slate-400 font-bold">ج.م</span>
            </div>
            <span className="text-[10px] text-slate-500 block mt-0.5">للأوامر الفعلية المعتمدة فقط</span>
          </div>
        </div>
      )}

      {/* ── Filters Toolbar ── */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
          {/* Search */}
          <div className="lg:col-span-2">
            <label className="block text-slate-400 font-bold mb-1">بحث سريع وشامل:</label>
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="رقم PO، PR، مورد، صنف، موقع، مقدم الطلب..."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 pr-8 text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
              />
              <span className="absolute right-2.5 top-2.5 text-slate-500">🔍</span>
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute left-2.5 top-2.5 text-slate-400 hover:text-white"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Stage Dropdown */}
          <div>
            <label className="block text-slate-400 font-bold mb-1">مرحلة دورة المستند:</label>
            <select
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 font-bold focus:border-amber-400 focus:outline-none"
            >
              <option value="all">كل المراحل والحالات</option>
              <option value="invoiced">مسقط بالحسابات (INVOICED)</option>
              <option value="actual_po_issued">أمر شراء فعلي معتمد (ACTUAL PO)</option>
              <option value="pending_actual_po">بالموقع - بانتظار الأمر الفعلي</option>
              <option value="grn_pending">بانتظار فحص واعتماد الاستلام</option>
              <option value="po_issued">أمر شراء صادر - قيد التوريد</option>
              <option value="pending_po">طلب معتمد - بانتظار أمر الشراء</option>
              <option value="under_review">طلب قيد المراجعة والاعتماد</option>
              <option value="cancelled_or_rejected">ملغي / مرفوض</option>
            </select>
          </div>

          {/* Department */}
          <div>
            <label className="block text-slate-400 font-bold mb-1">القسم / الإدارة:</label>
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-amber-400 focus:outline-none"
            >
              <option value="">كل الأقسام</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
          </div>

          {/* Supplier */}
          <div>
            <label className="block text-slate-400 font-bold mb-1">المورد:</label>
            <select
              value={supplierFilter}
              onChange={(e) => setSupplierFilter(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-amber-400 focus:outline-none"
            >
              <option value="">كل الموردين</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.company_name || s.name}
                </option>
              ))}
            </select>
          </div>

          {/* Reset Action */}
          <div className="flex items-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleResetFilters}
              className="w-full h-[38px] text-xs border-slate-700 text-slate-300 hover:text-white"
            >
              إعادة تعيين الفلاتر
            </Button>
          </div>
        </div>
      </div>

      {/* ── Orders Master Table ── */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden shadow-xl">
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/70 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-bold text-slate-200">النتائج المعروضة:</span>
            <span className="rounded-full bg-amber-500/10 border border-amber-500/30 px-2.5 py-0.5 font-mono font-bold text-amber-300">
              {orders.length} معاملة
            </span>
          </div>
          <div className="text-[11px] text-slate-400">
            * اضغط <strong className="text-amber-300">«تعديل»</strong> لتعديل بيانات الطلب أو نقله لمرحلة أخرى
          </div>
        </div>

        {loading ? (
          <div className="p-12">
            <LoadingSpinner message="جاري تحميل كافة المعاملات وأوامر الشراء ومراحلها..." />
          </div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm space-y-2">
            <span className="text-3xl block">🔍</span>
            <p className="font-bold text-slate-300">لا توجد أوامر أو طلبات تطابق معايير البحث والفلترة.</p>
            <p className="text-xs">جرّب تغيير فلاتر البحث أو إعادة تعيين الفلاتر.</p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-950 text-slate-400 font-bold border-b border-slate-800">
                  <tr>
                    <th className="p-3">رقم الأمر / الطلب</th>
                    <th className="p-3">القسم والموقع</th>
                    <th className="p-3">المورد</th>
                    <th className="p-3">مرحلة دورة المعاملة</th>
                    <th className="p-3">مستند الاستلام (GRN)</th>
                    <th className="p-3">الحسابات والفاتورة</th>
                    <th className="p-3 text-left">الإجمالي المالي</th>
                    <th className="p-3 text-center">التعديل والتحكم السيادي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 bg-slate-900/30">
                  {orders.map((order) => {
                    const isExpanded = expandedRowKey === order.unique_key;

                    return (
                      <React.Fragment key={order.unique_key}>
                        <tr className="hover:bg-slate-800/40 transition-colors">
                          {/* Numbers */}
                          <td className="p-3">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-black text-cyan-300 text-sm">
                                  {order.po_number}
                                </span>
                                {order.is_actual_po && (
                                  <span className="rounded bg-cyan-950 border border-cyan-500/40 px-1.5 py-0.2 text-[10px] font-bold text-cyan-300">
                                    فعلي
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono">
                                طلب: <span className="text-slate-300">{order.pr_number}</span>
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {order.created_at ? order.created_at.slice(0, 10) : '—'}
                              </div>
                            </div>
                          </td>

                          {/* Department & Site */}
                          <td className="p-3">
                            <div className="space-y-0.5">
                              <div className="font-bold text-slate-200">
                                {order.department?.name || 'غير محدد'}
                              </div>
                              <div className="text-[11px] text-slate-400">
                                القطعة: <strong className="text-cyan-300 font-mono">{order.project_site?.parcel_reference || '—'}</strong>
                              </div>
                              <div className="text-[10px] text-slate-400">
                                المنطقة: {order.project_site?.region || '—'}
                              </div>
                            </div>
                          </td>

                          {/* Supplier */}
                          <td className="p-3">
                            <div className="space-y-0.5">
                              <div className="font-bold text-slate-200">
                                {order.supplier?.name || 'لم يحدد بعد'}
                              </div>
                              {order.supplier?.code && (
                                <div className="text-[10px] text-slate-400 font-mono">
                                  كود: {order.supplier.code}
                                </div>
                              )}
                            </div>
                          </td>

                          {/* Cycle Stage */}
                          <td className="p-3">{renderStageBadge(order)}</td>

                          {/* Receipt */}
                          <td className="p-3">
                            {order.receipt ? (
                              <div className="space-y-0.5">
                                <span className="font-mono font-bold text-emerald-300 block">
                                  {order.receipt.receipt_number}
                                </span>
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                  order.receipt.status === 'APPROVED'
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-purple-950 text-purple-300 border border-purple-500/30'
                                }`}>
                                  {order.receipt.status === 'APPROVED' ? 'معتمد بالموقع' : 'قيد التدقيق'}
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-400 text-xs">— (لم يستلم بعد)</span>
                            )}
                          </td>

                          {/* Invoice */}
                          <td className="p-3">
                            {order.invoice ? (
                              <div className="space-y-0.5">
                                <span className="font-mono font-bold text-slate-200 block">
                                  {order.invoice.invoice_number}
                                </span>
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                  order.invoice.matching_status === 'MATCHED'
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-amber-950 text-amber-300 border border-amber-500/30'
                                }`}>
                                  {order.invoice.matching_status === 'MATCHED' ? 'مطابقة ومسقطة' : 'قيد المطابقة'}
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-400 text-xs">—</span>
                            )}
                          </td>

                          {/* Grand Total */}
                          <td className="p-3 text-left">
                            <div className="font-mono font-black text-sm text-emerald-300">
                              {formatCleanNumber(order.grand_total)} ج.م
                            </div>
                            <button
                              type="button"
                              onClick={() => setExpandedRowKey(isExpanded ? null : order.unique_key)}
                              className="text-[11px] text-cyan-400 hover:text-cyan-300 underline font-bold mt-1"
                            >
                              {isExpanded ? 'إخفاء البنود ▲' : `عرض ${order.items_count} بنود ▼`}
                            </button>
                          </td>

                          {/* Force Edit & Sovereign Delete Actions */}
                          <td className="p-3 text-center">
                            <div className="flex items-center justify-center gap-1.5 flex-wrap">
                              {order.order_id || order.request_id ? (
                                <Button
                                  variant="warning"
                                  size="sm"
                                  onClick={() => handleOpenForceEdit(order)}
                                  className="text-xs h-8 px-2.5 font-black shadow-md shadow-amber-950/40 border-amber-400/60 text-slate-950"
                                >
                                  تعديل
                                </Button>
                              ) : (
                                <Link to={`/requests/${order.request_id}`}>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    className="text-xs h-8 px-2.5 border-indigo-500/40 text-indigo-300"
                                  >
                                    عرض الطلب
                                  </Button>
                                </Link>
                              )}

                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => handleOpenForceDelete(order)}
                                className="text-xs h-8 px-2.5 font-black bg-rose-600/90 hover:bg-rose-500 text-white border-rose-500/60 shadow-md shadow-rose-950/40 flex items-center gap-1"
                                title="حذف نهائي شامل للطلب وكافة دورته المستندية"
                              >
                                <span>🗑️</span>
                                <span>حذف نهائي</span>
                              </Button>
                            </div>
                          </td>
                        </tr>

                        {/* Collapsible Items Row */}
                        {isExpanded && (
                          <tr className="bg-slate-950/80">
                            <td colSpan={8} className="p-4 border-y border-slate-800">
                              <div className="space-y-2">
                                <h4 className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                                  <span>📦</span> تفاصيل بنود المعاملة ({order.items.length} صنف):
                                </h4>
                                <div className="rounded-lg border border-slate-800 overflow-x-auto">
                                  <table className="w-full text-right text-xs">
                                    <thead className="bg-slate-900 text-slate-400 font-bold border-b border-slate-800">
                                      <tr>
                                        <th className="p-2">الصنف</th>
                                        <th className="p-2">رقم القطعة</th>
                                        <th className="p-2">المنطقة</th>
                                        <th className="p-2">الكمية</th>
                                        <th className="p-2">الوحدة</th>
                                        <th className="p-2">سعر الوحدة</th>
                                        <th className="p-2 text-left">إجمالي البند</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/60 bg-slate-950">
                                      {order.items.map((it) => (
                                        <tr key={`expanded-item-${it.id}`}>
                                          <td className="p-2 font-bold text-slate-100">{it.item_description}</td>
                                          <td className="p-2 font-mono text-cyan-300">{it.item_reference || '—'}</td>
                                          <td className="p-2 text-slate-300">{it.region || '—'}</td>
                                          <td className="p-2 font-mono font-bold text-cyan-200">{formatCleanQty(it.quantity)}</td>
                                          <td className="p-2 text-slate-300">{it.uom}</td>
                                          <td className="p-2 font-mono text-slate-200">{formatCleanNumber(it.unit_price)} ج.م</td>
                                          <td className="p-2 font-mono font-black text-emerald-300 text-left">
                                            {formatCleanNumber(it.line_total)} ج.م
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards View */}
            <div className="lg:hidden divide-y divide-slate-800/80">
              {orders.map((order) => (
                <div key={`mobile-order-${order.unique_key}`} className="p-4 space-y-3 bg-slate-900/40">
                  <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-black text-cyan-300 text-sm">{order.po_number}</span>
                        {order.is_actual_po && (
                          <span className="rounded bg-cyan-950 border border-cyan-500/40 px-1.5 py-0.2 text-[10px] font-bold text-cyan-300">
                            فعلي
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-slate-400 font-mono">طلب: {order.pr_number}</span>
                    </div>
                    {renderStageBadge(order)}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-400 block text-[10px]">القسم:</span>
                      <strong className="text-slate-200">{order.department?.name || '—'}</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px]">المورد:</span>
                      <strong className="text-slate-200">{order.supplier?.name || '—'}</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px]">الموقع:</span>
                      <span className="text-cyan-300 font-mono font-bold">
                        {order.project_site?.parcel_reference || '—'} ({order.project_site?.region || '—'})
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block text-[10px]">الإجمالي المالي:</span>
                      <strong className="text-emerald-300 font-mono font-black text-sm">
                        {formatCleanNumber(order.grand_total)} ج.م
                      </strong>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] text-slate-400 font-mono">
                      {order.created_at ? order.created_at.slice(0, 10) : '—'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {(order.order_id || order.request_id) && (
                        <Button
                          variant="warning"
                          size="sm"
                          onClick={() => handleOpenForceEdit(order)}
                          className="text-xs h-8 px-3 font-black shadow-md border-amber-400/60 text-slate-950"
                        >
                          تعديل
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleOpenForceDelete(order)}
                        className="text-xs h-8 px-2.5 font-black bg-rose-600/90 hover:bg-rose-500 text-white border-rose-500/60 shadow-md shadow-rose-950/40 flex items-center gap-1"
                        title="حذف نهائي شامل للطلب"
                      >
                        <span>🗑️</span>
                        <span>حذف نهائي</span>
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Sovereign Force Edit Modal ── */}
      {(selectedOrderId || selectedRequestId) && (
        <AdminForceEditModal
          orderId={selectedOrderId}
          requestId={selectedRequestId}
          isOpen={isForceModalOpen}
          onClose={() => {
            setIsForceModalOpen(false);
            setSelectedOrderId(null);
            setSelectedRequestId(null);
          }}
          onSuccess={() => {
            fetchOrders(true);
          }}
        />
      )}

      {/* ── Sovereign Force Delete Modal ── */}
      <AdminForceDeleteModal
        isOpen={isDeleteModalOpen}
        order={orderToDelete}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setOrderToDelete(null);
        }}
        onSuccess={handleDeleteSuccess}
      />
    </div>
  );
};

export default AdminMasterOrdersPage;
