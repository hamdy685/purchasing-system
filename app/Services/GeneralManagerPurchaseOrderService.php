<?php

namespace App\Services;

use App\Models\PurchaseOrder;
use App\Models\User;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

class GeneralManagerPurchaseOrderService
{
    public function getGmPurchaseOrders(int|string $perPage = 100, ?User $user = null)
    {
        $query = PurchaseOrder::with([
            'purchaseRequest.requester',
            'purchaseRequest.department',
            'purchaseRequest.targetDepartment',
            'supplier',
            'createdBy',
            'accountingReviewer',
            'items.item:id,name,sku',
        ])
            ->whereIn('status', ['ISSUED', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED']);

        if ($user && $user->hasRole('execution_manager')) {
            $query->whereHas('purchaseRequest.requester', fn ($q) => $q->where('manager_id', $user->id));
        }

        $query->orderBy('updated_at', 'desc');

        if ($perPage === 'all' || (is_numeric($perPage) && (int) $perPage <= 0)) {
            return $query->get();
        }

        return $query->paginate((int) $perPage);
    }

    /**
     * The dashboard only counts and totals orders, so it gets each order's few header fields
     * instead of the full resource (items, receipts, request) for every order.
     */
    public function getGmPurchaseOrderSummaries(?User $user = null): array
    {
        $query = PurchaseOrder::query()
            ->select(['id', 'po_number', 'status', 'supplier_id', 'purchase_request_id', 'grand_total', 'finalized_at', 'created_at', 'updated_at'])
            ->with([
                'supplier:id,company_name',
                'purchaseRequest:id,department_id,target_department_id',
                'purchaseRequest.department:id,name',
                'purchaseRequest.targetDepartment:id,name',
            ])
            ->whereIn('status', ['ISSUED', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED']);

        if ($user && $user->hasRole('execution_manager')) {
            $query->whereHas('purchaseRequest.requester', fn ($q) => $q->where('manager_id', $user->id));
        }

        return $query->orderBy('updated_at', 'desc')->get()->map(function (PurchaseOrder $po) {
            $pr = $po->purchaseRequest;
            $department = fn ($d) => $d ? ['id' => $d->id, 'name' => $d->name] : null;

            return [
                'id' => $po->id,
                'po_number' => $po->po_number,
                'status' => $po->status,
                'supplier_id' => $po->supplier_id,
                'supplier' => $po->supplier ? ['id' => $po->supplier->id, 'company_name' => $po->supplier->company_name] : null,
                'grand_total' => (float) $po->grand_total,
                'finalized_at' => $po->finalized_at?->toIso8601String(),
                'created_at' => $po->created_at?->toIso8601String(),
                'purchase_request' => $pr ? [
                    'id' => $pr->id,
                    'department' => $department($pr->department),
                    'target_department' => $department($pr->targetDepartment),
                ] : null,
            ];
        })->all();
    }

    public function getPoForGmView(int $id, ?User $user = null): PurchaseOrder
    {
        $po = PurchaseOrder::with([
            'purchaseRequest.requester',
            'purchaseRequest.department',
            'purchaseRequest.targetDepartment',
            'purchaseRequest.assignedReviewer',
            'purchaseRequest.approvalHistory.actor',
            'supplier',
            'createdBy',
            'accountingReviewer',
            'items.item',
            'approvalHistory.actor',
            'receipts.items.purchaseOrderItem',
            'receipts.warehouseKeeper',
            'receipts.siteEngineer',
            'receipts.receiver',
        ])->findOrFail($id);

        if ($user && $user->hasRole('execution_manager')) {
            if ((int) $po->purchaseRequest?->requester?->manager_id !== (int) $user->id) {
                throw new AccessDeniedHttpException('غير مصرح لك باستعراض أمر شراء لا يتبع موظفيك.');
            }
        }

        return $po;
    }
}
