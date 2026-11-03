<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestSupplement;
use App\Models\SupplierInvoice;
use App\Services\ProcurementPurchaseRequestService;
use App\Services\PurchaseReceiptService;
use App\Services\ReviewerPurchaseRequestService;
use App\Services\SupplierInvoiceService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class DashboardPendingTasksController extends Controller
{
    public function __construct(
        protected PurchaseReceiptService $receiptService,
        protected ReviewerPurchaseRequestService $reviewerService,
        protected ProcurementPurchaseRequestService $procurementService,
        protected SupplierInvoiceService $invoiceService
    ) {}

    /**
     * Unified pending actions & tasks across all entities for the authenticated user.
     */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $tasks = collect();

        // 1. Employee / Requester: Draft, Returned, or Rejected Purchase Requests
        $employeePrs = PurchaseRequest::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
            ->with(['department', 'items.item'])
            ->where('user_id', $user->id)
            ->whereIn('status', ['DRAFT', 'RETURNED', 'REJECTED'])
            ->orderByDesc('created_at')
            ->get();

        foreach ($employeePrs as $pr) {
            $isReturned = $pr->status === 'RETURNED';
            $isRejected = $pr->status === 'REJECTED';
            $tasks->push([
                'id' => "pr-{$pr->status}-{$pr->id}",
                'rawId' => $pr->id,
                'type' => 'PR',
                'code' => $pr->request_number,
                'title' => $pr->justification ?: ($pr->request_type === 'OFFICE_SUPPLIES' ? 'طلب مستلزمات مكتبية' : 'طلب مواد مشروعات'),
                'subtitle' => $isReturned ? 'طلب مُعاد إليك للتعديل' : ($isRejected ? 'طلب مرفوض يحتاج مراجعة أو تعديل' : 'مسودة لم تُرسل بعد'),
                'department' => $pr->department?->name,
                'amount' => $pr->total_estimated_cost ? (float) $pr->total_estimated_cost : null,
                'urgency' => ($isReturned || $isRejected) ? 'HIGH' : 'NORMAL',
                'reason' => $isReturned
                    ? 'تمت إعادة الطلب إليك للمراجعة والتعديل قبل إعادة الإرسال'
                    : ($isRejected ? ($pr->rejection_reason ?: 'تم رفض الطلب ويحتاج التعديل أو المراجعة') : 'مسودة لم تُرسل بعد للمراجعة والاعتماد'),
                'notes' => $pr->notes,
                'purpose' => $pr->notes,
                'actionUrl' => "/employee/requests/{$pr->id}/edit",
                'actionLabel' => ($isReturned || $isRejected) ? 'تعديل وإعادة الإرسال' : 'فتح وتعديل المسودة',
                'stageBadge' => [
                    'text' => $isReturned ? 'طلب مُعاد' : ($isRejected ? 'طلب مرفوض' : 'مسودة طلب'),
                    'icon' => $isReturned ? '↩️' : ($isRejected ? '❌' : '✏️'),
                    'className' => $isReturned
                        ? 'bg-amber-950/80 text-amber-300 border-amber-800/60'
                        : ($isRejected ? 'bg-rose-950/80 text-rose-300 border-rose-800/60' : 'bg-slate-800 text-slate-300 border-slate-700'),
                ],
                'created_at' => $pr->created_at?->toISOString(),
                'timeAgo' => $pr->created_at?->format('Y-m-d H:i'),
                'request_type' => $pr->request_type,
                'date_needed' => $pr->date_needed,
                'priority' => $pr->priority,
                'parcel_number' => $pr->items->first()?->item_reference,
                'region' => $pr->items->first()?->region,
                'items_count' => $pr->items->count(),
                'items_list' => $pr->items->map(fn ($it) => [
                    'description' => $it->item_description ?: ($it->item?->name ?: 'صنف'),
                    'quantity' => (float) $it->quantity,
                    'uom' => $it->uom,
                    'parcel' => $it->item_reference,
                    'region' => $it->region,
                ])->values()->all(),
            ]);
        }

        // Sync direct site receipts & office receipts for this user if assigned
        try {
            $this->receiptService->syncPendingDirectSiteReceiptsForEngineer($user);
            $this->receiptService->syncPendingOfficeReceiptsForRequester($user);
        } catch (\Throwable) {}

        // 1.5. Office Supplies Requester: Pending Receipt Confirmation Tasks
        // When an office supplies PO is issued, if no pending/approved receipt was generated yet,
        // show this task pointing to confirmation.
        $pendingOfficeOrders = PurchaseOrder::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
            ->with(['purchaseRequest.department', 'purchaseRequest.requester', 'supplier', 'items'])
            ->whereIn('status', ['ISSUED', 'APPROVED_BY_ACCOUNTING', 'PENDING_ACCOUNTING_REVIEW'])
            ->whereHas('purchaseRequest', function ($prQ) use ($user) {
                $prQ->where('user_id', $user->id)
                    ->where('request_type', 'OFFICE_SUPPLIES');
            })
            ->whereDoesntHave('receipts', function ($rQ) {
                $rQ->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED']);
            })
            ->orderByDesc('updated_at')
            ->get();

        foreach ($pendingOfficeOrders as $po) {
            $pr = $po->purchaseRequest;
            $tasks->push([
                'id' => "po-office-{$po->id}",
                'rawId' => $po->id,
                'type' => 'OFFICE_RECEIPT',
                'code' => $po->po_number,
                'title' => "تأكيد استلام المستلزمات المكتبية لأمر الشراء {$po->po_number}",
                'subtitle' => $pr ? "الطلب {$pr->request_number} — " . ($po->supplier?->company_name ?: 'المورد') : ($po->supplier?->company_name ?: 'المورد'),
                'department' => $pr?->department?->name,
                'supplier' => $po->supplier?->company_name,
                'amount' => $po->grand_total ? (float) $po->grand_total : null,
                'urgency' => 'HIGH',
                'reason' => 'تم إصدار أمر الشراء وبانتظار تأكيد استلام الأصناف المكتبية في المقر لإحالتها لأمر الشراء الفعلي تمهيداً للحسابات',
                'actionUrl' => "/requests/{$pr->id}?confirm_office_po={$po->id}",
                'actionLabel' => 'تأكيد استلام المستلزمات المكتبية',
                'stageBadge' => [
                    'text' => 'استلام مستلزمات مكتبية',
                    'icon' => '📦',
                    'className' => 'bg-indigo-950/80 text-indigo-300 border-indigo-800/60 ring-1 ring-indigo-500/40',
                ],
                'purchase_order_id' => $po->id,
                'purchase_request_id' => $pr?->id,
                'document_id' => $po->id,
                'document_number' => $po->po_number,
                'action_owner_id' => $user->id,
                'requester_id' => $pr?->user_id,
                'request_type' => 'OFFICE_SUPPLIES',
                'items_count' => $po->items->count(),
                'created_at' => $po->created_at?->toISOString(),
                'timeAgo' => $po->created_at?->format('Y-m-d H:i'),
                'items_list' => $po->items->map(fn ($it) => [
                    'description' => $it->item_description ?: 'صنف مكتبي',
                    'quantity' => (float) $it->quantity,
                    'uom' => $it->uom,
                    'parcel' => $it->item_reference,
                    'region' => $it->region,
                ])->values()->all(),
            ]);
        }

        // 2. Site Engineer / Technical Field Receiver: Pending Inspection Receipts
        $assignedReceipts = PurchaseReceipt::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
            ->with([
                'supplier',
                'purchaseOrder.supplier',
                'purchaseOrder.purchaseRequest.department',
                'purchaseOrder.purchaseRequest.targetDepartment',
                'purchaseRequest.department',
                'purchaseRequest.targetDepartment',
                'items.purchaseOrderItem.item',
            ])
            ->where(function ($q) use ($user) {
                // Strict Action Ownership:
                // 1) Office supplies receipts: confirmed by requester / actual receiver
                $q->where(function ($officeQ) use ($user) {
                    $officeQ->where('receipt_type', 'REQUESTER_OFFICE')
                        ->where(function ($sub) use ($user) {
                            $sub->where('receiver_user_id', $user->id)
                                ->orWhere('actual_receiver_user_id', $user->id)
                                ->orWhereHas('purchaseRequest', fn ($prQ) => $prQ->where('user_id', $user->id))
                                ->orWhereHas('purchaseOrder.purchaseRequest', fn ($prQ) => $prQ->where('user_id', $user->id));
                        });
                })
                // 2) Field/site receipts: strictly the assigned site engineer or receiver
                ->orWhere(function ($siteQ) use ($user) {
                    $siteQ->where('receipt_type', '!=', 'REQUESTER_OFFICE')
                        ->where(function ($sub) use ($user) {
                            $sub->where('site_engineer_user_id', $user->id)
                                ->orWhere('receiver_user_id', $user->id);
                        });
                });
            })
            ->whereIn('status', ['PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED'])
            ->orderByDesc('created_at')
            ->get();

        foreach ($assignedReceipts as $r) {
            $isOfficeReceipt = $r->receipt_type === 'REQUESTER_OFFICE';
            $tasks->push([
                'id' => "receipt-{$r->id}",
                'rawId' => $r->id,
                'type' => 'RECEIPT',
                'code' => $r->receipt_number,
                'title' => $isOfficeReceipt
                    ? ($r->purchaseOrder?->items?->first()?->item_description ?: "استلام مستلزمات مكتبية {$r->receipt_number}")
                    : ($r->purchaseOrder?->items?->first()?->item_description ?: "إذن استلام {$r->receipt_number}"),
                'subtitle' => $r->purchaseOrder ? "لأمر الشراء {$r->purchaseOrder->po_number}" : null,
                'department' => $r->purchaseRequest?->department?->name ?: $r->purchaseOrder?->purchaseRequest?->department?->name,
                'supplier' => $r->purchaseOrder?->supplier?->company_name ?: $r->supplier?->company_name,
                'urgency' => 'CRITICAL',
                'reason' => $isOfficeReceipt
                    ? 'تم توريد المستلزمات المكتبية وبانتظار فحصك وتأكيدك واعتمادك لإذن الاستلام وتعديل الكميات'
                    : 'تم استلام المواد وبانتظار معاينتك وفحصك الميداني/الهندسي واعتماد الاستلام بالموقع',
                'actionUrl' => "/site-engineer?receipt_id={$r->id}",
                'actionLabel' => $isOfficeReceipt ? 'فحص وتأكيد استلام المستلزمات' : 'فحص واعتماد إذن الاستلام',
                'stageBadge' => $isOfficeReceipt ? [
                    'text' => 'استلام مستلزمات مكتبية',
                    'icon' => '🏢',
                    'className' => 'bg-indigo-950/80 text-indigo-300 border-indigo-800/60 ring-1 ring-indigo-500/40',
                ] : [
                    'text' => 'إذن استلام مواد',
                    'icon' => '📦',
                    'className' => 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60',
                ],
                'created_at' => $r->created_at?->toISOString(),
                'timeAgo' => $r->created_at?->format('Y-m-d H:i'),
                'items_count' => $r->items->count(),
                'items_list' => $r->items->map(fn ($it) => [
                    'description' => $it->purchaseOrderItem?->item_description ?: ($it->purchaseOrderItem?->item?->name ?: 'بند استلام'),
                    'quantity' => (float) $it->received_quantity,
                    'uom' => $it->purchaseOrderItem?->uom,
                    'parcel' => $it->purchaseOrderItem?->item_reference,
                ])->values()->all(),
            ]);
        }

        // 3. Reviewer: Pending Purchase Requests, Quotes & Complementary Requests
        if ($user->hasRole('reviewer') || $user->hasPermission('purchase_request.review')) {
            $reviewablePrs = $this->reviewerService->getReviewableRequests($user);
            foreach ($reviewablePrs as $pr) {
                if (in_array($pr->status, ['SUBMITTED', 'UNDER_REVIEW'], true)) {
                    $isSupplement = $pr->isComplementaryRequest();

                    $tasks->push([
                        'id' => "pr-{$pr->id}",
                        'rawId' => $pr->id,
                        'type' => 'PR',
                        'code' => $pr->request_number,
                        'title' => $isSupplement
                            ? ($pr->justification ? "⚡ طلب كمالة: {$pr->justification}" : '⚡ طلب كمالة عاجل')
                            : ($pr->justification ?: ($pr->request_type === 'OFFICE_SUPPLIES' ? 'طلب مستلزمات مكتبية' : 'طلب مواد مشروعات')),
                        'subtitle' => $isSupplement
                            ? 'طلب كمالة ينتقل مباشرة لمدير المشتريات فور الاعتماد الفني (تخطي المسار المالي والتنفيذي)'
                            : 'طلب شراء جديد بانتظار المراجعة الفنية',
                        'department' => $pr->department?->name,
                        'requester' => $pr->requester?->name,
                        'urgency' => $isSupplement || $pr->priority === 'HIGH' || $pr->priority === 'URGENT' ? 'CRITICAL' : 'HIGH',
                        'reason' => $isSupplement
                            ? 'طلب كمالة عاجل بانتظار مراجعتك واعتمادك الفني للانتقال الفوري إلى مدير المشتريات ⚡'
                            : ($pr->status === 'SUBMITTED' ? 'طلب جديد مقدم بانتظار مراجعتك واعتمادك الفني' : 'طلب قيد المراجعة الفنية'),
                        'notes' => $pr->notes,
                        'purpose' => $pr->notes,
                        'next_actor' => $isSupplement
                            ? 'مدير المشتريات (تنفيذ فوري مباشر دون مالية أو تنفيذي)'
                            : 'المدير العام للاعتماد النهائي',
                        'actionUrl' => "/reviewer/requests/{$pr->id}/review",
                        'actionLabel' => 'مراجعة وتعديل الطلب',
                        'stageBadge' => $isSupplement ? [
                            'text' => 'طلب كمالة عاجل',
                            'icon' => '⚡',
                            'className' => 'bg-purple-950/80 text-purple-300 border-purple-800/60 ring-1 ring-purple-500/50',
                        ] : [
                            'text' => 'مراجعة فنية',
                            'icon' => '📋',
                            'className' => 'bg-cyan-950/80 text-cyan-300 border-cyan-800/60',
                        ],
                        'created_at' => $pr->created_at?->toISOString(),
                        'timeAgo' => $pr->created_at?->format('Y-m-d H:i'),
                        'request_type' => $pr->request_type,
                        'priority' => $pr->priority,
                        'items_count' => $pr->items->count(),
                        'items_list' => $pr->items->map(fn ($it) => [
                            'description' => $it->item_description ?: ($it->item?->name ?: 'صنف'),
                            'quantity' => (float) $it->quantity,
                            'uom' => $it->uom,
                            'parcel' => $it->item_reference,
                            'region' => $it->region,
                        ])->values()->all(),
                    ]);
                }
            }

            // Reviewer: Complementary Requests (طلبات الكمالة بانتظار المراجعة الفنية وتحديد الاستلام)
            $supplementQuery = PurchaseRequestSupplement::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                ->with([
                    'purchaseRequest.department',
                    'purchaseRequest.targetDepartment',
                    'purchaseRequest.requester',
                    'requester',
                    'items.item',
                ])
                ->where('status', 'SUBMITTED');

            if (! $user->hasRole('admin')) {
                $supplementQuery->whereHas('purchaseRequest', function ($prQ) use ($user) {
                    $prQ->where(function ($scopeQuery) use ($user) {
                        $scopeQuery->where('reviewer_user_id', $user->id)
                            ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));

                        if (! $user->hasRole('execution_manager')) {
                            $scopeQuery->orWhereHas('targetDepartment', fn ($dq) => $dq->where('manager_user_id', $user->id))
                                ->orWhere(function ($deptQ) use ($user) {
                                    $deptQ->whereNull('target_department_id')
                                          ->whereHas('department', fn ($dq) => $dq->where('manager_user_id', $user->id));
                                });

                            if ($user->hasRole('reviewer') && $user->department_id) {
                                $scopeQuery->orWhere('target_department_id', $user->department_id)
                                           ->orWhere(function ($fallbackDept) use ($user) {
                                               $fallbackDept->whereNull('target_department_id')
                                                            ->where('department_id', $user->department_id);
                                           });
                            }
                        }
                    });
                });
            }

            $pendingSupplements = $supplementQuery->orderByDesc('created_at')->get();

            foreach ($pendingSupplements as $sup) {
                $pr = $sup->purchaseRequest;
                $tasks->push([
                    'id' => "supplement-{$sup->id}",
                    'rawId' => $sup->id,
                    'type' => 'SUPPLEMENT',
                    'code' => ($pr?->request_number ?: "PR-{$sup->purchase_request_id}") . " (كمالة #{$sup->batch_number})",
                    'title' => "طلب كمالة جديد (دفعة #{$sup->batch_number}) — " . ($pr?->request_number ?: 'طلب شراء'),
                    'subtitle' => $sup->notes ?: 'بنود إضافية ملحقة بطلب الشراء تنتظر مراجعتك واعتمادك الفني',
                    'department' => $pr?->department?->name ?: $pr?->targetDepartment?->name,
                    'requester' => $sup->requester?->name ?: $pr?->requester?->name,
                    'urgency' => 'CRITICAL',
                    'reason' => 'طلب كمالة جديد (دفعة إضافية) مقدم بانتظار مراجعتك واعتمادك الفني وتحديد مسؤول الاستلام',
                    'actionUrl' => "/requests/supplements?expand_pr={$sup->purchase_request_id}&supplement_id={$sup->id}",
                    'actionLabel' => 'مراجعة واعتماد الكمالة',
                    'stageBadge' => [
                        'text' => 'كمالة عاجلة',
                        'icon' => '➕',
                        'className' => 'bg-purple-950/80 text-purple-300 border-purple-800/60',
                    ],
                    'created_at' => $sup->created_at?->toISOString(),
                    'timeAgo' => $sup->created_at?->format('Y-m-d H:i'),
                    'items_count' => $sup->items->count(),
                    'items_list' => $sup->items->map(fn ($it) => [
                        'description' => $it->item_description ?: ($it->item?->name ?: 'صنف كمالة'),
                        'quantity' => (float) $it->quantity,
                        'uom' => $it->uom,
                        'parcel' => $it->item_reference,
                        'region' => $it->region,
                    ])->values()->all(),
                ]);
            }

            // Quotes pending recommendations
            try {
                $quotePrs = $this->procurementService->getPendingQuoteRequests(50, $user);
            } catch (\Throwable) {
                $quotePrs = collect();
            }
            foreach ($quotePrs as $q) {
                if ($q->status === 'PENDING_QUOTE_RECOMMENDATIONS') {
                    $tasks->push([
                        'id' => "quote-{$q->id}",
                        'rawId' => $q->id,
                        'type' => 'QUOTE',
                        'code' => $q->request_number,
                        'title' => $q->justification ?: 'عروض أسعار بانتظار الترشيح',
                        'subtitle' => 'عروض أسعار مسجلة من الموردين',
                        'department' => $q->department?->name,
                        'requester' => $q->requester?->name,
                        'amount' => $q->total_estimated_cost ? (float) $q->total_estimated_cost : null,
                        'urgency' => 'HIGH',
                        'reason' => 'عروض أسعار مسجلة بانتظار التوصية الفنية لاختيار العرض الأنسب',
                        'notes' => $q->notes,
                        'purpose' => $q->notes,
                        'actionUrl' => "/reviewer/purchase-quotes?open={$q->id}",
                        'actionLabel' => 'البت وترشيح عروض الأسعار',
                        'stageBadge' => [
                            'text' => 'ترشيح أسعار',
                            'icon' => '⚖️',
                            'className' => 'bg-amber-950/80 text-amber-300 border-amber-800/60',
                        ],
                        'created_at' => $q->created_at?->toISOString(),
                        'timeAgo' => $q->created_at?->format('Y-m-d H:i'),
                        'items_count' => $q->items->count(),
                        'items_list' => $q->items->map(fn ($it) => [
                            'description' => $it->item_description ?: ($it->item?->name ?: 'صنف'),
                            'quantity' => (float) $it->quantity,
                            'uom' => $it->uom,
                            'parcel' => $it->item_reference,
                            'region' => $it->region,
                        ])->values()->all(),
                    ]);
                }
            }
        }

        // 4. Procurement Manager: Actual POs & Returned POs
        if ($user->hasRole('procurement_manager') || $user->hasPermission('purchase_order.create')) {
            $pendingActualPos = PurchaseOrder::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                ->with(['supplier', 'items'])
                ->where('status', 'PENDING_ACTUAL_PO')
                ->orderByDesc('updated_at')
                ->get();

            foreach ($pendingActualPos as $po) {
                $tasks->push([
                    'id' => "po-actual-{$po->id}",
                    'rawId' => $po->id,
                    'type' => 'PO',
                    'code' => $po->po_number,
                    'title' => "إذن الاستلام معتمد — مطلوب إصدار أمر الشراء الفعلي ({$po->supplier?->company_name})",
                    'subtitle' => 'الموقع أتم الاستلام — يرجى مطابقة الأسعار والكميات لإصدار الأمر الفعلي',
                    'department' => $po->department?->name,
                    'supplier' => $po->supplier?->company_name,
                    'amount' => (float) $po->grand_total,
                    'urgency' => 'CRITICAL',
                    'reason' => 'تم استلام البضاعة واعتماد إذن الاستلام بالموقع — بانتظار إصدار الأمر الفعلي للمالية.',
                    'actionUrl' => "/procurement/purchase-orders/{$po->id}/edit",
                    'actionLabel' => 'إصدار أمر الشراء الفعلي',
                    'created_at' => $po->created_at?->toISOString(),
                    'timeAgo' => $po->created_at?->format('Y-m-d H:i'),
                    'items_count' => $po->items->count(),
                ]);
            }

            $returnedPos = PurchaseOrder::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                ->with(['supplier', 'items'])
                ->where('status', 'RETURNED_TO_PROCUREMENT')
                ->orderByDesc('updated_at')
                ->get();

            foreach ($returnedPos as $po) {
                $tasks->push([
                    'id' => "po-ret-{$po->id}",
                    'rawId' => $po->id,
                    'type' => 'PO',
                    'code' => $po->po_number,
                    'title' => "أمر شراء معاد — {$po->supplier?->company_name}",
                    'subtitle' => 'معاد من الإدارة أو الحسابات لإعادة التدقيق والمراجعة',
                    'department' => $po->department?->name,
                    'supplier' => $po->supplier?->company_name,
                    'amount' => (float) $po->grand_total,
                    'urgency' => 'CRITICAL',
                    'reason' => 'أمر شراء معاد يتطلب التعديل والمراجعة قبل إعادة الإرسال',
                    'actionUrl' => "/procurement/purchase-orders/{$po->id}/edit",
                    'actionLabel' => 'تعديل وإعادة إرسال الأمر',
                    'created_at' => $po->created_at?->toISOString(),
                    'timeAgo' => $po->created_at?->format('Y-m-d H:i'),
                    'items_count' => $po->items->count(),
                ]);
            }
        }

        // 5. Executive / General Manager
        if ($user->hasRole('general_manager') || $user->hasRole('execution_manager')) {
            $execQuery = PurchaseRequest::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                ->with(['department', 'requester'])
                ->where('status', 'PENDING_EXECUTIVE_APPROVAL')
                ->where(function ($q) {
                    $q->whereNull('request_type')->orWhere('request_type', '!=', 'COMPLEMENTARY');
                });

            if ($user->hasRole('execution_manager')) {
                $execQuery->where(function ($q) use ($user) {
                    $q->where('reviewer_user_id', $user->id)
                      ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));
                });
            } elseif (! $user->hasRole('admin')) {
                $execQuery->where(function ($q) {
                    $q->whereDoesntHave('requester.manager.roles', fn ($mq) => $mq->where('slug', 'execution_manager'))
                      ->whereDoesntHave('assignedReviewer.roles', fn ($rq) => $rq->where('slug', 'execution_manager'));
                });
            }

            $execPrs = $execQuery->orderByDesc('created_at')->get();

            foreach ($execPrs as $pr) {
                $tasks->push([
                    'id' => "pr-exec-{$pr->id}",
                    'rawId' => $pr->id,
                    'type' => 'PR',
                    'code' => $pr->request_number,
                    'title' => $pr->justification ?: 'طلب شراء بانتظار الاعتماد التنفيذي',
                    'subtitle' => 'يتطلب قرارك التنفيذي النهائي',
                    'department' => $pr->department?->name,
                    'requester' => $pr->requester?->name,
                    'amount' => $pr->total_estimated_cost ? (float) $pr->total_estimated_cost : null,
                    'urgency' => 'CRITICAL',
                    'reason' => 'طلب شراء معتمد بانتظار قرارك التنفيذي النهائي',
                    'notes' => $pr->notes,
                    'purpose' => $pr->notes,
                    'actionUrl' => "/general-manager/purchase-requests?open={$pr->id}&view=items_only",
                    'actionLabel' => 'اعتماد أو رفض الطلب',
                    'created_at' => $pr->created_at?->toISOString(),
                    'timeAgo' => $pr->created_at?->format('Y-m-d H:i'),
                    'items_count' => $pr->items->count(),
                ]);
            }

            $quoteQuery = PurchaseRequest::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                ->with(['department', 'requester'])
                ->where('status', 'PENDING_EXECUTIVE_QUOTE_DECISION');

            if ($user->hasRole('execution_manager')) {
                $quoteQuery->where(function ($q) use ($user) {
                    $q->where('reviewer_user_id', $user->id)
                      ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));
                });
            } elseif (! $user->hasRole('admin')) {
                $quoteQuery->where(function ($q) {
                    $q->whereDoesntHave('requester.manager.roles', fn ($mq) => $mq->where('slug', 'execution_manager'))
                      ->whereDoesntHave('assignedReviewer.roles', fn ($rq) => $rq->where('slug', 'execution_manager'));
                });
            }

            $execQuotes = $quoteQuery->orderByDesc('created_at')->get();

            foreach ($execQuotes as $pr) {
                $tasks->push([
                    'id' => "quote-exec-{$pr->id}",
                    'rawId' => $pr->id,
                    'type' => 'QUOTE',
                    'code' => $pr->request_number,
                    'title' => $pr->justification ?: 'عروض أسعار بانتظار الاعتماد التنفيذي',
                    'subtitle' => 'عروض أسعار موصى بها بانتظار الترسية',
                    'department' => $pr->department?->name,
                    'requester' => $pr->requester?->name,
                    'urgency' => 'CRITICAL',
                    'reason' => 'عروض أسعار موصى بها بانتظار اعتماد الترسية التنفيذية',
                    'notes' => $pr->notes,
                    'purpose' => $pr->notes,
                    'actionUrl' => "/general-manager/purchase-quotes?open={$pr->id}",
                    'actionLabel' => 'البت والاعتماد التنفيذي',
                    'created_at' => $pr->created_at?->toISOString(),
                    'timeAgo' => $pr->created_at?->format('Y-m-d H:i'),
                ]);
            }
        }

        // 6. Accounting: Approved Receipts Pending Invoice Registration & Invoices Pending 3-Way Match
        $isAccountant = $user->hasRole('general_accountant')
            || $user->hasRole('site_accountant')
            || $user->hasRole('development_accountant')
            || $user->hasRole('licenses_accountant')
            || $user->hasRole('buffet_accountant')
            || $user->isGeneralAccountant();

        if ($isAccountant) {
            $allowedCodes = $this->invoiceService->getAllowedDepartmentCodesForAccountant($user);
            $primaryRole = $user->hasRole('general_accountant')
                ? 'general_accountant'
                : ($user->roles->first()?->slug ?? 'accountant');

            // 6.1 Approved Receipts pending invoice recording / accounting action
            $pendingReceiptsQuery = PurchaseReceipt::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                ->with([
                    'purchaseOrder.supplier',
                    'purchaseOrder.purchaseRequest.department',
                    'purchaseRequest.department',
                    'items.purchaseOrderItem',
                ])
                ->where('status', 'APPROVED')
                ->whereNull('accountant_recorded_at')
                ->whereDoesntHave('supplierInvoices', function ($iq) {
                    $iq->whereNotIn('status', ['VOIDED', 'CANCELLED']);
                })
                ->where(function ($query) {
                    $internalSupplier = \App\Models\Supplier::getOrCreateInternalWarehouseSupplier();
                    $query->where(function ($nonWhQuery) use ($internalSupplier) {
                        $nonWhQuery->where('supplier_id', '!=', $internalSupplier->id)
                                   ->whereHas('purchaseOrder', function ($poQ) use ($internalSupplier) {
                                       $poQ->where('supplier_id', '!=', $internalSupplier->id)
                                           ->whereDoesntHave('purchaseRequest', function ($prQ) {
                                               $prQ->where('request_type', 'OFFICE_SUPPLIES');
                                           });
                                   });
                    })->orWhereHas('purchaseOrder', function ($poQuery) {
                        $poQuery->where('status', '!=', 'PENDING_ACTUAL_PO')
                            ->where(function ($q) {
                                $q->whereNotNull('finalized_at')
                                  ->orWhereIn('status', ['ISSUED', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED']);
                            });
                    });
                });

            // Department filter for restricted department accountants
            if ($allowedCodes !== null) {
                $pendingReceiptsQuery->where(function ($q) use ($allowedCodes) {
                    $q->whereHas('purchaseOrder.purchaseRequest.department', fn ($dq) => $dq->whereIn('code', $allowedCodes))
                      ->orWhereHas('purchaseRequest.department', fn ($dq) => $dq->whereIn('code', $allowedCodes));
                });
            }

            $pendingReceipts = $pendingReceiptsQuery->orderByDesc('created_at')->limit(50)->get();

            foreach ($pendingReceipts as $rc) {
                $dept = $rc->purchaseOrder?->purchaseRequest?->department ?: $rc->purchaseRequest?->department;
                $deptCode = $dept?->code;
                $po = $rc->purchaseOrder;
                $pr = $po?->purchaseRequest ?: $rc->purchaseRequest;

                $tasks->push([
                    'id' => "acct-receipt-{$rc->id}",
                    'rawId' => $rc->id,
                    'type' => 'ACCOUNTING_RECEIPT',
                    'action_type' => 'RECORD_SUPPLIER_INVOICE',
                    'code' => $rc->receipt_number,
                    'document_number' => $rc->receipt_number,
                    'document_type' => 'PURCHASE_RECEIPT',
                    'document_id' => $rc->id,
                    'title' => "إذن استلام معتمد جاهز لتسجيل الفاتورة ({$rc->receipt_number})",
                    'subtitle' => $po ? "لأمر الشراء {$po->po_number} — " . ($po->supplier?->company_name ?: 'المورد') : ($rc->supplier?->company_name ?: 'المورد'),
                    'department' => $dept?->name,
                    'department_scope' => $deptCode,
                    'department_id' => $dept?->id,
                    'department_code' => $deptCode,
                    'department_name' => $dept?->name,
                    'action_owner_id' => $user->id,
                    'action_owner_role' => $primaryRole,
                    'current_status' => 'PENDING',
                    'current_stage' => 'ACCOUNTING',
                    'request_id' => $pr?->id,
                    'purchase_request_id' => $pr?->id,
                    'purchase_order_id' => $po?->id,
                    'actual_po_id' => ($po?->is_actual_po || $po?->finalized_at) ? $po->id : null,
                    'actual_po_number' => ($po?->is_actual_po || $po?->finalized_at) ? $po->po_number : null,
                    'actual_purchase_order_id' => ($po?->is_actual_po || $po?->finalized_at) ? $po->id : null,
                    'project' => $pr?->project_name ?? null,
                    'region' => $pr?->items?->first()?->region ?? null,
                    'land_plot' => $pr?->items?->first()?->item_reference ?? null,
                    'supplier' => $po?->supplier?->company_name ?: $rc->supplier?->company_name,
                    'urgency' => 'HIGH',
                    'reason' => 'تم اعتماد إذن الاستلام وبانتظار تسجيل فاتورة المورد واستكمال الدورة المحاسبية',
                    'actionUrl' => "/site-accountant?receipt_id={$rc->id}",
                    'action_url' => "/site-accountant?receipt_id={$rc->id}",
                    'actionLabel' => 'تسجيل فاتورة المورد',
                    'stageBadge' => [
                        'text' => 'الحسابات والتسجيل',
                        'icon' => '🧾',
                        'className' => 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60 ring-1 ring-emerald-500/40',
                    ],
                    'created_at' => $rc->created_at?->toISOString(),
                    'timeAgo' => $rc->created_at?->format('Y-m-d H:i'),
                ]);
            }

            // 6.2 Invoices pending 3-way matching
            $pendingInvoicesQuery = SupplierInvoice::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                ->with([
                    'supplier',
                    'purchaseOrder.purchaseRequest.department',
                ])
                ->whereNotIn('status', ['VOIDED', 'CANCELLED'])
                ->where(function ($iq) {
                    $iq->whereNull('matched_at')
                       ->orWhere('matching_status', '!=', 'MATCHED');
                });

            if ($allowedCodes !== null) {
                $pendingInvoicesQuery->whereHas('purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            }

            $pendingInvoices = $pendingInvoicesQuery->orderByDesc('created_at')->limit(50)->get();

            foreach ($pendingInvoices as $inv) {
                $dept = $inv->purchaseOrder?->purchaseRequest?->department;
                $deptCode = $dept?->code;
                $po = $inv->purchaseOrder;
                $pr = $po?->purchaseRequest;

                $tasks->push([
                    'id' => "acct-invoice-{$inv->id}",
                    'rawId' => $inv->id,
                    'type' => 'ACCOUNTING_INVOICE',
                    'action_type' => 'THREE_WAY_MATCH',
                    'code' => $inv->invoice_number ?: "INV-{$inv->id}",
                    'document_number' => $inv->invoice_number ?: "INV-{$inv->id}",
                    'document_type' => 'SUPPLIER_INVOICE',
                    'document_id' => $inv->id,
                    'title' => "فاتورة مورد بانتظار المطابقة الثلاثية (" . ($inv->invoice_number ?: "INV-{$inv->id}") . ")",
                    'subtitle' => $po ? "لأمر الشراء {$po->po_number} — " . ($inv->supplier?->company_name ?: 'المورد') : ($inv->supplier?->company_name ?: 'المورد'),
                    'department' => $dept?->name,
                    'department_scope' => $deptCode,
                    'department_id' => $dept?->id,
                    'department_code' => $deptCode,
                    'department_name' => $dept?->name,
                    'action_owner_id' => $user->id,
                    'action_owner_role' => $primaryRole,
                    'current_status' => 'PENDING',
                    'current_stage' => 'ACCOUNTING',
                    'request_id' => $pr?->id,
                    'purchase_request_id' => $pr?->id,
                    'purchase_order_id' => $po?->id,
                    'actual_po_id' => ($po?->is_actual_po || $po?->finalized_at) ? $po->id : null,
                    'actual_po_number' => ($po?->is_actual_po || $po?->finalized_at) ? $po->po_number : null,
                    'actual_purchase_order_id' => ($po?->is_actual_po || $po?->finalized_at) ? $po->id : null,
                    'project' => $pr?->project_name ?? null,
                    'region' => $pr?->items?->first()?->region ?? null,
                    'land_plot' => $pr?->items?->first()?->item_reference ?? null,
                    'amount' => (float) $inv->amount,
                    'supplier' => $inv->supplier?->company_name,
                    'urgency' => 'CRITICAL',
                    'reason' => 'فاتورة مسجلة بانتظار إجراء المطابقة الثلاثية (أمر الشراء + إذن الاستلام + الفاتورة)',
                    'actionUrl' => "/site-accountant?invoice_id={$inv->id}",
                    'action_url' => "/site-accountant?invoice_id={$inv->id}",
                    'actionLabel' => 'إجراء المطابقة الثلاثية',
                    'stageBadge' => [
                        'text' => 'مطابقة ثلاثية',
                        'icon' => '⚖️',
                        'className' => 'bg-amber-950/80 text-amber-300 border-amber-800/60 ring-1 ring-amber-500/40',
                    ],
                    'created_at' => $inv->created_at?->toISOString(),
                    'timeAgo' => $inv->created_at?->format('Y-m-d H:i'),
                ]);
            }
        }

        // 7. Material Transfer Requests: Requester (Returned), Reviewer (Pending), Accountant (Pending)
        // A) Requester: Returned transfer requests needing edit
        $returnedMtrs = \App\Models\MaterialTransferRequest::with('items')
            ->where('user_id', $user->id)
            ->where('status', \App\Models\MaterialTransferRequest::STATUS_RETURNED)
            ->get();
        foreach ($returnedMtrs as $mtr) {
            $tasks->push([
                'id' => "mtr-returned-{$mtr->id}",
                'rawId' => $mtr->id,
                'type' => 'MATERIAL_TRANSFER',
                'code' => $mtr->request_number,
                'title' => "طلب نقل خامات ({$mtr->request_number}): من {$mtr->from_project} إلى {$mtr->to_project}",
                'subtitle' => 'طلب نقل خامات مُعاد للتعديل من المراجع',
                'urgency' => 'HIGH',
                'reason' => $mtr->return_reason ?: 'تمت إعادة الطلب إليك للمراجعة والتعديل قبل إعادة الإرسال',
                'actionUrl' => "/material-transfers/{$mtr->id}/edit",
                'actionLabel' => 'تعديل وإعادة الإرسال',
                'created_at' => $mtr->created_at?->toISOString(),
                'timeAgo' => $mtr->created_at?->format('Y-m-d H:i'),
                'items_count' => $mtr->items->count(),
            ]);
        }

        // B) Reviewer: Requests waiting for review
        if ($user->hasRole('reviewer') || $user->hasAnyRole(['admin', 'general_manager', 'execution_manager'])) {
            $pendingReviewMtrs = \App\Models\MaterialTransferRequest::with(['user', 'items'])
                ->where('status', \App\Models\MaterialTransferRequest::STATUS_PENDING_REVIEWER)
                ->assignedToReviewer($user)
                ->get();
            foreach ($pendingReviewMtrs as $mtr) {
                $tasks->push([
                    'id' => "mtr-review-{$mtr->id}",
                    'rawId' => $mtr->id,
                    'type' => 'MATERIAL_TRANSFER',
                    'code' => $mtr->request_number,
                    'title' => "طلب نقل خامات ({$mtr->request_number}): من {$mtr->from_project} إلى {$mtr->to_project}",
                    'subtitle' => 'طلب نقل خامات بانتظار مراجعتك واعتمادك',
                    'requester' => $mtr->user?->name,
                    'urgency' => 'HIGH',
                    'reason' => 'طلب نقل خامات جديد بانتظار المراجعة والاعتماد أو الرفض أو الإعادة للتعديل',
                    'actionUrl' => '/reviewer/material-transfers',
                    'actionLabel' => 'مراجعة واعتماد الطلب',
                    'created_at' => $mtr->created_at?->toISOString(),
                    'timeAgo' => $mtr->created_at?->format('Y-m-d H:i'),
                    'items_count' => $mtr->items->count(),
                ]);
            }
        }

        // C) Accountant: Requests waiting for accounting action & archiving
        if ($user->hasAnyRole(['accountant', 'site_accountant', 'general_accountant', 'admin'])) {
            $pendingAcctMtrs = \App\Models\MaterialTransferRequest::with(['user', 'reviewer', 'items'])
                ->where('status', \App\Models\MaterialTransferRequest::STATUS_PENDING_ACCOUNTING)
                ->get();
            foreach ($pendingAcctMtrs as $mtr) {
                $tasks->push([
                    'id' => "mtr-acct-{$mtr->id}",
                    'rawId' => $mtr->id,
                    'type' => 'MATERIAL_TRANSFER',
                    'code' => $mtr->request_number,
                    'title' => "طلب نقل خامات ({$mtr->request_number}): من {$mtr->from_project} إلى {$mtr->to_project}",
                    'subtitle' => 'طلب نقل خامات معتمد بانتظار الإجراء المحاسبي والأرشفة',
                    'requester' => $mtr->user?->name,
                    'urgency' => 'HIGH',
                    'reason' => 'تم اعتماد الطلب فنيًا وبانتظار التوجيه المحاسبي وإتمام الأرشفة في أرشيف المنقولات',
                    'actionUrl' => '/accounting/material-transfers',
                    'actionLabel' => 'معالجة وأرشفة الطلب',
                    'created_at' => $mtr->created_at?->toISOString(),
                    'timeAgo' => $mtr->created_at?->format('Y-m-d H:i'),
                    'items_count' => $mtr->items->count(),
                ]);
            }
        }

        // Sort newest first & deduplicate by task id
        $sorted = $tasks->unique('id')->sortByDesc(fn ($t) => $t['created_at'] ?? '')->values();

        return response()->json([
            'count' => $sorted->count(),
            'data' => $sorted->all(),
        ]);
    }
}
