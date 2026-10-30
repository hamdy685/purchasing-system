<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItemSource;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestQuote;
use App\Models\ShipmentGroup;
use App\Models\SupplierInvoice;
use App\Models\User;
use App\Models\WeighingGroup;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Moves a purchase request back (or forward, or out of cancellation) to a workflow stage,
 * so it lands in that stage's inbox exactly as if it had just arrived there.
 * Uses only the statuses the normal workflow already produces; downstream documents that
 * no longer apply are cancelled, never deleted.
 */
class AdminRequestStageService
{
    public const STAGES = [
        'REQUESTER' => 'مقدم الطلب (للتعديل)',
        'REVIEWER' => 'المراجع',
        'EXECUTIVE' => 'اعتماد المدير العام',
        'PROCUREMENT' => 'المشتريات (اعتماد وتسعير)',
        'ACCOUNTING' => 'الحسابات',
        'PO_ISSUANCE' => 'إصدار أمر الشراء',
        'WAREHOUSE_RECEIPT' => 'استلام المخزن',
        'SITE_ENGINEER' => 'اعتماد الاستلام بالموقع',
        'ACTUAL_PO' => 'الأمر الفعلي',
        'CANCELLED' => 'ملغي',
    ];

    private const PRE_PO_STAGES = ['REQUESTER', 'REVIEWER', 'EXECUTIVE', 'PROCUREMENT', 'ACCOUNTING', 'PO_ISSUANCE'];

    private const POST_PO_STAGES = ['WAREHOUSE_RECEIPT', 'SITE_ENGINEER', 'ACTUAL_PO'];

    /** Invoices in these statuses carry no accounting weight and may be voided by a rollback. */
    private const VOIDABLE_INVOICE_STATUSES = ['DRAFT'];

    private const INACTIVE_INVOICE_STATUSES = ['VOIDED', 'CANCELLED', 'REJECTED'];

    public function __construct(
        private readonly AdminWorkflowControlService $workflowControl,
        private readonly NotificationService $notifications,
        private readonly SystemEventService $systemEvents,
    ) {
    }

    /**
     * The stage the request currently sits in, derived from the same statuses the inbox queries use.
     */
    public function currentStage(PurchaseRequest $pr): string
    {
        $status = (string) $pr->status;

        return match (true) {
            in_array($status, ['DRAFT', 'RETURNED', 'REJECTED'], true) => 'REQUESTER',
            in_array($status, ['SUBMITTED', 'UNDER_REVIEW'], true) => 'REVIEWER',
            in_array($status, ['PENDING_EXECUTIVE_APPROVAL', 'PENDING_EXECUTIVE_QUOTE_DECISION'], true) => 'EXECUTIVE',
            in_array($status, ['PENDING_PROCUREMENT_APPROVAL', 'PENDING_QUOTE_RECOMMENDATIONS'], true) => 'PROCUREMENT',
            $status === 'PENDING_ACCOUNTING_APPROVAL' => 'ACCOUNTING',
            in_array($status, ['CANCELLED', 'VOIDED'], true) => 'CANCELLED',
            $status === 'ISSUED' => $this->issuedStage($pr),
            default => 'PO_ISSUANCE',
        };
    }

    public function stageLabel(string $stage): string
    {
        return $stage === 'COMPLETED' ? 'أمر شراء فعلي مكتمل' : (self::STAGES[$stage] ?? $stage);
    }

    /**
     * Every stage with whether it can be chosen now and, if not, why.
     *
     * @return array<int, array{value: string, label: string, available: bool, reason: ?string, current: bool}>
     */
    public function stageOptions(PurchaseRequest $pr): array
    {
        $current = $this->currentStage($pr);
        $financialLock = $this->financialLockReason($pr);
        $sharedLock = $this->sharedOrderLockReason($pr);
        $po = $this->targetOrder($pr);

        $options = [];
        foreach (self::STAGES as $stage => $label) {
            $reason = null;
            if ($stage === $current) {
                $reason = 'المرحلة الحالية للطلب.';
            } elseif ($financialLock) {
                $reason = $financialLock;
            } elseif ($sharedLock && in_array($stage, self::PRE_PO_STAGES, true)) {
                $reason = $sharedLock;
            } else {
                $reason = $this->unavailableReason($pr, $stage, $po);
            }

            $options[] = [
                'value' => $stage,
                'label' => $label,
                'available' => $reason === null,
                'reason' => $reason,
                'current' => $stage === $current,
            ];
        }

        return $options;
    }

