import React, { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import NotificationBell from "../components/notifications/NotificationBell";
import GlobalSearchBar from "../components/search/GlobalSearchBar";
import { getPrimaryRoleSlug, getRoleLabel } from "../routes/roleRouting";
import PageHeader from "../components/ui/PageHeader";
import InstallPrompt from "../components/pwa/InstallPrompt";
import { useNotificationCount } from "../utils/notificationBadge";
import NetworkStatusToast from "../components/common/NetworkStatusToast";
import { hasAnyRole } from "../utils/permissions";

export const AuthenticatedLayout: React.FC = () => {
    const { user, logout, sessionExpired, hasPermission } = useAuth();
    const unreadNotificationsCount = useNotificationCount();
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const location = useLocation();

    const primaryRoleSlug = getPrimaryRoleSlug(user);
    const primaryRoleLabel = getRoleLabel(primaryRoleSlug);

    const isActivePath = (path: string): boolean => {
        return (
            location.pathname === path ||
            location.pathname.startsWith(`${path}/`)
        );
    };

    const closeMobileMenu = () => {
        setMobileMenuOpen(false);
        if (typeof window !== 'undefined' && window.innerWidth < 1280) {
            setSidebarOpen(false);
        }
    };

    const linkClassName = (path: string): string => {
        const active = isActivePath(path);
        return `flex items-center min-h-11 px-3 sm:px-4 py-2.5 text-xs font-bold rounded-xl transition-all duration-200 ${
            active
                ? "text-[#f0d695] bg-[#2a2111]/60 border-r-4 border-[#c7a45b] shadow-lg shadow-[#a47a2c]/10"
                : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
        }`;
    };

    const renderRoleNavigation = () => {
        switch (primaryRoleSlug) {
            case "reviewer":
                return (
                    <>
                        <Link to="/requests" className={linkClassName("/requests")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلبات الشراء الخاصة بي</Link>
                        <Link to="/requests/create" className={linkClassName("/requests/create")}><span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء</Link>
                        <Link to="/requests/create-complementary" className={linkClassName("/requests/create-complementary")}><span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة</Link>
                        <Link to="/requests/favorites" className={linkClassName("/requests/favorites")}><span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة</Link>
                        <Link to="/requests/supplements" className={linkClassName("/requests/supplements")}><span className="ml-2.5 text-sm" aria-hidden="true">➕</span> أرشيف طلبات الكمالة</Link>
                        <Link
                            to="/reviewer"
                            className={linkClassName("/reviewer")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📊</span> لوحة المراجعة
                        </Link>
                        <Link
                            to="/reviewer/requests"
                            className={linkClassName("/reviewer/requests")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلبات المراجعة
                        </Link>
                        <Link
                            to="/reviewer/purchase-quotes"
                            className={linkClassName("/reviewer/purchase-quotes")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">💰</span> ترشيح عروض الأسعار
                        </Link>
                        <Link
                            to="/reviewer/material-transfers"
                            className={linkClassName("/reviewer/material-transfers")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🚚</span> مراجعة نقل الخامات
                        </Link>
                        <Link
                            to="/site-engineer"
                            className={linkClassName("/site-engineer")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📦</span> إذن استلام المواد
                        </Link>
                    </>
                );
            case "warehouse_keeper":
                return (
                    <>
                        <Link to="/requests" className={linkClassName("/requests")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلبات الشراء الخاصة بي</Link>
                        <Link to="/requests/create" className={linkClassName("/requests/create")}><span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء</Link>
                        <Link to="/requests/create-complementary" className={linkClassName("/requests/create-complementary")}><span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة</Link>
                        <Link to="/requests/favorites" className={linkClassName("/requests/favorites")}><span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة</Link>
                        <Link to="/warehouse" className={linkClassName("/warehouse")}><span className="ml-2.5 text-sm" aria-hidden="true">📦</span> استلام المواد (المستودع)</Link>
                        <Link to="/site-engineer" className={linkClassName("/site-engineer")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> إذن استلام المواد</Link>
                    </>
                );
            case "site_engineer":
                return (
                    <>
                        <Link to="/requests" className={linkClassName("/requests")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلبات الشراء الخاصة بي</Link>
                        <Link to="/requests/create" className={linkClassName("/requests/create")}><span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء</Link>
                        <Link to="/requests/create-complementary" className={linkClassName("/requests/create-complementary")}><span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة</Link>
                        <Link to="/requests/favorites" className={linkClassName("/requests/favorites")}><span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة</Link>
                        <Link to="/requests/supplements" className={linkClassName("/requests/supplements")}><span className="ml-2.5 text-sm" aria-hidden="true">➕</span> أرشيف طلبات الكمالة</Link>
                        <Link to="/site-engineer" className={linkClassName("/site-engineer")}><span className="ml-2.5 text-sm" aria-hidden="true">📦</span> إذن استلام المواد</Link>
                    </>
                );
            case "procurement_manager":
                return (
                    <>
                        <Link to="/requests" className={linkClassName("/requests")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلبات الشراء الخاصة بي</Link>
                        <Link to="/requests/create" className={linkClassName("/requests/create")}><span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء</Link>
                        <Link to="/requests/create-complementary" className={linkClassName("/requests/create-complementary")}><span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة</Link>
                        <Link to="/requests/favorites" className={linkClassName("/requests/favorites")}><span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة</Link>
                        <Link to="/requests/supplements" className={linkClassName("/requests/supplements")}><span className="ml-2.5 text-sm" aria-hidden="true">➕</span> أرشيف طلبات الكمالة</Link>
                        <Link
                            to="/procurement"
                            className={linkClassName("/procurement")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📊</span> لوحة المشتريات
                        </Link>
                        <Link
                            to="/procurement/purchase-requests"
                            className={linkClassName("/procurement/purchase-requests")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">⊛</span> طلبات الشراء المعتمدة
                        </Link>
                        <Link
                            to="/procurement/purchase-orders"
                            className={linkClassName("/procurement/purchase-orders")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📋</span> أوامر الشراء
                        </Link>
                        <Link
                            to="/procurement/pending-receipts"
                            className={linkClassName("/procurement/pending-receipts")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📦</span> أذونات الاستلام المتوقفة
                        </Link>
                        <Link
                            to="/procurement/suppliers"
                            className={linkClassName("/procurement/suppliers")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🏢</span> إدارة الموردين
                        </Link>
                        <Link
                            to="/procurement/reports"
                            className={linkClassName("/procurement/reports")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📈</span> التقارير والتحليلات
                        </Link>
                        <Link
                            to="/site-engineer"
                            className={linkClassName("/site-engineer")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📦</span> إذن استلام المواد
                        </Link>
                    </>
                );
            case "accountant":
                return (
                    <>
                        <Link to="/requests" className={linkClassName("/requests")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلبات الشراء الخاصة بي</Link>
                        <Link to="/requests/create" className={linkClassName("/requests/create")}><span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء</Link>
                        <Link to="/requests/create-complementary" className={linkClassName("/requests/create-complementary")}><span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة</Link>
                        <Link to="/requests/favorites" className={linkClassName("/requests/favorites")}><span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة</Link>
                        <Link
                            to="/accounting"
                            className={linkClassName("/accounting")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📊</span> لوحة المحاسبة
                        </Link>
                        <Link
                            to="/accounting/purchase-requests"
                            className={linkClassName("/accounting/purchase-requests")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">✅</span> موافقات الطلبات المالية
                        </Link>
                        <Link
                            to="/accounting/purchase-orders"
                            className={linkClassName("/accounting/purchase-orders")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📋</span> أوامر الشراء للحسابات
                        </Link>
                        <Link
                            to="/accounting/purchase-quotes"
                            className={linkClassName("/accounting/purchase-quotes")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">💰</span> ترشيح عروض الأسعار
                        </Link>
                        <Link
                            to="/accounting/supplier-payments"
                            className={linkClassName("/accounting/supplier-payments")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🧾</span> فواتير الموردين والمطابقة
                        </Link>
                        <Link
                            to="/accounting/supplier-accounts"
                            className={linkClassName("/accounting/supplier-accounts")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🏦</span> حسابات وصرف الموردين
                        </Link>
                        <Link
                            to="/accounting/land-parcels"
                            className={linkClassName("/accounting/land-parcels")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🏗️</span> دفتر قطع الأراضي
                        </Link>
                        <Link
                            to="/accounting/material-transfers"
                            className={linkClassName("/accounting/material-transfers")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🚚</span> معالجة نقل الخامات
                        </Link>
                        <Link
                            to="/accounting/reports"
                            className={linkClassName("/accounting/reports")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📈</span> التقارير والتحليلات
                        </Link>
                        <Link
                            to="/site-engineer"
                            className={linkClassName("/site-engineer")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📦</span> إذن استلام المواد
                        </Link>
                    </>
                );
            case "general_accountant":
            case "site_accountant":
            case "licenses_accountant":
            case "buffet_accountant":
            case "development_accountant":
                return (
                    <>
                        <Link
                            to="/site-accountant"
                            className={linkClassName("/site-accountant")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📊</span> لوحة المحاسبة
                        </Link>
                        <Link
                            to="/accounting/purchase-orders"
                            className={linkClassName("/accounting/purchase-orders")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📋</span> أوامر الشراء والاستلام
                        </Link>
                        <Link
                            to="/accounting/supplier-payments"
                            className={linkClassName("/accounting/supplier-payments")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🧾</span> تسجيل فواتير الموردين
                        </Link>
                        <Link
                            to="/accounting/supplier-accounts"
                            className={linkClassName("/accounting/supplier-accounts")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🏦</span> كشف حسابات الموردين
                        </Link>
                        <Link
                            to="/accounting/reports"
                            className={linkClassName("/accounting/reports")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📈</span> التقارير والتحليلات
                        </Link>
                        <Link
                            to="/requests/create"
                            className={linkClassName("/requests/create")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء
                        </Link>
                        <Link
                            to="/requests/create-complementary"
                            className={linkClassName("/requests/create-complementary")}
                        >
                            <span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة
                        </Link>
                        <Link
                            to="/requests/favorites"
                            className={linkClassName("/requests/favorites")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة
                        </Link>
                        <Link
                            to="/requests"
                            className={linkClassName("/requests")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📂</span> طلباتي
                        </Link>
                    </>
                );
            case "general_manager":
            case "execution_manager":
                return (
                    <>
                        <Link to="/requests" className={linkClassName("/requests")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلبات الشراء الخاصة بي</Link>
                        <Link to="/requests/create" className={linkClassName("/requests/create")}><span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء</Link>
                        <Link to="/requests/create-complementary" className={linkClassName("/requests/create-complementary")}><span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة</Link>
                        <Link to="/requests/favorites" className={linkClassName("/requests/favorites")}><span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة</Link>
                        <Link to="/requests/supplements" className={linkClassName("/requests/supplements")}><span className="ml-2.5 text-sm" aria-hidden="true">➕</span> أرشيف طلبات الكمالة</Link>
                        <Link
                            to="/general-manager"
                            className={linkClassName("/general-manager")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📊</span> {primaryRoleSlug === "execution_manager" ? "لوحة مدير مشروعات التنفيذ" : "لوحة المدير العام"}
                        </Link>
                        <Link
                            to="/general-manager/purchase-requests"
                            className={linkClassName("/general-manager/purchase-requests")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">✅</span> طلبات القرار التنفيذي
                        </Link>
                        <Link
                            to="/general-manager/purchase-quotes"
                            className={linkClassName("/general-manager/purchase-quotes")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">⚖️</span> قرار عروض الأسعار
                        </Link>
                        <Link
                            to="/general-manager/purchase-orders"
                            className={linkClassName("/general-manager/purchase-orders")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📋</span> أوامر الشراء الصادرة — العرض التنفيذي
                        </Link>
                        <Link
                            to="/general-manager/land-parcels"
                            className={linkClassName("/general-manager/land-parcels")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">🏗️</span> متابعة مشاريع وقطع الأراضي
                        </Link>
                        <Link
                            to="/general-manager/reports"
                            className={linkClassName("/general-manager/reports")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📈</span> التقارير والتحليلات
                        </Link>
                        <Link
                            to="/site-engineer"
                            className={linkClassName("/site-engineer")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📦</span> إذن استلام المواد
                        </Link>
                    </>
                );
            case "admin":
                return (
                    <>
                        <Link to="/admin" className={linkClassName("/admin")}><span className="ml-2.5 text-sm" aria-hidden="true">⚙️</span> لوحة مدير النظام</Link>
                        <Link to="/admin/control-center" className={linkClassName("/admin/control-center")}><span className="ml-2.5 text-sm" aria-hidden="true">🏛️</span> مركز تحكم المشتريات (Control Center)</Link>
                        <Link to="/admin/master-orders" className={linkClassName("/admin/master-orders")}><span className="ml-2.5 text-sm" aria-hidden="true">🎛️</span> التحكم الشامل في الطلبات</Link>
                        <Link to="/admin/request-tracker" className={linkClassName("/admin/request-tracker")}><span className="ml-2.5 text-sm" aria-hidden="true">📋</span> مركز متابعة الطلبات</Link>
                        <Link to="/admin/system-monitor" className={linkClassName("/admin/system-monitor")}><span className="ml-2.5 text-sm" aria-hidden="true">🩺</span> مراقبة النظام والـDeploy</Link>
                        <Link to="/admin/users" className={linkClassName("/admin/users")}><span className="ml-2.5 text-sm" aria-hidden="true">👥</span> إدارة المستخدمين</Link>
                        <Link to="/admin/roles" className={linkClassName("/admin/roles")}><span className="ml-2.5 text-sm" aria-hidden="true">🛡️</span> الأدوار</Link>
                        <Link to="/admin/permissions" className={linkClassName("/admin/permissions")}><span className="ml-2.5 text-sm" aria-hidden="true">🔑</span> الصلاحيات</Link>
                        <Link to="/admin/departments" className={linkClassName("/admin/departments")}><span className="ml-2.5 text-sm" aria-hidden="true">🏢</span> الأقسام</Link>
                        <Link to="/admin/items" className={linkClassName("/admin/items")}><span className="ml-2.5 text-sm" aria-hidden="true">📦</span> الأصناف</Link>
                        <Link to="/admin/suppliers" className={linkClassName("/admin/suppliers")}><span className="ml-2.5 text-sm" aria-hidden="true">🏢</span> الموردين</Link>
                        <Link to="/requests/create-complementary" className={linkClassName("/requests/create-complementary")}><span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة</Link>
                        <Link to="/requests/supplements" className={linkClassName("/requests/supplements")}><span className="ml-2.5 text-sm" aria-hidden="true">➕</span> أرشيف طلبات الكمالة</Link>
                        <Link to="/site-engineer" className={linkClassName("/site-engineer")}><span className="ml-2.5 text-sm" aria-hidden="true">📦</span> إذن استلام المواد</Link>
                    </>
                );
            case "employee":
            default:
                return (
                    <>
                        <Link
                            to="/employee"
                            className={linkClassName("/employee")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📊</span> لوحة الموظف
                        </Link>
                        <Link
                            to="/employee/requests"
                            className={linkClassName("/employee/requests")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📋</span> طلباتي
                        </Link>
                        <Link
                            to="/employee/requests/create"
                            className={linkClassName("/employee/requests/create")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب شراء
                        </Link>
                        <Link
                            to="/requests/create-complementary"
                            className={linkClassName("/requests/create-complementary")}
                        >
                            <span className="ml-2.5 text-sm text-amber-400" aria-hidden="true">⚡</span> إنشاء طلب كمالة
                        </Link>
                        <Link
                            to="/requests/favorites"
                            className={linkClassName("/requests/favorites")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">⭐</span> الطلبات المفضلة
                        </Link>
                        <Link
                            to="/requests/supplements"
                            className={linkClassName("/requests/supplements")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">➕</span> أرشيف طلبات الكمالة
                        </Link>
                        <Link
                            to="/site-engineer"
                            className={linkClassName("/site-engineer")}
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">📦</span> إذن استلام المواد
                        </Link>
                    </>
                );
        }
    };

    return (
        <div
            dir="rtl"
            className="min-h-screen flex flex-col font-sans bg-[#070a0f] text-slate-100 print:bg-white print:text-black print:min-h-0 print:p-0"
        >
            {/* Header with Luxury Glassmorphism & Gold Highlights */}
            <header className="sticky top-0 z-40 bg-slate-950/85 backdrop-blur-2xl text-white shadow-2xl border-b border-white/10 shadow-black/60 print:hidden">

                <div className="max-w-[1800px] mx-auto w-full px-3 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between min-h-16 py-2">

                        {/* Sidebar Toggle + Company Logo & Title */}
                        <div className="flex items-center gap-2 sm:gap-3">
                            <button
                                type="button"
                                onClick={() => { setSidebarOpen(current => !current); setMobileMenuOpen(false); }}
                                aria-label={sidebarOpen ? 'إخفاء القائمة الجانبية' : 'إظهار القائمة الجانبية'}
                                aria-expanded={sidebarOpen}
                                className="hidden md:flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-white/10 bg-slate-900/80 px-2.5 text-lg text-gold-300 shadow-inner hover:border-gold-500/50 hover:bg-slate-800 active:scale-95 transition-all"
                            >
                                {sidebarOpen ? '‹' : '☰'}
                            </button>
                            <div className="flex items-center space-x-3 space-x-reverse">
                            <div className="w-10 h-10 rounded-xl bg-[#11100e] border border-gold-500/60 p-1.5 flex items-center justify-center shadow-inner shadow-black/30">
                                <img src="/eshbelia-logo.png" alt="شعار شركة اشبيلية" className="h-full w-full object-contain" />
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-sm sm:text-base font-black tracking-tight text-slate-100">
                                    <span className="truncate">اشبيلية</span>
                                    <span className="hidden sm:inline truncate"> — شركة</span>
                                </span>
                                <span className="hidden sm:block text-[10px] font-bold tracking-wide text-gold-400">
                                    <span className="truncate">للتطوير العقاري والمقاولات</span>
                                </span>
                                <span className="hidden sm:block text-[9px] font-semibold text-slate-400">
                                    <span className="truncate">نظام المشتريات التشغيلية</span>
                                </span>
                            </div>
                            </div>
                        </div>

                        {/* Global Search Bar (Tablet Landscape & Desktop Center) */}
                        <div className="hidden md:flex flex-1 justify-center px-4 max-w-lg">
                            <GlobalSearchBar />
                        </div>

                        {/* User الملف الشخصي & الإجراءات */}
                        <div className="hidden md:flex items-center space-x-4 space-x-reverse">
                            <NotificationBell />
                            <div className="h-6 w-px bg-white/10"></div>
                            <Link
                                to="/profile"
                                className="flex items-center gap-3 px-3 py-1.5 rounded-xl hover:bg-white/[0.05] transition-all border border-transparent hover:border-gold-500/30"
                            >
                                <div className="w-8 h-8 rounded-full bg-gold-500/15 border border-gold-500/40 text-gold-300 font-bold flex items-center justify-center text-xs">
                                    {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
                                </div>
                                <div className="text-right">
                                    <div className="text-xs font-bold text-slate-100">
                                        {user?.name}
                                    </div>
                                    <div className="text-[10px] text-gold-400 font-medium">
                                        {primaryRoleLabel}
                                    </div>
                                </div>
                            </Link>
                            <button
                                type="button"
                                onClick={() => logout()}
                                className="bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 hover:text-rose-100 px-3 py-1.5 rounded-xl text-xs font-bold transition-all border border-rose-800/50 hover:-translate-y-0.5 active:translate-y-0"
                            >
                                تسجيل الخروج
                            </button>
                        </div>

                        {/* Mobile & Small Tablet Quick Nav */}
                        <div className="md:hidden flex shrink-0 items-center gap-1 sm:gap-2">
                            <GlobalSearchBar />
                            <NotificationBell />
                            <Link
                                to="/profile"
                                aria-label={user?.name ? `حساب ${user.name}` : 'حساب المستخدم'}
                                title={user?.name || 'حساب المستخدم'}
                                className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 font-bold text-xs hover:bg-cyan-600/30 transition-all shrink-0"
                            >
                                {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
                            </Link>
                            <button
                                type="button"
                                onClick={() => { setMobileMenuOpen(!mobileMenuOpen); setSidebarOpen(true); }}
                                aria-label="Toggle navigation menu"
                                aria-expanded={mobileMenuOpen}
                                className="relative flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-slate-800/80 p-2.5 text-slate-300 hover:text-white border border-slate-700"
                            >
                                <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d={
                                            mobileMenuOpen
                                                ? "M6 18L18 6M6 6l12 12"
                                                : "M4 6h16M4 12h16M4 18h16"
                                        }
                                    />
                                </svg>
                                {unreadNotificationsCount > 0 && !mobileMenuOpen && (
                                    <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-black flex items-center justify-center animate-pulse shadow-md shadow-rose-600/40">
                                        {unreadNotificationsCount > 9 ? '9+' : unreadNotificationsCount}
                                    </span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            {/* Container */}
            <div className="relative flex-1 flex flex-col xl:flex-row max-w-[1800px] w-full mx-auto px-2 sm:px-3 lg:px-4 py-2 sm:py-3 gap-2 sm:gap-3">
                {/* Backdrop when sidebar is open on tablet & mobile (< 1280px) */}
                {(sidebarOpen || mobileMenuOpen) && (
                    <button
                        type="button"
                        aria-label="إغلاق القائمة الجانبية"
                        onClick={closeMobileMenu}
                        className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-[1px] xl:hidden"
                    />
                )}
                {/* Sidebar Nav with Luxury Frosted Glass */}
                <aside
                    className={`print:hidden fixed inset-x-2 bottom-2 top-[4.75rem] z-40 max-h-[calc(100dvh-5.5rem)] w-auto sm:max-w-xs sm:right-3 sm:left-auto overflow-y-auto rounded-2xl border border-white/10 bg-slate-900/90 p-3 shadow-2xl backdrop-blur-2xl transition-all duration-300 xl:relative xl:inset-auto xl:bottom-auto xl:top-auto xl:max-h-none xl:w-64 xl:max-w-none xl:overflow-visible xl:p-4 xl:shadow-2xl ${
                        sidebarOpen ? "block" : (mobileMenuOpen ? "block" : "hidden")
                    }`}
                >
                    <div className="px-3 py-2 mb-3 bg-slate-950/80 rounded-xl border border-white/5 flex items-center justify-between shadow-inner">
                        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider font-mono">
                            القائمة الرئيسية
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gold-950/80 text-gold-300 border border-gold-500/40">
                                {primaryRoleLabel}
                            </span>
                            <button
                                type="button"
                                onClick={closeMobileMenu}
                                className="xl:hidden flex items-center justify-center w-8 h-8 rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:text-rose-300 hover:border-rose-500/60 hover:bg-rose-950/40 transition-colors"
                                aria-label="إغلاق القائمة"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                    </div>
                    <nav
                        className="space-y-1.5 pb-16 xl:pb-0"
                        onClick={(event) => {
                            if ((event.target as HTMLElement).closest('a')) closeMobileMenu();
                        }}
                    >
                        {renderRoleNavigation()}
                        <Link to="/my-archive" className={linkClassName('/my-archive')} onClick={closeMobileMenu}>
                            <span className="ml-2.5 text-sm" aria-hidden="true">🗂️</span> أرشيف إجراءاتي
                        </Link>

                        <div className="border-t border-slate-800/80 my-3 pt-2">
                            <span className="px-3 text-[10px] font-black text-amber-400 uppercase tracking-wider block mb-1">
                                نقل الخامات والعهد
                            </span>
                            <Link to="/material-transfers" className={linkClassName('/material-transfers')} onClick={closeMobileMenu}>
                                <span className="ml-2.5 text-sm" aria-hidden="true">🚚</span> طلبات نقل الخامات
                            </Link>
                            <Link to="/material-transfers/create" className={linkClassName('/material-transfers/create')} onClick={closeMobileMenu}>
                                <span className="ml-2.5 text-sm" aria-hidden="true">✍️</span> إنشاء طلب نقل خامات
                            </Link>
                            <Link to="/material-transfers/archive" className={linkClassName('/material-transfers/archive')} onClick={closeMobileMenu}>
                                <span className="ml-2.5 text-sm" aria-hidden="true">📂</span> أرشيف المنقولات
                            </Link>
                        </div>
                        <Link
                            to="/notifications"
                            className={`justify-between ${linkClassName("/notifications")}`}
                            onClick={closeMobileMenu}
                        >
                            <span className="flex items-center">
                                <span className="ml-2.5 text-sm">🔔</span> الإشعارات
                            </span>
                            {unreadNotificationsCount > 0 && (
                                <span className="min-w-5 h-5 px-1.5 rounded-full bg-rose-500 text-white text-[10px] font-black flex items-center justify-center animate-pulse shadow-sm shadow-rose-600/30">
                                    {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                                </span>
                            )}
                        </Link>
                        <Link
                            to="/profile"
                            className={linkClassName("/profile")}
                            onClick={closeMobileMenu}
                        >
                            <span className="ml-2.5 text-sm">👤</span> الملف الشخصي
                        </Link>
                        <Link
                            to="/preferences"
                            className={linkClassName("/preferences")}
                            onClick={closeMobileMenu}
                        >
                            <span className="ml-2.5 text-sm">⚙️</span> تفضيلات المستخدم
                        </Link>
                        <button
                            type="button"
                            onClick={() => { closeMobileMenu(); logout(); }}
                            className="md:hidden flex items-center w-full min-h-11 px-3 sm:px-4 py-2.5 mt-3 text-xs font-bold text-rose-300 hover:bg-rose-950/40 rounded-xl border-t border-slate-800/80"
                        >
                            <span className="ml-2.5 text-sm" aria-hidden="true">↪</span> تسجيل الخروج
                        </button>
                    </nav>
                </aside>

                {/* Main Content Area */}
                <main className="flex-1 min-w-0 w-full bg-slate-900/70 border border-slate-800/80 rounded-2xl shadow-2xl p-3 sm:p-5 lg:p-6 pb-24 sm:pb-8 min-h-[calc(100dvh-6rem)] backdrop-blur-sm overflow-visible flex flex-col print:bg-white print:border-none print:shadow-none print:p-0 print:m-0 print:min-h-0 print:rounded-none">
                    {sessionExpired && (
                        <div className="mb-4 flex flex-col gap-2 rounded-xl border border-amber-700/70 bg-amber-950/30 px-4 py-3 text-xs text-amber-200 sm:flex-row sm:items-center sm:justify-between print:hidden" role="alert" aria-live="assertive">
                            <span>انتهت جلسة الدخول. احفظ أي بيانات محلية، ثم سجّل الدخول مرة أخرى للمتابعة.</span>
                            <Link to="/login" className="font-bold text-amber-100 underline underline-offset-4 hover:text-white">إعادة تسجيل الدخول</Link>
                        </div>
                    )}
                    <div className="print:hidden"><PageHeader /></div>
                    <Outlet />
                </main>
            </div>

            {/* Floating Quick Action Button (+) for Authorized Roles with PR creation permission (except Admin) */}
            {primaryRoleSlug !== 'admin' && hasPermission('purchase_request.create') && location.pathname !== '/requests/create' && location.pathname !== '/employee/requests/create' && (
                <Link
                    to={primaryRoleSlug === 'employee' ? '/employee/requests/create' : '/requests/create'}
                    className="print:hidden group fixed bottom-6 left-6 z-50 flex items-center gap-2.5 rounded-full bg-gradient-to-r from-cyan-500 to-teal-400 p-3.5 sm:px-5 sm:py-3.5 text-slate-950 font-black shadow-2xl shadow-cyan-500/40 hover:shadow-cyan-400/60 border border-cyan-200/50 hover:scale-105 active:scale-95 transition-all duration-200 select-none"
                    aria-label="إنشاء طلب شراء جديد"
                    title="إنشاء طلب شراء جديد"
                >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/20 text-xl font-black leading-none">
                        +
                    </span>
                    <span className="hidden sm:inline-block text-xs font-black tracking-wide">
                        طلب شراء جديد
                    </span>
                </Link>
            )}

            {/* PWA Install Banner */}
            <div className="print:hidden"><InstallPrompt /></div>

            {/* Network Resilience Offline/Online Toast */}
            <div className="print:hidden"><NetworkStatusToast /></div>

            <footer className="print:hidden hidden sm:block mx-auto w-full max-w-[1800px] px-2 pb-3 text-center text-[10px] text-slate-500 sm:px-3 lg:px-4">
                شركة اشبيلية للتطوير العقاري والمقاولات · منظومة المشتريات التشغيلية · <a href="https://ishbilia.dev" target="_blank" rel="noreferrer" className="text-[#d4b36a] hover:text-[#f0d695]">الموقع الرسمي</a> · <a href="https://web.facebook.com/Ishbilia.realestate?locale=ar_AR" target="_blank" rel="noreferrer" className="text-[#d4b36a] hover:text-[#f0d695]">صفحة Facebook</a>
            </footer>
        </div>

    );
};

export default AuthenticatedLayout;
