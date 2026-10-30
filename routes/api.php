<?php

use App\Http\Controllers\Api\V1\AccountingPurchaseOrderController;
use App\Http\Controllers\Api\V1\AccountingPurchaseRequestController;
use App\Http\Controllers\Api\V1\SupplierInvoiceController;
use App\Http\Controllers\Api\V1\AdminController;
use App\Http\Controllers\Api\V1\AdminControlCenterController;
use App\Http\Controllers\Api\V1\AdminMasterOrdersController;
use App\Http\Controllers\Api\V1\AdminRequestTrackerController;
use App\Http\Controllers\Api\V1\AdminSystemMonitoringController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\GeneralManagerPurchaseOrderController;
use App\Http\Controllers\Api\V1\GeneralManagerPurchaseRequestController;
use App\Http\Controllers\Api\V1\HealthController;
use App\Http\Controllers\Api\V1\DashboardPendingTasksController;
use App\Http\Controllers\Api\V1\LandParcelController;
use App\Http\Controllers\Api\V1\ProcurementAnalyticsController;
use App\Http\Controllers\Api\V1\PurchaseQuoteController;
use App\Http\Controllers\Api\V1\PurchaseReceiptController;
use App\Http\Controllers\Api\V1\NotificationController;
use App\Http\Controllers\Api\V1\SystemEventController;
use App\Http\Controllers\Api\V1\ProcurementPurchaseOrderController;
use App\Http\Controllers\Api\V1\PurchaseRequestController;
use App\Http\Controllers\Api\V1\PurchaseRequestItemController;
use App\Http\Controllers\Api\V1\PurchaseRequestSupplementController;
use App\Http\Controllers\Api\V1\PurchasesReportController;
use App\Http\Controllers\Api\V1\ReviewerPurchaseRequestController;
use App\Http\Controllers\Api\V1\SteelWeighingGroupController;
use App\Http\Controllers\Api\V1\SharedShipmentGroupController;
use App\Http\Controllers\Api\V1\MaterialTransferRequestController;
use App\Http\Controllers\Api\Accounting\AccountController;
use App\Http\Controllers\Api\Accounting\CostCenterController;
use App\Http\Controllers\Api\Accounting\ContractorInvoiceController;
use App\Http\Controllers\Api\Accounting\PettyCashSettlementController;
use App\Http\Controllers\Api\Accounting\CostCenterReportController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes - V1
|--------------------------------------------------------------------------
|
| Base API route group for Al-Ashbiliya Procurement Management System.
|
*/

Route::get('/health', [HealthController::class, 'index']);


// Authentication & Authorization Routes
Route::prefix('auth')->group(function () {
    Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:10,1');
    Route::get('/demo-accounts', [AuthController::class, 'demoAccounts'])->middleware('throttle:30,1');

    Route::middleware('auth:sanctum')->group(function () {
        Route::get('/me', [AuthController::class, 'me']);
        Route::put('/password', [AuthController::class, 'changePassword']);
        Route::post('/logout', [AuthController::class, 'logout']);
        Route::get('/authorization-test', function () {
            return response()->json([
                'message' => 'Authorization test successful',
            ]);
        })->middleware('permission:system.users.manage');
    });
});

// Catalog Items Route
Route::middleware('auth:sanctum')->get('/catalog-items', [\App\Http\Controllers\Api\V1\CatalogItemController::class, 'index']);
Route::middleware('auth:sanctum')->get('/items/suggestions', [\App\Http\Controllers\Api\V1\CatalogItemController::class, 'suggestions']);

// Unified Dashboard Pending Tasks (Aggregated tasks across all entities)
Route::middleware('auth:sanctum')->get('/dashboard/pending-tasks', [DashboardPendingTasksController::class, 'index']);
Route::middleware('auth:sanctum')->get('/pending-tasks', [DashboardPendingTasksController::class, 'index']);
Route::middleware('auth:sanctum')->get('/reviewer/pending-tasks', [\App\Http\Controllers\Api\V1\ReviewerDashboardController::class, 'index']);
Route::middleware('auth:sanctum')->get('/reviewer/dashboard/pending-tasks', [\App\Http\Controllers\Api\V1\ReviewerDashboardController::class, 'index']);
Route::middleware('auth:sanctum')->get('/reports/purchases', [PurchasesReportController::class, 'index'])
    ->middleware('permission:purchase_order.view|purchase_order.view_gm|purchase_order.view_accounting');
Route::middleware('auth:sanctum')->get('/supplier-invoices/pending', [SupplierInvoiceController::class, 'approvedReceipts'])
    ->middleware('permission:accounting.invoice.view');