    public function moveToStage(PurchaseRequest $request, string $stage, string $reason, User $admin): array
    {
        $reason = trim($reason);
        if (! array_key_exists($stage, self::STAGES)) {
            throw ValidationException::withMessages(['request_stage' => ['المرحلة المختارة غير معروفة.']]);
        }
        if (mb_strlen($reason) < 3) {
            throw ValidationException::withMessages(['admin_reason' => ['اكتب سبب التعديل (3 أحرف على الأقل).']]);
        }

        if ($stage === 'CANCELLED') {
            $this->assertMovable($request, $stage);

            return $this->workflowControl->cancelSafely('PURCHASE_REQUEST', $request->id, $reason, $admin);
        }

        return DB::transaction(function () use ($request, $stage, $reason, $admin) {
            /** @var PurchaseRequest $pr */
            $pr = PurchaseRequest::whereKey($request->id)->lockForUpdate()->firstOrFail();
            $this->assertMovable($pr, $stage);

            $fromStage = $this->currentStage($pr);
            $fromStatus = (string) $pr->status;
            $orders = $this->linkedOrders($pr);
            $before = $this->snapshot($pr, $orders);

            if (in_array($stage, self::PRE_PO_STAGES, true)) {
                foreach ($orders as $po) {
                    $this->cancelOrderChain($po);
                }
                $this->applyPrePoStage($pr, $stage, $reason);
            } else {
                $po = $this->targetOrder($pr);
                $this->applyPostPoStage($pr, $po, $stage);
            }

            $orders = $this->linkedOrders($pr);
            $after = $this->snapshot($pr->fresh(), $orders);

            $this->recordAudit($pr, $admin, $fromStage, $stage, $fromStatus, $reason, $before, $after);
            $this->notifyNewOwner($pr->fresh(['requester', 'assignedReviewer', 'siteEngineer', 'department']), $stage, $reason);

            return [
                'success' => true,
                'message' => "تم نقل الطلب {$pr->request_number} إلى مرحلة: " . self::STAGES[$stage] . '.',
                'document' => $pr->fresh(),
            ];
        });
    }

    private function assertMovable(PurchaseRequest $pr, string $stage): void
    {
        $option = collect($this->stageOptions($pr))->firstWhere('value', $stage);
        if (! $option || ! $option['available']) {
            throw ValidationException::withMessages([
                'request_stage' => [$option['reason'] ?? 'لا يمكن نقل الطلب لهذه المرحلة.'],
            ]);
        }
    }

    private function issuedStage(PurchaseRequest $pr): string
    {
        $po = $this->linkedOrders($pr)->first(fn (PurchaseOrder $o) => ! $this->isInactiveOrder($o));
        if (! $po) {
            return 'PO_ISSUANCE';
        }
        if (in_array($po->status, ['PO_DRAFT', 'PENDING_ACCOUNTING_REVIEW', 'RETURNED_TO_PROCUREMENT'], true)) {
            return 'PO_ISSUANCE';
        }
        if ($po->status === 'PENDING_ACTUAL_PO') {
            return 'ACTUAL_PO';
        }
        if ($po->finalized_at) {
            return 'COMPLETED';
        }
        if ($po->receipts()->where('status', 'PENDING_SITE_ENGINEER')->exists()) {
            return 'SITE_ENGINEER';
        }

        return $pr->requiresWarehouseReceipt() ? 'WAREHOUSE_RECEIPT' : 'SITE_ENGINEER';
    }

