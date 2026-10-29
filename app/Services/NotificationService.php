<?php

namespace App\Services;

use App\Jobs\SendNotificationsJob;
use App\Models\Notification;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\SupplierInvoice;
use App\Models\User;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Collection;

class NotificationService
{
    /**
     * Resolve users holding a specific permission, optionally filtered by department.
     */
    public function resolveUsersWithPermission(string $permissionSlug, ?int $departmentId = null): Collection
    {
        // The Admin role must never receive standard business/procurement workflow notifications
        $query = User::where('is_active', true)
            ->whereDoesntHave('roles', function ($q) {
                $q->where('slug', 'admin');
            });

        if ($departmentId !== null) {
            // First check departmental scope
            $deptUsers = (clone $query)->where('department_id', $departmentId)->get()
                ->filter(fn (User $u) => $u->hasPermission($permissionSlug));

            if ($deptUsers->isNotEmpty()) {
                return $deptUsers->values();
            }

            // Check if department has a designated manager with permission
            $dept = \App\Models\Department::find($departmentId);
            if ($dept?->manager_user_id) {
                $mgr = User::where('id', $dept->manager_user_id)->where('is_active', true)->first();
                if ($mgr && $mgr->hasPermission($permissionSlug)) {
                    return collect([$mgr]);
                }
            }

            // Mapped official reviewer for the department
            $emailMap = (array) config('procurement.default_department_reviewers', []);
            if ($dept?->code && isset($emailMap[$dept->code])) {
                $mappedUser = User::where('email', $emailMap[$dept->code])->where('is_active', true)->first();
                if ($mappedUser && $mappedUser->hasPermission($permissionSlug)) {
                    return collect([$mappedUser]);
                }
            }

            // Strict isolation: Do not leak notifications to unrelated departments
            return collect();
        }

        // Fallback to global active users with permission only when no specific department was requested
        return $query->get()
            ->filter(fn (User $u) => $u->hasPermission($permissionSlug))
            ->values();
    }

    /**
     * Create single notification for a recipient preventing duplicates.
     */
    private function isProcurementNotifiable(Model $notifiable): bool
    {
        return in_array(get_class($notifiable), [
            PurchaseRequest::class,
            PurchaseOrder::class,
            PurchaseReceipt::class,
            SupplierInvoice::class,
        ], true);
    }

    private function procurementNotifiableTypes(): array
    {
        return [
            PurchaseRequest::class,
            PurchaseOrder::class,
            PurchaseReceipt::class,
            SupplierInvoice::class,
        ];
    }

    /**
     * Format mandatory 4 core operational details (Parcel, Region, Item, Quantity) for notification messages.
     */
    public static function formatPrOperationalDetails(PurchaseRequest $pr): string
    {
        $items = $pr->relationLoaded('items') ? $pr->items : $pr->items()->get();
        $firstItem = $items->first();

        $parcel = $pr->parcel_reference ?: ($firstItem?->item_reference ?: '');
        $region = $pr->region ?: ($firstItem?->region ?: '');
        $itemDesc = $firstItem?->item_description ?: ($firstItem?->item?->name ?: '');
        $qty = $firstItem ? (float) $firstItem->quantity . ($firstItem->uom ? ' ' . $firstItem->uom : '') : '';
        $otherCount = $items->count() > 1 ? ' (+' . ($items->count() - 1) . ' أصناف أخرى)' : '';

        $parts = [];
        if ($parcel !== '') {
            $parts[] = "القطعة: {$parcel}";
        }
        if ($region !== '') {
            $parts[] = "المنطقة: {$region}";
        }
        if ($itemDesc !== '') {
            $parts[] = "الصنف: {$itemDesc}{$otherCount}";
        }
        if ($qty !== '') {
            $parts[] = "الكمية: {$qty}";
        }

        if (empty($parts)) {
            return '';
        }

        return ' • ' . implode(' | ', $parts);
    }

    public const EXECUTIVE_ACTIONABLE_TYPES = [
        'purchase_request_pending_executive',
        'purchase_request_pending_executive_approval',
        'purchase_quote_recommendations_ready',
    ];

