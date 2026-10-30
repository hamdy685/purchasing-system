import React, { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getPrimaryRoleSlug, getRoleLabel } from '../../routes/roleRouting';
import { useAuth } from '../../context/AuthContext';
import Breadcrumbs from './Breadcrumbs';

const PAGE_TITLES: Array<{ prefix: string; title: string }> = [
  { prefix: '/notifications', title: 'الإشعارات' },
  { prefix: '/my-archive', title: 'أرشيف إجراءاتي' },
  { prefix: '/profile', title: 'الملف الشخصي' },
  { prefix: '/preferences', title: 'تفضيلات المستخدم' },
  { prefix: '/requests/create', title: 'إنشاء طلب شراء' },
  { prefix: '/requests/favorites', title: 'الطلبات المفضلة وقوالب الطلبات' },
  { prefix: '/requests', title: 'طلبات الشراء' },
  { prefix: '/admin/master-orders', title: 'التحكم الشامل في الطلبات وأوامر الشراء' },
  { prefix: '/admin/request-tracker', title: 'مركز متابعة الطلبات والتحكم الإداري' },
  { prefix: '/admin/system-monitor', title: 'مراقبة النظام والـDeploy' },
  { prefix: '/admin', title: 'إدارة النظام' },
  { prefix: '/reviewer/purchase-quotes', title: 'ترشيح عروض الأسعار' },
  { prefix: '/reviewer/requests', title: 'طلبات المراجعة' },
  { prefix: '/reviewer', title: 'لوحة المراجعة' },
  { prefix: '/procurement/purchase-orders', title: 'أوامر الشراء' },
  { prefix: '/procurement/approved-requests', title: 'الطلبات المعتمدة للمشتريات' },
  { prefix: '/procurement/suppliers', title: 'إدارة موردي المشتريات' },
  { prefix: '/procurement/reports', title: 'تقارير وتحليلات المشتريات' },
  { prefix: '/procurement', title: 'لوحة إدارة المشتريات' },
  { prefix: '/accounting/supplier-payments', title: 'فواتير الموردين والمطابقة' },
  { prefix: '/accounting/supplier-accounts', title: 'حسابات وصرف الموردين' },
  { prefix: '/accounting/purchase-orders', title: 'أوامر الشراء للحسابات' },
  { prefix: '/accounting/purchase-requests', title: 'موافقات الطلبات المالية' },
  { prefix: '/accounting', title: 'لوحة المحاسبة' },
  { prefix: '/general-manager/purchase-orders', title: 'أوامر الشراء الصادرة' },
  { prefix: '/general-manager/purchase-quotes', title: 'قرار عروض الأسعار' },
  { prefix: '/general-manager/purchase-requests', title: 'طلبات القرار التنفيذي' },
  { prefix: '/general-manager', title: 'لوحة المدير العام' },
  { prefix: '/warehouse', title: 'استلام المواد' },
  { prefix: '/site-engineer', title: 'اعتماد استلام الموقع' },
  { prefix: '/receipts', title: 'فحص واعتماد استلام المواد' },
  { prefix: '/employee', title: 'لوحة الموظف' },
];

export const getPageTitle = (pathname: string): string => {
  return PAGE_TITLES.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.title || 'نظام المشتريات';
};

const getPageHint = (title: string): string => {
  if (title === 'نظام المشتريات') return 'شركة اشبيلية للتطوير العقاري والمقاولات';
  return 'راجع البيانات المتاحة للدور الحالي، ونفّذ الإجراء المسموح به فقط.';
};

export const PageHeader: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const title = useMemo(() => getPageTitle(location.pathname), [location.pathname]);
  const roleLabel = getRoleLabel(getPrimaryRoleSlug(user));

  const isRootPage = [
    '/',
    '/employee',
    '/reviewer',
    '/procurement',
    '/accounting',
    '/site-accountant',
    '/general-manager',
    '/admin',
    '/warehouse',
    '/site-engineer',
    '/protected',
  ].includes(location.pathname);

  const handleSmartBack = () => {
    if (window.history.length > 2) {
      navigate(-1);
    } else {
      const primaryRole = getPrimaryRoleSlug(user);
      const roleHomeMap: Record<string, string> = {
        admin: '/admin',
        general_manager: '/general-manager',
        accountant: '/accounting',
        general_accountant: '/site-accountant',
        site_accountant: '/site-accountant',
        licenses_accountant: '/site-accountant',
        buffet_accountant: '/site-accountant',
        development_accountant: '/site-accountant',
        procurement_manager: '/procurement',
        reviewer: '/reviewer',
        warehouse_keeper: '/warehouse',
        site_engineer: '/site-engineer',
        employee: '/employee',
      };
      navigate(primaryRole ? (roleHomeMap[primaryRole] || '/') : '/');
    }
  };

  return (
    <div className="mb-2.5 sm:mb-3.5 border-b border-slate-800/80 pb-2 sm:pb-2.5" dir="rtl">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Breadcrumbs />
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-sm font-black text-slate-100 sm:text-base lg:text-lg">
              {title}
            </h1>
            <span className="shrink-0 rounded-full border border-cyan-800/70 bg-cyan-950/50 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
              {roleLabel}
            </span>
          </div>
        </div>

        {!isRootPage && (
          <button
            type="button"
            onClick={handleSmartBack}
            className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-xs font-bold text-slate-300 hover:border-cyan-500/60 hover:text-white transition-all shrink-0 cursor-pointer shadow-xs active:scale-95"
            aria-label="العودة إلى الصفحة السابقة"
          >
            <span aria-hidden="true" className="text-sm">‹</span>
            <span>رجوع</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default PageHeader;