    private function unavailableReason(PurchaseRequest $pr, string $stage, ?PurchaseOrder $po): ?string
    {
        return match ($stage) {
            'REVIEWER' => $pr->reviewer_user_id ? null : 'لا يوجد مراجع معيّن على هذا الطلب.',
            'EXECUTIVE' => $pr->request_type === 'COMPLEMENTARY' ? 'الطلبات التكميلية لا تمر على المدير العام.' : null,
            'ACCOUNTING' => $pr->procurement_route === 'DIRECT' ? null : 'مرحلة الحسابات للطلبات المباشرة فقط.',
            'PO_ISSUANCE' => ($pr->procurement_route === 'DIRECT' || $pr->selected_quote_id)
                ? null
                : 'لم يتم تسعير الطلب أو اختيار عرض سعر بعد.',
            'WAREHOUSE_RECEIPT' => ! $po
                ? 'لا يوجد أمر شراء صادر لهذا الطلب.'
                : ($pr->requiresWarehouseReceipt() ? null : 'هذا الطلب لا يمر على المخزن.'),
            'SITE_ENGINEER' => ! $po
                ? 'لا يوجد أمر شراء صادر لهذا الطلب.'
                : (($pr->requiresWarehouseReceipt() && ! $this->latestReceipt($po))
                    ? 'لم يسجل المخزن استلامًا لهذا الأمر بعد.'
                    : null),
            'ACTUAL_PO' => ! $po
                ? 'لا يوجد أمر شراء صادر لهذا الطلب.'
                : ($po->receipts()->where('status', 'APPROVED')->exists() ? null : 'لا يوجد استلام معتمد لهذا الأمر.'),
            default => null,
        };
    }

    /**
     * Rollback is blocked while any invoice on the request's orders is registered in the accounts:
     * supplier balances count every invoice that is not a draft.
     */
    private function financialLockReason(PurchaseRequest $pr): ?string
    {
        $orderIds = $this->linkedOrders($pr)->pluck('id');
        if ($orderIds->isEmpty()) {
            return null;
        }

        $invoice = SupplierInvoice::whereIn('purchase_order_id', $orderIds)
            ->whereNotIn('status', array_merge(self::VOIDABLE_INVOICE_STATUSES, self::INACTIVE_INVOICE_STATUSES))
            ->orderBy('id')
            ->first();

        if (! $invoice) {
            return null;
        }

        $label = $invoice->invoice_number ?: "#{$invoice->id}";

        return "يوجد فاتورة مسجلة بالحسابات ({$label}). ألغِ الفاتورة من الحسابات أولاً ثم أعد المحاولة.";
    }

    private function sharedOrderLockReason(PurchaseRequest $pr): ?string
    {
        foreach ($this->linkedOrders($pr) as $po) {
            if ($this->isInactiveOrder($po)) {
                continue;
            }
            $otherRequests = PurchaseOrderItemSource::query()
                ->whereIn('purchase_order_item_id', $po->items()->pluck('id'))
                ->where('purchase_request_id', '!=', $pr->id)
                ->where('active_flag', true)
                ->exists();
            if ($otherRequests || ($po->purchase_request_id && (int) $po->purchase_request_id !== (int) $pr->id)) {
                return "أمر الشراء {$po->po_number} مجمّع لأكثر من طلب، ولا يمكن إرجاع طلب واحد منه لمرحلة قبل الأمر.";
            }
        }

        return null;
    }

    /**
     * Orders that belong to the request directly or hold its lines through consolidation sources.
     */
    private function linkedOrders(PurchaseRequest $pr): Collection
    {
        $sourcedOrderIds = PurchaseOrderItemSource::query()
            ->join('purchase_order_items', 'purchase_order_items.id', '=', 'purchase_order_item_sources.purchase_order_item_id')
            ->where('purchase_order_item_sources.purchase_request_id', $pr->id)
            ->pluck('purchase_order_items.purchase_order_id');

        return PurchaseOrder::query()
            ->where(function ($q) use ($pr, $sourcedOrderIds) {
                $q->where('purchase_request_id', $pr->id)->orWhereIn('id', $sourcedOrderIds);
            })
            ->orderByDesc('id')
            ->get();
    }

    /**
     * The order a post-PO stage acts on: the live one, or the most recent cancelled one when restoring.
     */
    private function targetOrder(PurchaseRequest $pr): ?PurchaseOrder
    {
        $orders = $this->linkedOrders($pr);

        return $orders->first(fn (PurchaseOrder $o) => ! $this->isInactiveOrder($o))
            ?? $orders->first(fn (PurchaseOrder $o) => in_array($o->status, ['CANCELLED', 'VOIDED'], true));
    }

    private function isInactiveOrder(PurchaseOrder $po): bool
    {
        return in_array($po->status, PurchaseOrderSourceService::INACTIVE_PO_STATUSES, true);
    }

    private function latestReceipt(PurchaseOrder $po): ?PurchaseReceipt
    {
        return $po->receipts()->where('status', '!=', 'CANCELLED')->latest('id')->first()
            ?? $po->receipts()->latest('id')->first();
    }

