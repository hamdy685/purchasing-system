import React, { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  getGeneralManagerPurchaseOrderSummariesApi,
  getGeneralManagerPurchaseRequestsApi,
  approveGeneralManagerPurchaseRequestApi,
  rejectGeneralManagerPurchaseRequestApi,
} from '../../api/generalManager';
import { getPendingQuoteRequestsApi } from '../../api/purchaseQuotes';
import { PurchaseOrder } from '../../types/purchaseOrder';
import { PurchaseRequest } from '../../types/purchaseRequest';
import { Button } from '../../components/ui/Button';
import { KpiCard, KpiPill, KpiPillsBar } from '../../components/ui/Card';
import { CurrencyDisplay } from '../../components/ui/CurrencyDisplay';
import { DashboardBars, DashboardDonut } from '../../components/ui/DashboardCharts';
import { getDefaultDateFrom, getTodayInputDate } from '../../utils/dateFilters';
import ActionRequiredInbox, { ActionInboxItem } from '../../components/dashboard/ActionRequiredInbox';
import QuickLauncherBar from '../../components/dashboard/QuickLauncherBar';
import { PushNotificationPrompt } from '../../components/notifications/PushNotificationPrompt';
import { formatDateTime24h } from '../../utils/dateTime';

import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh';

export const GeneralManagerDashboardPage: React.FC = () => {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [quoteRequests, setQuoteRequests] = useState<PurchaseRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const today = getTodayInputDate();
  const defaultDateFrom = getDefaultDateFrom();
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(today);
  const [departmentId, setDepartmentId] = useState('');
  const [supplierId, setSupplierId] = useState('');

  const loadData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [posData, reqsData, quotesData] = await Promise.all([
        getGeneralManagerPurchaseOrderSummariesApi().catch(() => []),
        getGeneralManagerPurchaseRequestsApi().catch(() => []),
        getPendingQuoteRequestsApi().catch(() => []),
      ]);
      setPos(posData);
      setRequests(reqsData);
      setQuoteRequests(quotesData);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void loadData(false);
  }, []);

  useRealtimeRefresh(() => { void loadData(true); });

  const filteredPos = useMemo(() => {
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`) : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59`) : null;

    return pos.filter((po) => {
      const createdAt = po.created_at ? new Date(po.created_at) : null;
      const currentDepartmentId = po.department?.id ?? po.purchase_request?.target_department?.id ?? po.purchase_request?.department?.id;
      const currentSupplierId = po.supplier_id ?? po.supplier?.id;
      const matchesFrom = !from || (!!createdAt && createdAt >= from);
      const matchesTo = !to || (!!createdAt && createdAt <= to);
      const matchesDepartment = !departmentId || String(currentDepartmentId) === departmentId;
      const matchesSupplier = !supplierId || String(currentSupplierId) === supplierId;
      return matchesFrom && matchesTo && matchesDepartment && matchesSupplier;
    });
  }, [pos, dateFrom, dateTo, departmentId, supplierId]);

  const departmentOptions = useMemo(() => {
    const options = new Map<string, string>();
    pos.forEach((po) => {
      const id = po.department?.id ?? po.purchase_request?.target_department?.id ?? po.purchase_request?.department?.id;
      const name = po.purchase_request?.target_department?.name || po.department?.name || po.purchase_request?.department?.name;
      if (id && name) options.set(String(id), name);
    });
    return Array.from(options, ([id, name]) => ({ id, name }));
  }, [pos]);

  const supplierOptions = useMemo(() => {
    const options = new Map<string, string>();
    pos.forEach((po) => {
      const id = po.supplier_id ?? po.supplier?.id;
      const name = po.supplier?.company_name;
      if (id && name) options.set(String(id), name);
    });
    return Array.from(options, ([id, name]) => ({ id, name }));
  }, [pos]);

  const isActualPo = (p: any) =>
    Boolean(p.finalized_at) ||
    ['ISSUED', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'].includes(p.status);

  const actualPos = filteredPos.filter(isActualPo);
  const totalValue = actualPos.reduce((acc, x) => acc + Number(x.grand_total || 0), 0);

  // حساب القرارات التنفيذية المطلوبة بدقة مع منع التكرار تماماً
  const gmActionItems: ActionInboxItem[] = useMemo(() => {
    const seenPrIds = new Set<number>();
    const items: ActionInboxItem[] = [];

    // 1. طلبات الشراء بانتظار قرار المدير التنفيذي (سواء اعتماد مبدئي أو اعتماد نهائي بعد التسعير)
    for (const req of requests) {
      if (seenPrIds.has(req.id)) continue;
      seenPrIds.add(req.id);

      const isFinalApproval = Boolean(
        req.executive_stage === 'FINAL_APPROVAL' ||
        req.is_returned_from_procurement ||
        req.status === 'APPROVED_BY_PROCUREMENT' ||
        (req.procurement_route === 'DIRECT' && (Boolean(req.direct_supplier_id || req.direct_supplier) || Boolean(req.items?.some((it) => Number(it.estimated_unit_price || 0) > 0)))) ||
        (Boolean(req.direct_supplier_id || req.direct_supplier) && (Number(req.total_estimated_cost || 0) > 0 || Boolean(req.items?.some((it) => Number(it.estimated_unit_price || 0) > 0))))
      );

      items.push({
        id: `req-${req.id}`,
        rawId: req.id,
        type: 'PR' as const,
        code: req.request_number,
        title: req.justification || (req.request_type === 'OFFICE_SUPPLIES' ? 'طلب مستلزمات مكتبية' : 'طلب مواد مشروعات'),
        subtitle: req.justification ? (req.request_type === 'OFFICE_SUPPLIES' ? 'مستلزمات مكتبية' : 'مشتريات مواقع') : undefined,
        department: req.department?.name,
        requester: req.requester?.name,
        amount: isFinalApproval && req.total_estimated_cost ? Number(req.total_estimated_cost) : undefined,
        supplier: isFinalApproval ? (req.direct_supplier?.company_name || req.items?.find((i) => i.supplier?.company_name)?.supplier?.company_name) : undefined,
        urgency: req.priority === 'HIGH' ? ('CRITICAL' as const) : ('HIGH' as const),

        // تمييز شارة المرحلة بوضوح تام
        stageBadge: isFinalApproval
          ? {
              text: 'راجع من المشتريات (مسعر)',
              icon: '📥',
              className: 'bg-emerald-950/90 text-emerald-300 border-emerald-600/70 shadow-emerald-950/40',
            }
          : {
              text: 'رايح للمشتريات (طلب جديد)',
              icon: '🛫',
              className: 'bg-sky-950/90 text-sky-300 border-sky-600/70 shadow-sky-950/40',
            },

        reason: isFinalApproval
          ? 'طلب شراء مسعر من إدارة المشتريات ومحدد المورد والأسعار — بانتظار اعتمادك النهائي للإحالة للحسابات'
          : 'طلب شراء جديد معتمد من المراجع — بانتظار موافقتك المبدئية لإحالته لإدارة المشتريات للبدء في التسعير',

        next_actor: isFinalApproval
          ? (req.next_actor_label || 'الإدارة المالية (الحسابات)')
          : (req.next_actor_label || 'إدارة المشتريات'),

        actionUrl: `/general-manager/purchase-requests?open=${req.id}&view=items_only`,
        actionLabel: isFinalApproval
          ? 'مراجعة الأسعار والمورد وتعديل الطلب'
          : 'مراجعة وتعديل الطلب',

        created_at: req.created_at,
        timeAgo: req.created_at ? formatDateTime24h(req.created_at) : undefined,
        purpose: req.notes || (req as any).purpose || req.justification || '',
        notes: req.notes || (req as any).purpose || '',
        request_type: req.request_type,
        date_needed: req.date_needed || undefined,
        priority: req.priority,
        parcel_number: req.items?.[0]?.item_reference || undefined,
        region: req.items?.[0]?.region || undefined,
        items_count: req.items?.length || 0,
        items_list: req.items?.map((it) => ({
          description: it.item_description || it.item?.name || 'صنف',
          quantity: it.quantity,
          uom: it.uom,
          parcel: it.item_reference,
          region: it.region,
          unit_price: isFinalApproval ? it.estimated_unit_price : undefined,
          line_total: isFinalApproval ? it.estimated_line_total : undefined,
          specifications: it.specifications,
        })),
        onDirectApprove: async (_item: any, comment?: string) => {
          await approveGeneralManagerPurchaseRequestApi(req.id, comment);
          // The decided request leaves the inbox at once; the rest refreshes in the background.
          setRequests((prev) => prev.filter((r) => r.id !== req.id));
          void loadData(true);
        },
        onDirectReject: async (_item: any, reason: string) => {
          await rejectGeneralManagerPurchaseRequestApi(req.id, reason);
          setRequests((prev) => prev.filter((r) => r.id !== req.id));
          void loadData(true);
        },

        // أزرار اتخاذ القرار الدقيقة لكل حالة
        directApproveLabel: isFinalApproval
          ? 'اعتماد تنفيذي نهائي'
          : 'موافقة وإرسال للمشتريات',
        directApproveIcon: isFinalApproval ? '👑✓' : '📤',
        directApproveClassName: isFinalApproval
          ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-950/40 ring-1 ring-emerald-400/40'
          : 'bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-950/40 ring-1 ring-sky-400/40',
        directRejectLabel: 'رفض الطلب',
        requireApproveModal: false,
      });
    }

    // 2. قرارات البت والترسية التنفيذية لعروض الأسعار الموصى بها
    for (const q of quoteRequests) {
      if (q.status !== 'PENDING_EXECUTIVE_QUOTE_DECISION') continue;
      if (seenPrIds.has(q.id)) continue;
      seenPrIds.add(q.id);

      items.push({
        id: `quote-${q.id}`,
        rawId: q.id,
        type: 'QUOTE' as const,
        code: q.request_number,
        title: q.justification || 'عروض أسعار بانتظار الاعتماد والترسية التنفيذية',
        subtitle: `${q.quotes?.length || 'عدة'} عروض أسعار تمت التوصية بها`,
        department: q.department?.name,
        requester: q.requester?.name,
        amount: q.total_estimated_cost ? Number(q.total_estimated_cost) : undefined,
        urgency: 'CRITICAL' as const,
        stageBadge: {
          text: 'ترسية عروض أسعار',
          icon: '⚖️',
          className: 'bg-indigo-950/90 text-indigo-300 border-indigo-600/70 shadow-indigo-950/40',
        },
        reason: 'عروض أسعار مكتملة التوصيات من القسم والمشتريات بانتظار البت والترسية التنفيذية لاختيار العرض الفائز',
        next_actor: 'إدارة المشتريات (لإصدار أمر الشراء بعد الترسية)',
        actionUrl: `/general-manager/purchase-quotes?open=${q.id}`,
        actionLabel: 'البت والترسية التنفيذية لعروض الأسعار',
        created_at: q.created_at || undefined,
        timeAgo: q.created_at ? formatDateTime24h(q.created_at) : undefined,
        purpose: q.notes || (q as any).purpose || q.justification || '',
        notes: q.notes || (q as any).purpose || '',
        items_count: q.items?.length || 0,
        items_list: q.items?.map((it) => ({
          description: it.item_description || it.item?.name || 'صنف',
          quantity: it.quantity,
          uom: it.uom,
          parcel: it.item_reference,
          region: it.region,
          unit_price: it.estimated_unit_price,
          line_total: it.estimated_line_total,
        })),
        directApproveLabel: undefined,
        directRejectLabel: undefined,
      });
    }

    return items;
  }, [requests, quoteRequests]);

  const pendingGmRequestsCount = useMemo(
    () => gmActionItems.filter((i) => i.type === 'PR').length,
    [gmActionItems]
  );
  const pendingGmQuotesCount = useMemo(
    () => gmActionItems.filter((i) => i.type === 'QUOTE').length,
    [gmActionItems]
  );

  // القسم Spend Breakdown (Actual POs only to prevent inflated numbers)
  const deptSpendMap = actualPos.reduce((acc: Record<string, number>, p) => {
    const deptName = p.purchase_request?.target_department?.name || p.purchase_request?.department?.name || p.department?.name || 'عام';
    acc[deptName] = (acc[deptName] || 0) + Number(p.grand_total || 0);
    return acc;
  }, {});

  // المورد Share Breakdown (Actual POs only)
  const supplierSpendMap = actualPos.reduce((acc: Record<string, number>, p) => {
    const supName = p.supplier?.company_name || 'غير محدد';
    acc[supName] = (acc[supName] || 0) + Number(p.grand_total || 0);
    return acc;
  }, {});
  const statusSegments = [
    { label: 'تم الإصدار', value: filteredPos.filter((po) => po.status === 'ISSUED').length, color: '#22c55e' },
    { label: 'في انتظار الحسابات', value: filteredPos.filter((po) => po.status === 'PENDING_ACCOUNTING_REVIEW').length, color: '#f59e0b' },
    { label: 'معاد للمشتريات', value: filteredPos.filter((po) => po.status === 'RETURNED_TO_PROCUREMENT').length, color: '#fb923c' },
    { label: 'معتمد نهائيًا', value: filteredPos.filter((po) => po.status === 'FINAL_APPROVED').length, color: '#06b6d4' },
  ];

  if (loading) {
    return <div className="text-cyan-400 animate-pulse text-xs p-6" dir="rtl">جاري تحميل بيانات لوحة الإدارة العامة...</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in" dir="rtl">
      {/* ── صندوق القرارات التنفيذية المطلوبة منك الآن (يظهر في أعلى الصفحة للمدير العام مباشرة) ── */}
      <ActionRequiredInbox
        title="القرارات التنفيذية المطلوبة منك الآن"
        description="طلبات الشراء وعروض الأسعار المعلقة التي تتطلب قرارك المباشر حصراً (اعتماد مبدئي، اعتماد نهائي بعد التسعير، أو بت في الترسية)."
        roleName="الإدارة التنفيذية العليا"
        onItemActionComplete={() => loadData(true)}
        items={gmActionItems}
      />

      {/* Filters */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5" aria-label="فلاتر لوحة المدير العام">
        <label className="text-xs text-slate-400">
          من تاريخ
          <input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400" />
        </label>
        <label className="text-xs text-slate-400">
          إلى تاريخ
          <input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400" />
        </label>
        <label className="text-xs text-slate-400">
          القسم
          <select value={departmentId} onChange={event => setDepartmentId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400">
            <option value="">كل الأقسام</option>
            {departmentOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          المورد
          <select value={supplierId} onChange={event => setSupplierId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400">
            <option value="">كل الموردين</option>
            {supplierOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { setDateFrom(defaultDateFrom); setDateTo(today); setDepartmentId(''); setSupplierId(''); }} className="self-end rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-500 hover:text-cyan-300">
          إعادة ضبط الفلاتر
        </button>
      </div>

      {/* Slim Horizontal KPI Pills */}
      <KpiPillsBar className="my-2">
        <KpiPill
          title="أوامر الشراء المصدرة"
          value={`${filteredPos.length} أمر`}
          accentColor="cyan"
          icon={<span className="text-xs">📋</span>}
          to="/general-manager/purchase-orders"
          clickableHint="عرض أوامر الشراء ←"
        />
        <KpiPill
          title="إجمالي أوامر الشراء الفعلية"
          value={<CurrencyDisplay amount={totalValue} amountClassName="font-bold font-mono text-emerald-400 text-xs" />}
          accentColor="emerald"
          icon={<span className="text-xs">💵</span>}
          to="/general-manager/reports"
          clickableHint="تقارير الإنفاق ←"
        />
        <KpiPill
          title="بانتظار الاعتماد التنفيذي"
          value={`${pendingGmRequestsCount} طلب`}
          accentColor="amber"
          icon={<span className="text-xs">⏳</span>}
          to="/general-manager/purchase-requests"
          clickableHint="مراجعة واعتماد الطلبات ←"
        />
        <KpiPill
          title="عروض أسعار للترسية"
          value={`${pendingGmQuotesCount} معاملة`}
          accentColor="indigo"
          icon={<span className="text-xs">⚖️</span>}
          to="/general-manager/purchase-quotes"
          clickableHint="اتخاذ قرارات الترسية ←"
        />
      </KpiPillsBar>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DashboardBars
          title="الإنفاق حسب القسم"
          subtitle="توزيع إجمالي قيم المشتريات على الأقسام"
          segments={Object.entries(deptSpendMap).map(([label, value]) => ({ label, value }))}
          unit="ج.م"
        />
        <DashboardBars
          title="الإنفاق حسب المورد"
          subtitle="أعلى الموردين تعاملاً في النطاق الحالي"
          segments={Object.entries(supplierSpendMap).map(([label, value]) => ({ label, value }))}
          unit="ج.م"
        />
      </div>

      {/* Executive الإجراءات Bar */}
      <div className="flex gap-4 pt-4 border-t border-slate-800 flex-wrap">
        <RouterLink to="/general-manager/purchase-orders">
          <button className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg text-xs font-bold transition-colors">
            عرض كافة أوامر الشراء المعتمدة &rarr;
          </button>
        </RouterLink>
        <RouterLink to="/general-manager/reports">
          <button className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-bold transition-colors">
            📈 تقارير الإنفاق التفصيلية
          </button>
        </RouterLink>
      </div>

      {/* ── أقسام التعريف والإشعارات والوصول السريع (تم نقلها لأسفل الصفحة لسهولة وصول المدير العام للطلبات أولاً) ── */}
      <div className="border-t border-slate-800/80 pt-6 space-y-4">
        {/* Executive Header */}
        <div className="border border-slate-800 bg-slate-900/50 rounded-2xl p-4">
          <div className="flex justify-between items-center flex-wrap gap-2">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-100 flex items-center gap-2">
                <span>👑</span> لوحة المدير العام التنفيذية
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                متابعة التدفقات التنفيذية والقرارات المعلقة وأوامر الشراء المصدرة وتقارير الإنفاق بـ (EGP / ج.م).
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 bg-blue-900/40 border border-blue-700/50 rounded-lg px-3 py-1.5">
              <span className="text-xs text-blue-300 font-medium">🛡️ الإدارة التنفيذية العليا</span>
            </div>
          </div>
        </div>

        {/* ── حالة واختبار إشعارات التابلت ── */}
        <PushNotificationPrompt variant="executive" title="إشعارات التابلت وجهاز المدير العام" className="mb-1" />

        {/* ── اختصارات الإجراءات السريعة (Quick Launcher Bar) ── */}
        <QuickLauncherBar className="mb-2" />
      </div>
    </div>
  );
};

export default GeneralManagerDashboardPage;