// Employee Purchase Request Routes
Route::middleware('auth:sanctum')->prefix('purchase-requests')->group(function () {
    Route::get('/', [PurchaseRequestController::class, 'index'])
        ->middleware('permission:purchase_request.view_own');

    Route::post('/', [PurchaseRequestController::class, 'store'])
        ->middleware('permission:purchase_request.create');

    Route::get('/department-options', [PurchaseRequestController::class, 'departmentOptions']);
    Route::get('/reviewer-options', [PurchaseRequestController::class, 'reviewerOptions']);
    Route::get('/site-engineer-options', [PurchaseRequestController::class, 'siteEngineerOptions']);
    Route::get('/eligible-for-supplement', [PurchaseRequestSupplementController::class, 'eligibleRequests']);
    Route::get('/{id}/supplements', [PurchaseRequestSupplementController::class, 'index'])->whereNumber('id');
    Route::post('/{id}/supplements', [PurchaseRequestSupplementController::class, 'store'])->whereNumber('id');
    Route::post('/supplements/{supplementId}/approve', [PurchaseRequestSupplementController::class, 'approveReviewer'])->whereNumber('supplementId');
    Route::post('/supplements/{supplementId}/reject', [PurchaseRequestSupplementController::class, 'rejectReviewer'])->whereNumber('supplementId');
    Route::post('/supplements/{supplementId}/process-procurement', [PurchaseRequestSupplementController::class, 'processProcurement'])->whereNumber('supplementId');

    Route::get('/{id}', [PurchaseRequestController::class, 'show'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.view_own');

    Route::put('/{id}', [PurchaseRequestController::class, 'update'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.edit_own');

    Route::delete('/{id}', [PurchaseRequestController::class, 'destroy'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.edit_own');

    Route::post('/{id}/submit', [PurchaseRequestController::class, 'submit'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.submit');

    Route::post('/{id}/cancel', [PurchaseRequestController::class, 'cancel'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.edit_own');

    Route::post('/{id}/attachments', [PurchaseRequestController::class, 'attachmentUpload'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.create');

    Route::delete('/{id}/attachments/{attachmentId}', [PurchaseRequestController::class, 'attachmentDelete'])
        ->whereNumber('id')
        ->whereNumber('attachmentId')
        ->middleware('permission:purchase_request.edit_own');

    Route::get('/{id}/attachments/{attachmentId}/download', [PurchaseRequestController::class, 'attachmentDownload'])
        ->whereNumber('id')
        ->whereNumber('attachmentId')
        ->middleware('permission:purchase_request.view_own');

    // Purchase Request Line Items Management (Emp in DRAFT, Reviewer during review, Procurement in active procurement states, Admin)
    Route::post('/{id}/items', [PurchaseRequestItemController::class, 'store'])
        ->whereNumber('id');

    Route::put('/{id}/items/{itemId}', [PurchaseRequestItemController::class, 'update'])
        ->whereNumber('id')
        ->whereNumber('itemId');

    Route::delete('/{id}/items/{itemId}', [PurchaseRequestItemController::class, 'destroy'])
        ->whereNumber('id')
        ->whereNumber('itemId');
});

// Reviewer Purchase Request Routes
Route::middleware('auth:sanctum')->prefix('reviewer/purchase-requests')->group(function () {
    Route::get('/', [ReviewerPurchaseRequestController::class, 'index'])
        ->middleware('permission:purchase_request.view_assigned');

    Route::get('/{id}', [ReviewerPurchaseRequestController::class, 'show'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.view_assigned');

    Route::post('/{id}/review', [ReviewerPurchaseRequestController::class, 'startReview'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.review');

    Route::put('/{id}', [ReviewerPurchaseRequestController::class, 'updateHeader'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.edit_during_review');

    Route::put('/{id}/items/{itemId}', [ReviewerPurchaseRequestController::class, 'updateItem'])
        ->whereNumber('id')
        ->whereNumber('itemId')
        ->middleware('permission:purchase_request.edit_during_review');

    Route::post('/{id}/items', [ReviewerPurchaseRequestController::class, 'addItem'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.edit_during_review');

    Route::delete('/{id}/items/{itemId}', [ReviewerPurchaseRequestController::class, 'deleteItem'])
        ->whereNumber('id')
        ->whereNumber('itemId')
        ->middleware('permission:purchase_request.edit_during_review');

    Route::post('/{id}/approve', [ReviewerPurchaseRequestController::class, 'approve'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.approve');

    Route::post('/{id}/reject', [ReviewerPurchaseRequestController::class, 'reject'])
        ->whereNumber('id')
        ->middleware('permission:purchase_request.reject');
});

// Procurement Manager Routes
Route::middleware('auth:sanctum')->prefix('procurement')->group(function () {

    // ── PR Approval Queue (PENDING_PROCUREMENT_APPROVAL) ──
    Route::get('/purchase-requests', [ProcurementPurchaseOrderController::class, 'indexApprovedPrs'])
        ->middleware('permission:purchase_request.view_approved');

    Route::get('/purchase-requests/quotes', [ProcurementPurchaseOrderController::class, 'indexPendingQuoteRequests'])
        ->middleware('permission:purchase_quote.view');

    Route::get('/purchase-requests/executive-pending', [ProcurementPurchaseOrderController::class, 'indexExecutivePendingPrs'])
        ->middleware('permission:purchase_request.view_approved');

    Route::get('/pending-receipts', [ProcurementPurchaseOrderController::class, 'indexPendingReceipts'])
        ->middleware('permission:purchase_order.view|purchase_order.create');

    Route::get('/purchase-requests/{id}', [ProcurementPurchaseOrderController::class, 'showApprovedPr'])
        ->middleware('permission:purchase_request.view_approved');

    Route::get('/purchase-requests/{id}/quotes', [PurchaseQuoteController::class, 'showForRequest'])
        ->middleware('permission:purchase_quote.view');

    Route::post('/purchase-requests/{id}/quotes', [PurchaseQuoteController::class, 'create'])
        ->middleware('permission:purchase_quote.create');

    Route::post('/purchase-requests/{id}/approve', [ProcurementPurchaseOrderController::class, 'approvePurchaseRequest'])
        ->middleware('permission:purchase_request.approve_procurement');

    Route::post('/purchase-requests/{id}/reject', [ProcurementPurchaseOrderController::class, 'rejectPurchaseRequest'])
        ->middleware('permission:purchase_request.approve_procurement');

    Route::post('/purchase-requests/{id}/reset-route', [ProcurementPurchaseOrderController::class, 'resetRoute'])
        ->middleware('permission:purchase_request.approve_procurement');

    // ── PR Approved by Procurement (APPROVED_BY_PROCUREMENT — ready for PO creation) ──
    Route::get('/approved-purchase-requests', [ProcurementPurchaseOrderController::class, 'indexProcurementApprovedPrs'])
        ->middleware('permission:purchase_request.view_approved');

    // ── Department and site-engineer targets for direct purchase requests ──
    Route::get('/departments', [AdminController::class, 'indexDepartments'])
        ->middleware('permission:purchase_order.create');

    Route::get('/site-engineers', [PurchaseRequestController::class, 'siteEngineerOptions'])
        ->middleware('permission:purchase_order.create');

    // ── Suppliers ──
    Route::get('/suppliers', [ProcurementPurchaseOrderController::class, 'indexSuppliers'])
        ->middleware('permission:supplier.view');

    Route::get('/suppliers-manage', [\App\Http\Controllers\Api\V1\SupplierController::class, 'index'])
        ->middleware('permission:supplier.view');

    Route::get('/suppliers-manage/{id}', [\App\Http\Controllers\Api\V1\SupplierController::class, 'show'])
        ->middleware('permission:supplier.view');

    Route::post('/suppliers', [\App\Http\Controllers\Api\V1\SupplierController::class, 'store'])
        ->middleware('permission:supplier.create');

    Route::put('/suppliers/{id}', [\App\Http\Controllers\Api\V1\SupplierController::class, 'update'])
        ->middleware('permission:supplier.edit');

    Route::delete('/suppliers/{id}', [\App\Http\Controllers\Api\V1\SupplierController::class, 'destroy'])
        ->middleware('permission:supplier.edit');

    // ── Direct purchase request (legacy URL retained for existing clients) ──
    Route::post('/direct-purchase-request', [ProcurementPurchaseOrderController::class, 'storeDirectPo'])
        ->middleware('permission:purchase_order.create');
    Route::post('/direct-po', [ProcurementPurchaseOrderController::class, 'storeDirectPo'])
        ->middleware('permission:purchase_order.create');

    // ── Purchase Orders ──
    Route::get('/purchase-orders', [ProcurementPurchaseOrderController::class, 'indexPos'])
        ->middleware('permission:purchase_order.view');

    Route::get('/purchase-orders/{id}', [ProcurementPurchaseOrderController::class, 'showPo'])
        ->middleware('permission:purchase_order.view');

    Route::get('/purchase-orders/{id}/combined-document', [ProcurementPurchaseOrderController::class, 'combinedDocument'])
        ->middleware('permission:purchase_order.view|purchase_order.view_gm');

    Route::post('/purchase-orders/batch', [ProcurementPurchaseOrderController::class, 'storeBatchPo'])
        ->middleware('permission:purchase_order.create');

    Route::post('/purchase-orders/consolidation-preview', [ProcurementPurchaseOrderController::class, 'previewConsolidatedPos'])
        ->middleware('permission:purchase_order.create');

    Route::post('/purchase-orders', [ProcurementPurchaseOrderController::class, 'storePo'])
        ->middleware('permission:purchase_order.create');

    Route::put('/purchase-orders/{id}', [ProcurementPurchaseOrderController::class, 'updateHeader'])
        ->middleware('permission:purchase_order.edit');

    Route::put('/purchase-orders/{id}/items/{itemId}', [ProcurementPurchaseOrderController::class, 'updateItem'])
        ->middleware('permission:purchase_order.edit');

    Route::post('/purchase-orders/{id}/items', [ProcurementPurchaseOrderController::class, 'addItem'])
        ->middleware('permission:purchase_order.edit');

    Route::delete('/purchase-orders/{id}/items/{itemId}', [ProcurementPurchaseOrderController::class, 'deleteItem'])
        ->middleware('permission:purchase_order.edit');

    Route::post('/purchase-orders/{id}/submit', [ProcurementPurchaseOrderController::class, 'submitPoToAccounting'])
        ->middleware('permission:purchase_order.create');

    Route::put('/purchase-orders/{id}/delivery', [ProcurementPurchaseOrderController::class, 'updateDeliveryStatus'])
        ->middleware('permission:purchase_order.edit');

    Route::get('/purchase-orders/pending-warehouse-tasks', [ProcurementPurchaseOrderController::class, 'pendingWarehouseTasks'])
        ->middleware('permission:purchase_receipt.view_assigned');

    // ── Actual PO Workflow (after GRN approval) ──
    Route::get('/pending-actual-pos', [ProcurementPurchaseOrderController::class, 'indexPendingActualPos'])
        ->middleware('permission:purchase_order.view');

    Route::post('/purchase-orders/{id}/finalize', [ProcurementPurchaseOrderController::class, 'finalizeActualPo'])
        ->middleware('permission:purchase_order.create');

    Route::post('/purchase-orders/{id}/upload-invoice', [ProcurementPurchaseOrderController::class, 'uploadInvoice'])
        ->middleware('permission:purchase_order.create|purchase_order.edit|purchase_order.manage');

    Route::get('/analytics', [ProcurementAnalyticsController::class, 'index'])
        ->middleware('permission:purchase_order.view|purchase_order.view_gm|purchase_order.view_accounting');

    Route::get('/reports/purchases', [PurchasesReportController::class, 'index'])
        ->middleware('permission:purchase_order.view|purchase_order.view_gm|purchase_order.view_accounting');
});

// Accounting Financial Review Routes (View Only)
Route::middleware('auth:sanctum')->prefix('accounting/purchase-orders')->group(function () {
    Route::get('/', [AccountingPurchaseOrderController::class, 'index'])
        ->middleware('permission:purchase_order.view_accounting');

    Route::get('/{id}', [AccountingPurchaseOrderController::class, 'show'])
        ->middleware('permission:purchase_order.view_accounting');

    Route::post('/{id}/approve', [AccountingPurchaseOrderController::class, 'approve'])
        ->middleware('permission:purchase_order.view_accounting');

    Route::post('/{id}/return', [AccountingPurchaseOrderController::class, 'returnToProcurement'])
        ->middleware('permission:purchase_order.view_accounting');
});

// Supplier Invoices, Payments, and Supplier Accounts
Route::middleware('auth:sanctum')->prefix('accounting')->group(function () {
    Route::get('/purchase-requests/direct-approval', [AccountingPurchaseRequestController::class, 'index'])
        ->middleware('permission:purchase_request.accounting_view');
    Route::get('/purchase-requests/direct-suppliers', [AccountingPurchaseRequestController::class, 'suppliers'])
        ->middleware('permission:purchase_request.accounting_view');
    Route::post('/purchase-requests/{id}/direct-approve', [AccountingPurchaseRequestController::class, 'approve'])
        ->middleware('permission:purchase_request.accounting_approve');
    Route::post('/purchase-requests/{id}/direct-reject', [AccountingPurchaseRequestController::class, 'reject'])
        ->middleware('permission:purchase_request.accounting_reject');

    Route::get('/departments', [AdminController::class, 'indexDepartments'])
        ->middleware('permission:accounting.invoice.view');
    Route::get('/land-parcels', [LandParcelController::class, 'index'])
        ->middleware('permission:accounting.invoice.view|purchase_order.view_gm|purchase_request.create|purchase_request.edit_own|purchase_request.view_own|purchase_request.view_all|purchase_request.review');
    Route::post('/land-parcels', [LandParcelController::class, 'store'])
        ->middleware('permission:accounting.invoice.create');
    Route::get('/land-parcels/{landParcel}', [LandParcelController::class, 'show'])
        ->middleware('permission:accounting.invoice.view|purchase_order.view_gm');
    Route::post('/land-parcels/{landParcel}/fund', [LandParcelController::class, 'fund'])
        ->middleware('permission:accounting.invoice.create');
    Route::delete('/land-parcels/wipe-all', [LandParcelController::class, 'wipeAll'])
        ->middleware('permission:accounting.invoice.create');
    Route::delete('/land-parcels/{landParcel}', [LandParcelController::class, 'destroy'])
        ->middleware('permission:accounting.invoice.create');

    Route::get('/receipts/approved', [SupplierInvoiceController::class, 'approvedReceipts'])
        ->middleware('permission:accounting.invoice.view');
    Route::post('/receipts/{id}/mark-recorded', [SupplierInvoiceController::class, 'markReceiptRecorded'])
        ->middleware('permission:accounting.invoice.view');
    Route::get('/supplier-invoices/pending', [SupplierInvoiceController::class, 'approvedReceipts'])
        ->middleware('permission:accounting.invoice.view');
    Route::get('/invoices', [SupplierInvoiceController::class, 'invoices'])
        ->middleware('permission:accounting.invoice.view');
    Route::post('/invoices', [SupplierInvoiceController::class, 'storeInvoice'])
        ->middleware('permission:accounting.invoice.create');
    Route::post('/invoices/{invoice}/match', [SupplierInvoiceController::class, 'match'])
        ->middleware('permission:accounting.invoice.match');
    Route::post('/invoices/{invoice}/payments', [SupplierInvoiceController::class, 'storePayment'])
        ->middleware('permission:accounting.payment.create');
    Route::post('/payments', [SupplierInvoiceController::class, 'storeDirectPayment'])
        ->middleware('permission:accounting.payment.create');
    Route::post('/suppliers/{supplier}/payments', [SupplierInvoiceController::class, 'storeSupplierPayment'])
        ->middleware('permission:accounting.payment.create');
    Route::get('/suppliers/accounts', [SupplierInvoiceController::class, 'supplierAccounts'])
        ->middleware('permission:supplier.account.view');
    Route::get('/suppliers/{supplier}/account', [SupplierInvoiceController::class, 'supplierAccount'])
        ->middleware('permission:supplier.account.view');
    Route::post('/suppliers/{supplier}/opening-balance', [SupplierInvoiceController::class, 'setOpeningBalance'])
        ->middleware('permission:accounting.invoice.create');
});

// General Accounting Module (Isolated - Chart of Accounts & Cost Centers)
Route::middleware(['auth:sanctum', 'permission:accounting.invoice.view|purchase_order.view_accounting|system.users.manage'])
    ->prefix('accounting')
    ->group(function () {
        Route::get('/accounts', [AccountController::class, 'index']);
        Route::get('/accounts/{account}', [AccountController::class, 'show']);
        Route::get('/cost-centers', [CostCenterController::class, 'index']);
        Route::get('/cost-centers/{costCenter}', [CostCenterController::class, 'show']);

        // Contractor Invoices (مستخلصات المقاولين)
        Route::get('/contractor-invoices', [ContractorInvoiceController::class, 'index']);
        Route::post('/contractor-invoices', [ContractorInvoiceController::class, 'store']);
        Route::get('/contractor-invoices/{contractorInvoice}', [ContractorInvoiceController::class, 'show']);
        Route::put('/contractor-invoices/{contractorInvoice}', [ContractorInvoiceController::class, 'update']);
        Route::delete('/contractor-invoices/{contractorInvoice}', [ContractorInvoiceController::class, 'destroy']);
        Route::post('/contractor-invoices/{contractorInvoice}/approve', [ContractorInvoiceController::class, 'approve']);

        // Petty Cash Settlements (تسويات العهد والمصروفات النثرية)
        Route::get('/petty-cash-settlements', [PettyCashSettlementController::class, 'index']);
        Route::post('/petty-cash-settlements', [PettyCashSettlementController::class, 'store']);
        Route::get('/petty-cash-settlements/{pettyCashSettlement}', [PettyCashSettlementController::class, 'show']);
        Route::put('/petty-cash-settlements/{pettyCashSettlement}', [PettyCashSettlementController::class, 'update']);
        Route::delete('/petty-cash-settlements/{pettyCashSettlement}', [PettyCashSettlementController::class, 'destroy']);
        Route::post('/petty-cash-settlements/{pettyCashSettlement}/approve', [PettyCashSettlementController::class, 'approve']);

        // Cost Centers & Project Costs Reports (تقارير تكاليف المشاريع ومراكز التكلفة)
        Route::get('/reports/cost-centers', [CostCenterReportController::class, 'summary']);
        Route::get('/reports/cost-centers/{id}/statement', [CostCenterReportController::class, 'statement']);
    });

// General Manager / Executive Purchase Request Decision Routes
Route::middleware('auth:sanctum')->prefix('general-manager/purchase-requests')->group(function () {
    Route::get('/', [GeneralManagerPurchaseRequestController::class, 'index'])
        ->middleware('permission:purchase_request.view_gm');

    Route::get('/{id}', [GeneralManagerPurchaseRequestController::class, 'show'])
        ->middleware('permission:purchase_request.view_gm');

    Route::put('/{id}', [GeneralManagerPurchaseRequestController::class, 'update'])
        ->middleware('permission:purchase_request.edit_gm');

    Route::post('/{id}/approve', [GeneralManagerPurchaseRequestController::class, 'approve'])
        ->middleware('permission:purchase_request.approve_gm');

    Route::post('/{id}/reject', [GeneralManagerPurchaseRequestController::class, 'reject'])
        ->middleware('permission:purchase_request.reject_gm');
});

// General Manager — Purchase Order View Access
Route::middleware('auth:sanctum')->prefix('general-manager/purchase-orders')->group(function () {
    Route::get('/', [GeneralManagerPurchaseOrderController::class, 'index'])
        ->middleware('permission:purchase_order.view_gm');

    Route::get('/{id}', [GeneralManagerPurchaseOrderController::class, 'show'])
        ->middleware('permission:purchase_order.view_gm');

    Route::post('/{id}/approve', [GeneralManagerPurchaseOrderController::class, 'approve'])
        ->middleware('permission:purchase_order.view_gm');

    Route::post('/{id}/reject', [GeneralManagerPurchaseOrderController::class, 'reject'])
        ->middleware('permission:purchase_order.view_gm');

    Route::post('/{id}/return', [GeneralManagerPurchaseOrderController::class, 'returnToProcurement'])
        ->middleware('permission:purchase_order.view_gm');
});

// Purchase receipt routes: warehouse first, then assigned site engineer
Route::middleware('auth:sanctum')->prefix('purchase-receipts')->group(function () {
    Route::get('/warehouse-queue', [PurchaseReceiptController::class, 'warehouseQueue'])
        ->middleware('permission:purchase_receipt.view_assigned');
    Route::get('/pending-warehouse-tasks', [PurchaseReceiptController::class, 'pendingWarehouseTasks'])
        ->middleware('permission:purchase_receipt.view_assigned');
    Route::get('/assigned', [PurchaseReceiptController::class, 'indexAssigned'])
        ->middleware('permission:purchase_receipt.view_assigned|purchase_request.view_own|purchase_request.review');
    Route::get('/archive', [PurchaseReceiptController::class, 'archive'])
        ->middleware('permission:purchase_receipt.view_assigned|purchase_request.view_own|purchase_request.review');
    Route::get('/{id}', [PurchaseReceiptController::class, 'show'])
        ->middleware('permission:purchase_receipt.view_assigned|purchase_request.view_own|purchase_request.review');
    Route::post('/purchase-orders/{purchaseOrderId}', [PurchaseReceiptController::class, 'store'])
        ->middleware('permission:purchase_receipt.edit');
    Route::post('/purchase-orders/{purchaseOrderId}/confirm-office', [PurchaseReceiptController::class, 'confirmOfficeReceipt'])
        ->middleware('permission:purchase_receipt.edit|purchase_request.view_own');
    Route::put('/{id}', [PurchaseReceiptController::class, 'update'])
        ->middleware('permission:purchase_receipt.edit|purchase_request.review');
    Route::post('/{id}/approve', [PurchaseReceiptController::class, 'approve'])
        ->middleware('permission:purchase_receipt.approve|purchase_request.review');
    Route::post('/{id}/cancel', [PurchaseReceiptController::class, 'cancelPending'])
        ->middleware('permission:purchase_receipt.edit|purchase_order.create|purchase_request.review');
});

// Steel Weighing Groups (تجميع وزنة الحديد)
Route::middleware('auth:sanctum')->prefix('weighing-groups')->group(function () {
    Route::get('/eligible/{poId}', [SteelWeighingGroupController::class, 'eligibleItems']);
    Route::get('/po/{poId}', [SteelWeighingGroupController::class, 'byPurchaseOrder']);
    Route::get('/{id}', [SteelWeighingGroupController::class, 'show']);
    Route::post('/', [SteelWeighingGroupController::class, 'store']);
    Route::post('/{id}/receive', [SteelWeighingGroupController::class, 'receive']);
    Route::post('/{id}/cancel', [SteelWeighingGroupController::class, 'cancel']);
    Route::post('/{id}/ungroup', [SteelWeighingGroupController::class, 'ungroup']);
});

// Shared Shipment Groups (مجموعات الشحنات المشتركة)
Route::middleware('auth:sanctum')->prefix('shipment-groups')->group(function () {
    Route::get('/eligible/{poId}', [SharedShipmentGroupController::class, 'eligibleItems']);
    Route::get('/po/{poId}', [SharedShipmentGroupController::class, 'byPurchaseOrder']);
    Route::get('/{id}', [SharedShipmentGroupController::class, 'show']);
    Route::post('/', [SharedShipmentGroupController::class, 'store']);
    Route::post('/{id}/ungroup', [SharedShipmentGroupController::class, 'ungroup']);
});

// Receipt direct photo stream (authenticated & permission-checked)
Route::middleware(['auth:sanctum', 'permission:purchase_receipt.view_assigned|accounting.invoice.view|purchase_order.view'])->get('/purchase-receipts/{id}/photo', [PurchaseReceiptController::class, 'viewPhoto']);
Route::middleware(['auth:sanctum', 'permission:purchase_receipt.view_assigned|accounting.invoice.view|purchase_order.view'])->get('/purchase-receipts/{id}/attachment', [PurchaseReceiptController::class, 'getAttachment']);

// Purchase Order direct invoice photo stream (authenticated & permission-checked)
Route::middleware(['auth:sanctum', 'permission:purchase_order.view|purchase_receipt.view_assigned|accounting.invoice.view'])->get('/purchase-orders/{id}/invoice-photo', [ProcurementPurchaseOrderController::class, 'viewInvoicePhoto']);

// Quote direct file stream (authenticated & permission-checked)
Route::middleware(['auth:sanctum', 'permission:purchase_quote.view|purchase_request.view_own'])->get('/purchase-quotes/{id}/file', [PurchaseQuoteController::class, 'viewFile']);

Route::middleware('auth:sanctum')->prefix('purchase-quotes')->group(function () {
    Route::get('/suppliers/{id}/archive', [PurchaseQuoteController::class, 'supplierQuotes']);

    Route::post('/{id}/recommend', [PurchaseQuoteController::class, 'recommend'])
        ->middleware('permission:purchase_quote.recommend');

    Route::post('/{id}/decide', [PurchaseQuoteController::class, 'decide'])
        ->middleware('permission:purchase_quote.decide');
});

// System Activity Timeline Routes
Route::middleware('auth:sanctum')->prefix('activity')->group(function () {
    Route::get('/purchase-requests/{id}', [SystemEventController::class, 'purchaseRequest']);
    Route::get('/purchase-orders/{id}', [SystemEventController::class, 'purchaseOrder']);
    Route::get('/my-archive', [SystemEventController::class, 'myArchive']);
});

// Material Transfer Requests Module (طلب نقل خامات وأرشيف المنقولات)
Route::middleware('auth:sanctum')->prefix('material-transfers')->group(function () {
    // Requester routes
    Route::get('/', [MaterialTransferRequestController::class, 'index']);
    Route::post('/', [MaterialTransferRequestController::class, 'store']);
    Route::get('/archive', [MaterialTransferRequestController::class, 'archiveIndex']);
    Route::get('/{id}', [MaterialTransferRequestController::class, 'show'])->whereNumber('id');
    Route::put('/{id}', [MaterialTransferRequestController::class, 'update'])->whereNumber('id');
    Route::post('/{id}/submit', [MaterialTransferRequestController::class, 'submit'])->whereNumber('id');
    Route::delete('/{id}', [MaterialTransferRequestController::class, 'destroy'])->whereNumber('id');

    // Reviewer routes
    Route::get('/reviewer/pending', [MaterialTransferRequestController::class, 'reviewerIndex']);
    Route::post('/{id}/approve', [MaterialTransferRequestController::class, 'reviewerApprove'])->whereNumber('id');
    Route::post('/{id}/reject', [MaterialTransferRequestController::class, 'reviewerReject'])->whereNumber('id');
    Route::post('/{id}/return', [MaterialTransferRequestController::class, 'reviewerReturn'])->whereNumber('id');

    // Accounting routes
    Route::get('/accounting/pending', [MaterialTransferRequestController::class, 'accountingIndex']);
    Route::post('/{id}/process-archive', [MaterialTransferRequestController::class, 'accountingProcessAndArchive'])->whereNumber('id');
});

// In-App Notification System Routes
Route::middleware('auth:sanctum')->prefix('notifications')->group(function () {
    Route::get('/', [NotificationController::class, 'index']);
    Route::get('/unread-count', [NotificationController::class, 'unreadCount']);
    Route::get('/stream', [NotificationController::class, 'stream'])->middleware('throttle:30,1');
    Route::post('/{id}/read', [NotificationController::class, 'markAsRead'])->whereNumber('id');
    Route::post('/{id}/mark-as-read', [NotificationController::class, 'markAsRead'])->whereNumber('id');
    Route::post('/read-all', [NotificationController::class, 'markAllAsRead']);
    Route::post('/mark-all-as-read', [NotificationController::class, 'markAllAsRead']);
    Route::post('/device-token', [NotificationController::class, 'registerDeviceToken']);
    Route::delete('/device-token', [NotificationController::class, 'deleteDeviceToken']);
    Route::post('/test-push', [NotificationController::class, 'testPush']);
});

// Master Orders Control (All Orders & Sovereign Force Override)
Route::middleware(['auth:sanctum', 'role:admin'])->prefix('admin')->group(function () {
    Route::get('/all-orders-master', [AdminMasterOrdersController::class, 'index']);
    Route::get('/orders/{id}/details', [AdminMasterOrdersController::class, 'showOrder']);
    Route::put('/orders/{id}/force-update', [AdminMasterOrdersController::class, 'forceUpdateOrder']);
    Route::get('/requests/{id}/stage', [AdminMasterOrdersController::class, 'showRequestStage'])->whereNumber('id');
    Route::post('/requests/{id}/move-stage', [AdminMasterOrdersController::class, 'moveRequestStage'])->whereNumber('id');
    Route::delete('/orders/{id}/force-delete', [AdminMasterOrdersController::class, 'forceDeleteOrder']);
});

// Admin Control Center (Sovereign Workflow & Lifecycle Control)
Route::middleware(['auth:sanctum', 'role:admin'])->prefix('admin/control')->group(function () {
    Route::get('/search', [AdminControlCenterController::class, 'search']);
    Route::get('/documents/{type}/{id}', [AdminControlCenterController::class, 'showDocument'])->whereNumber('id');
    Route::post('/preview', [AdminControlCenterController::class, 'previewImpact']);
    Route::post('/requests/{id}/edit', [AdminControlCenterController::class, 'editRequest'])->whereNumber('id');
    Route::post('/requests/{id}/cancel', [AdminControlCenterController::class, 'cancelDocument']);
    Route::post('/receipts/{id}/reassign', [AdminControlCenterController::class, 'reassignReceipt'])->whereNumber('id');
    Route::post('/documents/rollback', [AdminControlCenterController::class, 'rollbackDocument']);
    Route::post('/documents/forward', [AdminControlCenterController::class, 'forwardDocument']);
    Route::post('/assignments/manage', [AdminControlCenterController::class, 'manageAssignment']);
    Route::post('/notifications/{id}/resend', [AdminControlCenterController::class, 'resendNotification'])->whereNumber('id');
    Route::get('/audit-log', [AdminControlCenterController::class, 'getAuditLogs']);
    Route::get('/reports/grid', [AdminControlCenterController::class, 'getExcelReportsGrid']);
});

// Admin System Management Routes
Route::middleware(['auth:sanctum', 'permission:system.users.manage'])->prefix('admin')->group(function () {
    // One-time historical data fixes
    Route::post('/fix-rebar-quantities', [AdminController::class, 'fixHistoricalRebar']);
    Route::post('/purge-operational-data', [AdminController::class, 'purgeOperationalData']);

    // Users
    Route::get('/users', [AdminController::class, 'indexUsers']);
    Route::post('/users', [AdminController::class, 'storeUser']);
    Route::put('/users/{id}', [AdminController::class, 'updateUser']);
    Route::delete('/users/{id}', [AdminController::class, 'destroyUser']);

    // Roles & Permissions
    Route::get('/roles', [AdminController::class, 'indexRoles']);
    Route::get('/permissions', [AdminController::class, 'indexPermissions']);
    Route::put('/roles/{id}/permissions', [AdminController::class, 'updateRolePermissions']);

    // Departments
    Route::get('/departments', [AdminController::class, 'indexDepartments']);
    Route::post('/departments', [AdminController::class, 'storeDepartment']);
    Route::put('/departments/{id}', [AdminController::class, 'updateDepartment']);
    Route::delete('/departments/{id}', [AdminController::class, 'destroyDepartment']);

    // Categories
    Route::get('/categories', [AdminController::class, 'indexCategories']);
    Route::post('/categories', [AdminController::class, 'storeCategory']);
    Route::put('/categories/{id}', [AdminController::class, 'updateCategory']);
    Route::delete('/categories/{id}', [AdminController::class, 'destroyCategory']);

    // Items
    Route::get('/items', [AdminController::class, 'indexItems']);
    Route::post('/items', [AdminController::class, 'storeItem']);
    Route::put('/items/{id}', [AdminController::class, 'updateItem']);
    Route::delete('/items/{id}', [AdminController::class, 'destroyItem']);
});

// Admin System Monitoring Routes
Route::middleware(['auth:sanctum', 'permission:system.monitor.view'])->prefix('admin/system')->group(function () {
    Route::get('/monitoring', [AdminSystemMonitoringController::class, 'index']);
    Route::get('/health', [AdminSystemMonitoringController::class, 'healthCheck']);
    Route::get('/alerts', [AdminSystemMonitoringController::class, 'alerts']);
    Route::get('/audit-log', [AdminSystemMonitoringController::class, 'auditLog']);
    Route::get('/security-events', [AdminSystemMonitoringController::class, 'securityEvents']);
    Route::get('/data-quality', [AdminSystemMonitoringController::class, 'dataQuality']);
    Route::get('/drive-status', [AdminSystemMonitoringController::class, 'driveStatus']);
    Route::post('/run-migrations', [AdminSystemMonitoringController::class, 'runMigrations']);
});

// Admin Request Tracker — full procurement workflow visibility
Route::middleware(['auth:sanctum', 'permission:system.users.manage'])->prefix('admin/request-tracker')->group(function () {
    Route::get('', [AdminRequestTrackerController::class, 'index']);
    Route::get('/', [AdminRequestTrackerController::class, 'index']);
    Route::get('/stats', [AdminRequestTrackerController::class, 'stats']);
    Route::get('/{id}', [AdminRequestTrackerController::class, 'show'])->whereNumber('id');
    Route::post('/{id}/cancel', [AdminRequestTrackerController::class, 'cancel'])->whereNumber('id');
    Route::post('/{id}/archive', [AdminRequestTrackerController::class, 'archive'])->whereNumber('id');
    Route::post('/{id}/restore', [AdminRequestTrackerController::class, 'restore'])->whereNumber('id');
    Route::post('/{id}/reopen', [AdminRequestTrackerController::class, 'reopen'])->whereNumber('id');
    Route::post('/{id}/note', [AdminRequestTrackerController::class, 'addNote'])->whereNumber('id');
});