    private function cancelOrderChain(PurchaseOrder $po): void
    {
        $this->voidDraftInvoices($po);

        PurchaseReceipt::where('purchase_order_id', $po->id)
            ->where('status', '!=', 'CANCELLED')
            ->update(['status' => 'CANCELLED']);

        WeighingGroup::where('purchase_order_id', $po->id)
            ->where('status', '!=', 'CANCELLED')
            ->update(['status' => 'CANCELLED']);

        if (! $this->isInactiveOrder($po)) {
            $po->update(['status' => 'CANCELLED']);
        }

        $this->refreshShipmentGroups($po);
    }

    private function applyPrePoStage(PurchaseRequest $pr, string $stage, string $reason): void
    {
        $updates = match ($stage) {
            'REQUESTER' => ['status' => 'RETURNED', 'return_reason' => $reason],
            'REVIEWER' => ['status' => 'SUBMITTED'],
            'EXECUTIVE' => ['status' => 'PENDING_EXECUTIVE_APPROVAL'],
            'PROCUREMENT' => ['status' => 'PENDING_PROCUREMENT_APPROVAL'],
            'ACCOUNTING' => ['status' => 'PENDING_ACCOUNTING_APPROVAL'],
            'PO_ISSUANCE' => ['status' => $pr->procurement_route === 'DIRECT' ? 'APPROVED_BY_ACCOUNTING' : 'APPROVED_BY_PROCUREMENT'],
        };
        $updates['rejection_reason'] = null;

        // Stages before procurement pricing start over without a route, supplier or chosen quote,
        // the same way procurement's own "reset route" leaves the request.
        if (in_array($stage, ['REQUESTER', 'REVIEWER', 'PROCUREMENT'], true)) {
            $updates['procurement_route'] = 'UNDECIDED';
            $updates['direct_supplier_id'] = null;
            $updates['selected_quote_id'] = null;
            PurchaseRequestQuote::where('purchase_request_id', $pr->id)
                ->update(['status' => 'SUBMITTED', 'selected_at' => null]);
        }

        $pr->update($updates);
    }

    private function applyPostPoStage(PurchaseRequest $pr, PurchaseOrder $po, string $stage): void
    {
        $this->voidDraftInvoices($po);
        $pr->update(['status' => 'ISSUED', 'rejection_reason' => null]);

        $orderUpdates = ['finalized_at' => null, 'finalized_by_user_id' => null];

        if ($stage === 'WAREHOUSE_RECEIPT') {
            PurchaseReceipt::where('purchase_order_id', $po->id)
                ->where('status', '!=', 'CANCELLED')
                ->update(['status' => 'CANCELLED']);
            WeighingGroup::where('purchase_order_id', $po->id)->update([
                'status' => 'PENDING_RECEIPT',
                'received_at' => null,
                'received_by_user_id' => null,
                'total_received_weight' => null,
                'weight_difference' => null,
            ]);
            $orderUpdates += ['status' => 'ISSUED', 'delivery_status' => 'PENDING', 'actual_delivery_date' => null];
        } elseif ($stage === 'SITE_ENGINEER') {
            $receipt = $this->latestReceipt($po);
            if ($receipt) {
                PurchaseReceipt::where('purchase_order_id', $po->id)
                    ->whereKeyNot($receipt->id)
                    ->where('status', 'PENDING_SITE_ENGINEER')
                    ->update(['status' => 'CANCELLED']);
                $receipt->update([
                    'status' => 'PENDING_SITE_ENGINEER',
                    'site_engineer_approved_at' => null,
                    'receiver_approved_at' => null,
                ]);
                if ($receipt->weighing_group_id) {
                    WeighingGroup::whereKey($receipt->weighing_group_id)
                        ->whereIn('status', ['APPROVED', 'CANCELLED'])
                        ->update(['status' => 'RECEIVED']);
                }
            }
            $orderUpdates += ['status' => 'ISSUED', 'delivery_status' => $receipt ? 'IN_RECEIPT' : 'PENDING'];
        } else {
            $orderUpdates += ['status' => 'PENDING_ACTUAL_PO', 'delivery_status' => 'DELIVERED'];
        }

        $po->update($orderUpdates);
        $this->refreshShipmentGroups($po);
    }

    private function voidDraftInvoices(PurchaseOrder $po): void
    {
        SupplierInvoice::where('purchase_order_id', $po->id)
            ->whereIn('status', self::VOIDABLE_INVOICE_STATUSES)
            ->update(['status' => 'VOIDED']);
    }

