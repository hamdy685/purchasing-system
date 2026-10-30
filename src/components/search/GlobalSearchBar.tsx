import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import { getPrimaryRoleSlug } from '../../routes/roleRouting';
import { hasAnyRole, hasPermission } from '../../utils/permissions';
import { cachedGetData } from '../../api/client';
import { PurchaseRequest } from '../../types/purchaseRequest';
import { PurchaseOrder } from '../../types/purchaseOrder';
import { LandParcel, SupplierAccountSummary, getLandParcelsApi, getSupplierAccountsApi } from '../../api/supplierFinance';
import { getPurchaseOrdersApi } from '../../api/purchaseOrders';
import QuickPeekDrawer, { PeekType } from '../ui/QuickPeekDrawer';

import { formatCleanNumber } from '../../utils/numberFormat';

type SearchCategory = 'ALL' | 'PR' | 'PO' | 'SUPPLIER' | 'PARCEL' | 'PAGE';

interface SearchResultItem {
  id: string;
  type: 'PR' | 'PO' | 'SUPPLIER' | 'PARCEL' | 'PAGE';
  categoryLabel: string;
  title: string;
  subtitle: string;
  badge?: string;
  badgeColor?: string;
  url: string;
  meta?: string;
}

const money = (value: number | string | null | undefined) =>
  `${formatCleanNumber(value)} ج.م`;

