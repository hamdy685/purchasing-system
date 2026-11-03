<?php

namespace App\Services;

use App\Models\MaterialTransferRequest;
use App\Models\MaterialTransferRequestItem;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

class MaterialTransferRequestService
{
    public function __construct(
        protected NotificationService $notificationService
    ) {}

    /**
     * Generate sequential unique Material Transfer Request number (MTR-1, MTR-2, ...).
     */
    public function generateUniqueRequestNumber(string $prefix = 'MTR-'): string
    {
        $latestRequest = DB::table('material_transfer_requests')
            ->where('request_number', 'like', "{$prefix}%")
            ->orderByDesc('id')
            ->lockForUpdate()
            ->first();

        $maxSeq = 0;
        if ($latestRequest) {
            $parts = explode('-', (string) $latestRequest->request_number);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $maxSeq = (int) $lastPart;
            }
        }

        $existing = DB::table('material_transfer_requests')
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

        $nextSeq = $maxSeq + 1;

        return "{$prefix}{$nextSeq}";
    }

    /**
     * Requesters with these roles skip the reviewer step entirely.
     */
    public function bypassesReview(User $user): bool
    {
        return $user->hasAnyRole(['reviewer', 'admin', 'general_manager']);
    }

    /**
     * Validate the chosen reviewer (must be an active reviewer). Required on submit.
     */
    protected function resolveReviewerId(mixed $reviewerId, bool $required): ?int
    {
        if ($reviewerId === null || $reviewerId === '') {
            if ($required) {
                throw new InvalidArgumentException('اختار المراجع اللي هيراجع الطلب.');
            }

            return null;
        }

        $isReviewer = User::where('id', (int) $reviewerId)
            ->where('is_active', true)
            ->whereHas('roles', fn ($q) => $q->where('slug', 'reviewer'))
            ->exists();

        if (! $isReviewer) {
            throw new InvalidArgumentException('المستخدم المختار مش مراجع.');
        }

        return (int) $reviewerId;
    }

    /**
     * Status fields applied when a request is submitted.
     */
    protected function submitState(User $user, ?int $reviewerId): array
    {
        // Track 2: reviewer (or executive/admin) requester -> auto-reviewed, straight to accounting
        if ($this->bypassesReview($user)) {
            return [
                'status' => MaterialTransferRequest::STATUS_PENDING_ACCOUNTING,
                'reviewer_id' => $user->id,
                'reviewed_at' => now(),
                'review_notes' => 'اعتماد تلقائي - مقدم الطلب مراجع معتمد',
            ];
        }

        // Track 1: goes only to the reviewer the requester picked
        return [
            'status' => MaterialTransferRequest::STATUS_PENDING_REVIEWER,
            'reviewer_id' => $reviewerId,
            'return_reason' => null,
        ];
    }

    /**
     * Create a new material transfer request.
     */
    public function createRequest(User $user, array $data, bool $isSubmit = true): MaterialTransferRequest
    {
        return DB::transaction(function () use ($user, $data, $isSubmit) {
            $requestNumber = $this->generateUniqueRequestNumber();

            $status = MaterialTransferRequest::STATUS_DRAFT;
            $reviewerId = $this->bypassesReview($user) ? null : $this->resolveReviewerId($data['reviewer_id'] ?? null, $isSubmit);
            $reviewedAt = null;
            $reviewNotes = null;

            if ($isSubmit) {
                $submitState = $this->submitState($user, $reviewerId);
                $status = $submitState['status'];
                $reviewerId = $submitState['reviewer_id'];
                $reviewedAt = $submitState['reviewed_at'] ?? null;
                $reviewNotes = $submitState['review_notes'] ?? null;
            }

            $request = MaterialTransferRequest::create([
                'request_number' => $requestNumber,
                'transfer_date' => $data['transfer_date'] ?? now()->toDateString(),
                'from_project' => trim((string) $data['from_project']),
                'to_project' => trim((string) $data['to_project']),
                'driver_name' => isset($data['driver_name']) ? trim((string) $data['driver_name']) : null,
                'vehicle_plate_number' => isset($data['vehicle_plate_number']) ? trim((string) $data['vehicle_plate_number']) : null,
                'status' => $status,
                'user_id' => $user->id,
                'reviewer_id' => $reviewerId,
                'reviewed_at' => $reviewedAt,
                'review_notes' => $reviewNotes,
                'general_notes' => isset($data['general_notes']) ? trim((string) $data['general_notes']) : null,
            ]);

            // Save Items
            $items = $data['items'] ?? [];
            foreach ($items as $idx => $itemData) {
                MaterialTransferRequestItem::create([
                    'material_transfer_request_id' => $request->id,
                    'item_order' => $idx + 1,
                    'item_description' => trim((string) ($itemData['item_description'] ?? '')),
                    'uom' => trim((string) ($itemData['uom'] ?? 'وحدة')),
                    'quantity' => (float) ($itemData['quantity'] ?? 0),
                    'notes' => isset($itemData['notes']) ? trim((string) $itemData['notes']) : null,
                ]);
            }

            // Notifications
            if ($status === MaterialTransferRequest::STATUS_PENDING_REVIEWER) {
                $this->notifyReviewers($request);
            } elseif ($status === MaterialTransferRequest::STATUS_PENDING_ACCOUNTING) {
                $this->notifyAccountants($request);
            }

            return $request->load(['user', 'reviewer', 'accountant', 'items']);
        });
    }

    /**
     * Update an existing request (allowed for DRAFT or RETURNED).
     */
    public function updateRequest(MaterialTransferRequest $request, User $user, array $data, bool $isSubmit = false): MaterialTransferRequest
    {
        if (! $request->canBeEditedBy($user)) {
            throw new InvalidArgumentException('لا يمكن تعديل هذا الطلب في حالته الحالية أو بدون الصلاحيات الكافية.');
        }

        return DB::transaction(function () use ($request, $user, $data, $isSubmit) {
            $updates = [
                'transfer_date' => $data['transfer_date'] ?? $request->transfer_date,
                'from_project' => trim((string) ($data['from_project'] ?? $request->from_project)),
                'to_project' => trim((string) ($data['to_project'] ?? $request->to_project)),
                'driver_name' => array_key_exists('driver_name', $data) ? trim((string) $data['driver_name']) : $request->driver_name,
                'vehicle_plate_number' => array_key_exists('vehicle_plate_number', $data) ? trim((string) $data['vehicle_plate_number']) : $request->vehicle_plate_number,
                'general_notes' => array_key_exists('general_notes', $data) ? trim((string) $data['general_notes']) : $request->general_notes,
            ];

            if (! $this->bypassesReview($user) && array_key_exists('reviewer_id', $data)) {
                $updates['reviewer_id'] = $this->resolveReviewerId($data['reviewer_id'], false);
            }

            if ($isSubmit) {
                $reviewerId = $this->bypassesReview($user)
                    ? null
                    : $this->resolveReviewerId($updates['reviewer_id'] ?? $request->reviewer_id, true);
                $updates = array_merge($updates, $this->submitState($user, $reviewerId));
            }

            $request->update($updates);

            if (isset($data['items']) && is_array($data['items'])) {
                $request->items()->delete();
                foreach ($data['items'] as $idx => $itemData) {
                    MaterialTransferRequestItem::create([
                        'material_transfer_request_id' => $request->id,
                        'item_order' => $idx + 1,
                        'item_description' => trim((string) ($itemData['item_description'] ?? '')),
                        'uom' => trim((string) ($itemData['uom'] ?? 'وحدة')),
                        'quantity' => (float) ($itemData['quantity'] ?? 0),
                        'notes' => isset($itemData['notes']) ? trim((string) $itemData['notes']) : null,
                    ]);
                }
            }

            if ($isSubmit) {
                if ($request->status === MaterialTransferRequest::STATUS_PENDING_REVIEWER) {
                    $this->notifyReviewers($request);
                } elseif ($request->status === MaterialTransferRequest::STATUS_PENDING_ACCOUNTING) {
                    $this->notifyAccountants($request);
                }
            }

            return $request->fresh(['user', 'reviewer', 'accountant', 'items']);
        });
    }

    /**
     * Submit a draft or returned request.
     */
    public function submitRequest(MaterialTransferRequest $request, User $user): MaterialTransferRequest
    {
        if (! $request->canBeEditedBy($user)) {
            throw new InvalidArgumentException('لا يمكن إرسال هذا الطلب في حالته الحالية.');
        }

        return DB::transaction(function () use ($request, $user) {
            $reviewerId = $this->bypassesReview($user) ? null : $this->resolveReviewerId($request->reviewer_id, true);
            $request->update($this->submitState($user, $reviewerId));

            if ($request->status === MaterialTransferRequest::STATUS_PENDING_REVIEWER) {
                $this->notifyReviewers($request);
            } elseif ($request->status === MaterialTransferRequest::STATUS_PENDING_ACCOUNTING) {
                $this->notifyAccountants($request);
            }

            return $request->fresh(['user', 'reviewer', 'accountant', 'items']);
        });
    }

    /**
     * Reviewer approves request -> transitions directly to Accounting.
     */
    public function approveByReviewer(MaterialTransferRequest $request, User $reviewer, ?string $notes = null): MaterialTransferRequest
    {
        if (! $request->canBeReviewedBy($reviewer)) {
            throw new InvalidArgumentException('الطلب ليس في حالة انتظار المراجعة أو لا تملك صلاحية مراجعته.');
        }

        return DB::transaction(function () use ($request, $reviewer, $notes) {
            $request->update([
                'status' => MaterialTransferRequest::STATUS_PENDING_ACCOUNTING,
                'reviewer_id' => $reviewer->id,
                'reviewed_at' => now(),
                'review_notes' => $notes ? trim($notes) : null,
                'return_reason' => null,
                'rejection_reason' => null,
            ]);

            $this->notifyAccountants($request);

            if ($request->user_id !== $reviewer->id) {
                $this->notificationService->notifyUser(
                    $request->user_id,
                    'MATERIAL_TRANSFER_APPROVED',
                    'موافقة على طلب نقل خامات',
                    "تمت موافقة المراجع {$reviewer->name} على طلب نقل الخامات رقم {$request->request_number} وتم تحويله للحسابات.",
                    $request
                );
            }

            return $request->fresh(['user', 'reviewer', 'accountant', 'items']);
        });
    }

    /**
     * Reviewer rejects request.
     */
    public function rejectByReviewer(MaterialTransferRequest $request, User $reviewer, string $reason): MaterialTransferRequest
    {
        if (! $request->canBeReviewedBy($reviewer)) {
            throw new InvalidArgumentException('الطلب ليس في حالة انتظار المراجعة.');
        }

        if (empty(trim($reason))) {
            throw new InvalidArgumentException('سبب الرفض إلزامي.');
        }

        return DB::transaction(function () use ($request, $reviewer, $reason) {
            $request->update([
                'status' => MaterialTransferRequest::STATUS_REJECTED,
                'reviewer_id' => $reviewer->id,
                'reviewed_at' => now(),
                'rejection_reason' => trim($reason),
            ]);

            $this->notificationService->notifyUser(
                $request->user_id,
                'MATERIAL_TRANSFER_REJECTED',
                'رفض طلب نقل خامات',
                "تم رفض طلب نقل الخامات رقم {$request->request_number} من قبل المراجع {$reviewer->name}. السبب: {$reason}",
                $request
            );

            return $request->fresh(['user', 'reviewer', 'accountant', 'items']);
        });
    }

    /**
     * Reviewer returns request to requester for modification.
     */
    public function returnByReviewer(MaterialTransferRequest $request, User $reviewer, string $reason): MaterialTransferRequest
    {
        if (! $request->canBeReviewedBy($reviewer)) {
            throw new InvalidArgumentException('الطلب ليس في حالة انتظار المراجعة.');
        }

        if (empty(trim($reason))) {
            throw new InvalidArgumentException('سبب إعادة الطلب إلزامي.');
        }

        return DB::transaction(function () use ($request, $reviewer, $reason) {
            $request->update([
                'status' => MaterialTransferRequest::STATUS_RETURNED,
                'reviewer_id' => $reviewer->id,
                'reviewed_at' => now(),
                'return_reason' => trim($reason),
            ]);

            $this->notificationService->notifyUser(
                $request->user_id,
                'MATERIAL_TRANSFER_RETURNED',
                'إعادة طلب نقل خامات للتعديل',
                "تمت إعادة طلب نقل الخامات رقم {$request->request_number} إليك للتعديل من قبل المراجع {$reviewer->name}. السبب: {$reason}",
                $request
            );

            return $request->fresh(['user', 'reviewer', 'accountant', 'items']);
        });
    }

    /**
     * Accountant processes and archives the request.
     */
    public function processAndArchiveByAccountant(MaterialTransferRequest $request, User $accountant, ?string $accountingNotes = null): MaterialTransferRequest
    {
        if (! $request->canBeAccountedBy($accountant)) {
            throw new InvalidArgumentException('الطلب ليس بانتظار الإجراء المحاسبي أو لا تملك صلاحية معالجته.');
        }

        return DB::transaction(function () use ($request, $accountant, $accountingNotes) {
            $request->update([
                'status' => MaterialTransferRequest::STATUS_ARCHIVED,
                'accountant_id' => $accountant->id,
                'accounted_at' => now(),
                'accounting_notes' => $accountingNotes ? trim($accountingNotes) : null,
            ]);

            // Notify requester
            $this->notificationService->notifyUser(
                $request->user_id,
                'MATERIAL_TRANSFER_ARCHIVED',
                'معالجة وأرشفة طلب نقل الخامات',
                "تمت المعالجة المحاسبية وأرشفة طلب نقل الخامات رقم {$request->request_number} بنجاح.",
                $request
            );

            // Notify reviewer if different
            if ($request->reviewer_id && $request->reviewer_id !== $request->user_id) {
                $this->notificationService->notifyUser(
                    $request->reviewer_id,
                    'MATERIAL_TRANSFER_ARCHIVED',
                    'أرشفة طلب نقل خامات',
                    "تمت المعالجة المحاسبية وأرشفة طلب نقل الخامات رقم {$request->request_number}.",
                    $request
                );
            }

            return $request->fresh(['user', 'reviewer', 'accountant', 'items']);
        });
    }

    /**
     * Query user's own transfer requests.
     */
    public function getOwnRequests(User $user, array $filters = []): LengthAwarePaginator
    {
        $query = MaterialTransferRequest::with(['reviewer', 'accountant', 'items'])
            ->where('user_id', $user->id);

        $this->applyFilters($query, $filters);

        $perPage = min((int) ($filters['per_page'] ?? 15), 100);

        return $query->orderByDesc('id')->paginate($perPage);
    }

    /**
     * Query requests pending reviewer approval.
     */
    public function getPendingReviewerRequests(User $user, array $filters = []): LengthAwarePaginator
    {
        $query = MaterialTransferRequest::with(['user', 'items'])
            ->where('status', MaterialTransferRequest::STATUS_PENDING_REVIEWER)
            ->assignedToReviewer($user);

        $this->applyFilters($query, $filters);

        $perPage = min((int) ($filters['per_page'] ?? 15), 100);

        return $query->orderByDesc('id')->paginate($perPage);
    }

    /**
     * Query requests pending accounting action.
     */
    public function getPendingAccountingRequests(User $user, array $filters = []): LengthAwarePaginator
    {
        $query = MaterialTransferRequest::with(['user', 'reviewer', 'items'])
            ->where('status', MaterialTransferRequest::STATUS_PENDING_ACCOUNTING);

        $this->applyFilters($query, $filters);

        $perPage = min((int) ($filters['per_page'] ?? 15), 100);

        return $query->orderByDesc('id')->paginate($perPage);
    }

    /**
     * Query archived transfer requests (أرشيف المنقولات).
     */
    public function getArchivedRequests(array $filters = []): LengthAwarePaginator
    {
        $query = MaterialTransferRequest::with(['user', 'reviewer', 'accountant', 'items'])
            ->where('status', MaterialTransferRequest::STATUS_ARCHIVED);

        $this->applyFilters($query, $filters);

        $perPage = min((int) ($filters['per_page'] ?? 15), 100);

        return $query->orderByDesc('accounted_at')->orderByDesc('id')->paginate($perPage);
    }

    /**
     * Apply shared search & filter conditions.
     */
    protected function applyFilters(Builder $query, array $filters): void
    {
        if (! empty($filters['search'])) {
            $search = '%' . trim((string) $filters['search']) . '%';
            $query->where(function ($q) use ($search) {
                $q->where('request_number', 'like', $search)
                    ->orWhere('from_project', 'like', $search)
                    ->orWhere('to_project', 'like', $search)
                    ->orWhere('driver_name', 'like', $search)
                    ->orWhere('vehicle_plate_number', 'like', $search)
                    ->orWhereHas('user', function ($uq) use ($search) {
                        $uq->where('name', 'like', $search);
                    })
                    ->orWhereHas('items', function ($iq) use ($search) {
                        $iq->where('item_description', 'like', $search);
                    });
            });
        }

        if (! empty($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (! empty($filters['from_project'])) {
            $query->where('from_project', 'like', '%' . trim((string) $filters['from_project']) . '%');
        }

        if (! empty($filters['to_project'])) {
            $query->where('to_project', 'like', '%' . trim((string) $filters['to_project']) . '%');
        }

        if (! empty($filters['from_date'])) {
            $query->whereDate('transfer_date', '>=', $filters['from_date']);
        }

        if (! empty($filters['to_date'])) {
            $query->whereDate('transfer_date', '<=', $filters['to_date']);
        }
    }

    /**
     * Send notification to all Reviewers.
     */
    protected function notifyReviewers(MaterialTransferRequest $request): void
    {
        $reviewers = User::where('id', $request->reviewer_id)->where('is_active', true)->get();

        $this->notificationService->notifyUsers(
            $reviewers,
            'MATERIAL_TRANSFER_SUBMITTED',
            'طلب نقل خامات جديد بانتظار مراجعتك',
            "طلب نقل خامات جديد رقم {$request->request_number} من {$request->from_project} إلى {$request->to_project} مقدم من {$request->user?->name}.",
            $request
        );
    }

    /**
     * Send notification to Accountants.
     */
    protected function notifyAccountants(MaterialTransferRequest $request): void
    {
        $accountants = User::whereHas('roles', function ($q) {
            $q->whereIn('slug', ['accountant', 'site_accountant', 'general_accountant', 'admin']);
        })->where('is_active', true)->get();

        $this->notificationService->notifyUsers(
            $accountants,
            'MATERIAL_TRANSFER_PENDING_ACCOUNTING',
            'طلب نقل خامات بانتظار الإجراء المحاسبي والأرشفة',
            "طلب نقل الخامات رقم {$request->request_number} جاهز للمعالجة المحاسبية والأرشفة.",
            $request
        );
    }
}