    private function refreshShipmentGroups(PurchaseOrder $po): void
    {
        $groupIds = $po->items()->whereNotNull('shipment_group_id')->pluck('shipment_group_id')->unique();
        foreach ($groupIds as $groupId) {
            try {
                app(SharedShipmentGroupService::class)->updateShipmentStatus((int) $groupId);
            } catch (Throwable) {
                // Shipment status is a derived summary; a failed refresh must not undo the stage move.
            }
        }
    }

    private function snapshot(PurchaseRequest $pr, Collection $orders): array
    {
        return [
            'request_status' => $pr->status,
            'procurement_route' => $pr->procurement_route,
            'orders' => $orders->map(fn (PurchaseOrder $po) => [
                'po_number' => $po->po_number,
                'status' => $po->fresh()->status,
                'finalized_at' => optional($po->fresh()->finalized_at)->toDateTimeString(),
                'receipts' => PurchaseReceipt::where('purchase_order_id', $po->id)->pluck('status', 'receipt_number')->toArray(),
            ])->values()->toArray(),
        ];
    }

    private function recordAudit(
        PurchaseRequest $pr,
        User $admin,
        string $fromStage,
        string $toStage,
        string $fromStatus,
        string $reason,
        array $before,
        array $after
    ): void {
        $fromLabel = $this->stageLabel($fromStage);
        $toLabel = self::STAGES[$toStage];
        $toStatus = (string) $pr->fresh()->status;

        $this->workflowControl->logAdminAudit(
            $admin,
            'ADMIN_REQUEST_STAGE_MOVE',
            'PURCHASE_REQUEST',
            $pr->id,
            $pr->request_number,
            $fromStatus,
            $toStatus,
            $reason,
            $before,
            $after,
            ['from_stage' => $fromStage, 'to_stage' => $toStage]
        );

        $this->systemEvents->record([
            'actor_user_id' => $admin->id,
            'event_type' => 'admin.request_stage_move',
            'action' => 'ADMIN_REQUEST_STAGE_MOVE',
            'entity_type' => PurchaseRequest::class,
            'entity_id' => $pr->id,
            'entity_label' => "طلب شراء {$pr->request_number}",
            'from_state' => $fromStatus,
            'to_state' => $toStatus,
            'description' => "نقل الطلب من «{$fromLabel}» إلى «{$toLabel}». السبب: {$reason}",
            'old_values' => $before,
            'new_values' => $after,
            'metadata' => ['from_stage' => $fromStage, 'to_stage' => $toStage, 'reason' => $reason],
        ]);

        ApprovalHistory::create([
            'target_type' => PurchaseRequest::class,
            'target_id' => $pr->id,
            'actor_user_id' => $admin->id,
            'action' => 'ADMIN_STAGE_MOVE',
            'from_state' => $fromStatus,
            'to_state' => $toStatus,
            'user_note' => ApprovalHistory::typedNote($reason),
            'comments' => "نقل إداري إلى مرحلة «{$toLabel}»: {$reason}",
        ]);
    }

    private function notifyNewOwner(PurchaseRequest $pr, string $stage, string $reason): void
    {
        try {
            $this->notifications->markEntityNotificationsAsRead($pr);

            $recipients = match ($stage) {
                'REQUESTER' => collect([$pr->requester]),
                'REVIEWER' => collect([$pr->assignedReviewer]),
                'SITE_ENGINEER' => collect([$pr->isOfficeRequest() ? $pr->requester : $pr->siteEngineer]),
                'EXECUTIVE' => $this->usersWithRole('general_manager'),
                'ACCOUNTING' => $this->usersWithRole('accountant'),
                'WAREHOUSE_RECEIPT' => $this->usersWithRole('warehouse_keeper'),
                default => $this->usersWithRole('procurement_manager'),
            };

            $this->notifications->queueUsers(
                $recipients->filter()->values(),
                'purchase_request_admin_stage_move',
                "الطلب {$pr->request_number} بانتظارك",
                'أعاد مدير النظام الطلب إلى مرحلة «' . self::STAGES[$stage] . "». السبب: {$reason}",
                $pr
            );
        } catch (Throwable) {
            // Notifications are best effort; the stage move itself is already recorded.
        }
    }

    private function usersWithRole(string $slug): Collection
    {
        return User::where('is_active', true)
            ->whereHas('roles', fn ($q) => $q->where('slug', $slug))
            ->get();
    }
}