export const GlobalSearchBar: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<SearchCategory>('ALL');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [peekState, setPeekState] = useState<{ isOpen: boolean; type: PeekType; id: number | null }>({
    isOpen: false,
    type: 'PR',
    id: null,
  });

  // Cached data for instant search
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierAccountSummary[]>([]);
  const [parcels, setParcels] = useState<LandParcel[]>([]);
  const [hasFetched, setHasFetched] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRole = getPrimaryRoleSlug(user);

  // Role permissions
  const isFinancialRole = hasAnyRole(user, ['accountant', 'general_manager', 'admin']);
  const isProcurementRole = hasAnyRole(user, ['procurement_manager', 'general_manager', 'admin', 'accountant']);
  const isReviewerRole = hasAnyRole(user, ['reviewer', 'admin']);
  const isWarehouseRole = hasAnyRole(user, ['warehouse_keeper', 'admin', 'procurement_manager']);
  const isSiteEngineerRole = hasAnyRole(user, ['site_engineer', 'admin']);
  const isGmRole = hasAnyRole(user, ['general_manager', 'admin']);
  const isAdminRole = hasAnyRole(user, ['admin']);

  // Global Ctrl+K / Cmd+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      } else if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Focus input on open & load data according to role
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      if (!hasFetched) {
        void loadSearchData();
      }
    } else {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen, hasFetched]);

  const loadSearchData = async () => {
    setLoading(true);
    try {
      // 1. Always load PRs (accessible to all roles)
      const promises: Promise<any>[] = [
        cachedGetData<{ data: PurchaseRequest[] }>('/purchase-requests')
          .then((r) => r.data)
          .catch(() => []),
      ];

      // 2. Only load POs if procurement / accountant / GM / admin / has permission
      if (isProcurementRole || hasPermission(user, 'purchase_orders.view')) {
        promises.push(
          getPurchaseOrdersApi({ per_page: 50 })
            .then((r) => r.data)
            .catch(() => [])
        );
      } else {
        promises.push(Promise.resolve([]));
      }

      // 3. Only load Supplier Accounts if Financial role
      if (isFinancialRole) {
        promises.push(getSupplierAccountsApi().catch(() => []));
      } else {
        promises.push(Promise.resolve([]));
      }

      // 4. Only load Land Parcels if Financial or GM or Admin
      if (isFinancialRole || isGmRole) {
        promises.push(getLandParcelsApi().catch(() => []));
      } else {
        promises.push(Promise.resolve([]));
      }

      const [prList, poList, suppList, parcelList] = await Promise.all(promises);

      setRequests(prList || []);
      setOrders(poList || []);
      setSuppliers(suppList || []);
      setParcels(parcelList || []);
      setHasFetched(true);
    } catch {
      // Non-blocking
    } finally {
      setLoading(false);
    }
  };

  // Quick navigation pages filtered strictly by Role
  const quickPages: SearchResultItem[] = useMemo(() => {
    const pages: SearchResultItem[] = [
      { id: 'page-create-pr', type: 'PAGE', categoryLabel: 'صفحة', title: 'إنشاء طلب شراء جديد', subtitle: 'تقديم طلب شراء أصناف أو خدمات', url: '/requests/create', badge: 'طلب جديد', badgeColor: 'bg-cyan-950 text-cyan-300' },
      { id: 'page-my-pr', type: 'PAGE', categoryLabel: 'صفحة', title: 'طلبات الشراء الخاصة بي', subtitle: 'متابعة حالة طلباتي السابقة', url: '/requests', badge: 'طلباتي', badgeColor: 'bg-slate-800 text-slate-300' },
    ];

    if (isReviewerRole) {
      pages.push({ id: 'page-reviewer', type: 'PAGE', categoryLabel: 'صفحة', title: 'مراجعة وتدقيق طلبات القسم', subtitle: 'الاعتماد الفني ومراجعة الطلبات المعلقة', url: '/reviewer', badge: 'مراجع', badgeColor: 'bg-indigo-950 text-indigo-300' });
    }

    if (isProcurementRole) {
      pages.push(
        { id: 'page-proc-dashboard', type: 'PAGE', categoryLabel: 'صفحة', title: 'لوحة إدارة المشتريات', subtitle: 'عروض الأسعار والترسية وأوامر الشراء', url: '/procurement', badge: 'مشتريات', badgeColor: 'bg-indigo-950 text-indigo-300' },
        { id: 'page-quotes-proc', type: 'PAGE', categoryLabel: 'صفحة', title: 'عروض أسعار الموردين والترسية', subtitle: 'مقارنة وترشيح عروض الأسعار', url: '/procurement/quotes', badge: 'عروض', badgeColor: 'bg-violet-950 text-violet-300' }
      );
    }

    if (isFinancialRole) {
      pages.push(
        { id: 'page-acc-dashboard', type: 'PAGE', categoryLabel: 'صفحة', title: 'لوحة الحسابات والماليات', subtitle: 'الاعتمادات المالية ومتابعة الدفعات', url: '/accounting', badge: 'مالية', badgeColor: 'bg-emerald-950 text-emerald-300' },
        { id: 'page-supplier-accounts', type: 'PAGE', categoryLabel: 'صفحة', title: 'حسابات الموردين والمديونية', subtitle: 'كشوف الحسابات والأرصدة والدفعات', url: '/accounting/supplier-accounts', badge: 'حسابات', badgeColor: 'bg-emerald-950 text-emerald-300' },
        { id: 'page-supplier-payments', type: 'PAGE', categoryLabel: 'صفحة', title: 'فواتير ودفعات الموردين وقطع الأراضي', subtitle: 'تسجيل الفواتير وتوزيع المصروف على الأراضي', url: '/accounting/supplier-payments', badge: 'فواتير', badgeColor: 'bg-amber-950 text-amber-300' },
        { id: 'page-land-parcels', type: 'PAGE', categoryLabel: 'صفحة', title: 'كشف حركة ومصروفات قطع الأراضي', subtitle: 'التمويلات والمصروفات والتحصيلات للمواقع', url: '/accounting/land-parcels', badge: 'أراضي', badgeColor: 'bg-sky-950 text-sky-300' }
      );
    }

    if (isWarehouseRole) {
      pages.push({ id: 'page-warehouse', type: 'PAGE', categoryLabel: 'صفحة', title: 'استلام المواد وفحص المخزن', subtitle: 'إذونات الاستلام ومطابقة الكميات الموردة', url: '/warehouse', badge: 'مخزن', badgeColor: 'bg-amber-950 text-amber-300' });
    }

    if (isSiteEngineerRole) {
      pages.push({ id: 'page-site-eng', type: 'PAGE', categoryLabel: 'صفحة', title: 'اعتماد استلام الموقع (مهندس الموقع)', subtitle: 'المطابقة الفنية واعتماد إذونات الاستلام', url: '/site-engineer', badge: 'موقع', badgeColor: 'bg-cyan-950 text-cyan-300' });
    }

    if (isGmRole) {
      pages.push(
        { id: 'page-gm', type: 'PAGE', categoryLabel: 'صفحة', title: 'لوحة المدير العام والقرارات التنفيذية', subtitle: 'قرارات عروض الأسعار واعتماد أوامر الشراء اليومية', url: '/general-manager', badge: 'تنفيذي', badgeColor: 'bg-rose-950 text-rose-300' },
        { id: 'page-gm-reports', type: 'PAGE', categoryLabel: 'صفحة', title: 'تقارير الإدارة والمشتريات والمالية', subtitle: 'مؤشرات الأداء والكشوف الشاملة', url: '/general-manager/reports', badge: 'تقارير', badgeColor: 'bg-purple-950 text-purple-300' }
      );
    }

    if (isAdminRole) {
      pages.push(
        { id: 'page-admin', type: 'PAGE', categoryLabel: 'صفحة', title: 'لوحة تحكم مدير النظام', subtitle: 'إدارة المستخدمين والأدوار والصلاحيات', url: '/admin', badge: 'إدارة', badgeColor: 'bg-slate-800 text-slate-200' }
      );
    }

    return pages;
  }, [isReviewerRole, isProcurementRole, isFinancialRole, isWarehouseRole, isSiteEngineerRole, isGmRole, isAdminRole]);

  // Compute filtered search results
  const searchResults: SearchResultItem[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return quickPages.slice(0, 6);
    }

    const results: SearchResultItem[] = [];

    // 1. Match PRs
    if (activeCategory === 'ALL' || activeCategory === 'PR') {
      requests.forEach((pr) => {
        const itemNames = (pr.items || []).map((i) => `${i.item_description || i.item?.name || ''} ${i.item_reference || ''} ${i.region || ''}`).join(' ');
        const textToSearch = `${pr.request_number} ${pr.requester?.name || ''} ${pr.department?.name || ''} ${pr.justification || ''} ${itemNames}`.toLowerCase();
        if (textToSearch.includes(q)) {
          const prUrl = primaryRole === 'reviewer' ? `/reviewer/requests/${pr.id}/review`
            : primaryRole === 'accountant' ? `/accounting/purchase-requests?open=${pr.id}`
            : primaryRole === 'general_manager' ? `/general-manager/purchase-requests?open=${pr.id}`
            : `/requests/${pr.id}`;

          const firstItem = pr.items?.[0];
          const itemsSummary = firstItem ? `${firstItem.item_description || firstItem.item?.name || ''} ${pr.items && pr.items.length > 1 ? `(+${pr.items.length - 1} بنود)` : ''}` : '';

          results.push({
            id: `pr-${pr.id}`,
            type: 'PR',
            categoryLabel: 'طلب شراء',
            title: `${pr.request_number} — ${itemsSummary || pr.department?.name || 'طلب شراء'}`,
            subtitle: `مقدم الطلب: ${pr.requester?.name || '—'} | القسم: ${pr.department?.name || '—'} | تاريخ: ${pr.date_needed || pr.created_at?.split('T')[0] || ''}`,
            badge: pr.status,
            badgeColor: 'bg-cyan-950 text-cyan-300 border border-cyan-800/60',
            url: prUrl,
            meta: firstItem?.item_reference ? `قطعة #${firstItem.item_reference}` : undefined,
          });
        }
      });
    }

    // 2. Match POs (only if authorized)
    if ((isProcurementRole || hasPermission(user, 'purchase_orders.view')) && (activeCategory === 'ALL' || activeCategory === 'PO')) {
      orders.forEach((po) => {
        const textToSearch = `${po.po_number || ''} PO-${po.id} ${po.supplier?.company_name || ''} ${po.status || ''} ${po.currency || ''}`.toLowerCase();
        if (textToSearch.includes(q)) {
          const poUrl = primaryRole === 'general_manager' ? `/general-manager/purchase-orders/${po.id}`
            : isFinancialRole ? `/accounting/purchase-orders/${po.id}`
            : isProcurementRole ? `/procurement/purchase-orders/${po.id}`
            : primaryRole === 'warehouse_keeper' ? `/warehouse`
            : `/requests/${po.purchase_request_id || (po.purchase_request as any)?.id || ''}`;

          // Only show financial amount to financial / procurement / GM / admin roles
          const amountText = (isFinancialRole || isProcurementRole)
            ? `الإجمالي: ${money(po.grand_total || po.subtotal)} | `
            : '';

          results.push({
            id: `po-${po.id}`,
            type: 'PO',
            categoryLabel: 'أمر شراء',
            title: `${po.po_number || `PO #${po.id}`} — ${po.supplier?.company_name || 'مورد غير محدد'}`,
            subtitle: `${amountText}الحالة: ${po.status || '—'} | التاريخ: ${po.created_at?.split('T')[0] || ''}`,
            badge: po.status || 'مفتوح',
            badgeColor: 'bg-amber-950 text-amber-300 border border-amber-800/60',
            url: poUrl,
          });
        }
      });
    }

    // 3. Match Suppliers (only if financial role)
    if (isFinancialRole && (activeCategory === 'ALL' || activeCategory === 'SUPPLIER')) {
      suppliers.forEach((supp) => {
        const textToSearch = `${supp.company_name} ${supp.code || ''} ${supp.email || ''} ${supp.phone || ''}`.toLowerCase();
        if (textToSearch.includes(q)) {
          results.push({
            id: `supp-${supp.supplier_id}`,
            type: 'SUPPLIER',
            categoryLabel: 'مورد',
            title: `${supp.company_name} ${supp.code ? `(${supp.code})` : ''}`,
            subtitle: `الرصيد المستحق: ${money(Math.max(supp.balance, 0))} | الفواتير المفتوحة: ${supp.open_invoices_count} | هاتف: ${supp.phone || '—'}`,
            badge: supp.balance > 0 ? `مديونية: ${money(supp.balance)}` : 'مسدد',
            badgeColor: supp.balance > 0 ? 'bg-amber-950 text-amber-300 border border-amber-800/60' : 'bg-emerald-950 text-emerald-300 border border-emerald-800/60',
            url: `/accounting/supplier-accounts`,
          });
        }
      });
    }

    // 4. Match Land Parcels (only if financial or GM or Admin)
    if ((isFinancialRole || isGmRole) && (activeCategory === 'ALL' || activeCategory === 'PARCEL')) {
      parcels.forEach((parcel) => {
        const textToSearch = `${parcel.parcel_reference} ${parcel.region} ${parcel.notes || ''}`.toLowerCase();
        if (textToSearch.includes(q)) {
          const parcelUrl = primaryRole === 'general_manager' ? '/general-manager/land-parcels' : '/accounting/land-parcels';
          const balanceText = isFinancialRole ? `رصيد العميل المتاح: ${money(parcel.balance)} | ` : '';
          
          results.push({
            id: `parcel-${parcel.id}`,
            type: 'PARCEL',
            categoryLabel: 'قطعة أرض',
            title: `قطعة أرض رقم ${parcel.parcel_reference} — منطقة ${parcel.region}`,
            subtitle: `${balanceText}ملاحظات: ${parcel.notes || 'لا توجد'}`,
            badge: isFinancialRole ? (Number(parcel.balance) < 0 ? 'عجز تمويل' : 'رصيد كافٍ') : parcel.region,
            badgeColor: Number(parcel.balance) < 0 ? 'bg-rose-950 text-rose-300 border border-rose-800/60' : 'bg-emerald-950 text-emerald-300 border border-emerald-800/60',
            url: parcelUrl,
          });
        }
      });
    }

    // 5. Match Quick Pages
    if (activeCategory === 'ALL' || activeCategory === 'PAGE') {
      quickPages.forEach((page) => {
        if (`${page.title} ${page.subtitle}`.toLowerCase().includes(q)) {
          results.push(page);
        }
      });
    }

    return results.slice(0, 15);
  }, [query, activeCategory, requests, orders, suppliers, parcels, quickPages, primaryRole, isFinancialRole, isProcurementRole, isGmRole, user]);

  const handleSelectResult = (item: SearchResultItem) => {
    setIsOpen(false);
    navigate(item.url);
  };

  const handlePeek = (e: React.MouseEvent, item: SearchResultItem) => {
    e.stopPropagation();
    const rawId = parseInt(item.id.split('-')[1], 10);
    if (!rawId) return;

    if (item.type === 'PR') {
      setPeekState({ isOpen: true, type: 'PR', id: rawId });
    } else if (item.type === 'PO') {
      setPeekState({ isOpen: true, type: 'PO', id: rawId });
    } else {
      setIsOpen(false);
      navigate(item.url);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < searchResults.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : searchResults.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchResults[selectedIndex]) {
        handleSelectResult(searchResults[selectedIndex]);
      }
    }
  };

  return (
    <>
      {/* Search Trigger Button in Navbar / Header */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-400 shadow-sm transition-all hover:border-cyan-500/60 hover:bg-slate-800 hover:text-slate-200 cursor-pointer sm:px-3"
        title="البحث السريع (Ctrl + K)"
        aria-label="البحث السريع في النظام"
      >
        <svg className="h-4 w-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span className="hidden sm:inline">ابحث عن طلب، أمر شراء، صفحة...</span>
        <kbd className="hidden rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-slate-700 sm:inline-block">
          Ctrl K
        </kbd>
      </button>

      {/* Search Modal Backdrop & Dialog */}
      {isOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[99999] flex items-start justify-center bg-slate-950/80 p-3 sm:p-6 backdrop-blur-md animate-fade-in"
            dir="rtl"
            onClick={() => setIsOpen(false)}
          >
            <div
              className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/80 mt-6 sm:mt-12 flex flex-col max-h-[85vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Search Input Bar */}
              <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-3.5">
                <svg className="h-5 w-5 text-cyan-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="ابحث برقم الطلب، اسم الصنف، المورد، أو اسم الصفحة..."
                  className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="text-xs text-slate-500 hover:text-slate-300 font-bold px-1"
                  >
                    مسح
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs font-bold text-slate-300 hover:bg-rose-950/40 hover:text-rose-300 hover:border-rose-500/50 transition-colors cursor-pointer"
                  title="إغلاق البحث"
                >
                  <span>✕</span>
                  <span className="text-[11px] hidden sm:inline">إغلاق</span>
                </button>
              </div>

              {/* Category Filter Pills (Strictly Role-Aware) */}
              <div className="flex items-center gap-1.5 border-b border-slate-800/80 bg-slate-950/50 px-4 py-2 overflow-x-auto text-xs">
                <button
                  type="button"
                  onClick={() => setActiveCategory('ALL')}
                  className={`rounded-lg px-2.5 py-1 font-bold transition-colors cursor-pointer ${
                    activeCategory === 'ALL'
                      ? 'bg-cyan-600 text-white shadow-sm'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  الكل
                </button>
                <button
                  type="button"
                  onClick={() => setActiveCategory('PR')}
                  className={`rounded-lg px-2.5 py-1 font-bold transition-colors cursor-pointer ${
                    activeCategory === 'PR'
                      ? 'bg-cyan-600 text-white shadow-sm'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  طلبات الشراء
                </button>
                {(isProcurementRole || hasPermission(user, 'purchase_orders.view')) && (
                  <button
                    type="button"
                    onClick={() => setActiveCategory('PO')}
                    className={`rounded-lg px-2.5 py-1 font-bold transition-colors cursor-pointer ${
                      activeCategory === 'PO'
                        ? 'bg-cyan-600 text-white shadow-sm'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    أوامر الشراء
                  </button>
                )}
                {isFinancialRole && (
                  <button
                    type="button"
                    onClick={() => setActiveCategory('SUPPLIER')}
                    className={`rounded-lg px-2.5 py-1 font-bold transition-colors cursor-pointer ${
                      activeCategory === 'SUPPLIER'
                        ? 'bg-cyan-600 text-white shadow-sm'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    الموردين
                  </button>
                )}
                {(isFinancialRole || isGmRole) && (
                  <button
                    type="button"
                    onClick={() => setActiveCategory('PARCEL')}
                    className={`rounded-lg px-2.5 py-1 font-bold transition-colors cursor-pointer ${
                      activeCategory === 'PARCEL'
                        ? 'bg-cyan-600 text-white shadow-sm'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    قطع الأراضي
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setActiveCategory('PAGE')}
                  className={`rounded-lg px-2.5 py-1 font-bold transition-colors cursor-pointer ${
                    activeCategory === 'PAGE'
                      ? 'bg-cyan-600 text-white shadow-sm'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  الصفحات
                </button>
              </div>

              {/* Search Results List */}
              <div className="flex-1 overflow-y-auto p-2 divide-y divide-slate-800/50">
                {loading && !hasFetched ? (
                  <div className="p-8 text-center text-xs text-slate-400 animate-pulse">
                    جاري تحميل محرك البحث الذكي...
                  </div>
                ) : searchResults.length > 0 ? (
                  searchResults.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    const canPeek = item.type === 'PR' || item.type === 'PO';

                    return (
                      <div
                        key={item.id}
                        onClick={() => handleSelectResult(item)}
                        onMouseEnter={() => setSelectedIndex(index)}
                        className={`group flex items-center justify-between gap-3 p-3 rounded-xl transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-cyan-950/40 border border-cyan-500/40 text-cyan-200'
                            : 'hover:bg-slate-800/60 text-slate-300'
                        }`}
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <span
                            className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-md ${
                              item.type === 'PR'
                                ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/60'
                                : item.type === 'PO'
                                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                                : item.type === 'SUPPLIER'
                                ? 'bg-amber-950 text-amber-300 border border-amber-800/60'
                                : item.type === 'PARCEL'
                                ? 'bg-sky-950 text-sky-300 border border-sky-800/60'
                                : 'bg-slate-800 text-slate-300 border border-slate-700'
                            }`}
                          >
                            {item.categoryLabel}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-xs font-bold text-slate-100 truncate">{item.title}</p>
                              {item.meta && (
                                <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                                  {item.meta}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 truncate mt-0.5">{item.subtitle}</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {item.badge && (
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${item.badgeColor || 'bg-slate-800 text-slate-400'}`}>
                              {item.badge}
                            </span>
                          )}

                          {canPeek && (
                            <button
                              type="button"
                              onClick={(e) => handlePeek(e, item)}
                              className="hidden group-hover:flex items-center gap-1 rounded-lg border border-cyan-800/60 bg-cyan-950/40 px-2 py-1 text-[11px] font-bold text-cyan-300 hover:bg-cyan-900/60 transition-colors"
                              title="معاينة سريعة دون مغادرة الصفحة"
                            >
                              <span>👁️</span>
                              <span>معاينة</span>
                            </button>
                          )}

                          <span className="text-slate-500 group-hover:text-cyan-400 text-xs">←</span>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-8 text-center text-xs text-slate-500">
                    <span className="text-2xl block mb-2">🔍</span>
                    لا توجد نتائج مطابقة لبحثك «{query}»
                  </div>
                )}
              </div>

              {/* Footer Helper */}
              <div className="border-t border-slate-800 bg-slate-950/80 px-4 py-2.5 flex items-center justify-between text-[11px] text-slate-500">
                <div className="flex items-center gap-3">
                  <span>
                    <kbd className="font-mono bg-slate-800 px-1 rounded border border-slate-700">↑↓</kbd> للتنقل
                  </span>
                  <span>
                    <kbd className="font-mono bg-slate-800 px-1 rounded border border-slate-700">Enter</kbd> للفتح
                  </span>
                  <span>
                    <kbd className="font-mono bg-slate-800 px-1 rounded border border-slate-700">ESC</kbd> للإغلاق
                  </span>
                </div>
                <span>نظام البحث الذكي المفلتر حسب الدور</span>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Quick Peek Drawer Integration */}
      <QuickPeekDrawer
        isOpen={peekState.isOpen}
        onClose={() => setPeekState((prev) => ({ ...prev, isOpen: false }))}
        type={peekState.type}
        id={peekState.id}
      />
    </>
  );
};

export default GlobalSearchBar;
