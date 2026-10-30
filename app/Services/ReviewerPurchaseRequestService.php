<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use App\Models\Department;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\User;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class ReviewerPurchaseRequestService
{
    /**
     * Determine if the request is explicitly assigned to the authenticated reviewer or belongs to their department.
     */
    public function canUserReviewRequest(User $user, PurchaseRequest $request): bool
    {
        if ($user->hasRole('admin')) {
            return true;
        }

        $request->loadMissing(['requester', 'targetDepartment', 'department']);

        // 1. Explicitly assigned reviewer on the request
        if ($request->reviewer_user_id !== null && (int) $request->reviewer_user_id === (int) $user->id) {
            return true;
        }

        // 2. Requester directly reports to this manager
        if ($request->requester?->manager_id !== null && (int) $request->requester->manager_id === (int) $user->id) {
            return true;
        }

        // 3. Departmental reviewer: designated manager of target department
        if (! $user->hasRole('execution_manager')) {
            $targetDept = $request->targetDepartment ?? $request->department;
            if ($targetDept?->manager_user_id !== null && (int) $targetDept->manager_user_id === (int) $user->id) {
                return true;
            }

            // 4. Departmental reviewer matched by target_department_id (or fallback department_id if target is null)
            if ($user->hasRole('reviewer') && $user->department_id) {
                if ((int) $request->target_department_id === (int) $user->department_id) {
                    return true;
                }
                if ($request->target_department_id === null && (int) $request->department_id === (int) $user->department_id) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Get reviewable PRs assigned to the Reviewer or created by engineers reporting directly to them.
     */
    public function getReviewableRequests(User $user, array $filters = [], int $perPage = 200): LengthAwarePaginator
    {
        $query = PurchaseRequest::with([
            'requester.roles',
            'department',
            'targetDepartment.manager',
            'targetDepartment.siteEngineer',
            'assignedReviewer',
            'items.item',
            'items.supplier',
        ])
            ->where('status', '!=', 'DRAFT');

        if (! $user->hasRole('admin')) {
            $query->where(function ($scopeQuery) use ($user) {
                // 1. Explicitly assigned reviewer on the request
                $scopeQuery->where('reviewer_user_id', $user->id)
                    // 2. Or requester reports directly to this user
                    ->orWhereHas('requester', function ($rq) use ($user) {
                        $rq->where('manager_id', $user->id);
                    });

                // 3. Departmental reviewer: designated manager of target department or requester department
                if (! $user->hasRole('execution_manager')) {
                    $scopeQuery->orWhereHas('targetDepartment', function ($departmentQuery) use ($user) {
                        $departmentQuery->where('manager_user_id', $user->id);
                    })->orWhere(function ($deptQuery) use ($user) {
                        $deptQuery->whereNull('target_department_id')
                            ->whereHas('department', function ($departmentQuery) use ($user) {
                                $departmentQuery->where('manager_user_id', $user->id);
                            });
                    });

                    // 4. Departmental reviewer matched by target_department_id (or department_id if target is null)
                    if ($user->hasRole('reviewer') && $user->department_id) {
                        $scopeQuery->orWhere('target_department_id', $user->department_id)
                                   ->orWhere(function ($fallbackDept) use ($user) {
                                       $fallbackDept->whereNull('target_department_id')
                                                    ->where('department_id', $user->department_id);
                                   });
                    }
                }
            });
        }

        if (! empty($filters['request_number'])) {
            $query->where('request_number', 'like', '%' . $filters['request_number'] . '%');
        }
        if (! empty($filters['requester_name'])) {
            $query->whereHas('requester', function ($requesterQuery) use ($filters) {
                $requesterQuery->where('name', 'like', '%' . $filters['requester_name'] . '%');
            });
        }
        if (! empty($filters['status'])) {
            $query->where('status', $filters['status']);
        }
        if (! empty($filters['item_reference'])) {
            $query->whereHas('items', function ($itemQuery) use ($filters): void {
                $itemQuery->where('item_reference', 'like', '%' . $filters['item_reference'] . '%');
            });
        }
        if (! empty($filters['region'])) {
            $query->whereHas('items', function ($itemQuery) use ($filters): void {
                $itemQuery->where('region', 'like', '%' . $filters['region'] . '%');
            });
        }
        if (! empty($filters['from_date'])) {
            $query->whereDate('created_at', '>=', $filters['from_date']);
        }
        if (! empty($filters['to_date'])) {
            $query->whereDate('created_at', '<=', $filters['to_date']);
        }

        return $query
            ->orderByDesc('updated_at')
            ->paginate(min(max($perPage, 1), 200));
    }

    /**
     * Start review process on a submitted request (SUBMITTED -> UNDER_REVIEW).
     */
    public function startReview(User $reviewer, PurchaseRequest $request): PurchaseRequest
    {
        if (! $this->canUserReviewRequest($reviewer, $request)) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('This action is unauthorized.');
        }

        if ($request->status !== 'SUBMITTED' && $request->status !== 'UNDER_REVIEW') {
            throw new \RuntimeException('Only submitted requests can be reviewed.');
        }

        if ($request->status === 'UNDER_REVIEW') {
            return $request->load(['requester', 'department', 'targetDepartment.manager', 'targetDepartment.siteEngineer', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory.actor']);
        }

        return DB::transaction(function () use ($reviewer, $request) {
            // Lock row for update to prevent concurrent modification
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->firstOrFail();
            if ($pr->status === 'UNDER_REVIEW') {
                return $pr->load(['requester', 'department', 'items.item', 'approvalHistory']);
            }
            if ($pr->status !== 'SUBMITTED') {
                throw new \RuntimeException('تم بدء مراجعة الطلب أو لم يعد في حالة انتظار المراجعة.');
            }

            $pr->update(['status' => 'UNDER_REVIEW']);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $reviewer->id,
                'action' => 'REVIEW_STARTED',
                'from_state' => 'SUBMITTED',
                'to_state' => 'UNDER_REVIEW',
                'comments' => 'بدأ المراجع مراجعة الطلب مباشرة.',
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'REVIEW_STARTED',
                'بدأ رئيس القسم مراجعة طلب الشراء.',
                ['event_type' => 'purchase_request.review_started', 'from_state' => 'SUBMITTED', 'to_state' => 'UNDER_REVIEW', 'actor_user_id' => $reviewer->id]
            );

            return $pr->fresh(['requester', 'department', 'targetDepartment.manager', 'targetDepartment.siteEngineer', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory.actor']);
        });
    }

    /**
     * Directly update header fields before procurement manager approval with field-level audit logging.
     */
    public function updateHeader(User $reviewer, PurchaseRequest $request, array $data): PurchaseRequest
    {
        if (! $this->canUserReviewRequest($reviewer, $request)) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('This action is unauthorized.');
        }

        if ($request->status === 'SUBMITTED') {
            $this->startReview($reviewer, $request);
            $request->refresh();
        }

        if (! $request->isEditableByReviewer()) {
            throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
        }

        return DB::transaction(function () use ($reviewer, $request, $data) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->first();
            if (! $pr->isEditableByReviewer()) {
                throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
            }

            $allowedFields = ['date_needed', 'priority', 'notes', 'parcel_reference', 'region', 'land_parcel_id', 'requires_warehouse_receipt'];
            $updateFields = [];

            foreach ($allowedFields as $field) {
                if (array_key_exists($field, $data)) {
                    $oldValue = (string) ($pr->{$field} ?? '');
                    $newValue = (string) ($data[$field] ?? '');

                    if ($oldValue !== $newValue) {
                        $updateFields[$field] = $data[$field];

                        AuditLog::create([
                            'user_id' => $reviewer->id,
                            'entity_type' => PurchaseRequest::class,
                            'entity_id' => $pr->id,
                            'action' => 'HEADER_UPDATED',
                            'field_name' => $field,
                            'old_value' => $oldValue,
                            'new_value' => $newValue,
                        ]);
                    }
                }
            }

            if (! empty($updateFields)) {
                $pr->update($updateFields);

                if (isset($updateFields['parcel_reference']) || isset($updateFields['region'])) {
                    $pr->items()->update([
                        'item_reference' => $pr->parcel_reference,
                        'region' => $pr->region,
                    ]);
                }
            }

            return $pr->fresh(['requester', 'department', 'targetDepartment.manager', 'targetDepartment.siteEngineer', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory.actor']);
        });
    }

    /**
     * Directly edit a line item before procurement manager approval with field-level audit logging.
     */
    public function updateLineItem(User $reviewer, PurchaseRequest $request, PurchaseRequestItem $item, array $data): PurchaseRequest
    {
        if (! $this->canUserReviewRequest($reviewer, $request)) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('This action is unauthorized.');
        }

        if ($item->purchase_request_id !== $request->id) {
            throw new \InvalidArgumentException('Item does not belong to this purchase request.');
        }

        if ($request->status === 'SUBMITTED') {
            $this->startReview($reviewer, $request);
            $request->refresh();
        }

        if (! $request->isEditableByReviewer()) {
            throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
        }

        return DB::transaction(function () use ($reviewer, $request, $item, $data) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->first();
            if (! $pr->isEditableByReviewer()) {
                throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
            }
            $prItem = PurchaseRequestItem::where('id', $item->id)->lockForUpdate()->first();

            $newQty = array_key_exists('quantity', $data) ? (float) $data['quantity'] : (float) $prItem->quantity;
            [$itemReference, $region] = $this->requireReferenceFields(
                array_key_exists('item_reference', $data) ? $data['item_reference'] : $prItem->item_reference,
                array_key_exists('region', $data) ? $data['region'] : $prItem->region,
                'item',
                $pr->isOfficeRequest()
            );

            $trackFields = [
                'item_id' => $data['item_id'] ?? $prItem->item_id,
                'item_description' => $data['item_description'] ?? $prItem->item_description,
                'item_reference' => $itemReference,
                'region' => $region,
                'quantity' => $newQty,
                'uom' => $data['uom'] ?? $prItem->uom,
                'specifications' => array_key_exists('specifications', $data) ? $data['specifications'] : $prItem->specifications,
                'notes' => array_key_exists('notes', $data) ? $data['notes'] : $prItem->notes,
            ];

            foreach ($trackFields as $field => $newValue) {
                $oldVal = (string) ($prItem->{$field} ?? '');
                $newVal = (string) ($newValue ?? '');

                if ($oldVal !== $newVal) {
                    AuditLog::create([
                        'user_id' => $reviewer->id,
                        'entity_type' => PurchaseRequestItem::class,
                        'entity_id' => $prItem->id,
                        'action' => 'ITEM_UPDATED',
                        'field_name' => $field,
                        'old_value' => $oldVal,
                        'new_value' => $newVal,
                    ]);
                }
            }

            $prItem->update($trackFields);

            return $pr->fresh(['requester', 'department', 'targetDepartment.manager', 'targetDepartment.siteEngineer', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory.actor']);
        });
    }

    /**
     * Add a new line item to a PR before procurement manager approval.
     */
    public function addLineItem(User $reviewer, PurchaseRequest $request, array $data): PurchaseRequest
    {
        if (! $this->canUserReviewRequest($reviewer, $request)) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('This action is unauthorized.');
        }

        if ($request->status === 'SUBMITTED') {
            $this->startReview($reviewer, $request);
            $request->refresh();
        }

        if (! $request->isEditableByReviewer()) {
            throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
        }

        return DB::transaction(function () use ($reviewer, $request, $data) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->first();
            if (! $pr->isEditableByReviewer()) {
                throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
            }

            $qty = (float) $data['quantity'];
            $itemReference = !empty($data['item_reference']) ? $data['item_reference'] : $pr->parcel_reference;
            $region = !empty($data['region']) ? $data['region'] : $pr->region;
            [$itemReference, $region] = $this->requireReferenceFields(
                $itemReference,
                $region,
                'item',
                $pr->isOfficeRequest()
            );

            $newItem = $pr->items()->create([
                'item_id' => $data['item_id'] ?? null,
                'item_description' => $data['item_description'],
                'item_reference' => $itemReference,
                'region' => $region,
                'quantity' => $qty,
                'uom' => $data['uom'] ?? 'PCS',
                'specifications' => $data['specifications'] ?? null,
                'notes' => $data['notes'] ?? null,
            ]);

            AuditLog::create([
                'user_id' => $reviewer->id,
                'entity_type' => PurchaseRequestItem::class,
                'entity_id' => $newItem->id,
                'action' => 'ITEM_ADDED',
                'field_name' => 'item_description',
                'old_value' => null,
                'new_value' => $newItem->item_description,
            ]);

            return $pr->fresh(['requester', 'department', 'targetDepartment.manager', 'targetDepartment.siteEngineer', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory.actor']);
        });
    }

    /**
     * Remove a line item from a PR before procurement manager approval.
     */
    public function deleteLineItem(User $reviewer, PurchaseRequest $request, PurchaseRequestItem $item): PurchaseRequest
    {
        if (! $this->canUserReviewRequest($reviewer, $request)) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('This action is unauthorized.');
        }

        if ($item->purchase_request_id !== $request->id) {
            throw new \InvalidArgumentException('Item does not belong to this purchase request.');
        }

        if ($request->status === 'SUBMITTED') {
            $this->startReview($reviewer, $request);
            $request->refresh();
        }

        if (! $request->isEditableByReviewer()) {
            throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
        }

        return DB::transaction(function () use ($reviewer, $request, $item) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->first();
            if (! $pr->isEditableByReviewer()) {
                throw new \RuntimeException('لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.');
            }

            AuditLog::create([
                'user_id' => $reviewer->id,
                'entity_type' => PurchaseRequestItem::class,
                'entity_id' => $item->id,
                'action' => 'ITEM_REMOVED',
                'field_name' => 'item_description',
                'old_value' => $item->item_description,
                'new_value' => null,
            ]);

            $item->delete();

            return $pr->fresh(['requester', 'department', 'targetDepartment.manager', 'targetDepartment.siteEngineer', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory.actor']);
        });
    }

    /**
     * Approve Purchase Request (UNDER_REVIEW -> PENDING_EXECUTIVE_APPROVAL).
     */
    public function approveRequest(User $reviewer, PurchaseRequest $request, ?string $comment, ?int $siteEngineerUserId = null, ?bool $requiresWarehouseReceipt = null, ?bool $isComplementaryOverride = null): PurchaseRequest
    {
        if (! $this->canUserReviewRequest($reviewer, $request)) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('This action is unauthorized.');
        }

        if ($request->status !== 'UNDER_REVIEW' && $request->status !== 'SUBMITTED') {
            throw new \RuntimeException('Only pending purchase requests can be approved.');
        }

        if ($request->items()->count() === 0) {
            throw ValidationException::withMessages([
                'items' => ['Cannot approve a purchase request with no line items.'],
            ]);
        }

        return DB::transaction(function () use ($reviewer, $request, $comment, $siteEngineerUserId, $requiresWarehouseReceipt, $isComplementaryOverride) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->firstOrFail();
            if (! in_array($pr->status, ['UNDER_REVIEW', 'SUBMITTED'], true)) {
                throw new \RuntimeException('تم اعتماد طلب الشراء بالفعل أو لم يعد في حالة انتظار اعتماد المراجع.');
            }
            $fromState = $pr->status;

            $isOffice = in_array($pr->request_type, ['OFFICE_SUPPLIES', 'ADMINISTRATIVE'], true) || (method_exists($pr, 'isOfficeRequest') && $pr->isOfficeRequest());
            $engineerUser = null;

            if (! $isOffice) {
                // Resolve site engineer: explicit reviewer selection takes precedence, then PR value, then department default
                $siteEngineerId = $siteEngineerUserId ?: $pr->site_engineer_user_id;
                if (! $siteEngineerId && $pr->targetDepartment?->site_engineer_user_id) {
                    $siteEngineerId = $pr->targetDepartment->site_engineer_user_id;
                }
                if (! $siteEngineerId && $pr->department?->site_engineer_user_id) {
                    $siteEngineerId = $pr->department->site_engineer_user_id;
                }

                if (! $siteEngineerId) {
                    throw ValidationException::withMessages([
                        'site_engineer_user_id' => ['يجب اختيار مهندس الموقع أو مسؤول الاستلام قبل اعتماد الطلب وإرساله إلى المدير التنفيذي.'],
                    ]);
                }

                $engineerUser = User::where('id', $siteEngineerId)->where('is_active', true)->first();
                if (! $engineerUser) {
                    throw ValidationException::withMessages([
                        'site_engineer_user_id' => ['مهندس الموقع / مسؤول الاستلام المحدد غير موجود أو حسابه غير نشط.'],
                    ]);
                }
            }

            $isComplementary = $isComplementaryOverride !== null ? (bool) $isComplementaryOverride : $pr->isComplementaryRequest();
            $targetStatus = $isComplementary ? 'PENDING_PROCUREMENT_APPROVAL' : 'PENDING_EXECUTIVE_APPROVAL';
            $actionName = $isComplementary ? 'APPROVED_BY_REVIEWER_FAST_TRACK' : 'APPROVED_BY_REVIEWER';
            $defaultComment = $isComplementary
                ? 'اعتمد رئيس القسم طلب الكمالة المستقل وأرسله مباشرة إلى إدارة المشتريات (تخطي المسار التنفيذي والمالي).'
                : 'اعتمد المراجع الطلب وأرسله إلى المدير التنفيذي للقرار.';

            $updateData = [
                'status' => $targetStatus,
                'reviewer_user_id' => $pr->reviewer_user_id ?: $reviewer->id,
                'site_engineer_user_id' => $engineerUser?->id,
            ];

            if ($requiresWarehouseReceipt !== null) {
                $updateData['requires_warehouse_receipt'] = $requiresWarehouseReceipt;
            }

            $pr->update($updateData);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $reviewer->id,
                'action' => $actionName,
                'from_state' => $fromState,
                'to_state' => $targetStatus,
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment ?? $defaultComment,
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                $actionName,
                $isComplementary
                    ? 'اعتمد رئيس القسم طلب الكمالة وأرسله مباشرة إلى إدارة المشتريات (مسار سريع).'
                    : 'اعتمد رئيس القسم طلب الشراء وأرسله إلى المدير التنفيذي.',
                ['event_type' => 'purchase_request.approved_by_reviewer', 'from_state' => $fromState, 'to_state' => $targetStatus, 'actor_user_id' => $reviewer->id, 'metadata' => ['comment' => $comment, 'is_complementary' => $isComplementary]]
            );

            // Notify Requester Employee
            $notificationService = app(\App\Services\NotificationService::class);
            $notificationService->markEntityNotificationsAsRead($pr);
            $notificationService->queueNotification(
                $pr->user_id,
                'purchase_request_approved',
                $isComplementary ? 'تم اعتماد طلب الكمالة' : 'تم اعتماد طلب الشراء',
                $isComplementary
                    ? "تم اعتماد طلب الكمالة المستقل {$pr->request_number} من رئيس القسم وإحالته مباشرة إلى إدارة المشتريات لإصدار أمر الشراء."
                    : "تم اعتماد طلب الشراء {$pr->request_number} وإرساله إلى المدير التنفيذي.",
                $pr
            );

            if ($isComplementary) {
                // Fast-Track: notify Procurement Manager(s) directly
                $procurementManagers = User::whereHas('roles', fn ($q) => $q->where('slug', 'procurement_manager'))->where('is_active', true)->get();
                $notificationService->queueUsers(
                    $procurementManagers,
                    'purchase_request_pending_procurement',
                    'طلب كمالة جديد بانتظار أمر الشراء',
                    "تم اعتماد طلب الكمالة المستقل {$pr->request_number} وهو جاهز الآن لدى إدارة المشتريات لإصدار أمر الشراء مباشرة.",
                    $pr
                );
            } else {
                // Normal route: Notify the Executive / General Manager or Direct Manager
                $requester = $pr->requester;
                $directManager = ($requester && $requester->manager_id)
                    ? User::where('id', $requester->manager_id)->where('is_active', true)->first()
                    : null;

                if ($directManager) {
                    $notificationService->queueNotification(
                        $directManager->id,
                        'purchase_request_pending_executive',
                        'طلب شراء بانتظار قرار المدير',
                        "طلب الشراء {$pr->request_number} لموظفك ({$requester->name}) اعتمده المراجع وبانتظار قرارك.",
                        $pr
                    );
                } else {
                    $executives = User::whereHas('roles', fn ($q) => $q->where('slug', 'general_manager'))->where('is_active', true)->get();
                    $notificationService->queueUsers(
                        $executives,
                        'purchase_request_pending_executive',
                        'طلب شراء بانتظار قرار المدير التنفيذي',
                        "طلب الشراء {$pr->request_number} اعتمده المراجع وبانتظار قرار المدير التنفيذي.",
                        $pr
                    );
                }
            }

            return $pr->fresh(['requester', 'department', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory']);
        });
    }

    /**
     * Reject Purchase Request (UNDER_REVIEW -> REJECTED).
     */
    public function rejectRequest(User $reviewer, PurchaseRequest $request, string $comment): PurchaseRequest
    {
        if (! $this->canUserReviewRequest($reviewer, $request)) {
            throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('This action is unauthorized.');
        }

        if ($request->status !== 'UNDER_REVIEW' && $request->status !== 'SUBMITTED') {
            throw new \RuntimeException('Only pending purchase requests can be rejected.');
        }

        return DB::transaction(function () use ($reviewer, $request, $comment) {
            $pr = PurchaseRequest::where('id', $request->id)->lockForUpdate()->firstOrFail();
            if (! in_array($pr->status, ['UNDER_REVIEW', 'SUBMITTED'], true)) {
                throw new \RuntimeException('تم اتخاذ قرار بشأن طلب الشراء بالفعل أو لم يعد في حالة انتظار المراجع.');
            }
            $fromState = $pr->status;

            $pr->update([
                'status' => 'REJECTED',
                'rejection_reason' => $comment,
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $reviewer->id,
                'action' => 'REJECTED',
                'from_state' => $fromState,
                'to_state' => 'REJECTED',
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment,
            ]);

            app(SystemEventService::class)->recordAction(
                $pr,
                'REJECTED_BY_REVIEWER',
                'رفض رئيس القسم طلب الشراء.',
                ['event_type' => 'purchase_request.rejected_by_reviewer', 'from_state' => $fromState, 'to_state' => 'REJECTED', 'actor_user_id' => $reviewer->id, 'metadata' => ['comment' => $comment]]
            );

            // Notify Requester Employee
            $notificationService = app(\App\Services\NotificationService::class);
            $notificationService->markEntityNotificationsAsRead($pr);
            $rejMsg = "تم إرجاع/رفض طلب الشراء {$pr->request_number}.";
            if (! empty($comment)) {
                $rejMsg .= "\nالسبب: {$comment}";
            }
            $notificationService->queueNotification(
                $pr->user_id,
                'purchase_request_rejected',
                'تم رفض/إرجاع طلب الشراء',
                $rejMsg,
                $pr
            );

            return $pr->fresh(['requester', 'department', 'targetDepartment.manager', 'targetDepartment.siteEngineer', 'assignedReviewer', 'siteEngineer', 'items.item', 'approvalHistory.actor']);
        });
    }

    /**
     * Validate and normalize fields required for item traceability.
     */
    private function requireReferenceFields($itemReference, $region, string $key, bool $isOffice = false): array
    {
        $itemReference = trim((string) ($itemReference ?? ''));
        $region = trim((string) ($region ?? ''));

        if ($isOffice) {
            if ($itemReference === '') $itemReference = 'مقر الشركة';
            if ($region === '') $region = 'إداري / المقر الرئيسي';
            return [$itemReference, $region];
        }

        $errors = [];

        if ($itemReference === '') {
            $errors["{$key}.item_reference"] = ['رقم قطعة الأرض مطلوب ولا يمكن أن يكون فارغًا.'];
        }
        if ($region === '') {
            $errors["{$key}.region"] = ['المنطقة مطلوبة ولا يمكن أن تكون فارغة.'];
        }

        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return [$itemReference, $region];
    }
}
