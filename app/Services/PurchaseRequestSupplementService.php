<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\PurchaseRequestSupplement;
use App\Models\Supplier;
use App\Models\User;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class PurchaseRequestSupplementService
{
    public function __construct(
        protected PurchaseOrderService $poService,
        protected NotificationService $notificationService,
    ) {}

    /**
     * Get paginated requests eligible for a supplement ('طلب كمالة').
     * Conditions:
     * 1. Requisition is active/approved/issued.
     * 2. Requisition has NOT been fully received / has NO approved receipt by warehouse or site engineer.
     * 3. Scoped by user role/department.
     */
    public function getEligibleRequests(User $user, int $perPage = 15): LengthAwarePaginator
    {
        $query = PurchaseRequest::with([
            'requester',
            'department',
            'targetDepartment',
            'assignedReviewer',
            'directSupplier',
            'selectedQuote.supplier',
            'purchaseOrders.supplier',
            'supplements.items',
            'items.item',
        ])
            ->where(function ($q) {
                $q->whereIn('status', [
                    'APPROVED_BY_REVIEWER',
                    'APPROVED_BY_GM',
                    'PO_ISSUED',
                    'ISSUED',
                    'ACCOUNTING_APPROVED',
                    'APPROVED_BY_ACCOUNTING',
                    'APPROVED_BY_PROCUREMENT',
                    'PENDING_PROCUREMENT_APPROVAL',
                    'PENDING_EXECUTIVE_APPROVAL',
                ])
                    ->orWhereHas('purchaseOrders');
            })
            // Exclude requests where materials have already been received at the site/warehouse
            ->whereDoesntHave('purchaseOrders.receipts', function ($q) {
                $q->where('status', 'APPROVED');
            })
            ->whereDoesntHave('receipts', function ($q) {
                $q->where('status', 'APPROVED');
            });

        // Department and role scoping
        if ($user->hasRole('admin') || $user->hasRole('procurement_manager') || $user->hasRole('general_manager')) {
            // Can view all eligible requests across company
        } elseif ($user->hasRole('reviewer') || $user->hasRole('execution_manager')) {
            $userDeptId = $user->department_id;
            $query->where(function ($q) use ($user, $userDeptId) {
                $q->where('department_id', $userDeptId)
                    ->orWhere('target_department_id', $userDeptId)
                    ->orWhere('reviewer_user_id', $user->id)
                    ->orWhere('user_id', $user->id)
                    ->orWhereHas('approvalHistory', fn ($ah) => $ah->where('actor_user_id', $user->id))
                    ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));
            });
        } elseif ($user->hasRole('site_engineer')) {
            $query->where(function ($q) use ($user) {
                $q->where('site_engineer_user_id', $user->id)
                    ->orWhere('user_id', $user->id);
            });
        } else {
            // Employee sees own requests
            $query->where('user_id', $user->id);
        }

        return $query->orderByDesc('updated_at')->paginate($perPage);
    }

    /**
     * Create supplementary items on the same PurchaseRequest.
     */
    public function createSupplement(
        PurchaseRequest $pr,
        User $creator,
        array $itemsData,
        ?string $notes = null
    ): PurchaseRequestSupplement {
        $pr->loadMissing(['department', 'assignedReviewer', 'purchaseOrders.receipts']);

        // 1. Authorization check
        $isRequester = (int) $pr->user_id === (int) $creator->id;
        $isReviewer = (int) $pr->reviewer_user_id === (int) $creator->id
            || (int) $pr->department_id === (int) $creator->department_id
            || (int) $pr->target_department_id === (int) $creator->department_id;
        $isSiteEngineer = (int) $pr->site_engineer_user_id === (int) $creator->id
            || $creator->hasRole('site_engineer');
        $isManager = $creator->hasAnyRole(['admin', 'procurement_manager', 'execution_manager', 'general_manager']);

        if (! $isRequester && ! $isReviewer && ! $isManager && ! $isSiteEngineer) {
            throw new ValidationException(validator([], []), [
                'authorization' => ['غير مصرح لك بإنشاء طلب كمالة لهذا الطلب.'],
            ]);
        }

        // 2. Eligibility check
        if (! $pr->canAcceptSupplement()) {
            $hasApprovedReceipt = $pr->purchaseOrders()->whereHas('receipts', fn ($q) => $q->where('status', 'APPROVED'))->exists()
                || $pr->receipts()->where('status', 'APPROVED')->exists();
            $msg = $hasApprovedReceipt
                ? 'لا يمكن إنشاء طلب كمالة لهذا الطلب؛ لقد تم استلام الكمية في الموقع واعتماد الإذن نهائياً بالفعل.'
                : 'لا يمكن إنشاء طلب كمالة لهذا الطلب؛ الطلب غير معتمد أو غير سارٍ.';
            throw ValidationException::withMessages([
                'eligibility' => [$msg],
            ]);
        }

        if (empty($itemsData)) {
            throw ValidationException::withMessages([
                'items' => ['يجب إدخال بند واحد على الأقل في طلب الكمالة.'],
            ]);
        }

        return DB::transaction(function () use ($pr, $creator, $itemsData, $notes) {
            $nextBatch = ($pr->supplements()->max('batch_number') ?? 0) + 1;

            $isCreatorReviewer = $creator->hasRole('reviewer') || ((int) $pr->reviewer_user_id === (int) $creator->id);

            if ($isCreatorReviewer) {
                // If reviewer himself created the supplement, it is already approved by reviewer
                $status = 'PENDING_PROCUREMENT_APPROVAL';
                $reviewedAt = now();
                $reviewerUserId = $creator->id;
            } else {
                // Otherwise (created by site engineer, requester, etc.), it MUST go to the reviewer first!
                $status = 'SUBMITTED';
                $reviewedAt = null;
                $targetDept = $pr->targetDepartment ?: $pr->department;
                if ($targetDept && in_array($targetDept->code, ['MARKETING', 'SALES'], true)) {
                    $deptReviewer = $targetDept->manager ?: User::where('department_id', $targetDept->id)->whereHas('roles', fn ($q) => $q->where('slug', 'reviewer'))->first();
                    $reviewerUserId = $deptReviewer?->id ?: $pr->reviewer_user_id;
                } else {
                    $reviewerUserId = $pr->reviewer_user_id;
                }
            }

            $supplement = PurchaseRequestSupplement::create([
                'purchase_request_id' => $pr->id,
                'batch_number' => $nextBatch,
                'requested_by_user_id' => $creator->id,
                'reviewer_user_id' => $reviewerUserId,
                'reviewed_at' => $reviewedAt,
                'status' => $status,
                'notes' => $notes,
            ]);

            $supplementTotal = 0.0;

            // Only procurement/admin can set pricing; requesters/reviewers cannot
            $canSetPrice = $creator->hasAnyRole(['admin', 'procurement_manager']);

            foreach ($itemsData as $row) {
                $qty = (float) ($row['quantity'] ?? 1);
                $unitPrice = $canSetPrice && isset($row['estimated_unit_price'])
                    ? (float) $row['estimated_unit_price']
                    : 0.0;
                $lineTotal = round($qty * $unitPrice, 2);
                $supplementTotal += $lineTotal;

                PurchaseRequestItem::create([
                    'purchase_request_id' => $pr->id,
                    'is_supplementary' => true,
                    'supplement_id' => $supplement->id,
                    'supplement_batch' => $nextBatch,
                    'item_id' => $row['item_id'] ?? null,
                    'supplier_id' => $row['supplier_id'] ?? null,
                    'item_description' => $row['item_description'] ?? 'بند كمالة',
                    'item_reference' => $row['item_reference'] ?? $pr->parcel_reference,
                    'region' => $row['region'] ?? $pr->region,
                    'quantity' => $qty,
                    'uom' => $row['uom'] ?? 'PCS',
                    'estimated_unit_price' => $unitPrice,
                    'estimated_line_total' => $lineTotal,
                    'specifications' => $row['specifications'] ?? null,
                    'notes' => $row['notes'] ?? null,
                ]);
            }

            // Update PR estimated total
            $pr->increment('total_estimated_cost', $supplementTotal);

            // Record Approval History and Notifications
            if ($isCreatorReviewer) {
                ApprovalHistory::create([
                    'target_type' => PurchaseRequest::class,
                    'target_id' => $pr->id,
                    'actor_user_id' => $creator->id,
                    'action' => 'SUBMIT_AND_APPROVE_SUPPLEMENT',
                    'from_state' => $pr->status,
                    'to_state' => $pr->status,
                    'user_note' => ApprovalHistory::typedNote($notes),
                    'comments' => "تم إنشاء واعتماد طلب كمالة (دفعة {$nextBatch}) بواسطة المراجع وتوجيهه لإدارة المشتريات للتسعير والربط بأمر الشراء" . ($notes ? ": {$notes}" : ''),
                ]);

                // Notify Procurement Manager directly (Eng. Ahmed)
                $procurementUsers = $this->notificationService->resolveUsersWithPermission('manage_procurement');
                $this->notificationService->queueUsers(
                    $procurementUsers,
                    'pr_supplement_submitted_procurement',
                    "طلب كمالة معتمد من المراجع على الطلب {$pr->request_number}",
                    "قام مراجع القسم {$creator->name} بإضافة بنود كمالة معتمدة (دفعة {$nextBatch}) على طلب الشراء {$pr->request_number}. يرجى تحديد المورد والتسعير.",
                    $pr
                );
            } else {
                ApprovalHistory::create([
                    'target_type' => PurchaseRequest::class,
                    'target_id' => $pr->id,
                    'actor_user_id' => $creator->id,
                    'action' => 'SUBMIT_SUPPLEMENT',
                    'from_state' => $pr->status,
                    'to_state' => $pr->status,
                    'user_note' => ApprovalHistory::typedNote($notes),
                    'comments' => "تم إنشاء طلب كمالة (دفعة {$nextBatch}) بواسطة {$creator->name} بانتظار مراجعة واعتماد مراجع القسم وتحديد جهة الاستلام" . ($notes ? ": {$notes}" : ''),
                ]);

                // Notify Reviewer
                $reviewers = collect();
                if ($pr->reviewer_user_id) {
                    $assigned = User::find($pr->reviewer_user_id);
                    if ($assigned) {
                        $reviewers->push($assigned);
                    }
                }
                if ($reviewers->isEmpty()) {
                    $reviewers = User::whereHas('roles', fn ($q) => $q->where('slug', 'reviewer'))
                        ->where('department_id', $pr->department_id)
                        ->get();
                }
                if ($reviewers->isEmpty()) {
                    $reviewers = User::whereHas('roles', fn ($q) => $q->where('slug', 'reviewer'))->get();
                }

                $this->notificationService->queueUsers(
                    $reviewers,
                    'pr_supplement_submitted_reviewer',
                    "طلب كمالة جديد بانتظار المراجعة على الطلب {$pr->request_number}",
                    "قام {$creator->name} بإضافة بنود كمالة (دفعة {$nextBatch}) على الطلب {$pr->request_number} بانتظار مراجعتك وتحديد جهة الاستلام.",
                    $pr
                );
            }

            return $supplement->load(['items.item', 'requester', 'reviewer']);
        });
    }

    /**
     * Reviewer approves supplementary items and assigns receiver.
     */
    public function approveByReviewer(
        PurchaseRequestSupplement $supplement,
        User $reviewer,
        int|string|null $receiverUserId = null,
        ?string $notes = null
    ): PurchaseRequestSupplement {
        $pr = $supplement->purchaseRequest;

        if ($supplement->status !== 'SUBMITTED') {
            throw ValidationException::withMessages([
                'status' => ['طلب الكمالة ليس بانتظار مراجعة القسم.'],
            ]);
        }

        $effectiveReceiverId = $receiverUserId ?: $pr->site_engineer_user_id;
        if (! $effectiveReceiverId) {
            throw ValidationException::withMessages([
                'receiver_user_id' => ['يجب تحديد الشخص المسؤول عن الاستلام (مهندس الموقع أو أمين المخزن) قبل اعتماد الطلب.'],
            ]);
        }

        return DB::transaction(function () use ($supplement, $pr, $reviewer, $effectiveReceiverId, $notes) {
            if ($effectiveReceiverId && (int) $pr->site_engineer_user_id !== (int) $effectiveReceiverId) {
                $pr->update(['site_engineer_user_id' => (int) $effectiveReceiverId]);
            }

            $supplement->update([
                'status' => 'PENDING_PROCUREMENT_APPROVAL',
                'reviewer_user_id' => $reviewer->id,
                'reviewed_at' => now(),
                'notes' => $notes ? trim(($supplement->notes ? $supplement->notes . "\n" : '') . "ملاحظات المراجع: {$notes}") : $supplement->notes,
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $reviewer->id,
                'action' => 'APPROVE_SUPPLEMENT',
                'from_state' => $pr->status,
                'to_state' => $pr->status,
                'comments' => "تم اعتماد طلب الكمالة (دفعة {$supplement->batch_number}) وتوجيهه للمشتريات وتحديد جهة الاستلام.",
            ]);

            // Notify Procurement
            $procurementUsers = $this->notificationService->resolveUsersWithPermission('manage_procurement');
            $this->notificationService->queueUsers(
                $procurementUsers,
                'pr_supplement_reviewer_approved',
                "طلب كمالة معتمد على الطلب {$pr->request_number}",
                "اعتمد المراجع {$reviewer->name} بنود الكمالة (دفعة {$supplement->batch_number}) للطلب {$pr->request_number}. يرجى تحديد المورد والتسعير.",
                $pr
            );

            return $supplement->load(['items.item', 'requester', 'reviewer']);
        });
    }

    /**
     * Reviewer rejects supplementary items with reason.
     */
    public function rejectByReviewer(
        PurchaseRequestSupplement $supplement,
        User $reviewer,
        string $reason
    ): PurchaseRequestSupplement {
        $pr = $supplement->purchaseRequest;

        if ($supplement->status !== 'SUBMITTED') {
            throw ValidationException::withMessages([
                'status' => ['طلب الكمالة ليس بانتظار مراجعة القسم.'],
            ]);
        }

        return DB::transaction(function () use ($supplement, $pr, $reviewer, $reason) {
            $supplement->update([
                'status' => 'REJECTED',
                'reviewer_user_id' => $reviewer->id,
                'reviewed_at' => now(),
                'rejection_reason' => $reason,
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $reviewer->id,
                'action' => 'REJECT_SUPPLEMENT',
                'from_state' => $pr->status,
                'to_state' => $pr->status,
                'user_note' => ApprovalHistory::typedNote($reason),
                'comments' => "تم رفض طلب الكمالة (دفعة {$supplement->batch_number}) من قِبل مراجع القسم: {$reason}",
            ]);

            // Notify Requester
            if ($supplement->requested_by_user_id) {
                $requester = User::find($supplement->requested_by_user_id);
                if ($requester) {
                    $this->notificationService->queueUsers(
                        collect([$requester]),
                        'pr_supplement_rejected',
                        "تم رفض طلب الكمالة على الطلب {$pr->request_number}",
                        "تم رفض بنود الكمالة (دفعة {$supplement->batch_number}) من قِبل المراجع {$reviewer->name}. السبب: {$reason}",
                        $pr
                    );
                }
            }

            return $supplement->load(['items.item', 'requester', 'reviewer']);
        });
    }

    /**
     * Procurement Manager processes the supplement:
     * Can assign the SAME supplier or a DIFFERENT supplier.
     * Either adds items to the existing PO (if same supplier and requested) or creates a supplementary PO.
     */
    public function processByProcurement(
        PurchaseRequestSupplement $supplement,
        User $procurementUser,
        int $supplierId,
        array $itemsPricing,
        ?string $notes = null,
        bool $mergeToExistingPo = true
    ): PurchaseRequestSupplement {
        $pr = $supplement->purchaseRequest;

        if (! in_array($supplement->status, ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED'], true)) {
            throw ValidationException::withMessages([
                'status' => ['طلب الكمالة يجب أن يكون معتمداً من المراجع وموجهاً للمشتريات أولاً.'],
            ]);
        }

        $supplier = Supplier::findOrFail($supplierId);
        if (! $supplier->is_active) {
            throw ValidationException::withMessages([
                'supplier_id' => ['المورد المحدد غير نشط.'],
            ]);
        }

        return DB::transaction(function () use ($supplement, $pr, $procurementUser, $supplier, $itemsPricing, $notes, $mergeToExistingPo) {
            // Find existing open PO on this PR if merging is possible
            $existingPo = null;
            if ($mergeToExistingPo) {
                $existingPo = PurchaseOrder::where('purchase_request_id', $pr->id)
                    ->where('supplier_id', $supplier->id)
                    ->whereIn('status', ['PO_DRAFT', 'ISSUED'])
                    ->first()
                    ?? PurchaseOrder::where('purchase_request_id', $pr->id)
                    ->whereIn('status', ['PO_DRAFT', 'ISSUED'])
                    ->first();
            }

            $targetPo = null;

            if ($existingPo) {
                $targetPo = $existingPo;
            } else {
                // Create a new PO (for different supplier, or separate supplement PO)
                $poNumber = $this->poService->generatePoNumber();
                $targetPo = PurchaseOrder::create([
                    'po_number' => $poNumber,
                    'purchase_request_id' => $pr->id,
                    'supplier_id' => $supplier->id,
                    'created_by_user_id' => $procurementUser->id,
                    'status' => 'ISSUED',
                    'subtotal' => 0,
                    'grand_total' => 0,
                    'payment_terms' => 'بحسب شروط التوريد',
                    'notes' => "أمر شراء تكميلي (كمالة دفعة {$supplement->batch_number}) على الطلب {$pr->request_number}",
                ]);
            }

            // Map pricing array by pr_item_id
            $pricingMap = collect($itemsPricing)->keyBy('pr_item_id');

            $supplementItems = $supplement->items;
            foreach ($supplementItems as $item) {
                $unitPrice = 0.0;
                if ($pricingMap->has($item->id)) {
                    $unitPrice = (float) $pricingMap->get($item->id)['unit_price'];
                } elseif ((float) $item->estimated_unit_price > 0) {
                    $unitPrice = (float) $item->estimated_unit_price;
                }

                $qty = (float) $item->quantity;
                $lineTotal = round($qty * $unitPrice, 2);

                // Update PR item
                $item->update([
                    'supplier_id' => $supplier->id,
                    'estimated_unit_price' => $unitPrice,
                    'estimated_line_total' => $lineTotal,
                ]);

                // Add to PO items
                PurchaseOrderItem::create([
                    'purchase_order_id' => $targetPo->id,
                    'pr_item_id' => $item->id,
                    'item_id' => $item->item_id,
                    'item_description' => $item->item_description,
                    'item_reference' => $item->item_reference,
                    'region' => $item->region,
                    'quantity' => $qty,
                    'uom' => $item->uom,
                    'unit_price' => $unitPrice,
                    'line_total' => $lineTotal,
                    'is_supplementary' => true,
                    'supplement_batch' => $supplement->batch_number,
                    'specifications' => $item->specifications,
                ]);
            }

            // Recalculate PO grand totals
            $this->poService->recalculateTotals($targetPo);

            // Update supplement record
            $supplement->update([
                'status' => 'PROCUREMENT_PROCESSED',
                'procurement_user_id' => $procurementUser->id,
                'procurement_processed_at' => now(),
                'purchase_order_id' => $targetPo->id,
                'supplier_id' => $supplier->id,
                'notes' => $notes ? trim(($supplement->notes ? $supplement->notes . "\n" : '') . "ملاحظات المشتريات: {$notes}") : $supplement->notes,
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $procurementUser->id,
                'action' => 'PROCESS_SUPPLEMENT_PO',
                'from_state' => $pr->status,
                'to_state' => $pr->status,
                'comments' => "تم اعتماد بنود الكمالة وربطها بأمر الشراء {$targetPo->po_number} مع المورد {$supplier->company_name}.",
            ]);

            // Notifications:
            // 1. Notify warehouse keeper & site engineer
            $warehouseUsers = $this->notificationService->resolveUsersWithPermission('create_purchase_receipts');
            $siteUsers = $this->notificationService->resolveUsersWithPermission('approve_purchase_receipts');
            $recipients = $warehouseUsers->merge($siteUsers)->unique('id');

            $this->notificationService->queueUsers(
                $recipients,
                'pr_supplement_ready_for_receipt',
                "إضافة بنود كمالة على أمر الشراء {$targetPo->po_number}",
                "تمت إضافة بنود تكميلية (كمالة دفعة {$supplement->batch_number}) على أمر الشراء {$targetPo->po_number} مع المورد {$supplier->company_name}. ستظهر بعلامة كمالة عند الاستلام.",
                $targetPo
            );

            // 2. Notify accounting
            $accountingUsers = $this->notificationService->resolveUsersWithPermission('manage_accounting');
            $this->notificationService->queueUsers(
                $accountingUsers,
                'pr_supplement_accounting_updated',
                "تحديث مالي: بنود كمالة على أمر الشراء {$targetPo->po_number}",
                "تم اعتماد بنود كمالة بمبلغ إجمالي محدث لأمر الشراء {$targetPo->po_number} تابع للطلب {$pr->request_number}.",
                $targetPo
            );

            return $supplement->load(['items.item', 'requester', 'reviewer', 'procurementManager', 'supplier', 'purchaseOrder']);
        });
    }
}