    /**
     * The one informational notification the General Manager receives despite the executive gate:
     * an Actual PO issued above the high-value threshold (config procurement.actual_po_high_value_threshold).
     */
    public const GM_HIGH_VALUE_ACTUAL_PO_TYPE = 'purchase_order_actual_high_value';

    private function isGmHighValueNotice(User $user, string $type, Model $notifiable): bool
    {
        return $type === self::GM_HIGH_VALUE_ACTUAL_PO_TYPE
            && $notifiable instanceof PurchaseOrder
            && $user->hasRole('general_manager');
    }

    public function isExecutiveUser(User $user): bool
    {
        return ($user->hasRole('general_manager') || $user->hasRole('execution_manager')) && ! $user->hasRole('admin');
    }

    public function scopeExecutiveNotifications(\Illuminate\Database\Eloquent\Builder $query, User $user): void
    {
        $query->where(function ($visible) use ($user) {
            $visible->where(function ($actionable) use ($user) {
                $actionable->whereIn('type', self::EXECUTIVE_ACTIONABLE_TYPES)
                    ->where('notifiable_type', PurchaseRequest::class)
                    ->whereHasMorph(
                        'notifiable',
                        [PurchaseRequest::class],
                        function ($prQuery) use ($user) {
                            $prQuery->whereIn('status', [
                                'PENDING_EXECUTIVE_APPROVAL',
                                'PENDING_EXECUTIVE_QUOTE_DECISION',
                            ]);

                            if ($user->hasRole('general_manager')) {
                                $prQuery->whereDoesntHave('requester.manager.roles', function ($rq) {
                                    $rq->where('slug', 'execution_manager');
                                });
                            } elseif ($user->hasRole('execution_manager')) {
                                $prQuery->where(function ($eq) use ($user) {
                                    $eq->where('reviewer_user_id', $user->id)
                                       ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));
                                });
                            }
                        }
                    );
            });

            if ($user->hasRole('general_manager')) {
                $visible->orWhere(fn ($highValue) => $highValue
                    ->where('type', self::GM_HIGH_VALUE_ACTUAL_PO_TYPE)
                    ->where('notifiable_type', PurchaseOrder::class));
            }
        });
    }

    public function createNotification(User|int $recipient, string $type, string $title, string $message, Model $notifiable): ?Notification
    {
        $userId = $recipient instanceof User ? $recipient->id : (int) $recipient;
        $user = $recipient instanceof User ? $recipient : User::find($userId);

        if (! $user) {
            return null;
        }

        // The Admin role must never receive standard procurement/workflow notifications.
        // Admin ONLY receives system errors/health/monitoring alerts.
        if ($user->hasRole('admin') && !str_starts_with($type, 'system_error') && !str_starts_with($type, 'system_issue') && !str_starts_with($type, 'system_alert')) {
            return null;
        }

        if (! $this->isProcurementNotifiable($notifiable)) {
            return null;
        }

        // Strict Gate for Executive Directors (Eng. Mohamed & Eng. Karim):
        // ZERO Informational Notifications. Only actionable decision-pending notifications are permitted.
        if ($this->isExecutiveUser($user) && ! $this->isGmHighValueNotice($user, $type, $notifiable)) {
            // 1. Must be strictly an allowed actionable decision type
            if (! in_array($type, self::EXECUTIVE_ACTIONABLE_TYPES, true)) {
                return null;
            }

            // 2. Notifiable must be a PurchaseRequest
            if (! ($notifiable instanceof PurchaseRequest)) {
                return null;
            }

            // 3. The PurchaseRequest must currently be in the active actionable pending status
            if (in_array($type, ['purchase_request_pending_executive', 'purchase_request_pending_executive_approval'], true)) {
                if ($notifiable->status !== 'PENDING_EXECUTIVE_APPROVAL') {
                    return null;
                }
            } elseif ($type === 'purchase_quote_recommendations_ready') {
                if ($notifiable->status !== 'PENDING_EXECUTIVE_QUOTE_DECISION') {
                    return null;
                }
            }

            // 4. Role & Team Isolation between Eng. Mohamed (GM) and Eng. Karim (Execution Manager)
            if ($user->hasRole('general_manager')) {
                $notifiable->loadMissing('requester.manager.roles');
                if ($notifiable->requester?->manager?->hasRole('execution_manager')) {
                    return null;
                }
            } elseif ($user->hasRole('execution_manager')) {
                $notifiable->loadMissing('requester');
                if ((int) $notifiable->requester?->manager_id !== (int) $user->id && (int) $notifiable->reviewer_user_id !== (int) $user->id) {
                    return null;
                }
            }
        }

        // Automatically ensure mandatory 4 operational data points are present in the notification message
        if ($notifiable instanceof PurchaseRequest && !str_contains($message, 'القطعة:') && !str_contains($message, 'الصنف:')) {
            $message .= self::formatPrOperationalDetails($notifiable);
        } elseif ($notifiable instanceof PurchaseOrder && !str_contains($message, 'القطعة:') && !str_contains($message, 'الصنف:')) {
            if ($notifiable->purchaseRequest) {
                $message .= self::formatPrOperationalDetails($notifiable->purchaseRequest);
            }
        } elseif ($notifiable instanceof PurchaseReceipt && !str_contains($message, 'القطعة:') && !str_contains($message, 'الصنف:')) {
            if ($notifiable->purchaseOrder?->purchaseRequest) {
                $message .= self::formatPrOperationalDetails($notifiable->purchaseOrder->purchaseRequest);
            }
        }

        $existing = Notification::where([
            'user_id' => $userId,
            'type' => $type,
            'notifiable_type' => get_class($notifiable),
            'notifiable_id' => $notifiable->getKey(),
        ])->first();

        $poId = $notifiable instanceof PurchaseOrder ? $notifiable->id : ($notifiable instanceof PurchaseReceipt ? $notifiable->purchase_order_id : null);
        $receiptId = $notifiable instanceof PurchaseReceipt ? $notifiable->id : ($notifiable instanceof PurchaseOrder ? $notifiable->receipts()->latest('id')->value('id') : null);

        if ($existing) {
            $existing->update([
                'title' => $title,
                'message' => $message,
                'purchase_order_id' => $poId ?: $existing->purchase_order_id,
                'purchase_receipt_id' => $receiptId ?: $existing->purchase_receipt_id,
                'read_at' => null,
                'created_at' => now(),
            ]);

            try {
                \Illuminate\Support\Facades\Notification::send(
                    $user,
                    new \App\Notifications\ProcurementWorkflowNotification($type, $title, $message, $notifiable)
                );
            } catch (\Throwable) {
            }

            return $existing;
        }

        $created = Notification::create([
            'user_id' => $userId,
            'type' => $type,
            'notifiable_type' => get_class($notifiable),
            'notifiable_id' => $notifiable->getKey(),
            'purchase_order_id' => $poId,
            'purchase_receipt_id' => $receiptId,
            'title' => $title,
            'message' => $message,
            'read_at' => null,
        ]);

        try {
            \Illuminate\Support\Facades\Notification::send(
                $user,
                new \App\Notifications\ProcurementWorkflowNotification($type, $title, $message, $notifiable)
            );
        } catch (\Throwable) {
        }

        return $created;
    }

    /**
     * Create notification for a single recipient.
     */
    public function notifyUser(User|int $recipient, string $type, string $title, string $message, Model $notifiable): ?Notification
    {
        return $this->createNotification($recipient, $type, $title, $message, $notifiable);
    }

    /**
     * Create notifications for multiple recipients.
     */
    public function notifyUsers(iterable $recipients, string $type, string $title, string $message, Model $notifiable): void
    {
        foreach ($recipients as $recipient) {
            $this->createNotification($recipient, $type, $title, $message, $notifiable);
        }
    }

    /**
     * Queue a notification for one recipient after the surrounding transaction commits.
     */
    public function queueNotification(User|int $recipient, string $type, string $title, string $message, Model $notifiable): void
    {
        $userId = $recipient instanceof User ? $recipient->id : (int) $recipient;

        // Persist notification to database immediately for instant realtime delivery
        $this->createNotification($userId, $type, $title, $message, $notifiable);

        try {
            SendNotificationsJob::dispatch([$userId], $type, $title, $message, $notifiable);
        } catch (\Throwable $qe) {
            \Illuminate\Support\Facades\Log::warning('SendNotificationsJob queue dispatch warning: ' . $qe->getMessage());
        }
    }

    /**
     * Queue notifications for multiple recipients after the surrounding transaction commits.
     */
    public function queueUsers(iterable $recipients, string $type, string $title, string $message, Model $notifiable): void
    {
        $recipientIds = collect($recipients)
            ->map(fn (User|int $recipient): int => $recipient instanceof User ? $recipient->id : (int) $recipient)
            ->filter(fn (int $id): bool => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($recipientIds === []) {
            return;
        }

        // Persist notifications to database immediately for instant realtime delivery
        $this->notifyUsers($recipientIds, $type, $title, $message, $notifiable);

        try {
            SendNotificationsJob::dispatch($recipientIds, $type, $title, $message, $notifiable);
        } catch (\Throwable $qe) {
            \Illuminate\Support\Facades\Log::warning('SendNotificationsJob queue dispatch warning: ' . $qe->getMessage());
        }
    }

    /**
     * Queue one Accounting notification that carries both the PO and its approved receipt.
     */
    public function queueAccountingWithPurchaseOrderAndReceipt(iterable $recipients, PurchaseOrder $purchaseOrder, PurchaseReceipt $purchaseReceipt): void
    {
        $recipientIds = collect($recipients)
            ->map(fn (User|int $recipient): int => $recipient instanceof User ? $recipient->id : (int) $recipient)
            ->filter(fn (int $id): bool => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($recipientIds === []) {
            return;
        }

        // Persist notification to database immediately for instant realtime delivery
        $this->notifyAccountingWithPurchaseOrderAndReceipt($recipientIds, $purchaseOrder, $purchaseReceipt);

        try {
            SendNotificationsJob::dispatch(
                $recipientIds,
                'purchase_order_and_receipt_ready_accounting',
                '',
                '',
                $purchaseOrder,
                $purchaseReceipt,
            );
        } catch (\Throwable $qe) {
            \Illuminate\Support\Facades\Log::warning('SendNotificationsJob queue dispatch warning: ' . $qe->getMessage());
        }
    }

    /**
     * Send one Accounting notification that carries both the PO and its approved receipt.
     */
    public function notifyAccountingWithPurchaseOrderAndReceipt(iterable $recipients, PurchaseOrder $purchaseOrder, PurchaseReceipt $purchaseReceipt): void
    {
        foreach ($recipients as $recipient) {
            $userId = $recipient instanceof User ? $recipient->id : (int) $recipient;
            $user = $recipient instanceof User ? $recipient : User::find($userId);

            if (! $user || $user->hasRole('admin')) {
                continue;
            }

            $existing = Notification::where([
                'user_id' => $userId,
                'type' => 'purchase_order_and_receipt_ready_accounting',
                'notifiable_type' => PurchaseOrder::class,
                'notifiable_id' => $purchaseOrder->id,
            ])->first();

            if ($existing) {
                $existing->update([
                    'title' => 'أمر الشراء وإذن الاستلام جاهزان للحسابات',
                    'message' => "أمر الشراء {$purchaseOrder->po_number} وإذن الاستلام {$purchaseReceipt->receipt_number} مرتبطان بنفس العملية. افتح الرسالة لمراجعة المستندين واستكمال فاتورة المورد.",
                    'purchase_order_id' => $purchaseOrder->id,
                    'purchase_receipt_id' => $purchaseReceipt->id,
                    'read_at' => null,
                    'created_at' => now(),
                ]);
            } else {
                Notification::create([
                    'user_id' => $userId,
                    'type' => 'purchase_order_and_receipt_ready_accounting',
                    'notifiable_type' => PurchaseOrder::class,
                    'notifiable_id' => $purchaseOrder->id,
                    'purchase_order_id' => $purchaseOrder->id,
                    'purchase_receipt_id' => $purchaseReceipt->id,
                    'title' => 'أمر الشراء وإذن الاستلام جاهزان للحسابات',
                    'message' => "أمر الشراء {$purchaseOrder->po_number} وإذن الاستلام {$purchaseReceipt->receipt_number} مرتبطان بنفس العملية. افتح الرسالة لمراجعة المستندين واستكمال فاتورة المورد.",
                    'read_at' => null,
                ]);
            }

            try {
                \Illuminate\Support\Facades\Notification::send(
                    $user,
                    new \App\Notifications\ProcurementWorkflowNotification(
                        'purchase_order_and_receipt_ready_accounting',
                        'أمر الشراء وإذن الاستلام جاهزان للحسابات',
                        "أمر الشراء {$purchaseOrder->po_number} وإذن الاستلام {$purchaseReceipt->receipt_number} مرتبطان بنفس العملية.",
                        $purchaseOrder
                    )
                );
            } catch (\Throwable) {
            }
        }
    }

    /**
     * Get paginated notifications for user.
     */
    public function getUserNotifications(User $user, int $perPage = 15): LengthAwarePaginator
    {
        $query = Notification::where('user_id', $user->id);

        if ($user->hasRole('admin')) {
            return $query->where(function ($q) {
                $q->where('type', 'like', 'system_error%')
                  ->orWhere('type', 'like', 'system_issue%')
                  ->orWhere('type', 'like', 'system_alert%');
            })
            ->orderBy('created_at', 'desc')
            ->orderBy('id', 'desc')
            ->paginate($perPage);
        }

        if ($this->isExecutiveUser($user)) {
            $this->scopeExecutiveNotifications($query, $user);

            return $query->orderBy('created_at', 'desc')
                ->orderBy('id', 'desc')
                ->paginate($perPage);
        }

        return $query->where(function ($q) {
            $q->whereIn('notifiable_type', $this->procurementNotifiableTypes())
              ->orWhereNull('notifiable_type');
        })
            ->orderBy('created_at', 'desc')
            ->orderBy('id', 'desc')
            ->paginate($perPage);
    }

    public const INFORMATIONAL_WORKFLOW_TYPES = [
        'purchase_request_approved',
        'purchase_order_issued',
        'purchase_order_issued_requester',
        'purchase_order_created',
        'purchase_receipt_delivered',
    ];

    /**
     * Auto-dismiss unread notifications where the underlying document has already completed its actionable stage.
     */
    public function autoDismissResolvedNotifications(User $user): void
    {
        // 1. Reviewer: dismiss notifications for PRs that are no longer awaiting reviewer
        if ($user->hasRole('reviewer')) {
            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', PurchaseRequest::class)
                ->whereIn('type', [
                    'purchase_request_submitted',
                    'purchase_request_under_review',
                    'purchase_request_review_assigned',
                ])
                ->whereHasMorph('notifiable', [PurchaseRequest::class], function ($q) {
                    $q->whereNotIn('status', ['SUBMITTED', 'UNDER_REVIEW']);
                })
                ->update(['read_at' => now()]);

            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', PurchaseReceipt::class)
                ->whereIn('type', [
                    'purchase_receipt_pending_site_engineer',
                    'purchase_receipt_submitted',
                ])
                ->whereHasMorph('notifiable', [PurchaseReceipt::class], function ($q) {
                    $q->whereNotIn('status', ['PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED']);
                })
                ->update(['read_at' => now()]);
        }

        // 2. Site Engineer: dismiss notifications for Receipts that are already approved
        if ($user->hasRole('site_engineer')) {
            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', PurchaseReceipt::class)
                ->whereIn('type', [
                    'purchase_receipt_pending_site_engineer',
                    'purchase_receipt_submitted',
                    'purchase_receipt_created',
                ])
                ->whereHasMorph('notifiable', [PurchaseReceipt::class], function ($q) {
                    $q->whereNotIn('status', ['PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED']);
                })
                ->update(['read_at' => now()]);
        }

        // 3. Procurement Manager: dismiss notifications for PRs that already have POs
        if ($user->hasRole('procurement_manager')) {
            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', PurchaseRequest::class)
                ->whereIn('type', [
                    'purchase_request_pending_procurement',
                    'purchase_request_approved_for_procurement',
                    'purchase_request_approved_by_accounting',
                ])
                ->whereHasMorph('notifiable', [PurchaseRequest::class], function ($q) {
                    $q->whereHas('purchaseOrders', fn ($poQ) => $poQ->whereNotIn('status', ['REJECTED']));
                })
                ->update(['read_at' => now()]);

            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', PurchaseOrder::class)
                ->whereIn('type', [
                    'purchase_order_returned_procurement',
                    'po_returned',
                ])
                ->whereHasMorph('notifiable', [PurchaseOrder::class], function ($q) {
                    $q->where('status', '!=', 'RETURNED_TO_PROCUREMENT');
                })
                ->update(['read_at' => now()]);
        }

        // 4. Accountants: dismiss notifications for receipts that are already invoiced/matched
        if ($user->hasAnyRole(['accountant', 'site_accountant', 'licenses_accountant', 'buffet_accountant', 'development_accountant', 'general_accountant']) || $user->isGeneralAccountant()) {
            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', PurchaseReceipt::class)
                ->whereIn('type', [
                    'purchase_order_and_receipt_ready_accounting',
                    'purchase_receipt_ready_for_invoice',
                    'receipt_approved',
                ])
                ->whereHasMorph('notifiable', [PurchaseReceipt::class], function ($q) {
                    $q->whereNotNull('accountant_recorded_at')
                      ->orWhereHas('supplierInvoices', fn ($iq) => $iq->whereNotIn('status', ['VOIDED', 'CANCELLED']));
                })
                ->update(['read_at' => now()]);

            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', SupplierInvoice::class)
                ->whereIn('type', [
                    'supplier_invoice_pending_matching',
                    'supplier_invoice_pending_approval',
                ])
                ->whereHasMorph('notifiable', [SupplierInvoice::class], function ($q) {
                    $q->where('matching_status', 'MATCHED');
                })
                ->update(['read_at' => now()]);
        }

        // 5. Employee: dismiss notifications for requests that are no longer RETURNED
        if ($user->hasRole('employee')) {
            Notification::where('user_id', $user->id)
                ->whereNull('read_at')
                ->where('notifiable_type', PurchaseRequest::class)
                ->whereIn('type', [
                    'purchase_request_returned',
                    'purchase_request_needs_edit',
                ])
                ->whereHasMorph('notifiable', [PurchaseRequest::class], function ($q) {
                    $q->where('status', '!=', 'RETURNED');
                })
                ->update(['read_at' => now()]);
        }
    }

    /**
     * Get count of actionable unread notifications for user.
     */
    public function getUnreadCount(User $user): int
    {
        $this->autoDismissResolvedNotifications($user);

        $query = Notification::where('user_id', $user->id)->whereNull('read_at');

        if ($user->hasRole('admin')) {
            return $query->where(function ($q) {
                $q->where('type', 'like', 'system_error%')
                  ->orWhere('type', 'like', 'system_issue%')
                  ->orWhere('type', 'like', 'system_alert%');
            })->count();
        }

        if ($this->isExecutiveUser($user)) {
            $this->scopeExecutiveNotifications($query, $user);

            return $query->count();
        }

        // Exclude purely informational messages from actionable counter
        return $query->whereNotIn('type', self::INFORMATIONAL_WORKFLOW_TYPES)->count();
    }

    /**
     * Mark single notification as read.
     */
    public function markAsRead(User $user, Notification $notification): Notification
    {
        if ($notification->user_id !== $user->id) {
            throw new AuthorizationException('This notification belongs to another user.');
        }

        if ($notification->read_at === null) {
            $notification->update(['read_at' => now()]);
        }

        return $notification;
    }

    /**
     * Mark all notifications belonging to user as read.
     */
    public function markAllAsRead(User $user): int
    {
        $query = Notification::where('user_id', $user->id)->whereNull('read_at');

        if ($user->hasRole('admin')) {
            return $query->where(function ($q) {
                $q->where('type', 'like', 'system_error%')
                  ->orWhere('type', 'like', 'system_issue%')
                  ->orWhere('type', 'like', 'system_alert%');
            })->update(['read_at' => now()]);
        }

        return $query->update(['read_at' => now()]);
    }

    /**
     * Mark notifications for an entity as read for a specific user, or for all users when an action completes.
     */
    public function markEntityNotificationsAsRead(Model $notifiable, User|int|null $user = null, ?string $type = null): int
    {
        $notifiableClass = get_class($notifiable);
        $notifiableKey = $notifiable->getKey();

        $query = Notification::where(function ($q) use ($notifiableClass, $notifiableKey, $notifiable) {
            $q->where(function ($sub) use ($notifiableClass, $notifiableKey) {
                $sub->where('notifiable_type', $notifiableClass)
                    ->where('notifiable_id', $notifiableKey);
            });

            if ($notifiable instanceof PurchaseOrder) {
                $q->orWhere('purchase_order_id', $notifiableKey);
                if (!empty($notifiable->po_number)) {
                    $q->orWhere('message', 'like', "%{$notifiable->po_number}%");
                }
            } elseif ($notifiable instanceof PurchaseReceipt) {
                $q->orWhere('purchase_receipt_id', $notifiableKey);
                if (!empty($notifiable->receipt_number)) {
                    $q->orWhere('message', 'like', "%{$notifiable->receipt_number}%");
                }
            } elseif ($notifiable instanceof PurchaseRequest) {
                if (!empty($notifiable->request_number)) {
                    $q->orWhere('message', 'like', "%{$notifiable->request_number}%");
                }
            } elseif ($notifiable instanceof SupplierInvoice) {
                if (!empty($notifiable->invoice_number)) {
                    $q->orWhere('message', 'like', "%{$notifiable->invoice_number}%");
                }
                if ($notifiable->purchase_order_id) {
                    $q->orWhere('purchase_order_id', $notifiable->purchase_order_id);
                }
                if ($notifiable->purchase_receipt_id) {
                    $q->orWhere('purchase_receipt_id', $notifiable->purchase_receipt_id);
                }
            }
        })
        ->whereNull('read_at');

        if ($user !== null) {
            $userId = $user instanceof User ? $user->id : (int) $user;
            $query->where('user_id', $userId);
        }

        if ($type !== null) {
            $query->where('type', $type);
        }

        return $query->update(['read_at' => now()]);
    }

    /**
     * Mark all pending notifications for a purchase order, receipt, or related request as read when an action is executed.
     */
    public function markOrderAndReceiptNotificationsAsRead(int|PurchaseOrder $purchaseOrder, int|PurchaseReceipt|null $receipt = null, User|int|null $user = null): int
    {
        $poId = $purchaseOrder instanceof PurchaseOrder ? $purchaseOrder->id : (int) $purchaseOrder;
        $poNumber = $purchaseOrder instanceof PurchaseOrder ? $purchaseOrder->po_number : null;
        $receiptId = $receipt instanceof PurchaseReceipt ? $receipt->id : ($receipt ? (int) $receipt : null);
        $receiptNumber = $receipt instanceof PurchaseReceipt ? $receipt->receipt_number : null;

        $query = Notification::where(function ($q) use ($poId, $poNumber, $receiptId, $receiptNumber) {
            $q->where('purchase_order_id', $poId)
              ->orWhere(function ($q2) use ($poId) {
                  $q2->where('notifiable_type', PurchaseOrder::class)
                     ->where('notifiable_id', $poId);
              });

            if ($poNumber) {
                $q->orWhere('message', 'like', "%{$poNumber}%");
            }

            if ($receiptId) {
                $q->orWhere('purchase_receipt_id', $receiptId)
                  ->orWhere(function ($q3) use ($receiptId) {
                      $q3->where('notifiable_type', PurchaseReceipt::class)
                         ->where('notifiable_id', $receiptId);
                  });
            }

            if ($receiptNumber) {
                $q->orWhere('message', 'like', "%{$receiptNumber}%");
            }
        })
        ->whereNull('read_at');

        if ($user !== null) {
            $userId = $user instanceof User ? $user->id : (int) $user;
            $query->where('user_id', $userId);
        }

        return $query->update(['read_at' => now()]);
    }
}

