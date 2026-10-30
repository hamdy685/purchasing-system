<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use App\Models\PurchaseRequest;
use App\Models\User;
use App\Models\Supplier;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

class ProcurementPurchaseRequestService
{
    /**
     * Get PRs pending procurement manager approval.
     */
    public function getPendingProcurementApprovalRequests(int $perPage = 15)
    {
        return PurchaseRequest::with([
            'requester.roles',
            'requester.department',
            'department',
            'targetDepartment.manager',
            'targetDepartment.siteEngineer',
            'assignedReviewer',
            'siteEngineer',
            'directSupplier',
            'items.item',
            'items.supplier',
            'approvalHistory.actor',
            'supplements',
        ])->withCount(['purchaseOrders as issued_purchase_orders_count' => function ($query) {
            $query->whereNotIn('status', ['REJECTED']);
        }])
        ->where('status', 'PENDING_PROCUREMENT_APPROVAL')
        ->orderBy('updated_at', 'desc')
        ->paginate($perPage);
    }

    /**
     * Get PRs awaiting Executive Director / General Manager decisions.
     */
    public function getExecutivePendingRequests(int $perPage = 50)
    {
        return PurchaseRequest::with([
            'requester.roles',
            'requester.department',
            'department',
            'targetDepartment.manager',
            'targetDepartment.siteEngineer',
            'assignedReviewer',
            'siteEngineer',
            'directSupplier',
            'items.item',
            'items.supplier',
            'approvalHistory.actor',
            'quotes.supplier',
            'supplements',
        ])->withCount(['purchaseOrders as issued_purchase_orders_count' => function ($query) {
            $query->whereNotIn('status', ['REJECTED']);
        }])
        ->where('status', 'PENDING_EXECUTIVE_APPROVAL')
        ->where(function ($query) {
            $query->whereNull('request_type')->orWhere('request_type', '!=', 'COMPLEMENTARY');
        })
        ->orderBy('updated_at', 'desc')
        ->paginate($perPage);
    }

    /**
     * Get PRs waiting for the procurement manager to enter three supplier quotes.
     */
    public function getPendingQuoteRequests(int $perPage = 15, ?User $actor = null)
    {
        $query = PurchaseRequest::with([
            'requester.roles',
            'requester.department',
            'department',
            'targetDepartment.manager',
            'targetDepartment.siteEngineer',
            'assignedReviewer',
            'siteEngineer',
            'items.item',
            'items.supplier',
            'quotes.supplier',
            'quotes.recommendations.user',
            'supplements',
        ]);

        if ($actor?->hasRole('procurement_manager')) {
            $query->where('status', 'PENDING_QUOTE_RECOMMENDATIONS')
                ->whereDoesntHave('quotes');
        } elseif ($actor?->hasRole('reviewer')) {
            // Sequential workflow: Department reviewers must only see requests where ACCOUNTING recommendation has already been submitted,
            // and DEPARTMENT recommendation is not yet submitted.
            $query->where('status', 'PENDING_QUOTE_RECOMMENDATIONS')
                ->whereHas('quotes')
                ->whereHas('quotes.recommendations', function ($recommendationQuery): void {
                    $recommendationQuery->where('role_type', 'ACCOUNTING');
                })
                ->whereDoesntHave('quotes.recommendations', function ($recommendationQuery): void {
                    $recommendationQuery->where('role_type', 'DEPARTMENT');
                })
                ->whereDoesntHave('requester.roles', function ($roleQuery): void {
                    $roleQuery->where('slug', 'general_manager');
                })
                ->where(function ($scopeQuery) use ($actor): void {
                    $scopeQuery->where('reviewer_user_id', $actor->id)
                        ->orWhereHas('targetDepartment', function ($departmentQuery) use ($actor): void {
                            $departmentQuery->where('manager_user_id', $actor->id);
                        })
                        ->orWhereHas('department', function ($departmentQuery) use ($actor): void {
                            $departmentQuery->where('manager_user_id', $actor->id);
                        });

                    if ($actor->department_id) {
                        $scopeQuery->orWhere('department_id', $actor->department_id)
                                   ->orWhere('target_department_id', $actor->department_id);
                    }
                });
        } elseif ($actor?->hasRole('accountant')) {
            // Financial Director must only see requests where ACCOUNTING recommendation is not yet submitted.
            $query->where('status', 'PENDING_QUOTE_RECOMMENDATIONS')
                ->whereHas('quotes')
                ->whereDoesntHave('quotes.recommendations', function ($recommendationQuery): void {
                    $recommendationQuery->where('role_type', 'ACCOUNTING');
                });
        } elseif ($actor?->hasRole('execution_manager')) {
            $query->where('status', 'PENDING_EXECUTIVE_QUOTE_DECISION')
                ->whereHas('quotes')
                ->whereHas('requester', fn ($q) => $q->where('manager_id', $actor->id));
        } elseif ($actor?->hasRole('general_manager')) {
            $query->where('status', 'PENDING_EXECUTIVE_QUOTE_DECISION')
                ->whereHas('quotes')
                ->whereDoesntHave('requester.manager.roles', fn ($q) => $q->where('slug', 'execution_manager'));
        } elseif ($actor?->hasRole('admin')) {
            $query->whereIn('status', ['PENDING_QUOTE_RECOMMENDATIONS', 'PENDING_EXECUTIVE_QUOTE_DECISION'])
                ->whereHas('quotes');
        } else {
            $query->whereRaw('1 = 0');
        }

        return $query->orderBy('updated_at', 'desc')->paginate($perPage);
    }

