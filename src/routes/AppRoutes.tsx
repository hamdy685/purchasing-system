import React from "react";
import { Routes, Route } from "react-router-dom";
import AuthenticatedLayout from "../layouts/AuthenticatedLayout";
import LoginPage from "../pages/LoginPage";
import ProtectedPage from "../pages/ProtectedPage";
import { lazyImportWithRetry } from "../utils/lazyImportWithRetry";

const GuestOfficeRequestPage = lazyImportWithRetry(() => import("../pages/public/GuestOfficeRequestPage"), "GuestOfficeRequestPage");
const EmployeeDashboardPage = lazyImportWithRetry(() => import("../pages/employee/EmployeeDashboardPage"), "EmployeeDashboardPage");
const PurchaseRequestsPage = lazyImportWithRetry(() => import("../pages/employee/PurchaseRequestsPage"), "PurchaseRequestsPage");
const CreatePurchaseRequestPage = lazyImportWithRetry(() => import("../pages/employee/CreatePurchaseRequestPage"), "CreatePurchaseRequestPage");
const FavoriteRequestsPage = lazyImportWithRetry(() => import("../pages/employee/FavoriteRequestsPage"), "FavoriteRequestsPage");
const EditPurchaseRequestPage = lazyImportWithRetry(() => import("../pages/employee/EditPurchaseRequestPage"), "EditPurchaseRequestPage");
const PurchaseRequestDetailsPage = lazyImportWithRetry(() => import("../pages/employee/PurchaseRequestDetailsPage"), "PurchaseRequestDetailsPage");
const SupplementaryRequestsPage = lazyImportWithRetry(() => import("../pages/SupplementaryRequestsPage").then(m => ({ default: m.SupplementaryRequestsPage })), "SupplementaryRequestsPage");
const AdminSystemMonitoringPage = lazyImportWithRetry(() => import("../pages/admin/AdminSystemMonitoringPage"), "AdminSystemMonitoringPage");
import ProtectedRoute from "./ProtectedRoute";
import RoleRoute from "./RoleRoute";
const ReviewerDashboardPage = lazyImportWithRetry(() => import("../pages/reviewer/ReviewerDashboardPage"), "ReviewerDashboardPage");
const ReviewerRequestsPage = lazyImportWithRetry(() => import("../pages/reviewer/ReviewerRequestsPage"), "ReviewerRequestsPage");
const ReviewerPurchaseRequestDetailsPage = lazyImportWithRetry(() => import("../pages/reviewer/ReviewerPurchaseRequestDetailsPage"), "ReviewerPurchaseRequestDetailsPage");
const ReviewPurchaseRequestPage = lazyImportWithRetry(() => import("../pages/reviewer/ReviewPurchaseRequestPage"), "ReviewPurchaseRequestPage");
const ApprovedPurchaseRequestsPage = lazyImportWithRetry(() => import("../pages/procurement/ApprovedPurchaseRequestsPage"), "ApprovedPurchaseRequestsPage");
const CreatePurchaseOrderPage = lazyImportWithRetry(() => import("../pages/procurement/CreatePurchaseOrderPage"), "CreatePurchaseOrderPage");
const EditPurchaseOrderPage = lazyImportWithRetry(() => import("../pages/procurement/EditPurchaseOrderPage"), "EditPurchaseOrderPage");
const PurchaseOrderDetailsPage = lazyImportWithRetry(() => import("../pages/procurement/PurchaseOrderDetailsPage"), "PurchaseOrderDetailsPage");
const ProcurementManagerPage = lazyImportWithRetry(() => import("../pages/procurement/ProcurementManagerPage"), "ProcurementManagerPage");
const ProcurementPendingReceiptsPage = lazyImportWithRetry(() => import("../pages/procurement/ProcurementPendingReceiptsPage"), "ProcurementPendingReceiptsPage");
const ProcurementReportsPage = lazyImportWithRetry(() => import("../pages/procurement/ProcurementReportsPage"), "ProcurementReportsPage");
const UniversalReportsPage = lazyImportWithRetry(() => import("../pages/reports/UniversalReportsPage"), "UniversalReportsPage");
const SiteAccountantDashboardPage = lazyImportWithRetry(() => import("../pages/accounting/SiteAccountantDashboardPage"), "SiteAccountantDashboardPage");
const AccountingDashboardPage = lazyImportWithRetry(() => import("../pages/accounting/AccountingDashboardPage"), "AccountingDashboardPage");
const AccountingPurchaseOrdersPage = lazyImportWithRetry(() => import("../pages/accounting/AccountingPurchaseOrdersPage"), "AccountingPurchaseOrdersPage");
const AccountingPurchaseRequestsPage = lazyImportWithRetry(() => import("../pages/accounting/AccountingPurchaseRequestsPage"), "AccountingPurchaseRequestsPage");
const AccountingPurchaseOrderDetailsPage = lazyImportWithRetry(() => import("../pages/accounting/AccountingPurchaseOrderDetailsPage"), "AccountingPurchaseOrderDetailsPage");
const GeneralManagerDashboardPage = lazyImportWithRetry(() => import("../pages/general-manager/GeneralManagerDashboardPage"), "GeneralManagerDashboardPage");
const GeneralManagerPurchaseRequestsPage = lazyImportWithRetry(() => import("../pages/general-manager/GeneralManagerPurchaseRequestsPage"), "GeneralManagerPurchaseRequestsPage");
const GeneralManagerPurchaseOrdersPage = lazyImportWithRetry(() => import("../pages/general-manager/GeneralManagerPurchaseOrdersPage"), "GeneralManagerPurchaseOrdersPage");
const GeneralManagerPurchaseOrderDetailsPage = lazyImportWithRetry(() => import("../pages/general-manager/GeneralManagerPurchaseOrderDetailsPage"), "GeneralManagerPurchaseOrderDetailsPage");
const GeneralManagerReportsPage = lazyImportWithRetry(() => import("../pages/general-manager/GeneralManagerReportsPage"), "GeneralManagerReportsPage");
const PurchaseQuotesDecisionPage = lazyImportWithRetry(() => import("../pages/purchase-quotes/PurchaseQuotesDecisionPage"), "PurchaseQuotesDecisionPage");
const PurchaseReceiptPage = lazyImportWithRetry(() => import("../pages/receipts/PurchaseReceiptPage"), "PurchaseReceiptPage");
const SupplierPaymentsPage = lazyImportWithRetry(() => import("../pages/accounting/SupplierPaymentsPage"), "SupplierPaymentsPage");
const SupplierAccountsPage = lazyImportWithRetry(() => import("../pages/accounting/SupplierAccountsPage"), "SupplierAccountsPage");
const SupplierFinanceWorkspacePage = lazyImportWithRetry(() => import("../pages/accounting/SupplierFinanceWorkspacePage"), "SupplierFinanceWorkspacePage");
const LandParcelsPage = lazyImportWithRetry(() => import("../pages/accounting/LandParcelsPage"), "LandParcelsPage");
const ChartOfAccountsPage = lazyImportWithRetry(() => import("../pages/accounting/ChartOfAccountsPage"), "ChartOfAccountsPage");
const CostCentersPage = lazyImportWithRetry(() => import("../pages/accounting/CostCentersPage"), "CostCentersPage");
const ContractorInvoicesPage = lazyImportWithRetry(() => import("../pages/accounting/ContractorInvoicesPage"), "ContractorInvoicesPage");
const PettyCashPage = lazyImportWithRetry(() => import("../pages/accounting/PettyCashPage"), "PettyCashPage");
const ProjectCostsReportPage = lazyImportWithRetry(() => import("../pages/accounting/ProjectCostsReportPage"), "ProjectCostsReportPage");
const NotificationsPage = lazyImportWithRetry(() => import("../pages/NotificationsPage"), "NotificationsPage");
const RoleArchivePage = lazyImportWithRetry(() => import("../pages/RoleArchivePage"), "RoleArchivePage");
const ProfilePage = lazyImportWithRetry(() => import("../pages/ProfilePage"), "ProfilePage");
const UserPreferencesPage = lazyImportWithRetry(() => import("../pages/UserPreferencesPage"), "UserPreferencesPage");
const AdminDashboardPage = lazyImportWithRetry(() => import("../pages/admin/AdminDashboardPage"), "AdminDashboardPage");
const UsersPage = lazyImportWithRetry(() => import("../pages/admin/UsersPage"), "UsersPage");
const RolesPage = lazyImportWithRetry(() => import("../pages/admin/RolesPage"), "RolesPage");
const PermissionsPage = lazyImportWithRetry(() => import("../pages/admin/PermissionsPage"), "PermissionsPage");
const DepartmentsPage = lazyImportWithRetry(() => import("../pages/admin/DepartmentsPage"), "DepartmentsPage");
const CategoriesPage = lazyImportWithRetry(() => import("../pages/admin/CategoriesPage"), "CategoriesPage");
const ItemsPage = lazyImportWithRetry(() => import("../pages/admin/ItemsPage"), "ItemsPage");
const SuppliersPage = lazyImportWithRetry(() => import("../pages/admin/SuppliersPage"), "SuppliersPage");
const AdminRequestTrackerPage = lazyImportWithRetry(() => import("../pages/admin/AdminRequestTrackerPage"), "AdminRequestTrackerPage");
const AdminRequestDetailsPage = lazyImportWithRetry(() => import("../pages/admin/AdminRequestDetailsPage"), "AdminRequestDetailsPage");
const AdminMasterOrdersPage = lazyImportWithRetry(() => import("../pages/admin/AdminMasterOrdersPage"), "AdminMasterOrdersPage");
const AdminControlCenterPage = lazyImportWithRetry(() => import("../pages/admin/AdminControlCenterPage"), "AdminControlCenterPage");
const MyMaterialTransfersPage = lazyImportWithRetry(() => import("../pages/transfers/MyMaterialTransfersPage").then(m => ({ default: m.MyMaterialTransfersPage })), "MyMaterialTransfersPage");
const CreateMaterialTransferPage = lazyImportWithRetry(() => import("../pages/transfers/CreateMaterialTransferPage").then(m => ({ default: m.CreateMaterialTransferPage })), "CreateMaterialTransferPage");
const ReviewerMaterialTransfersPage = lazyImportWithRetry(() => import("../pages/transfers/ReviewerMaterialTransfersPage").then(m => ({ default: m.ReviewerMaterialTransfersPage })), "ReviewerMaterialTransfersPage");
const AccountingMaterialTransfersPage = lazyImportWithRetry(() => import("../pages/transfers/AccountingMaterialTransfersPage").then(m => ({ default: m.AccountingMaterialTransfersPage })), "AccountingMaterialTransfersPage");
const MaterialTransferArchivePage = lazyImportWithRetry(() => import("../pages/transfers/MaterialTransferArchivePage").then(m => ({ default: m.MaterialTransferArchivePage })), "MaterialTransferArchivePage");
import RoleHomeRedirect from "./RoleHomeRedirect";
import { ForbiddenPage, NotFoundPage, ServerErrorPage } from "../pages/ErrorPages";

