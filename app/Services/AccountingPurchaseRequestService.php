<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use App\Models\PurchaseRequest;
use App\Models\Supplier;
use App\Models\User;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class AccountingPurchaseRequestService
{
    public const PENDING_STATUS = 'PENDING_ACCOUNTING_APPROVAL';
    public const APPROVED_STATUS = 'APPROVED_BY_ACCOUNTING';

    public function getPendingRequests(int $perPage = 50, ?User $user = null): LengthAwarePaginator
    {
        $allowedCodes = $user ? app(SupplierInvoiceService::class)->getAllowedDepartmentCodesForAccountant($user) : null;

        return PurchaseRequest::query()
            ->with([
                'requester:id,name,email',
                'department:id,name,code',
                'directSupplier:id,company_name',
                'assignedReviewer:id,name,email,department_id',
                'siteEngineer:id,name,email,department_id',
                'items.item',
                'items.supplier',
                'approvalHistory.actor',
            ])
            ->where('status', self::PENDING_STATUS)
            ->when($allowedCodes !== null, function ($query) use ($allowedCodes) {
                $query->whereHas('department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            })
            ->orderByDesc('updated_at')
            ->paginate(min(max($perPage, 1), 100));
    }

    public function approveRequest(User $accountant, PurchaseRequest $request, array $financialData = [], ?string $comment = null): PurchaseRequest
    {
        $this->ensurePending($request);

        return DB::transaction(function () use ($accountant, $request, $comment): PurchaseRequest {
            $pr = PurchaseRequest::with('items')->lockForUpdate()->findOrFail($request->id);
            if ($pr->status !== self::PENDING_STATUS) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن الطلب المباشر أو لم يعد بانتظار الموافقة المالية.');
            }

            // الدور يقتصر حصرياً على الموافقة أو الرفض: تحديث الحالة فقط دون المساس بالبيانات المالية أو الموردين أو البنود
            $pr->update([
                'status' => self::APPROVED_STATUS,
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $accountant->id,
                'action' => 'ACCOUNTING_APPROVED_DIRECT',
                'from_state' => self::PENDING_STATUS,
                'to_state' => self::APPROVED_STATUS,
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment ?? 'وافقت الإدارة المالية على الطلب وأعادته إلى مدير المشتريات لإنشاء أمر الشراء.',
            ]);

            AuditLog::create([
                'user_id' => $accountant->id,
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'action' => 'ACCOUNTING_APPROVED_DIRECT',
                'field_name' => 'status',
                'old_value' => self::PENDING_STATUS,
                'new_value' => self::APPROVED_STATUS,
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'ACCOUNTING_APPROVED_DIRECT',
                'وافقت الإدارة المالية على الطلب وأعادته إلى مدير المشتريات لإنشاء أمر الشراء.',
                [
                    'event_type' => 'purchase_request.accounting_approved_direct',
                    'from_state' => self::PENDING_STATUS,
                    'to_state' => self::APPROVED_STATUS,
                    'actor_user_id' => $accountant->id,
                    'metadata' => ['comment' => $comment],
                ]
            );

            $notificationService = app(NotificationService::class);
            $notificationService->markEntityNotificationsAsRead($pr);
            $notificationService->queueUsers(
                $notificationService->resolveUsersWithPermission('purchase_request.approve_procurement'),
                'purchase_request_pending_procurement_po',
                'طلب شراء مباشر جاهز للمشتريات',
                "وافقت الإدارة المالية على الطلب {$pr->request_number}. عاد الطلب إلى مدير المشتريات لإنشاء أمر الشراء.",
                $pr
            );
            $notificationService->queueNotification(
                $pr->user_id,
                'purchase_request_accounting_approved_direct',
                'تمت الموافقة المالية على طلبك',
                "وافقت الإدارة المالية على الطلب {$pr->request_number} وأعادته إلى مدير المشتريات لإنشاء أمر الشراء.",
                $pr
            );

            return $this->freshRequest($pr);
        });
    }

    public function rejectRequest(User $accountant, PurchaseRequest $request, string $comment): PurchaseRequest
    {
        $this->ensurePending($request);

        return DB::transaction(function () use ($accountant, $request, $comment): PurchaseRequest {
            $pr = PurchaseRequest::query()->lockForUpdate()->findOrFail($request->id);
            if ($pr->status !== self::PENDING_STATUS) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن الطلب المباشر أو لم يعد بانتظار الموافقة المالية.');
            }
            $pr->update([
                'status' => 'REJECTED',
                'rejection_reason' => $comment,
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($pr);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $accountant->id,
                'action' => 'ACCOUNTING_REJECTED_DIRECT',
                'from_state' => self::PENDING_STATUS,
                'to_state' => 'REJECTED',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment,
            ]);

            AuditLog::create([
                'user_id' => $accountant->id,
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'action' => 'ACCOUNTING_REJECTED_DIRECT',
                'field_name' => 'status',
                'old_value' => self::PENDING_STATUS,
                'new_value' => 'REJECTED',
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'ACCOUNTING_REJECTED_DIRECT',
                'رفضت الحسابات الطلب الذي لم يطلب عروض أسعار.',
                [
                    'event_type' => 'purchase_request.accounting_rejected_direct',
                    'from_state' => self::PENDING_STATUS,
                    'to_state' => 'REJECTED',
                    'actor_user_id' => $accountant->id,
                    'metadata' => ['comment' => $comment],
                ]
            );

            $notificationService = app(NotificationService::class);
            $notificationService->queueNotification(
                $pr->user_id,
                'purchase_request_accounting_rejected_direct',
                'تم رفض الطلب ماليًا',
                "رفضت الحسابات الطلب {$pr->request_number}. السبب: {$comment}",
                $pr
            );
            $notificationService->queueUsers(
                $notificationService->resolveUsersWithPermission('purchase_request.view_approved'),
                'purchase_request_accounting_rejected_direct',
                'رفض مالي مباشر',
                "رفضت الحسابات الطلب {$pr->request_number} الذي لم يطلب عروض أسعار.",
                $pr
            );

            return $this->freshRequest($pr);
        });
    }

    public function getActiveSuppliers(): Collection
    {
        return Supplier::query()
            ->where('is_active', true)
            ->orderBy('company_name')
            ->get(['id', 'company_name', 'email', 'phone', 'is_active']);
    }

    private function applyFinancialData(User $accountant, PurchaseRequest $pr, array $financialData): float
    {
        $submittedItems = $financialData['items'] ?? [];
        // Legacy fallback: accept a top-level supplier_id for backward compatibility
        $globalSupplierId = (int) ($financialData['supplier_id'] ?? 0);
        if (! is_array($submittedItems) || count($submittedItems) === 0) {
            $existingTotal = (float) $pr->items->sum('estimated_line_total');
            $hasSuppliers = $pr->items->isNotEmpty() && $pr->items->every(fn ($item) => (int) $item->supplier_id > 0);
            if ($existingTotal > 0 && $hasSuppliers) {
                return round($existingTotal, 2);
            }
            throw ValidationException::withMessages(['financial_data.items' => ['يجب إدخال البيانات المالية لجميع بنود الطلب قبل الاعتماد.']]);
        }

        $requestItemsById = $pr->items->keyBy(fn ($item): string => (string) $item->id);
        $submittedById = collect($submittedItems)->keyBy(fn (array $item): string => (string) ($item['pr_item_id'] ?? ''));
        if ($submittedById->count() !== $requestItemsById->count() || $submittedById->keys()->diff($requestItemsById->keys())->isNotEmpty()) {
            throw ValidationException::withMessages(['financial_data.items' => ['يجب إدخال البيانات المالية لجميع بنود الطلب دون حذف أو إضافة بند.']]);
        }

        $supplierIds = collect();
        foreach ($requestItemsById as $prItemId => $prItem) {
            $input = $submittedById->get((string) $prItemId);
            $quantity = (float) ($input['quantity'] ?? $prItem->quantity);
            $unitPrice = isset($input['unit_price']) && $input['unit_price'] !== '' && (float) $input['unit_price'] >= 0
                ? (float) $input['unit_price']
                : (float) ($prItem->estimated_unit_price ?? -1);
            $itemSupplierId = (int) ($input['supplier_id'] ?? $prItem->supplier_id ?? $globalSupplierId);

            if ($itemSupplierId <= 0) {
                throw ValidationException::withMessages(["financial_data.items.{$prItemId}.supplier_id" => ['يجب اختيار المورد لكل بند.']]);
            }
            if ($quantity <= 0) {
                throw ValidationException::withMessages(["financial_data.items.{$prItemId}.quantity" => ['الكمية يجب أن تكون أكبر من صفر.']]);
            }
            if ($unitPrice < 0) {
                throw ValidationException::withMessages(["financial_data.items.{$prItemId}.unit_price" => ['سعر الوحدة يجب أن يكون صفرًا أو أكبر.']]);
            }

            $supplierIds->push($itemSupplierId);

            $lineTotal = round($quantity * $unitPrice, 2);
            foreach (['supplier_id' => $itemSupplierId, 'quantity' => $quantity, 'estimated_unit_price' => $unitPrice, 'estimated_line_total' => $lineTotal] as $field => $newValue) {
                $oldValue = (string) ($prItem->{$field} ?? '');
                if ($oldValue !== (string) $newValue) {
                    AuditLog::create([
                        'user_id' => $accountant->id,
                        'entity_type' => get_class($prItem),
                        'entity_id' => $prItem->id,
                        'action' => 'ACCOUNTING_FINANCIAL_DATA_UPDATED',
                        'field_name' => $field,
                        'old_value' => $oldValue,
                        'new_value' => (string) $newValue,
                    ]);
                }
            }
            $prItem->update([
                'supplier_id' => $itemSupplierId,
                'quantity' => $quantity,
                'estimated_unit_price' => $unitPrice,
                'estimated_line_total' => $lineTotal,
            ]);
        }

        // Validate all referenced suppliers exist and are active
        $uniqueSupplierIds = $supplierIds->unique()->values()->all();
        $activeCount = Supplier::whereIn('id', $uniqueSupplierIds)->where('is_active', true)->count();
        if ($activeCount !== count($uniqueSupplierIds)) {
            throw ValidationException::withMessages(['financial_data.supplier_id' => ['أحد الموردين المختارين غير موجود أو غير نشط.']]);
        }

        // Use the first item's supplier as the PR-level direct_supplier_id for backward compatibility
        $primarySupplierId = $uniqueSupplierIds[0] ?? null;

        if (array_key_exists('notes', $financialData)) {
            $oldNotes = (string) ($pr->notes ?? '');
            $newNotes = (string) ($financialData['notes'] ?? '');
            if ($oldNotes !== $newNotes) {
                AuditLog::create([
                    'user_id' => $accountant->id,
                    'entity_type' => PurchaseRequest::class,
                    'entity_id' => $pr->id,
                    'action' => 'ACCOUNTING_FINANCIAL_DATA_UPDATED',
                    'field_name' => 'notes',
                    'old_value' => $oldNotes,
                    'new_value' => $newNotes,
                ]);
                $pr->notes = $financialData['notes'] ?: null;
            }
        }
        $pr->direct_supplier_id = $primarySupplierId;
        $pr->save();

        return round($requestItemsById->reduce(function (float $total, $prItem) use ($submittedById): float {
            $input = $submittedById->get((string) $prItem->id);
            return $total + round((float) $input['quantity'] * (float) $input['unit_price'], 2);
        }, 0.0), 2);
    }

    private function ensurePending(PurchaseRequest $request): void
    {
        if ($request->status !== self::PENDING_STATUS) {
            throw new \RuntimeException('الطلب ليس بانتظار الموافقة المالية المباشرة.');
        }
    }

    private function freshRequest(PurchaseRequest $request): PurchaseRequest
    {
        return $request->fresh([
            'requester',
            'department',
            'targetDepartment',
            'directSupplier',
            'assignedReviewer',
            'siteEngineer',
            'items.item',
            'items.supplier',
            'approvalHistory.actor',
        ]);
    }
}
