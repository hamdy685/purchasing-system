import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getItemsAdminApi } from '../../api/admin/items';
import { getSuppliersAdminApi } from '../../api/admin/suppliers';
import { getUsersAdminApi } from '../../api/admin/users';
import { getDepartmentsAdminApi } from '../../api/admin/departments';
import {
  getAdminSystemMonitoringApi,
  getAdminAuditLogApi,
  runAdminMigrationsApi,
  MonitoringSnapshot,
  AdminAuditEvent,
} from '../../api/admin/systemMonitoring';
import LoadingSpinner from '../../components/LoadingSpinner';
import ErrorMessage from '../../components/ErrorMessage';
import { parseApiError } from '../../utils/apiError';
import { useAuth } from '../../context/AuthContext';
import { KpiCard, Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { DashboardBars } from '../../components/ui/DashboardCharts';
import GuestOfficeLinkCard from '../../components/admin/GuestOfficeLinkCard';
import { exportToCsv } from '../../utils/exportCsv';
import ActionRequiredInbox, { ActionInboxItem } from '../../components/dashboard/ActionRequiredInbox';

export const AdminDashboardPage: React.FC = () => {
  const [usersCount, setUsersCount] = useState<number | null>(null);
  const [deptsCount, setDeptsCount] = useState<number | null>(null);
  const [itemsCount, setItemsCount] = useState<number | null>(null);
  const [suppliersCount, setSuppliersCount] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [auditEvents, setAuditEvents] = useState<AdminAuditEvent[]>([]);
  const [auditFilter, setAuditFilter] = useState<'ALL' | 'WORKFLOW' | 'USERS' | 'SUPPLIERS'>('ALL');
  const [loading, setLoading] = useState<boolean>(true);
  const [exporting, setExporting] = useState<boolean>(false);
  const [runningMigrations, setRunningMigrations] = useState<boolean>(false);
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { hasPermission } = useAuth();

  const handleRunMigrations = async () => {
    setRunningMigrations(true);
    setMigrationMessage(null);
    try {
      const res = await runAdminMigrationsApi();
      setMigrationMessage(res.message || 'تم تطبيق الترحيلات بنجاح.');
      await loadData();
    } catch (err) {
      setMigrationMessage(parseApiError(err).message);
    } finally {
      setRunningMigrations(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const promises: Promise<any>[] = [];

      promises.push(
        getAdminSystemMonitoringApi()
          .then((res) => setSnapshot(res))
          .catch(() => setSnapshot(null))
      );

      promises.push(
        getAdminAuditLogApi()
          .then((res) => setAuditEvents(res))
          .catch(() => setAuditEvents([])),
      );

      if (hasPermission('system.users.manage')) {
        promises.push(
          getUsersAdminApi()
            .then((res) => setUsersCount(res.length))
            .catch(() => setUsersCount(null))
        );
      }

      if (hasPermission('system.departments.manage')) {
        promises.push(
          getDepartmentsAdminApi()
            .then((res) => setDeptsCount(res.length))
            .catch(() => setDeptsCount(null))
        );
      }

      if (hasPermission('system.items.manage')) {
        promises.push(
          getItemsAdminApi()
            .then((res) => setItemsCount(res.length))
            .catch(() => setItemsCount(null))
        );
      }

      if (hasPermission('system.suppliers.manage') || hasPermission('supplier.view')) {
        promises.push(
          getSuppliersAdminApi()
            .then((res) => setSuppliersCount(res.length))
            .catch(() => setSuppliersCount(null))
        );
      }

      await Promise.all(promises);
    } catch (err: unknown) {
      const parsed = parseApiError(err);
      setError(parsed.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExportAuditLogs = () => {
    if (!auditEvents.length) return;
    setExporting(true);
    try {
      const headers = ['معرّف الحدث', 'نوع الحدث', 'الإجراء', 'الكيان', 'رقم الكيان', 'المستخدم المنفّذ', 'تاريخ ووقت الحدث'];
      const rows = auditEvents.map((evt) => [
        evt.id,
        evt.event_type || 'نظام',
        evt.action,
        evt.entity_type,
        evt.entity_id,
        evt.actor?.name || 'النظام التلقائي',
        evt.occurred_at ? new Date(evt.occurred_at).toLocaleString('ar-EG') : '—',
      ]);
      exportToCsv({
        filename: `ashbiliya_audit_log_${new Date().toISOString().slice(0, 10)}.csv`,
        headers,
        rows,
      });
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const adminActionItems: ActionInboxItem[] = React.useMemo(() => {
    const items: ActionInboxItem[] = [];

    // 1. Alerts from snapshot
    if (snapshot?.alerts) {
      snapshot.alerts
        .filter((a) => a.status === 'open')
        .forEach((alert, idx) => {
          items.push({
            id: `admin-alert-${idx}`,
            rawId: idx,
            type: 'PR' as const,
            code: `ALERT-${idx + 1}`,
            title: alert.title,
            subtitle: alert.message,
            urgency: alert.severity === 'critical' ? 'CRITICAL' : alert.severity === 'high' ? 'HIGH' : 'NORMAL',
            reason: alert.message,
            actionUrl: '/admin/system-monitor',
            actionLabel: 'فحص التنبيه بالنظام',
          });
        });
    }

    // 2. Database Disconnection Alert
    if (snapshot?.database?.status === 'disconnected') {
      items.push({
        id: 'admin-db-down',
        rawId: 9991,
        type: 'PR' as const,
        code: 'DB-ERR',
        title: 'قاعدة البيانات غير متصلة!',
        subtitle: snapshot.database.error || 'فشل الاتصال بقاعدة البيانات',
        urgency: 'CRITICAL',
        reason: 'توقف الاتصال بقاعدة البيانات يستدعي تدخل مسؤول النظام الفوري',
        actionUrl: '/admin/system-monitor',
        actionLabel: 'فحص اتصال قاعدة البيانات',
      });
    }

    // 3. Pending migrations
    if (snapshot?.migrations?.pending_count && snapshot.migrations.pending_count > 0) {
      items.push({
        id: 'admin-migrations-pending',
        rawId: 9992,
        type: 'PR' as const,
        code: 'MIGRATE',
        title: `يوجد ${snapshot.migrations.pending_count} ترحيل قاعدة بيانات معلق`,
        subtitle: 'تحديثات الجداول تحتاج تطبيق للوصول لأحدث إصدار',
        urgency: 'HIGH',
        reason: 'توجد ملفات ترحيل معلقة بقاعدة البيانات',
        actionUrl: '/admin/system-monitor',
        actionLabel: runningMigrations ? 'جاري التطبيق...' : '⚡ تطبيق الترحيل الآن',
        onAction: () => void handleRunMigrations(),
      });
    }

    // 4. Failed Jobs
    if (snapshot?.counts?.failed_jobs && snapshot.counts.failed_jobs > 0) {
      items.push({
        id: 'admin-failed-jobs',
        rawId: 9993,
        type: 'PR' as const,
        code: 'JOBS-FAIL',
        title: `يوجد ${snapshot.counts.failed_jobs} مهمة معالجة فاشلة (Failed Jobs)`,
        subtitle: 'مهام خلفية لم تكتمل بنجاح في طابور العمليات',
        urgency: 'HIGH',
        reason: 'مهام في طابور العمليات الخلفية واجهت أخطاء برمجية أو انقطاع',
        actionUrl: '/admin/system-monitor',
        actionLabel: 'فحص طابور العمليات',
      });
    }

    return items;
  }, [snapshot]);

  if (loading) {
    return <LoadingSpinner fullScreen message="جاري تحميل لوحة تحكم الإدارة العامة بالنظام..." />;
  }

  return (
    <div className="space-y-6 animate-fade-in" dir="rtl">
      {/* Header */}
      <div className="pb-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-black text-slate-100">لوحة تحكم وإدارة النظام</h1>
          <p className="mt-1 text-xs text-slate-400">
            المراقبة الحية لعمليات الشراء، الهيكل التنظيمي، المستخدمين، الصلاحيات وسجلات التدقيق.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportAuditLogs}
            disabled={exporting || auditEvents.length === 0}
            className="border-slate-700 bg-slate-900 text-cyan-300 hover:bg-slate-800 text-xs font-bold flex items-center gap-1.5"
          >
            <span>💾</span>
            <span>{exporting ? 'جاري التصدير...' : 'تصدير سجل العمليات (Excel)'}</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={loadData}
            className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 text-xs font-bold"
          >
            <span>🔄</span>
            <span>تحديث</span>
          </Button>
        </div>
      </div>

      {/* ── تنبيه الترحيلات المعلقة مع زر التنفيذ المباشر ── */}
      {snapshot?.migrations?.pending_count && snapshot.migrations.pending_count > 0 ? (
        <div className="rounded-2xl border-2 border-amber-500/50 bg-gradient-to-r from-amber-950/40 via-slate-900 to-amber-950/20 p-4 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xl font-black animate-pulse">
              ⚠️
            </span>
            <div>
              <h3 className="text-sm font-black text-amber-200">
                يوجد {snapshot.migrations.pending_count} ترحيل قاعدة بيانات معلق
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                تحديثات الجداول وقاعدة البيانات بانتظار التطبيق للوصول لأحدث إصدار.
              </p>
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleRunMigrations}
            disabled={runningMigrations}
            className="bg-amber-600 hover:bg-amber-500 text-slate-950 font-black shadow-lg shadow-amber-900/40 shrink-0 flex items-center gap-2"
          >
            <span>⚡</span>
            <span>{runningMigrations ? 'جاري تطبيق الترحيلات...' : 'تطبيق الترحيلات الآن بضغطة واحدة'}</span>
          </Button>
        </div>
      ) : null}

      {migrationMessage && (
        <div className="rounded-xl border border-cyan-500/50 bg-cyan-950/40 p-3 text-xs text-cyan-200 flex items-center justify-between">
          <span>{migrationMessage}</span>
          <button onClick={() => setMigrationMessage(null)} className="text-slate-400 hover:text-white text-sm font-bold">✕</button>
        </div>
      )}

      {/* ── صندوق المهام والإجراءات الإدارية المطلوبة (Admin Action Inbox) ── */}
      <ActionRequiredInbox
        title="المهام والإجراءات الإدارية المطلوبة منك الآن"
        description="تنبيهات حالة النظام، ترحيلات قواعد البيانات، والأعطال التشغيلية التي تتطلب تدخلاً إدارياً."
        roleName="مدير النظام العام"
        onItemActionComplete={() => void loadData()}
        items={adminActionItems}
      />

      {/* ── صندوق العمليات والإدارة السريعة (Admin Quick Actions Hub) ── */}
      <div className="rounded-2xl border-2 border-indigo-500/40 bg-gradient-to-r from-slate-900 via-indigo-950/20 to-slate-900 p-4 sm:p-5 shadow-xl space-y-4">
        <div className="flex items-center gap-2.5 border-b border-indigo-900/40 pb-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600/30 border border-indigo-500/50 text-indigo-300 text-lg font-black shadow-inner">
            ⚡
          </span>
          <div>
            <h2 className="text-base font-black text-slate-100">
              مركز الإجراءات والعمليات الإدارية السريعة
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              إدارة المستخدمين والأقسام والأصناف والموردين ومراقبة أداء النظام.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 pt-1">
          {hasPermission('system.users.manage') && (
            <Link to="/admin/users">
              <Button variant="secondary" size="sm" className="w-full h-auto py-2.5 text-xs flex flex-col gap-1 items-center border-slate-700 bg-slate-950/80 hover:border-cyan-500/60">
                <span className="text-base">👥</span>
                <span className="font-bold text-slate-200">إدارة المستخدمين</span>
              </Button>
            </Link>
          )}

          {hasPermission('system.departments.manage') && (
            <Link to="/admin/departments">
              <Button variant="secondary" size="sm" className="w-full h-auto py-2.5 text-xs flex flex-col gap-1 items-center border-slate-700 bg-slate-950/80 hover:border-indigo-500/60">
                <span className="text-base">🏢</span>
                <span className="font-bold text-slate-200">الأقسام والهيكل</span>
              </Button>
            </Link>
          )}

          {hasPermission('system.items.manage') && (
            <Link to="/admin/items">
              <Button variant="secondary" size="sm" className="w-full h-auto py-2.5 text-xs flex flex-col gap-1 items-center border-slate-700 bg-slate-950/80 hover:border-emerald-500/60">
                <span className="text-base">📦</span>
                <span className="font-bold text-slate-200">كتالوج الأصناف</span>
              </Button>
            </Link>
          )}

          {(hasPermission('system.suppliers.manage') || hasPermission('supplier.view')) && (
            <Link to="/admin/suppliers">
              <Button variant="secondary" size="sm" className="w-full h-auto py-2.5 text-xs flex flex-col gap-1 items-center border-slate-700 bg-slate-950/80 hover:border-amber-500/60">
                <span className="text-base">🏭</span>
                <span className="font-bold text-slate-200">الموردين والأرصدة</span>
              </Button>
            </Link>
          )}

          <Link to="/admin/master-orders">
            <Button variant="secondary" size="sm" className="w-full h-auto py-2.5 text-xs flex flex-col gap-1 items-center border-amber-500/60 bg-amber-950/40 text-amber-300 hover:border-amber-400 shadow-md shadow-amber-950/30">
              <span className="text-base">🎛️</span>
              <span className="font-bold text-amber-200">التحكم الشامل في الطلبات</span>
            </Button>
          </Link>

          <Link to="/admin/request-tracker">
            <Button variant="secondary" size="sm" className="w-full h-auto py-2.5 text-xs flex flex-col gap-1 items-center border-indigo-800/60 bg-indigo-950/40 text-indigo-300 hover:border-indigo-400">
              <span className="text-base">📋</span>
              <span className="font-bold text-indigo-200">مركز متابعة الطلبات</span>
            </Button>
          </Link>

          <Link to="/admin/system-monitor">
            <Button variant="secondary" size="sm" className="w-full h-auto py-2.5 text-xs flex flex-col gap-1 items-center border-cyan-800/60 bg-cyan-950/30 text-cyan-300 hover:border-cyan-400">
              <span className="text-base">🖥️</span>
              <span className="font-bold text-cyan-200">مراقبة صحة النظام</span>
            </Button>
          </Link>
        </div>
      </div>

      {error && <ErrorMessage error={error} />}

      {/* ── ملخص سير المعاملات والمراقبة الحية (Operational Workflow Health) ── */}
      {snapshot && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-black text-slate-200 flex items-center gap-2">
              <span className="text-emerald-400">📊</span> المراقبة التشغيلية لدورة المعاملات الحية
            </h2>
            <span className="text-[11px] text-slate-400 font-mono">
              قاعدة البيانات: {snapshot.database.status === 'connected' ? '🟢 متصلة' : '🔴 عطل'}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 space-y-1">
              <span className="text-[11px] font-bold text-slate-400 block">إجمالي طلبات الشراء</span>
              <span className="text-lg font-mono font-black text-cyan-400 block">
                {snapshot.counts.purchase_requests}
              </span>
              <span className="text-[10px] text-slate-500">
                المعلقة: {(snapshot.workflow.purchase_requests_by_status?.SUBMITTED || 0) + (snapshot.workflow.purchase_requests_by_status?.UNDER_REVIEW || 0)}
              </span>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 space-y-1">
              <span className="text-[11px] font-bold text-slate-400 block">بانتظار المدير العام</span>
              <span className="text-lg font-mono font-black text-amber-400 block">
                {snapshot.workflow.purchase_requests_by_status?.PENDING_EXECUTIVE_APPROVAL || snapshot.workflow.purchase_requests_by_status?.PENDING_EXECUTIVE_QUOTE_DECISION || 0}
              </span>
              <span className="text-[10px] text-slate-500">طلبات عروض وقرارات</span>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 space-y-1">
              <span className="text-[11px] font-bold text-slate-400 block">أوامر الشراء (POs)</span>
              <span className="text-lg font-mono font-black text-indigo-400 block">
                {snapshot.counts.purchase_orders}
              </span>
              <span className="text-[10px] text-slate-500">
                الحسابات: {snapshot.workflow.purchase_orders_by_status?.PENDING_ACCOUNTING_REVIEW || 0}
              </span>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 space-y-1">
              <span className="text-[11px] font-bold text-slate-400 block">المستخدمون النشطون</span>
              <span className="text-lg font-mono font-black text-emerald-400 block">
                {snapshot.counts.active_users} / {snapshot.counts.users}
              </span>
              <span className="text-[10px] text-slate-500">حساب مفعل بالنظام</span>
            </div>
          </div>
        </div>
      )}

      {/* Available Management KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {hasPermission('system.users.manage') && (
          <KpiCard
            title="المستخدمين"
            value={usersCount !== null ? usersCount : '—'}
            accentColor="cyan"
            icon={<span className="text-sm">👥</span>}
            to="/admin/users"
            clickableHint="إدارة المستخدمين ←"
          />
        )}

        {hasPermission('system.departments.manage') && (
          <KpiCard
            title="الأقسام والإدارات"
            value={deptsCount !== null ? deptsCount : '—'}
            accentColor="indigo"
            icon={<span className="text-sm">🏢</span>}
            to="/admin/departments"
            clickableHint="إدارة الأقسام ←"
          />
        )}

        {hasPermission('system.items.manage') && (
          <KpiCard
            title="الأصناف في الكتالوج"
            value={itemsCount !== null ? itemsCount : '—'}
            accentColor="emerald"
            icon={<span className="text-sm">📦</span>}
            to="/admin/items"
            clickableHint="كتالوج الأصناف ←"
          />
        )}

        {(hasPermission('system.suppliers.manage') || hasPermission('supplier.view')) && (
          <KpiCard
            title="سجل الموردين"
            value={suppliersCount !== null ? suppliersCount : '—'}
            accentColor="amber"
            icon={<span className="text-sm">🏭</span>}
            to="/admin/suppliers"
            clickableHint="سجل الموردين ←"
          />
        )}
      </div>

      <GuestOfficeLinkCard />

      {/* ── سجل الأحداث والنشاط اللحظي (Audit Trail Feed) ── */}
      <Card className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-sm font-black text-slate-100 flex items-center gap-2">
              <span>📜</span> سجل الأحداث والنشاط اللحظي (Audit Trail)
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              تسجيل زمني لجميع عمليات الدخول، الاعتمادات، والتعديلات المنفذة في النظام.
            </p>
          </div>

          <div className="flex items-center gap-1.5">
            {(['ALL', 'WORKFLOW', 'USERS', 'SUPPLIERS'] as const).map((filterKey) => {
              const labels = {
                ALL: 'الكل',
                WORKFLOW: 'الطلبات والأوامر',
                USERS: 'المستخدمين',
                SUPPLIERS: 'الموردين',
              };
              return (
                <button
                  key={filterKey}
                  type="button"
                  onClick={() => setAuditFilter(filterKey)}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition-all ${
                    auditFilter === filterKey
                      ? 'bg-cyan-600 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {labels[filterKey]}
                </button>
              );
            })}
          </div>
        </div>

        {auditEvents.length === 0 ? (
          <p className="text-xs text-slate-500 py-4 text-center">لا توجد أحداث مسجلة حديثاً في سجل النظام.</p>
        ) : (
          <div className="divide-y divide-slate-800/60 max-h-80 overflow-y-auto pr-1">
            {auditEvents
              .filter((evt) => {
                if (auditFilter === 'WORKFLOW') return evt.entity_type?.includes('purchase_request') || evt.entity_type?.includes('purchase_order') || evt.entity_type?.includes('receipt');
                if (auditFilter === 'USERS') return evt.entity_type?.includes('user') || evt.entity_type?.includes('role') || evt.entity_type?.includes('department');
                if (auditFilter === 'SUPPLIERS') return evt.entity_type?.includes('supplier');
                return true;
              })
              .slice(0, 15)
              .map((evt) => (
                <div key={evt.id} className="py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-slate-900/40 px-2 rounded-lg transition-colors">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-800 border border-slate-700 text-xs text-cyan-300">
                      ⚡
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-200 truncate">{evt.action}</span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.2 text-[9px] font-bold text-slate-400 shrink-0">
                          {evt.entity_type} #{evt.entity_id}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                        المنفّذ: <strong className="text-slate-300">{evt.actor?.name || 'النظام التلقائي'}</strong>
                        {evt.entity_label && ` — ${evt.entity_label}`}
                      </p>
                    </div>
                  </div>

                  <span className="shrink-0 text-[10px] font-mono text-slate-500">
                    {evt.occurred_at ? new Date(evt.occurred_at).toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '—'}
                  </span>
                </div>
              ))}
          </div>
        )}
      </Card>

      <DashboardBars
        title="حجم وحدات النظام"
        subtitle="عدد السجلات الإدارية المتاحة حسب الوحدة"
        segments={[
          { label: 'المستخدمون', value: usersCount ?? 0, color: '#06b6d4' },
          { label: 'الأقسام والإدارات', value: deptsCount ?? 0, color: '#6366f1' },
          { label: 'الأصناف في الكتالوج', value: itemsCount ?? 0, color: '#22c55e' },
          { label: 'الموردون', value: suppliersCount ?? 0, color: '#f59e0b' },
        ]}
        unit="سجل"
      />

      {/* Module Capabilities & الحالة */}
      <div className="space-y-4">
        <h2 className="text-sm font-bold text-slate-200">
          حالة وحدات إدارة النظام
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 text-xs">👥 إدارة المستخدمين</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                متاح بالكامل
              </span>
            </div>
            <p className="text-xs text-slate-400">
              إضافة المستخدمين، تعيين الأقسام، تفعيل/تعطيل الحسابات وتخصيص الأدوار.
            </p>
            <Link to="/admin/users" className="block pt-2">
              <Button variant="secondary" size="sm" className="w-full">
                إدارة المستخدمين &rarr;
              </Button>
            </Link>
          </Card>

          <Card className="space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 text-xs">🛡️ الأدوار</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                مستعرض الأدوار
              </span>
            </div>
            <p className="text-xs text-slate-400">
              استعراض أدوار النظام الثابتة والصلاحيات المسندة لكل دور بشكل رسمي.
            </p>
            <Link to="/admin/roles" className="block pt-2">
              <Button variant="secondary" size="sm" className="w-full">
                عرض الأدوار &rarr;
              </Button>
            </Link>
          </Card>

          <Card className="space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 text-xs">🔑 الصلاحيات</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                دليل الصلاحيات
              </span>
            </div>
            <p className="text-xs text-slate-400">
              استعراض قائمة الصلاحيات الشاملة ومصفوفة الصلاحيات حسب كل موديول.
            </p>
            <Link to="/admin/permissions" className="block pt-2">
              <Button variant="secondary" size="sm" className="w-full">
                عرض مصفوفة الصلاحيات &rarr;
              </Button>
            </Link>
          </Card>

          <Card className="space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 text-xs">🏢 الأقسام</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                متاح بالكامل
              </span>
            </div>
            <p className="text-xs text-slate-400">
              إضافة وتعديل وحذف الهيكل التنظيمي وأكواد الأقسام في المؤسسة.
            </p>
            <Link to="/admin/departments" className="block pt-2">
              <Button variant="secondary" size="sm" className="w-full">
                إدارة الأقسام &rarr;
              </Button>
            </Link>
          </Card>

          <Card className="space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 text-xs">📦 الأصناف والكتالوج</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                متاح بالكامل
              </span>
            </div>
            <p className="text-xs text-slate-400">
              إضافة وتعديل أصناف ومواد الشركة ووحدات القياس وحالتها.
            </p>
            <Link to="/admin/items" className="block pt-2">
              <Button variant="secondary" size="sm" className="w-full">
                إدارة الكتالوج &rarr;
              </Button>
            </Link>
          </Card>

          <Card className="space-y-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 text-xs">🏭 سجل الموردين</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                متاح بالكامل
              </span>
            </div>
            <p className="text-xs text-slate-400">
              إدارة وتحديث الشركات والموردين وبيانات التواصل.
            </p>
            <Link to="/admin/suppliers" className="block pt-2">
              <Button variant="secondary" size="sm" className="w-full">
                إدارة الموردين &rarr;
              </Button>
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default AdminDashboardPage;