    /**
     * Get purchase requests ready for PO creation: quote decisions approved by procurement or direct requests approved by accounting.
     */
    public function getApprovedByProcurementRequests(int $perPage = 15)
    {
        return PurchaseRequest::with([
            'requester.roles',
            'requester.department',
            'department',
            'targetDepartment.manager',
            'targetDepartment.siteEngineer',
            'assignedReviewer',
            'siteEngineer',
            'directSupplier',
            'items.item',
            'items.supplier',
            'selectedQuote.supplier',
            'quotes.supplier',
            'approvalHistory.actor',
            'supplements.items.item',
            'supplements.requester',
            'supplements.reviewer',
            'purchaseOrders.supplier',
        ])
            ->withCount(['purchaseOrders as issued_purchase_orders_count' => function ($query) {
                $query->whereNotIn('status', ['REJECTED']);
            }])
            ->where(function ($query): void {
                $query->where(function ($regularQuery): void {
                    $regularQuery->where(function ($eligibilityQuery): void {
                        $eligibilityQuery->whereDoesntHave('purchaseOrders', function ($poQuery): void {
                            $poQuery->whereNotIn('status', ['REJECTED', 'CANCELLED', 'VOIDED']);
                        })->orWhereHas('items', function ($itemQuery): void {
                            $itemQuery->whereNot(fn ($orderedQuery) => PurchaseOrderSourceService::orderedScope($orderedQuery));
                        });
                    })->where(function ($statusQuery): void {
                        $statusQuery->where(function ($quotePath): void {
                            $quotePath
                                ->where('status', 'APPROVED_BY_PROCUREMENT')
                                ->where(function ($route): void {
                                    $route->whereNull('procurement_route')->orWhere('procurement_route', '!=', 'DIRECT');
                                });
                        })->orWhere(function ($directPath): void {
                            $directPath
                                ->where('status', 'APPROVED_BY_ACCOUNTING')
                                ->where('procurement_route', 'DIRECT');
                        });
                    });
                })->orWhereHas('supplements', function ($suppQuery): void {
                    $suppQuery->whereIn('status', ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED']);
                });
            })
            ->orderBy('updated_at', 'desc')
            ->paginate($perPage);
    }

    /**
     * Procurement Manager starts the supplier quote process (PENDING_PROCUREMENT_APPROVAL or PENDING_EXECUTIVE_APPROVAL → PENDING_QUOTE_RECOMMENDATIONS).
     */
    public function approvePurchaseRequest(User $procurementManager, PurchaseRequest $request, ?string $comment = null): PurchaseRequest
    {
        $allowedStatuses = ['PENDING_PROCUREMENT_APPROVAL', 'PENDING_EXECUTIVE_APPROVAL'];
        if (! in_array($request->status, $allowedStatuses, true)) {
            throw new \RuntimeException('Only purchase requests pending procurement or executive approval can be approved by the procurement manager.');
        }

        if ($request->items()->count() === 0) {
            throw new \RuntimeException('Cannot approve a purchase request with no line items.');
        }

        return DB::transaction(function () use ($procurementManager, $request, $comment, $allowedStatuses) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->first();
            if (! $pr || ! in_array($pr->status, $allowedStatuses, true)) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن طلب الشراء أو لم يعد متاحًا لاتخاذ الإجراء.');
            }

            $fromState = $pr->status;

            $pr->update([
                'status' => 'PENDING_QUOTE_RECOMMENDATIONS',
                'procurement_route' => 'QUOTES',
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($pr);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $procurementManager->id,
                'action' => 'THREE_QUOTES_REQUIRED',
                'from_state' => $fromState,
                'to_state' => 'PENDING_QUOTE_RECOMMENDATIONS',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment ?? 'بدأ مدير المشتريات تجهيز عروض أسعار من موردين مختلفين.',
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'THREE_QUOTES_REQUIRED',
                'بدأ مدير المشتريات تجهيز عروض أسعار من موردين مختلفين للطلب.',
                ['event_type' => 'purchase_request.quotes_required', 'from_state' => $fromState, 'to_state' => 'PENDING_QUOTE_RECOMMENDATIONS', 'actor_user_id' => $procurementManager->id, 'metadata' => ['comment' => $comment]]
            );

            AuditLog::create([
                'user_id' => $procurementManager->id,
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'action' => 'THREE_QUOTES_REQUIRED',
                'field_name' => 'status',
                'old_value' => $fromState,
                'new_value' => 'PENDING_QUOTE_RECOMMENDATIONS',
            ]);

            return $pr->fresh(['requester.roles', 'department', 'items.item', 'items.supplier', 'approvalHistory']);
        });
    }

