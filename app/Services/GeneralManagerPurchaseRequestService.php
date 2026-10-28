<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use App\Models\PurchaseRequest;
use App\Models\User;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class GeneralManagerPurchaseRequestService
{
    public const PENDING_STATUS = 'PENDING_EXECUTIVE_APPROVAL';

    public function getPendingRequests(int $perPage = 50, ?User $user = null): LengthAwarePaginator
    {
        $query = PurchaseRequest::query()
            ->with([
                'requester.roles',
                'department:id,name,code',
                'targetDepartment:id,name,code',
                'directSupplier:id,company_name',
                'assignedReviewer.roles',
                'siteEngineer.roles',
                'items.item',
                'items.supplier',
                'approvalHistory.actor.roles',
                'quotes.supplier',
                'quotes.recommendations.user.roles',
                'selectedQuote.supplier',
            ])
            ->where('status', self::PENDING_STATUS)
            ->where(function ($q) {
                $q->whereNull('request_type')->orWhere('request_type', '!=', 'COMPLEMENTARY');
            });

        if ($user && $user->hasRole('execution_manager')) {
            $query->where(function ($q) use ($user) {
                $q->where('reviewer_user_id', $user->id)
                    ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));
            });
        } elseif ($user && ! $user->hasRole('admin')) {
            $hasExecutionManager = User::whereHas('roles', fn ($q) => $q->where('slug', 'execution_manager'))->where('is_active', true)->exists();
            if ($hasExecutionManager) {
                $query->where(function ($q) {
                    $q->whereDoesntHave('requester.manager.roles', fn ($mq) => $mq->where('slug', 'execution_manager'))
                        ->whereDoesntHave('assignedReviewer.roles', fn ($rq) => $rq->where('slug', 'execution_manager'));
                });
            }
        }

        return $query->orderByDesc('updated_at')
            ->paginate(min(max($perPage, 1), 100));
    }

    public function getPendingRequest(int $id, ?User $user = null): PurchaseRequest
    {
        $query = PurchaseRequest::query()
            ->with([
                'requester.roles',
                'department:id,name,code',
                'targetDepartment:id,name,code',
                'directSupplier:id,company_name',
                'assignedReviewer.roles',
                'siteEngineer.roles',
                'items.item',
                'items.supplier',
                'approvalHistory.actor.roles',
                'quotes.supplier',
                'quotes.recommendations.user.roles',
                'selectedQuote.supplier',
            ])
            ->where('status', self::PENDING_STATUS);

        if ($user && $user->hasRole('execution_manager')) {
            $query->where(function ($q) use ($user) {
                $q->where('reviewer_user_id', $user->id)
                    ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));
            });
        } elseif ($user && ! $user->hasRole('admin')) {
            $hasExecutionManager = User::whereHas('roles', fn ($q) => $q->where('slug', 'execution_manager'))->where('is_active', true)->exists();
            if ($hasExecutionManager) {
                $query->where(function ($q) {
                    $q->whereDoesntHave('requester.manager.roles', fn ($mq) => $mq->where('slug', 'execution_manager'))
                        ->whereDoesntHave('assignedReviewer.roles', fn ($rq) => $rq->where('slug', 'execution_manager'));
                });
            }
        }

        return $query->findOrFail($id);
    }

    public function updateRequest(User $executive, PurchaseRequest $request, array $data): PurchaseRequest
    {
        $this->ensurePending($request);

        if ($executive->hasRole('accountant') && ! $executive->hasRole('admin')) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('المدير المالي ليس له صلاحية تعديل القيم المالية أو تغيير المورد. دوره يقتصر حصرياً على الموافقة أو الرفض.');
        }

        if ($executive->hasRole('execution_manager')) {
            if (! $this->canManageExecutionRequest($executive, $request)) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('غير مصرح لك بتعديل طلب شراء لا يقع ضمن مهندسي إدارة التنفيذ (م. كامل).');
            }
        } elseif (! $executive->hasRole('admin')) {
            $hasExecutionManager = User::whereHas('roles', fn ($q) => $q->where('slug', 'execution_manager'))->where('is_active', true)->exists();
            if ($hasExecutionManager && $this->isExecutionRequest($request)) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('هذا الطلب يتبع مدير مشروعات التنفيذ (م. كريم) ولا يقرره المدير العام (م. محمد).');
            }
        }

        return DB::transaction(function () use ($executive, $request, $data): PurchaseRequest {
            $pr = PurchaseRequest::query()->lockForUpdate()->findOrFail($request->id);
            if ($pr->status !== self::PENDING_STATUS) {
                throw new \RuntimeException('الطلب ليس بانتظار قرار المدير التنفيذي أو تم اتخاذ قرار بشأنه بالفعل.');
            }
            $oldState = $pr->status;
            $updateFields = [];

            foreach (['date_needed', 'notes'] as $field) {
                if (array_key_exists($field, $data) && (string) ($pr->{$field} ?? '') !== (string) ($data[$field] ?? '')) {
                    $updateFields[$field] = $data[$field];
                }
            }

            if (array_key_exists('items', $data)) {
                $items = $data['items'];
                if (count($items) === 0) {
                    throw ValidationException::withMessages([
                        'items' => ['يجب أن يحتوي الطلب على بند واحد على الأقل.'],
                    ]);
                }

                $existingItems = $pr->items->keyBy('id');
                $normalizedItems = [];
                $totalEstimatedCost = 0.0;
                $primarySupplierId = $pr->direct_supplier_id;

                foreach ($items as $index => $item) {
                    $reference = trim((string) ($item['item_reference'] ?? ''));
                    $region = trim((string) ($item['region'] ?? ''));
                    if ($reference === '' || $region === '') {
                        $errors = [];
                        if ($reference === '') {
                            $errors["items.{$index}.item_reference"] = ['رقم قطعة الأرض مطلوب.'];
                        }
                        if ($region === '') {
                            $errors["items.{$index}.region"] = ['المنطقة مطلوبة.'];
                        }
                        throw ValidationException::withMessages($errors);
                    }

                    $quantity = (float) ($item['quantity'] ?? 0);
                    if ($quantity <= 0) {
                        throw ValidationException::withMessages([
                            "items.{$index}.quantity" => ['الكمية يجب أن تكون أكبر من صفر.'],
                        ]);
                    }

                    $existingItem = !empty($item['id']) ? $existingItems->get((int) $item['id']) : ($pr->items[$index] ?? null);

                    $supplierId = array_key_exists('supplier_id', $item)
                        ? (!empty($item['supplier_id']) ? (int) $item['supplier_id'] : null)
                        : ($existingItem?->supplier_id ?? null);

                    $unitPrice = array_key_exists('estimated_unit_price', $item) && $item['estimated_unit_price'] !== null && $item['estimated_unit_price'] !== ''
                        ? (float) $item['estimated_unit_price']
                        : (float) ($existingItem?->estimated_unit_price ?? 0.0);

                    $lineTotal = round($quantity * $unitPrice, 2);
                    $totalEstimatedCost += $lineTotal;
                    if ($supplierId && !$primarySupplierId) {
                        $primarySupplierId = $supplierId;
                    }

                    $normalizedItems[] = [
                        'item_id' => $item['item_id'] ?? $existingItem?->item_id ?? null,
                        'item_description' => $item['item_description'] ?? $existingItem?->item_description ?? '',
                        'item_reference' => $reference,
                        'region' => $region,
                        'quantity' => $quantity,
                        'uom' => $item['uom'] ?? $existingItem?->uom ?? 'PCS',
                        'specifications' => $item['specifications'] ?? $existingItem?->specifications ?? null,
                        'notes' => $item['notes'] ?? $existingItem?->notes ?? null,
                        'supplier_id' => $supplierId,
                        'estimated_unit_price' => $unitPrice,
                        'estimated_line_total' => $lineTotal,
                        'is_consolidated_steel' => (bool) ($existingItem?->is_consolidated_steel),
                        // Snapshot reference-only steel diameters before the items are recreated.
                        '_steel_components' => $existingItem?->is_consolidated_steel
                            ? $existingItem->steelComponents()->get()->map(fn ($c) => collect($c->getAttributes())
                                ->except(['id', 'purchase_request_item_id', 'purchase_order_item_id', 'created_at', 'updated_at'])
                                ->all())->all()
                            : [],
                    ];
                }

                $pr->items()->delete();
                foreach ($normalizedItems as $normItem) {
                    $components = $normItem['_steel_components'];
                    unset($normItem['_steel_components']);
                    $newItem = $pr->items()->create($normItem);
                    foreach ($components as $component) {
                        $newItem->steelComponents()->create($component);
                    }
                }

                if ($primarySupplierId) {
                    $updateFields['direct_supplier_id'] = $primarySupplierId;
                }
                if ($totalEstimatedCost > 0) {
                    $updateFields['total_estimated_cost'] = round($totalEstimatedCost, 2);
                }
            }

            $isDirect = ($pr->procurement_route === 'DIRECT') || (!empty($primarySupplierId) && $totalEstimatedCost > 0);
            $nextStatus = $isDirect ? 'PENDING_ACCOUNTING_APPROVAL' : 'PENDING_PROCUREMENT_APPROVAL';
            $updateFields['status'] = $nextStatus;
            $pr->update($updateFields);

            app(NotificationService::class)->markEntityNotificationsAsRead($pr);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $executive->id,
                'action' => 'EDITED_BY_EXECUTIVE',
                'from_state' => $oldState,
                'to_state' => $nextStatus,
                'comments' => $data['comment'] ?? ($isDirect ? 'تم اعتماد وتعديل الطلب من المدير التنفيذي وإحالته للإدارة المالية.' : 'تم تعديل الطلب من المدير التنفيذي وإرساله للمشتريات.'),
            ]);

            AuditLog::create([
                'user_id' => $executive->id,
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'action' => 'EDITED_BY_EXECUTIVE',
                'old_value' => json_encode(['status' => $oldState], JSON_UNESCAPED_UNICODE),
                'new_value' => json_encode(['status' => $nextStatus], JSON_UNESCAPED_UNICODE),
            ]);

            if ($isDirect) {
                $notificationService = app(NotificationService::class);
                $notificationService->queueUsers(
                    $notificationService->resolveUsersWithPermission('purchase_request.accounting_view'),
                    'purchase_request_pending_accounting_approval',
                    'طلب شراء معتمد تنفيذيًا بانتظار الموافقة المالية',
                    "اعتمد المدير التنفيذي الطلب {$pr->request_number} بعد مراجعة البنود، وهو الآن بانتظار موافقة الإدارة المالية.",
                    $pr
                );
            } else {
                $this->notifyProcurement($pr, 'تم تعديل طلب الشراء من المدير التنفيذي وإرساله إلى مدير المشتريات.');
            }

            return $pr->fresh([
                'requester',
                'department',
                'directSupplier',
                'assignedReviewer',
                'siteEngineer',
                'items.item',
                'items.supplier',
                'approvalHistory',
            ]);
        });
    }

    public function approveRequest(User $executive, PurchaseRequest $request, ?string $comment): PurchaseRequest
    {
        $this->ensurePending($request);

        if ($executive->hasRole('execution_manager')) {
            if (! $this->canManageExecutionRequest($executive, $request)) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('غير مصرح لك باعتماد طلب شراء لا يقع ضمن مهندسي إدارة التنفيذ (م. كامل).');
            }
        } elseif (! $executive->hasRole('admin')) {
            $hasExecutionManager = User::whereHas('roles', fn ($q) => $q->where('slug', 'execution_manager'))->where('is_active', true)->exists();
            if ($hasExecutionManager && $this->isExecutionRequest($request)) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('هذا الطلب يتبع مدير مشروعات التنفيذ (م. كريم) ولا يقرره المدير العام (م. محمد).');
            }
        }

        $actorTitle = $executive->hasRole('execution_manager') ? "مدير مشروعات التنفيذ ({$executive->name})" : "المدير التنفيذي ({$executive->name})";

        return DB::transaction(function () use ($executive, $request, $comment, $actorTitle): PurchaseRequest {
            $pr = PurchaseRequest::query()->lockForUpdate()->with(['items', 'approvalHistory.actor.roles'])->findOrFail($request->id);
            if ($pr->status !== self::PENDING_STATUS) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن طلب الشراء بالفعل أو لم يعد بانتظار المدير التنفيذي.');
            }
            $isFinalApproval = $pr->isPricedForFinalApproval();
            $nextStatus = $isFinalApproval ? 'PENDING_ACCOUNTING_APPROVAL' : 'PENDING_PROCUREMENT_APPROVAL';
            $pr->update([
                'status' => $nextStatus,
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($pr);

            $defaultComment = $isFinalApproval
                ? "اعتمد {$actorTitle} طلب الشراء بعد التسعير وحوله إلى الإدارة المالية للموافقة."
                : "تم الاعتماد المبدئي للطلب من {$actorTitle} وإرساله للمشتريات للبدء في التسعير.";

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $executive->id,
                'action' => 'APPROVED_BY_EXECUTIVE',
                'from_state' => self::PENDING_STATUS,
                'to_state' => $nextStatus,
                'comments' => $comment ?? $defaultComment,
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'APPROVED_BY_EXECUTIVE',
                $isFinalApproval ? "اعتمد {$actorTitle} طلب الشراء بعد التسعير وحوله إلى الإدارة المالية." : "اعتمد {$actorTitle} طلب الشراء مبدئياً وأرسله إلى مدير المشتريات.",
                [
                    'event_type' => 'purchase_request.approved_by_executive',
                    'from_state' => self::PENDING_STATUS,
                    'to_state' => $nextStatus,
                    'actor_user_id' => $executive->id,
                    'metadata' => [
                        'comment' => $comment,
                        'is_final_approval' => $isFinalApproval,
                        'stage' => $isFinalApproval ? 'FINAL_APPROVAL' : 'INITIAL_APPROVAL',
                    ],
                ]
            );

            app(NotificationService::class)->queueNotification(
                $pr->user_id,
                'purchase_request_approved_by_executive',
                $isFinalApproval ? 'تم الاعتماد النهائي لطلب الشراء تنفيذيًا' : 'تم الاعتماد المبدئي لطلب الشراء تنفيذيًا',
                "اعتمد {$actorTitle} طلب الشراء {$pr->request_number}.",
                $pr
            );

            if ($isFinalApproval) {
                $notificationService = app(NotificationService::class);
                $notificationService->queueUsers(
                    $notificationService->resolveUsersWithPermission('purchase_request.accounting_view'),
                    'purchase_request_pending_accounting_approval',
                    'طلب شراء معتمد تنفيذيًا بانتظار الموافقة المالية',
                    "اعتمد {$actorTitle} الطلب {$pr->request_number} بعد التسعير، وهو الآن بانتظار موافقة المدير المالي / الحسابات.",
                    $pr
                );
            } else {
                $this->notifyProcurement($pr, "اعتمد {$actorTitle} طلب الشراء مبدئيًا، وهو بانتظار بدء التسعير من إدارة المشتريات.");
            }

            return $pr->fresh(['requester', 'department', 'assignedReviewer', 'siteEngineer', 'items.item', 'items.supplier', 'approvalHistory']);
        });
    }

    public function rejectRequest(User $executive, PurchaseRequest $request, string $comment): PurchaseRequest
    {
        $this->ensurePending($request);

        if ($executive->hasRole('execution_manager')) {
            if (! $this->canManageExecutionRequest($executive, $request)) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('غير مصرح لك برفض طلب شراء لا يقع ضمن مهندسي إدارة التنفيذ (م. كامل).');
            }
        } elseif (! $executive->hasRole('admin')) {
            $hasExecutionManager = User::whereHas('roles', fn ($q) => $q->where('slug', 'execution_manager'))->where('is_active', true)->exists();
            if ($hasExecutionManager && $this->isExecutionRequest($request)) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('هذا الطلب يتبع مدير مشروعات التنفيذ (م. كريم) ولا يقرره المدير العام (م. محمد).');
            }
        }

        return DB::transaction(function () use ($executive, $request, $comment): PurchaseRequest {
            $pr = PurchaseRequest::query()->lockForUpdate()->findOrFail($request->id);
            if ($pr->status !== self::PENDING_STATUS) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن طلب الشراء بالفعل أو لم يعد بانتظار المدير التنفيذي.');
            }
            $pr->update([
                'status' => 'REJECTED',
                'rejection_reason' => $comment,
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($pr);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $executive->id,
                'action' => 'REJECTED_BY_EXECUTIVE',
                'from_state' => self::PENDING_STATUS,
                'to_state' => 'REJECTED',
                'comments' => $comment,
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'REJECTED_BY_EXECUTIVE',
                'رفض المدير التنفيذي طلب الشراء.',
                [
                    'event_type' => 'purchase_request.rejected_by_executive',
                    'from_state' => self::PENDING_STATUS,
                    'to_state' => 'REJECTED',
                    'actor_user_id' => $executive->id,
                ]
            );

            app(NotificationService::class)->queueNotification(
                $pr->user_id,
                'purchase_request_rejected_by_executive',
                'تم رفض طلب الشراء تنفيذيًا',
                "رفض المدير التنفيذي طلب الشراء {$pr->request_number}.",
                $pr
            );

            return $pr->fresh(['requester', 'department', 'assignedReviewer', 'siteEngineer', 'items.item', 'items.supplier', 'approvalHistory']);
        });
    }

    private function ensurePending(PurchaseRequest $request): void
    {
        if ($request->status !== self::PENDING_STATUS) {
            throw new \RuntimeException('الطلب ليس بانتظار قرار المدير التنفيذي.');
        }
    }

    private function notifyProcurement(PurchaseRequest $request, string $message): void
    {
        $notificationService = app(NotificationService::class);
        $procurementManagers = $notificationService->resolveUsersWithPermission('purchase_request.approve_procurement');
        $notificationService->queueUsers(
            $procurementManagers,
            'purchase_request_pending_procurement',
            'طلب شراء بانتظار المشتريات',
            $message . " رقم الطلب: {$request->request_number}",
            $request
        );
    }

    public function isExecutionRequest(PurchaseRequest $request): bool
    {
        $request->loadMissing(['requester.manager.roles', 'assignedReviewer.roles']);

        return (bool) (
            $request->requester?->manager?->hasRole('execution_manager') ||
            $request->assignedReviewer?->hasRole('execution_manager')
        );
    }

    public function canManageExecutionRequest(User $user, PurchaseRequest $request): bool
    {
        if ($user->hasRole('admin')) {
            return true;
        }

        $request->loadMissing(['requester']);

        if ((int) $request->reviewer_user_id === (int) $user->id) {
            return true;
        }

        if ((int) $request->requester?->manager_id === (int) $user->id) {
            return true;
        }

        return false;
    }
}