export const AppRoutes: React.FC = () => {
    return (
        <React.Suspense fallback={
            <div className="min-h-[50vh] flex flex-col items-center justify-center p-8" dir="rtl">
                <div className="relative flex items-center justify-center">
                    <div className="w-14 h-14 rounded-full border-2 border-gold-500/20 border-t-gold-400 animate-spin" />
                    <span className="absolute text-base select-none">🏢</span>
                </div>
                <p className="mt-4 text-xs font-black tracking-wider text-gold-300/90 animate-pulse">
                    جاري تحميل الصفحة...
                </p>
                <span className="text-[10px] text-slate-500 mt-1 font-mono">منظومة المشتريات التشغيلية</span>
            </div>
        }>
            <Routes>
            {/* Public Routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/office-request/:token" element={<GuestOfficeRequestPage />} />

            {/* Protected Routes wrapped in Authenticated Layout */}
            <Route
                element={
                    <ProtectedRoute>
                        <AuthenticatedLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/protected" element={<ProtectedPage />} />
                {/* Shared routes available to all authenticated users */}
                <Route path="/notifications" element={<NotificationsPage />} />
                <Route path="/my-archive" element={<RoleArchivePage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/preferences" element={<UserPreferencesPage />} />

                {/* ── Shared Purchase Request Routes for all operational roles ── */}
                <Route element={<RoleRoute allowedRoles={["employee", "reviewer", "warehouse_keeper", "site_engineer", "procurement_manager", "general_accountant", "accountant", "site_accountant", "licenses_accountant", "buffet_accountant", "development_accountant", "general_manager", "execution_manager", "admin"]} />}>
                    <Route path="/requests" element={<PurchaseRequestsPage />} />
                    <Route path="/requests/create" element={<CreatePurchaseRequestPage />} />
                    <Route path="/requests/create-complementary" element={<CreatePurchaseRequestPage initialRequestType="COMPLEMENTARY" />} />
                    <Route path="/requests/favorites" element={<FavoriteRequestsPage />} />
                    <Route path="/requests/supplements" element={<SupplementaryRequestsPage />} />
                    <Route path="/requests/:id" element={<PurchaseRequestDetailsPage />} />
                    <Route path="/requests/:id/edit" element={<EditPurchaseRequestPage />} />

                    {/* Material Transfer Requests (طلب نقل خامات وأرشيف المنقولات) */}
                    <Route path="/material-transfers" element={<MyMaterialTransfersPage />} />
                    <Route path="/material-transfers/create" element={<CreateMaterialTransferPage />} />
                    <Route path="/material-transfers/:id/edit" element={<CreateMaterialTransferPage />} />
                    <Route path="/material-transfers/archive" element={<MaterialTransferArchivePage />} />
                </Route>

                {/* ── Admin Routes ─────────────────────────────────────────── */}
                <Route element={<RoleRoute allowedRoles={["admin"]} />}>
                    <Route path="/admin" element={<AdminDashboardPage />} />
                    <Route path="/admin/control-center" element={<AdminControlCenterPage />} />
                    <Route path="/admin/master-orders" element={<AdminMasterOrdersPage />} />
                    <Route path="/admin/request-tracker" element={<AdminRequestTrackerPage />} />
                    <Route path="/admin/request-tracker/:id" element={<AdminRequestDetailsPage />} />
                    <Route path="/admin/system-monitor" element={<AdminSystemMonitoringPage />} />
                    <Route path="/admin/users" element={<UsersPage />} />
                    <Route path="/admin/roles" element={<RolesPage />} />
                    <Route path="/admin/permissions" element={<PermissionsPage />} />
                    <Route path="/admin/departments" element={<DepartmentsPage />} />
                    <Route path="/admin/categories" element={<CategoriesPage />} />
                    <Route path="/admin/items" element={<ItemsPage />} />
                    <Route path="/admin/suppliers" element={<SuppliersPage />} />
                </Route>

                {/* ── Employee Routes ───────────────────────────────────────── */}
                <Route element={<RoleRoute allowedRoles={["employee", "reviewer", "warehouse_keeper", "site_engineer", "procurement_manager", "general_accountant", "accountant", "site_accountant", "licenses_accountant", "buffet_accountant", "development_accountant", "general_manager", "execution_manager", "admin"]} />}>
                    <Route path="/employee" element={<EmployeeDashboardPage />} />
                    <Route path="/employee/requests" element={<PurchaseRequestsPage />} />
                    <Route path="/employee/requests/create" element={<CreatePurchaseRequestPage />} />
                    <Route path="/employee/requests/create-complementary" element={<CreatePurchaseRequestPage initialRequestType="COMPLEMENTARY" />} />
                    <Route path="/employee/requests/favorites" element={<FavoriteRequestsPage />} />
                    <Route path="/employee/requests/:id" element={<PurchaseRequestDetailsPage />} />
                    <Route path="/employee/requests/:id/edit" element={<EditPurchaseRequestPage />} />
                </Route>

                {/* ── Reviewer Routes ───────────────────────────────────────── */}
                <Route element={<RoleRoute allowedRoles={["reviewer"]} />}>
                    <Route path="/reviewer" element={<ReviewerDashboardPage />} />
                    <Route path="/reviewer/requests" element={<ReviewerRequestsPage />} />
                    <Route path="/reviewer/requests/:id" element={<ReviewerPurchaseRequestDetailsPage />} />
                    <Route path="/reviewer/requests/:id/review" element={<ReviewPurchaseRequestPage />} />
                    <Route path="/reviewer/purchase-quotes" element={<PurchaseQuotesDecisionPage mode="recommend" />} />
                    <Route path="/reviewer/material-transfers" element={<ReviewerMaterialTransfersPage />} />
                </Route>

                {/* ── Warehouse Keeper Routes ─────────────────────────────── */}
                <Route element={<RoleRoute allowedRoles={["warehouse_keeper"]} />}>
                    <Route path="/warehouse" element={<PurchaseReceiptPage mode="warehouse" />} />
                </Route>

                {/* ── Material Receipt / Site Engineer Routes ──────────────────────── */}
                <Route element={<RoleRoute allowedRoles={["employee", "reviewer", "warehouse_keeper", "site_engineer", "procurement_manager", "accountant", "general_accountant", "site_accountant", "licenses_accountant", "buffet_accountant", "development_accountant", "general_manager", "execution_manager", "admin"]} />}>
                    <Route path="/site-engineer" element={<PurchaseReceiptPage mode="site" />} />
                    <Route path="/site-engineer/:id" element={<PurchaseReceiptPage mode="site" />} />
                    <Route path="/receipts" element={<PurchaseReceiptPage mode="site" />} />
                    <Route path="/receipts/:id" element={<PurchaseReceiptPage mode="site" />} />
                    <Route path="/receipts/:id/inspect" element={<PurchaseReceiptPage mode="site" />} />
                </Route>

                {/* ── Procurement Manager Routes ────────────────────────────── */}
                <Route element={<RoleRoute allowedRoles={["procurement_manager", "admin"]} />}>
                    <Route path="/procurement" element={<ProcurementManagerPage />} />
                    <Route path="/procurement/approved-requests" element={<ApprovedPurchaseRequestsPage />} />
                    <Route path="/procurement/purchase-orders/create" element={<CreatePurchaseOrderPage />} />
                    <Route path="/procurement/purchase-orders/:id/edit" element={<EditPurchaseOrderPage />} />
                    <Route path="/procurement/purchase-orders/:id" element={<PurchaseOrderDetailsPage />} />
                    <Route path="/procurement/pending-receipts" element={<ProcurementPendingReceiptsPage />} />
                    <Route path="/procurement/reports" element={<ProcurementReportsPage />} />
                    <Route path="/procurement/*" element={<ProcurementManagerPage />} />
                </Route>

                {/* ── Accounting & Department Accountants Shared Routes ────────────── */}
                <Route element={<RoleRoute allowedRoles={["general_accountant", "accountant", "site_accountant", "licenses_accountant", "buffet_accountant", "development_accountant"]} />}>
                    <Route path="/accounting/purchase-orders" element={<AccountingPurchaseOrdersPage />} />
                    <Route path="/accounting/purchase-orders/:id" element={<AccountingPurchaseOrderDetailsPage />} />
                    <Route path="/accounting/supplier-finance" element={<SupplierFinanceWorkspacePage />} />
                    <Route path="/accounting/supplier-payments" element={<SupplierFinanceWorkspacePage />} />
                    <Route path="/accounting/supplier-accounts" element={<SupplierFinanceWorkspacePage />} />
                    <Route path="/accounting/material-transfers" element={<AccountingMaterialTransfersPage />} />
                    <Route path="/accounting/reports" element={<UniversalReportsPage />} />
                </Route>

                {/* ── Financial Management (Isolated MVP Accounting Module) ──────── */}
                <Route element={<RoleRoute allowedRoles={["general_accountant", "accountant", "site_accountant", "licenses_accountant", "buffet_accountant", "development_accountant", "admin"]} />}>
                    <Route path="/accounting/chart-of-accounts" element={<ChartOfAccountsPage />} />
                    <Route path="/accounting/cost-centers" element={<CostCentersPage />} />
                    <Route path="/accounting/contractor-invoices" element={<ContractorInvoicesPage />} />
                    <Route path="/accounting/petty-cash" element={<PettyCashPage />} />
                    <Route path="/accounting/reports/project-costs" element={<ProjectCostsReportPage />} />
                </Route>

                {/* ── Department Accountants Dedicated Dashboard ─────────────────────── */}
                <Route element={<RoleRoute allowedRoles={["general_accountant", "site_accountant", "licenses_accountant", "buffet_accountant", "development_accountant", "admin"]} />}>
                    <Route path="/site-accountant" element={<SiteAccountantDashboardPage />} />
                </Route>

                {/* ── Financial Director (Accountant) Only Routes ─────────────── */}
                <Route element={<RoleRoute allowedRoles={["accountant", "admin"]} />}>
                    <Route path="/accounting" element={<AccountingDashboardPage />} />
                    <Route path="/accounting/purchase-requests" element={<AccountingPurchaseRequestsPage />} />
                    <Route path="/accounting/purchase-quotes" element={<PurchaseQuotesDecisionPage mode="recommend" />} />
                    <Route path="/accounting/land-parcels" element={<LandParcelsPage />} />
                </Route>

                {/* ── General Manager & Execution Manager Routes ───────────────── */}
                <Route element={<RoleRoute allowedRoles={["general_manager", "execution_manager"]} />}>
                    <Route path="/general-manager" element={<GeneralManagerDashboardPage />} />
                    <Route path="/general-manager/purchase-requests" element={<GeneralManagerPurchaseRequestsPage />} />
                    <Route path="/general-manager/purchase-quotes" element={<PurchaseQuotesDecisionPage mode="executive" />} />
                    <Route path="/general-manager/purchase-orders" element={<GeneralManagerPurchaseOrdersPage />} />
                    <Route path="/general-manager/purchase-orders/:id" element={<GeneralManagerPurchaseOrderDetailsPage />} />
                    <Route path="/general-manager/land-parcels" element={<LandParcelsPage />} />
                    <Route path="/general-manager/reports" element={<GeneralManagerReportsPage />} />
                </Route>

                {/* Direct alias & shared routes */}
                <Route element={<RoleRoute allowedRoles={["general_accountant", "accountant", "site_accountant", "licenses_accountant", "buffet_accountant", "development_accountant", "general_manager", "execution_manager", "procurement_manager", "admin"]} />}>
                    <Route path="/reports" element={<UniversalReportsPage />} />
                </Route>
                <Route element={<RoleRoute allowedRoles={["general_manager", "execution_manager", "procurement_manager", "accountant", "reviewer", "admin"]} />}>
                    <Route path="/purchase-quotes" element={<PurchaseQuotesDecisionPage mode="recommend" />} />
                </Route>
                <Route element={<RoleRoute allowedRoles={["general_manager", "execution_manager", "admin"]} />}>
                    <Route path="/purchase-quotes/decision" element={<PurchaseQuotesDecisionPage mode="executive" />} />
                </Route>
                <Route element={<RoleRoute allowedRoles={["accountant", "reviewer", "general_manager", "execution_manager", "procurement_manager", "admin"]} />}>
                    <Route path="/quotes" element={<PurchaseQuotesDecisionPage mode="recommend" />} />
                </Route>
            </Route>

            {/* Root & Error Routes */}
            <Route path="/" element={<RoleHomeRedirect />} />
            <Route path="/403" element={<ForbiddenPage />} />
            <Route path="/404" element={<NotFoundPage />} />
            <Route path="/500" element={<ServerErrorPage />} />
            <Route path="*" element={<NotFoundPage />} />
            </Routes>
        </React.Suspense>
    );
};

export default AppRoutes;