    /**
     * Send a purchase request directly to accounting when procurement decides that quotes are not required.
     * Also supports fast-track pricing from PENDING_EXECUTIVE_APPROVAL, skipping preliminary approval and routing directly to final executive approval.
     */
    public function sendToAccountingWithoutQuotes(User $procurementManager, PurchaseRequest $request, array $financialData = [], ?string $comment = null): PurchaseRequest
    {
        $allowedStatuses = ['PENDING_PROCUREMENT_APPROVAL', 'PENDING_EXECUTIVE_APPROVAL'];
        if (! in_array($request->status, $allowedStatuses, true)) {
            throw new \RuntimeException('يمكن إرسال الطلب إلى الحسابات فقط من مرحلة اعتماد المشتريات أو انتظار اعتماد المدير التنفيذي.');
        }

        $submittedItems = $financialData['items'] ?? [];
        $hasNotes = array_key_exists('notes', $financialData);
        $notes = $hasNotes ? (trim((string) ($financialData['notes'] ?? '')) ?: null) : null;
        // Legacy fallback: accept a top-level supplier_id for backward compatibility
        $globalSupplierId = (int) ($financialData['supplier_id'] ?? 0);
        if (! is_array($submittedItems) || count($submittedItems) === 0) {
            throw ValidationException::withMessages(['items' => ['يجب إدخال البيانات المالية لبند واحد على الأقل قبل الإرسال.']]);
        }

        return DB::transaction(function () use ($procurementManager, $request, $globalSupplierId, $submittedItems, $hasNotes, $notes, $comment, $allowedStatuses): PurchaseRequest {
            $pr = PurchaseRequest::with('items')->where('id', $request->id)->lockForUpdate()->firstOrFail();
            if (! in_array($pr->status, $allowedStatuses, true)) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن طلب الشراء أو لم يعد متاحًا للاعتماد.');
            }

            $fromState = $pr->status;
            $isFastTrack = ($fromState === 'PENDING_EXECUTIVE_APPROVAL');

            $requestItemsById = $pr->items->keyBy('id');
            $submittedById = collect($submittedItems)->keyBy(fn (array $item): int => (int) ($item['pr_item_id'] ?? 0));
            if ($submittedById->count() !== $requestItemsById->count() || $submittedById->keys()->diff($requestItemsById->keys())->isNotEmpty()) {
                throw ValidationException::withMessages(['items' => ['يجب إدخال البيانات المالية لجميع بنود الطلب دون حذف أو إضافة بند.']]);
            }

            // Validate and resolve per-item suppliers
            $supplierIds = collect();
            $grandTotal = 0.0;
            foreach ($requestItemsById as $prItemId => $prItem) {
                $input = $submittedById->get($prItemId);
                $quantity = (float) ($input['quantity'] ?? 0);
                $unitPrice = (float) ($input['unit_price'] ?? -1);
                $itemSupplierId = (int) ($input['supplier_id'] ?? $globalSupplierId);

                if ($itemSupplierId <= 0) {
                    throw ValidationException::withMessages(["items.{$prItemId}.supplier_id" => ['يجب اختيار المورد لكل بند.']]);
                }
                if ($quantity <= 0 || $unitPrice < 0) {
                    throw ValidationException::withMessages([
                        "items.{$prItemId}.quantity" => ['الكمية يجب أن تكون أكبر من صفر.'],
                        "items.{$prItemId}.unit_price" => ['سعر الوحدة يجب أن يكون صفرًا أو أكبر.'],
                    ]);
                }

                $supplierIds->push($itemSupplierId);
                $lineTotal = round($quantity * $unitPrice, 2);
                $itemUpdateData = [
                    'supplier_id' => $itemSupplierId,
                    'quantity' => $quantity,
                    'estimated_unit_price' => $unitPrice,
                    'estimated_line_total' => $lineTotal,
                ];
                if (!empty($input['uom'])) {
                    $itemUpdateData['uom'] = trim((string) $input['uom']);
                }
                $prItem->update($itemUpdateData);
                $grandTotal += $lineTotal;
            }

            // Validate all referenced suppliers exist and are active
            $uniqueSupplierIds = $supplierIds->unique()->values()->all();
            $activeCount = Supplier::whereIn('id', $uniqueSupplierIds)->where('is_active', true)->count();
            if ($activeCount !== count($uniqueSupplierIds)) {
                throw ValidationException::withMessages(['supplier_id' => ['أحد الموردين المختارين غير موجود أو غير نشط.']]);
            }

            // Use the first item's supplier as the PR-level direct_supplier_id for backward compatibility
            $primarySupplierId = $uniqueSupplierIds[0] ?? null;

            $oldNotes = (string) ($pr->notes ?? '');
            if ($hasNotes && $oldNotes !== (string) ($notes ?? '')) {
                AuditLog::create([
                    'user_id' => $procurementManager->id,
                    'entity_type' => PurchaseRequest::class,
                    'entity_id' => $pr->id,
                    'action' => 'DIRECT_FINANCIAL_DATA_UPDATED',
                    'field_name' => 'notes',
                    'old_value' => $oldNotes,
                    'new_value' => (string) ($notes ?? ''),
                ]);
            }

            $pr->update([
                'status' => 'PENDING_EXECUTIVE_APPROVAL',
                'procurement_route' => 'DIRECT',
                'direct_supplier_id' => $primarySupplierId,
                'total_estimated_cost' => round($grandTotal, 2),
                ...($hasNotes ? ['notes' => $notes] : []),
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($pr);

            $action = $isFastTrack ? 'FAST_TRACK_PRICING_SKIPPED_PRELIMINARY' : 'DIRECT_EXECUTIVE_REVIEW_REQUIRED';
            $actionComment = $comment ?? ($isFastTrack
                ? 'قام مدير المشتريات بتسعير الطلب مباشرة واختيار المورد وتخطي مرحلة الاعتماد المبدئي وأرسل الطلب إلى المدير التنفيذي للاعتماد النهائي.'
                : 'أدخل مدير المشتريات البيانات المالية واختار المورد ثم أرسل الطلب إلى المدير التنفيذي المهندس محمد للاعتماد.');

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $procurementManager->id,
                'action' => $action,
                'from_state' => $fromState,
                'to_state' => 'PENDING_EXECUTIVE_APPROVAL',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $actionComment,
            ]);

            AuditLog::create([
                'user_id' => $procurementManager->id,
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'action' => $action,
                'field_name' => 'status',
                'old_value' => $fromState,
                'new_value' => 'PENDING_EXECUTIVE_APPROVAL',
            ]);

            $requester = $pr->requester;
            $directManager = ($requester && $requester->manager_id)
                ? User::with('roles')->where('id', $requester->manager_id)->where('is_active', true)->first()
                : null;
            $isExecutionManager = $directManager && $directManager->hasRole('execution_manager');
            $targetExecutiveTitle = $isExecutionManager ? "مدير مشروعات التنفيذ ({$directManager->name})" : 'المدير التنفيذي';

            $systemEventDesc = $isFastTrack
                ? "قام مدير المشتريات بتسعير الطلب واختيار المورد وتخطي الاعتماد المبدئي، وأرسله مسعرًا إلى {$targetExecutiveTitle} للاعتماد النهائي."
                : "أدخل مدير المشتريات البيانات المالية واختار المورد وأرسل طلب الشراء المباشر إلى {$targetExecutiveTitle} للاعتماد.";

            app(SystemEventService::class)->recordAction(
                $pr,
                $action,
                $systemEventDesc,
                [
                    'event_type' => $isFastTrack ? 'purchase_request.fast_track_pricing' : 'purchase_request.direct_executive_review_required',
                    'from_state' => $fromState,
                    'to_state' => 'PENDING_EXECUTIVE_APPROVAL',
                    'actor_user_id' => $procurementManager->id,
                    'metadata' => ['comment' => $comment, 'requires_quotes' => false, 'supplier_ids' => $uniqueSupplierIds, 'total_estimated_cost' => round($grandTotal, 2), 'is_fast_track' => $isFastTrack],
                ]
            );

            $notificationService = app(NotificationService::class);
            if ($isExecutionManager) {
                $notificationService->queueNotification(
                    $directManager->id,
                    'purchase_request_pending_executive_approval',
                    'طلب شراء مسعر بانتظار اعتمادك النهائي',
                    "أرسل مدير المشتريات الطلب {$pr->request_number} لموظفك ({$requester->name}) بعد تحديد المورد والأسعار لاعتمادك النهائي.",
                    $pr
                );
            } else {
                $gmUsers = User::whereHas('roles', fn ($q) => $q->where('slug', 'general_manager'))->where('is_active', true)->get();
                $notificationService->queueUsers(
                    $gmUsers,
                    'purchase_request_pending_executive_approval',
                    'طلب شراء مباشر مسعر بانتظار اعتماد المدير التنفيذي',
                    "أرسل مدير المشتريات الطلب {$pr->request_number} بعد تحديد المورد والأسعار إلى المدير التنفيذي للاعتماد النهائي.",
                    $pr
                );
            }

            return $pr->fresh(['requester.roles', 'department', 'targetDepartment', 'directSupplier', 'assignedReviewer', 'siteEngineer', 'items.item', 'items.supplier', 'approvalHistory']);
        });
    }

    /**
     * Generate sequential unique Direct Purchase Request number (PR-DIRECT-1, PR-DIRECT-2, ...).
     * Simple, clean, ascending starting from 1 with no leading zeros.
     */
    public function generateDirectRequestNumber(string $prefix = 'PR-DIRECT-'): string
    {
        $latestRequest = DB::table('purchase_requests')
            ->where('request_number', 'like', "{$prefix}%")
            ->orderBy('id', 'desc')
            ->lockForUpdate()
            ->first();

        $maxSeq = 0;
        if ($latestRequest) {
            $parts = explode('-', $latestRequest->request_number);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $maxSeq = (int) $lastPart;
            }
        }

        $existing = DB::table('purchase_requests')
            ->where('request_number', 'like', "{$prefix}%")
            ->pluck('request_number');

        foreach ($existing as $num) {
            $parts = explode('-', (string) $num);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $seq = (int) $lastPart;
                if ($seq > $maxSeq) {
                    $maxSeq = $seq;
                }
            }
        }

        $nextNumber = max(1, $maxSeq + 1);

        while (DB::table('purchase_requests')->where('request_number', "{$prefix}{$nextNumber}")->exists()) {
            $nextNumber++;
        }

        return "{$prefix}{$nextNumber}";
    }

    /**
     * Create a direct purchase request that must pass accounting approval before PO creation.
     */
    public function createDirectPurchaseRequest(User $procurementManager, array $data): PurchaseRequest
    {
        $maxAttempts = 5;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                return DB::transaction(function () use ($procurementManager, $data): PurchaseRequest {
                    $prNumber = $this->generateDirectRequestNumber();
            $total = 0.0;

            foreach ($data['items'] as $item) {
                $total += (float) $item['quantity'] * (float) $item['unit_price'];
            }

            $pr = PurchaseRequest::create([
                'request_number' => $prNumber,
                'user_id' => $procurementManager->id,
                'department_id' => $data['department_id'],
                'site_engineer_user_id' => $data['site_engineer_user_id'],
                'requires_warehouse_receipt' => array_key_exists('requires_warehouse_receipt', $data) ? (bool)$data['requires_warehouse_receipt'] : true,
                'direct_supplier_id' => $data['supplier_id'],
                'procurement_route' => 'DIRECT',
                'status' => 'PENDING_EXECUTIVE_APPROVAL',
                'priority' => $data['priority'] ?? 'NORMAL',
                'date_needed' => $data['delivery_date'] ?? null,
                'total_estimated_cost' => round($total, 2),
                'notes' => $data['notes'] ?? null,
            ]);

            foreach ($data['items'] as $item) {
                $quantity = (float) $item['quantity'];
                $unitPrice = (float) $item['unit_price'];
                $pr->items()->create([
                    'item_id' => $item['item_id'] ?? null,
                    'supplier_id' => $item['supplier_id'] ?? $data['supplier_id'] ?? null,
                    'item_description' => $item['item_description'],
                    'item_reference' => $item['item_reference'],
                    'region' => $item['region'],
                    'quantity' => $quantity,
                    'uom' => $item['uom'] ?? 'PCS',
                    'estimated_unit_price' => $unitPrice,
                    'estimated_line_total' => round($quantity * $unitPrice, 2),
                    'specifications' => $item['specifications'] ?? null,
                ]);
            }

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $procurementManager->id,
                'action' => 'DIRECT_PURCHASE_REQUEST_CREATED',
                'from_state' => 'DRAFT',
                'to_state' => 'PENDING_EXECUTIVE_APPROVAL',
                'comments' => 'أنشأ مدير المشتريات طلب شراء مباشرًا وأرسله إلى المدير التنفيذي المهندس محمد للاعتماد.',
            ]);

            AuditLog::create([
                'user_id' => $procurementManager->id,
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'action' => 'DIRECT_PURCHASE_REQUEST_CREATED',
                'field_name' => 'status',
                'old_value' => 'DRAFT',
                'new_value' => 'PENDING_EXECUTIVE_APPROVAL',
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'DIRECT_PURCHASE_REQUEST_CREATED',
                'أنشأ مدير المشتريات طلب شراء مباشرًا وأرسله إلى المدير التنفيذي للاعتماد.',
                [
                    'event_type' => 'purchase_request.direct_created',
                    'from_state' => 'DRAFT',
                    'to_state' => 'PENDING_EXECUTIVE_APPROVAL',
                    'actor_user_id' => $procurementManager->id,
                    'metadata' => ['supplier_id' => $data['supplier_id'], 'total' => round($total, 2)],
                ]
            );

            $notificationService = app(NotificationService::class);
            $gmUsers = User::whereHas('roles', fn ($q) => $q->where('slug', 'general_manager'))->where('is_active', true)->get();
            $notificationService->queueUsers(
                $gmUsers,
                'purchase_request_pending_executive_approval',
                'طلب شراء مباشر بانتظار اعتماد المدير التنفيذي',
                "أنشأ مدير المشتريات الطلب المباشر {$pr->request_number} وهو بانتظار اعتماد المدير التنفيذي.",
                $pr
            );

            return $pr->fresh([
                'requester.roles',
                'department',
                'directSupplier',
                'siteEngineer',
                'items.item',
                'items.supplier',
                'approvalHistory.actor',
            ]);
        });
            } catch (QueryException $e) {
                $isDuplicate = $e->getCode() == 23000
                    || ($e->errorInfo[1] ?? null) == 1062
                    || str_contains($e->getMessage(), '1062')
                    || str_contains($e->getMessage(), 'Duplicate entry')
                    || str_contains($e->getMessage(), 'request_number');

                if ($isDuplicate && $attempt < $maxAttempts) {
                    Log::warning("ProcurementPurchaseRequestService: Duplicate request_number collision detected on attempt {$attempt}, retrying...", [
                        'user_id' => $procurementManager->id,
                        'attempt' => $attempt,
                        'error' => $e->getMessage(),
                    ]);
                    usleep(random_int(20000, 100000));
                    continue;
                }

                throw $e;
            }
        }

        throw new \RuntimeException('تعذر إنشاء طلب الشراء المباشر بسبب تداخل أرقام الطلبات. يرجى إعادة المحاولة.');
    }

    /**
     * Procurement Manager rejects PR (PENDING_PROCUREMENT_APPROVAL or PENDING_EXECUTIVE_APPROVAL → REJECTED).
     */
    public function rejectPurchaseRequest(User $procurementManager, PurchaseRequest $request, string $comment): PurchaseRequest
    {
        $allowedStatuses = ['PENDING_PROCUREMENT_APPROVAL', 'PENDING_EXECUTIVE_APPROVAL'];
        if (! in_array($request->status, $allowedStatuses, true)) {
            throw new \RuntimeException('Only purchase requests pending procurement or executive approval can be rejected by the procurement manager.');
        }

        return DB::transaction(function () use ($procurementManager, $request, $comment, $allowedStatuses) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->first();
            if (! $pr || ! in_array($pr->status, $allowedStatuses, true)) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن طلب الشراء أو لم يعد متاحًا لاتخاذ الإجراء.');
            }

            $fromState = $pr->status;

            $pr->update([
                'status' => 'REJECTED',
                'rejection_reason' => $comment,
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($pr);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $procurementManager->id,
                'action' => 'REJECTED_BY_PROCUREMENT',
                'from_state' => $fromState,
                'to_state' => 'REJECTED',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment,
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'REJECTED_BY_PROCUREMENT',
                'رفض مدير المشتريات طلب الشراء.',
                ['event_type' => 'purchase_request.rejected_by_procurement', 'from_state' => $fromState, 'to_state' => 'REJECTED', 'actor_user_id' => $procurementManager->id, 'metadata' => ['comment' => $comment]]
            );

            AuditLog::create([
                'user_id' => $procurementManager->id,
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'action' => 'PROCUREMENT_REJECTED',
                'field_name' => 'status',
                'old_value' => $fromState,
                'new_value' => 'REJECTED',
            ]);

            // Notify the PR requester
            $notificationService = app(NotificationService::class);
            $rejMsg = "طلب الشراء {$pr->request_number} رُفض من قِبَل مدير المشتريات.";
            if (! empty($comment)) {
                $rejMsg .= " السبب: {$comment}";
            }
            $notificationService->queueNotification(
                $pr->user_id,
                'purchase_request_rejected_procurement',
                'طلب الشراء مرفوض من المشتريات',
                $rejMsg,
                $pr
            );

            return $pr->fresh(['requester.roles', 'department', 'items.item', 'items.supplier', 'approvalHistory']);
        });
    }

    /**
     * Revert PR route from PENDING_QUOTE_RECOMMENDATIONS back to PENDING_PROCUREMENT_APPROVAL (UNDECIDED route)
     * so Procurement Manager can change decision, select direct route, or input direct prices.
     */
    public function resetRoute(User $procurementManager, PurchaseRequest $request, ?string $comment = null): PurchaseRequest
    {
        if (! in_array($request->status, ['PENDING_QUOTE_RECOMMENDATIONS', 'PENDING_PROCUREMENT_APPROVAL'], true)) {
            throw new \RuntimeException('لا يمكن التراجع إلا إذا كان الطلب في مرحلة عروض الأسعار أو اعتماد المشتريات ولم يتم إصدار أمر شراء له.');
        }

        return DB::transaction(function () use ($procurementManager, $request, $comment) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->first();
            $oldStatus = $pr->status;

            // Delete any unselected quotes created during quotes stage
            $pr->quotes()->delete();

            $pr->update([
                'status' => 'PENDING_PROCUREMENT_APPROVAL',
                'procurement_route' => 'UNDECIDED',
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $procurementManager->id,
                'action' => 'ROUTE_RESET_TO_PENDING',
                'from_state' => $oldStatus,
                'to_state' => 'PENDING_PROCUREMENT_APPROVAL',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment ?? 'تم التراجع عن مسار عروض الأسعار وإعادة الطلب إلى قسم اختيار المسار وتحديد الأسعار المباشرة.',
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'ROUTE_RESET_TO_PENDING',
                'تم التراجع عن مسار عروض الأسعار وإعادة الطلب إلى مرحلة اختيار المسار وتحديد الأسعار.',
                [
                    'event_type' => 'purchase_request.route_reset',
                    'from_state' => $oldStatus,
                    'to_state' => 'PENDING_PROCUREMENT_APPROVAL',
                    'actor_user_id' => $procurementManager->id,
                    'metadata' => ['comment' => $comment],
                ]
            );

            return $pr->fresh(['requester.roles', 'department', 'items.item', 'items.supplier', 'approvalHistory']);
        });
    }
}

