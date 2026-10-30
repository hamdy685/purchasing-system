<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use App\Models\PurchaseOrder;
use App\Models\User;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;

class AccountingPurchaseOrderService
{
    /**
     * Get POs pending accounting financial review or history.
     */
    public function getAccountingPurchaseOrders(int $perPage = 15, ?User $user = null): LengthAwarePaginator
    {
        $allowedCodes = $user ? app(SupplierInvoiceService::class)->getAllowedDepartmentCodesForAccountant($user) : null;

        return PurchaseOrder::with(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'supplier', 'createdBy', 'accountingReviewer', 'items.item:id,name,sku', 'items.supplier', 'finalizedBy'])
            ->whereIn('status', ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'RETURNED_TO_PROCUREMENT'])
            ->where('status', '!=', 'PENDING_ACTUAL_PO')
            ->where(function ($query) {
                // Must be either finalized by procurement (actual PO), or have approved receipt, or legacy/no receipt required
                $query->whereNotNull('finalized_at')
                    ->orWhereHas('receipts', fn ($rq) => $rq->where('status', 'APPROVED'))
                    ->orWhereHas('purchaseRequest', fn ($pq) => $pq->where('requires_warehouse_receipt', false))
                    ->orWhereIn('status', ['APPROVED_BY_ACCOUNTING', 'RETURNED_TO_PROCUREMENT']);
            })
            ->when($allowedCodes !== null, function ($query) use ($allowedCodes) {
                $query->whereHas('purchaseRequest.department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            })
            ->orderBy('updated_at', 'desc')
            ->paginate(min(max($perPage, 1), 100));
    }

    /**
     * Approve Purchase Order from accounting side (PENDING_ACCOUNTING_REVIEW -> APPROVED_BY_ACCOUNTING).
     */
    public function approvePo(User $accountant, PurchaseOrder $po, ?string $comment = null, ?string $financialNotes = null): PurchaseOrder
    {
        if ($po->status !== 'PENDING_ACCOUNTING_REVIEW') {
            throw new \RuntimeException('Only purchase orders pending accounting review can be approved.');
        }

        return DB::transaction(function () use ($accountant, $po, $comment, $financialNotes) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->first();

            $lockedPo->update([
                'status' => 'APPROVED_BY_ACCOUNTING',
                'reviewed_by_accounting_user_id' => $accountant->id,
                'reviewed_at_accounting' => now(),
                'financial_notes' => $financialNotes ?? $lockedPo->financial_notes,
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($lockedPo);

            ApprovalHistory::create([
                'target_type' => PurchaseOrder::class,
                'target_id' => $lockedPo->id,
                'actor_user_id' => $accountant->id,
                'action' => 'ACCOUNTING_APPROVED',
                'from_state' => 'PENDING_ACCOUNTING_REVIEW',
                'to_state' => 'APPROVED_BY_ACCOUNTING',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment ?? 'Financial review approved by accounting.',
            ]);

            if ($lockedPo->purchaseRequest) {
                $pr = $lockedPo->purchaseRequest;
                $prFromState = $pr->status;
                $pr->update(['status' => 'ISSUED']);

                ApprovalHistory::create([
                    'target_type' => PurchaseRequest::class,
                    'target_id'   => $pr->id,
                    'actor_user_id' => $accountant->id,
                    'action'      => 'PO_APPROVED_BY_ACCOUNTING',
                    'from_state'  => $prFromState,
                    'to_state'    => 'ISSUED',
                    'user_note'    => ApprovalHistory::typedNote($comment),
                    'comments'    => 'تم اعتماد أمر الشراء محاسبياً رقم ' . $lockedPo->po_number . ($comment ? " ({$comment})" : ''),
                ]);
            }

            AuditLog::create([
                'user_id' => $accountant->id,
                'entity_type' => PurchaseOrder::class,
                'entity_id' => $lockedPo->id,
                'action' => 'ACCOUNTING_APPROVED',
                'field_name' => 'status',
                'old_value' => 'PENDING_ACCOUNTING_REVIEW',
                'new_value' => 'APPROVED_BY_ACCOUNTING',
            ]);

            // Notify Requester (if the request belongs to GM or user)
            $notificationService = app(NotificationService::class);
            if ($lockedPo->purchaseRequest && $lockedPo->purchaseRequest->user_id) {
                $notificationService->queueNotification(
                    $lockedPo->purchaseRequest->user_id,
                    'purchase_order_approved_accounting',
                    'تمت الموافقة المحاسبية على أمر الشراء',
                    "أمر الشراء {$lockedPo->po_number} لطلبك {$lockedPo->purchaseRequest->request_number} اعتُمد محاسبياً.",
                    $lockedPo
                );
            }

            return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'supplier', 'createdBy', 'accountingReviewer', 'items.item:id,name,sku']);
        });
    }

    /**
     * Return Purchase Order to Procurement for commercial corrections (PENDING_ACCOUNTING_REVIEW -> RETURNED_TO_PROCUREMENT).
     */
    public function returnPoToProcurement(User $accountant, PurchaseOrder $po, string $comment): PurchaseOrder
    {
        if ($po->status !== 'PENDING_ACCOUNTING_REVIEW') {
            throw new \RuntimeException('Only purchase orders pending accounting review can be returned.');
        }

        return DB::transaction(function () use ($accountant, $po, $comment) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->first();

            $lockedPo->update([
                'status' => 'RETURNED_TO_PROCUREMENT',
                'reviewed_by_accounting_user_id' => $accountant->id,
                'reviewed_at_accounting' => now(),
                'financial_notes' => $comment,
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($lockedPo);

            ApprovalHistory::create([
                'target_type' => PurchaseOrder::class,
                'target_id' => $lockedPo->id,
                'actor_user_id' => $accountant->id,
                'action' => 'RETURNED_TO_PROCUREMENT',
                'from_state' => 'PENDING_ACCOUNTING_REVIEW',
                'to_state' => 'RETURNED_TO_PROCUREMENT',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment,
            ]);

            AuditLog::create([
                'user_id' => $accountant->id,
                'entity_type' => PurchaseOrder::class,
                'entity_id' => $lockedPo->id,
                'action' => 'RETURNED_TO_PROCUREMENT',
                'field_name' => 'status',
                'old_value' => 'PENDING_ACCOUNTING_REVIEW',
                'new_value' => 'RETURNED_TO_PROCUREMENT',
            ]);

            // Notify Procurement Manager who created the PO (Event 6)
            $notificationService = app(NotificationService::class);
            $notificationService->queueNotification(
                $lockedPo->created_by_user_id,
                'purchase_order_returned',
                'إعادة أمر الشراء للتصحيح',
                "تمت إعادة أمر الشراء {$lockedPo->po_number} إلى مدير المشتريات للتصحيح. السبب: {$comment}",
                $lockedPo
            );

            return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'supplier', 'createdBy', 'accountingReviewer', 'items.item:id,name,sku']);
        });
    }
}

