<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\MorphMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use App\Models\Concerns\RecordsSystemEvents;
use App\Traits\ScopesDataByUserRole;

class PurchaseRequest extends Model
{
    /**
     * The requester may edit until the departmental reviewer approves the request.
     */
    public const REQUESTER_EDITABLE_STATUSES = [
        'DRAFT',
        'SUBMITTED',
        'UNDER_REVIEW',
        'REJECTED',
        'RETURNED',
    ];

    public function isEditableByRequester(): bool
    {
        return in_array($this->status, self::REQUESTER_EDITABLE_STATUSES, true);
    }

    /**
     * The assigned reviewer may edit only while the request is awaiting the reviewer's decision.
     * Once the reviewer approves, the request is locked for the reviewer and requester.
     */
    public const REVIEWER_EDITABLE_STATUSES = [
        'SUBMITTED',
        'UNDER_REVIEW',
    ];

    public function isEditableByReviewer(): bool
    {
        return in_array($this->status, self::REVIEWER_EDITABLE_STATUSES, true);
    }

    use HasFactory, SoftDeletes, RecordsSystemEvents, ScopesDataByUserRole;

    protected static function booted(): void
    {
        static::creating(function (PurchaseRequest $model) {
            if (empty($model->request_number)) {
                $model->request_number = app(\App\Services\PurchaseRequestService::class)->generateUniqueRequestNumber();
            }
        });
    }

    protected $table = 'purchase_requests';

    protected $attributes = [
        'status' => 'DRAFT',
        'procurement_route' => 'UNDECIDED',
        'total_estimated_cost' => 0,
        'priority' => 'NORMAL',
    ];

    protected $fillable = [
        'request_number',
        'request_type',
        'parcel_reference',
        'region',
        'land_parcel_id',
        'user_id',
        'department_id',
        'target_department_id',
        'reviewer_user_id',
        'site_engineer_user_id',
        'requires_warehouse_receipt',
        'selected_quote_id',
        'priority',
        'status',
        'procurement_route',
        'direct_supplier_id',
        'total_estimated_cost',
        'date_needed',
        'notes',
        'rejection_reason',
        'return_reason',
        'submitted_at',
    ];

    public function landParcel(): BelongsTo
    {
        return $this->belongsTo(LandParcel::class, 'land_parcel_id');
    }

    public function isOfficeRequest(): bool
    {
        return $this->request_type === 'OFFICE_SUPPLIES';
    }

    public function getPurposeAttribute(): ?string
    {
        return $this->notes;
    }

    public function isComplementaryRequest(): bool
    {
        if ($this->request_type === 'COMPLEMENTARY') {
            return true;
        }

        if ((bool) ($this->is_supplementary ?? false)) {
            return true;
        }

        if ((bool) ($this->has_pending_supplement ?? false)) {
            return true;
        }

        $justification = (string) ($this->justification ?? '');
        $notes = (string) ($this->notes ?? '');
        $reqNum = (string) ($this->request_number ?? '');

        if (
            str_contains($justification, 'كمالة') || str_contains($justification, 'تكملة') ||
            str_contains($notes, 'كمالة') || str_contains($notes, 'تكملة') ||
            str_contains($reqNum, 'كمالة') || str_contains($reqNum, 'تكملة')
        ) {
            return true;
        }

        if ($this->relationLoaded('items')) {
            if ($this->items->contains(fn ($it) =>
                (bool) ($it->is_supplementary ?? false) ||
                ! empty($it->supplement_id) ||
                str_contains((string) ($it->item_description ?? ''), 'كمالة') ||
                str_contains((string) ($it->notes ?? ''), 'كمالة')
            )) {
                return true;
            }
        }

        if ($this->relationLoaded('supplements')) {
            if ($this->supplements->isNotEmpty()) {
                return true;
            }
        }

        // Database checks when model is persisted but relations are not eager loaded
        if ($this->exists) {
            if ($this->supplements()->exists()) {
                return true;
            }

            if ($this->items()->where(function ($q) {
                $q->where('is_supplementary', true)
                  ->orWhereNotNull('supplement_id')
                  ->orWhere('item_description', 'like', '%كمالة%')
                  ->orWhere('item_description', 'like', '%تكملة%')
                  ->orWhere('notes', 'like', '%كمالة%');
            })->exists()) {
                return true;
            }
        }

        return false;
    }

    /**
     * Determines whether a purchase request in PENDING_EXECUTIVE_APPROVAL has completed
     * pricing and supplier selection by procurement, qualifying for Final Executive Approval.
     */
    public function isPricedForFinalApproval(): bool
    {
        if ($this->status !== 'PENDING_EXECUTIVE_APPROVAL') {
            return false;
        }

        $hasProcurementPricingHistory = false;
        if ($this->relationLoaded('approvalHistory')) {
            $hasProcurementPricingHistory = $this->approvalHistory->contains(function ($entry) {
                return in_array($entry->action, [
                    'DIRECT_EXECUTIVE_REVIEW_REQUIRED',
                    'FAST_TRACK_PRICING_SKIPPED_PRELIMINARY',
                    'EDITED_BY_EXECUTIVE',
                    'DIRECT_PRICED',
                ], true) || (
                    $entry->relationLoaded('actor') &&
                    $entry->actor &&
                    $entry->actor->relationLoaded('roles') &&
                    $entry->actor->roles->contains(fn ($r) => in_array($r->slug, ['procurement_manager', 'admin'], true)) &&
                    in_array($entry->to_state, ['PENDING_EXECUTIVE_APPROVAL', 'APPROVED_BY_PROCUREMENT'], true)
                );
            });
        } elseif ($this->exists) {
            $hasProcurementPricingHistory = $this->approvalHistory()
                ->whereIn('action', [
                    'DIRECT_EXECUTIVE_REVIEW_REQUIRED',
                    'FAST_TRACK_PRICING_SKIPPED_PRELIMINARY',
                    'EDITED_BY_EXECUTIVE',
                    'DIRECT_PRICED',
                ])
                ->exists();
        }

        $items = $this->relationLoaded('items') ? $this->items : ($this->exists ? $this->items()->get() : collect());
        $hasItems = $items->isNotEmpty();
        $hasItemPrices = $hasItems && $items->contains(fn ($it) => (float) ($it->estimated_unit_price ?? 0) > 0);
        $hasSupplier = !empty($this->direct_supplier_id) || ($hasItems && $items->contains(fn ($it) => !empty($it->supplier_id)));
        $hasTotalCost = (float) ($this->total_estimated_cost ?? 0) > 0;

        if ($hasProcurementPricingHistory) {
            return true;
        }

        if ($this->procurement_route === 'DIRECT' && ($hasTotalCost || $hasItemPrices || $hasSupplier)) {
            return true;
        }

        if ($hasSupplier && ($hasTotalCost || $hasItemPrices)) {
            return true;
        }

        return false;
    }

    /**
     * Returns the exact executive decision stage for this purchase request.
     * Returns:
     * - 'INITIAL_APPROVAL': Waiting for preliminary executive approval to dispatch to procurement.
     * - 'FINAL_APPROVAL': Priced by procurement with supplier and unit prices, waiting for final executive approval before accounting.
     * - 'QUOTE_AWARD': Multi-quote evaluation waiting for executive selection/awarding decision.
     * - 'NONE': Does not currently require executive decision.
     */
    public function getExecutiveDecisionStage(): string
    {
        if ($this->status === 'PENDING_EXECUTIVE_QUOTE_DECISION') {
            return 'QUOTE_AWARD';
        }

        if ($this->status === 'PENDING_EXECUTIVE_APPROVAL') {
            return $this->isPricedForFinalApproval() ? 'FINAL_APPROVAL' : 'INITIAL_APPROVAL';
        }

        return 'NONE';
    }

    public function isProjectRequest(): bool
    {
        return ! $this->isOfficeRequest();
    }

    public function requiresWarehouseReceipt(): bool
    {
        if ($this->isOfficeRequest()) {
            return false;
        }

        return (bool) ($this->requires_warehouse_receipt ?? true);
    }

    public function isBuildingsDirectDelivery(): bool
    {
        // If reviewer explicitly configured warehouse receipt requirement, respect it
        if (! $this->requiresWarehouseReceipt()) {
            return true;
        }

        return false;
    }

    protected function casts(): array
    {
        return [
            'requires_warehouse_receipt' => 'boolean',
            'total_estimated_cost' => 'decimal:2',
            'date_needed' => 'date',

            'submitted_at' => 'datetime',
        ];
    }

    public function requester(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class, 'department_id');
    }

    public function targetDepartment(): BelongsTo
    {
        return $this->belongsTo(Department::class, 'target_department_id');
    }

    public function assignedReviewer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'reviewer_user_id');
    }

    public function siteEngineer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'site_engineer_user_id');
    }

    public function selectedQuote(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequestQuote::class, 'selected_quote_id');
    }

    public function directSupplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class, 'direct_supplier_id');
    }

    public function quotes(): HasMany
    {
        return $this->hasMany(PurchaseRequestQuote::class, 'purchase_request_id');
    }

    public function items(): HasMany
    {
        return $this->hasMany(PurchaseRequestItem::class, 'purchase_request_id');
    }

    public function purchaseOrders(): HasMany
    {
        return $this->hasMany(PurchaseOrder::class, 'purchase_request_id');
    }

    public function supplements(): HasMany
    {
        return $this->hasMany(PurchaseRequestSupplement::class, 'purchase_request_id');
    }

    public function receipts(): HasMany
    {
        return $this->hasMany(PurchaseReceipt::class, 'purchase_request_id');
    }

    public function canAcceptSupplement(): bool
    {
        // 1. If any purchase order has an approved receipt (already received at site / warehouse), CANNOT accept supplements
        if ($this->purchaseOrders()->whereHas('receipts', fn ($q) => $q->where('status', 'APPROVED'))->exists()) {
            return false;
        }

        // Also if direct receipt on PR is approved
        if ($this->receipts()->where('status', 'APPROVED')->exists()) {
            return false;
        }

        // 2. Must be an approved/issued requisition
        $validStatuses = [
            'APPROVED_BY_REVIEWER',
            'APPROVED_BY_GM',
            'PO_ISSUED',
            'ISSUED',
            'ACCOUNTING_APPROVED',
            'APPROVED_BY_ACCOUNTING',
            'APPROVED_BY_PROCUREMENT',
            'PENDING_PROCUREMENT_APPROVAL',
            'PENDING_EXECUTIVE_APPROVAL',
        ];
        if (! in_array($this->status, $validStatuses, true) && $this->purchaseOrders()->count() === 0) {
            return false;
        }

        return true;
    }

    public function creator(): BelongsTo
    {
        return $this->user();
    }

    public function approvalHistory(): MorphMany
    {
        return $this->morphMany(ApprovalHistory::class, 'target');
    }

    public function approvalHistories(): MorphMany
    {
        return $this->approvalHistory();
    }

    public function attachments(): MorphMany
    {
        return $this->morphMany(Attachment::class, 'attachable');
    }

    public function systemEvents(): HasMany
    {
        return $this->hasMany(SystemEvent::class, 'entity_id')
            ->where('entity_type', self::class)
            ->orderByDesc('occurred_at');
    }

    /**
     * Compute the real-time lifecycle status, label, and last action taking into account downstream POs.
     */
    public function getEffectiveLifecycle(): array
    {
        $pos = $this->relationLoaded('purchaseOrders')
            ? $this->purchaseOrders
            : $this->purchaseOrders()->with(['receipts', 'supplier'])->get();

        $validPos = $pos->filter(fn ($p) => ! in_array($p->status, ['REJECTED', 'CANCELLED', 'VOIDED'], true));
        $latestPo = $validPos->last() ?? $validPos->first();

        if ($latestPo) {
            $hasApprovedReceipt = $latestPo->relationLoaded('receipts')
                ? $latestPo->receipts->contains(fn ($r) => $r->status === 'APPROVED')
                : $latestPo->receipts()->where('status', 'APPROVED')->exists();

            $isActualPo = (bool) (
                $latestPo->finalized_at !== null ||
                ($hasApprovedReceipt && in_array($latestPo->status, ['APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'], true))
            );

            if ($isActualPo) {
                return [
                    'status' => 'ACTUAL_PO_ISSUED',
                    'label' => 'أمر شراء فعلي معتمد',
                    'last_action' => "تم اعتماد أمر الشراء الفعلي ({$latestPo->po_number})",
                    'po_number' => $latestPo->po_number,
                    'po_id' => $latestPo->id,
                    'is_actual_po' => true,
                ];
            }

            if ($hasApprovedReceipt || $latestPo->status === 'PENDING_ACTUAL_PO') {
                return [
                    'status' => 'PENDING_ACTUAL_PO',
                    'label' => 'بالموقع - بانتظار الأمر الفعلي',
                    'last_action' => "تم استلام المواد بالموقع - بانتظار الأمر الفعلي ({$latestPo->po_number})",
                    'po_number' => $latestPo->po_number,
                    'po_id' => $latestPo->id,
                    'is_actual_po' => false,
                ];
            }

            $hasPendingReceipt = $latestPo->relationLoaded('receipts')
                ? $latestPo->receipts->contains(fn ($r) => in_array($r->status, ['PENDING', 'SUBMITTED_BY_WAREHOUSE'], true))
                : $latestPo->receipts()->whereIn('status', ['PENDING', 'SUBMITTED_BY_WAREHOUSE'])->exists();

            if ($hasPendingReceipt) {
                return [
                    'status' => 'GRN_PENDING',
                    'label' => 'بانتظار فحص واعتماد الاستلام',
                    'last_action' => "تم توريد المواد للمخزن - بانتظار فحص الموقع ({$latestPo->po_number})",
                    'po_number' => $latestPo->po_number,
                    'po_id' => $latestPo->id,
                    'is_actual_po' => false,
                ];
            }

            $isAccountingApproved = $latestPo->status === 'APPROVED_BY_ACCOUNTING';
            $isPendingAccounting = $latestPo->status === 'PENDING_ACCOUNTING_REVIEW';

            return [
                'status' => $isAccountingApproved ? 'PO_APPROVED' : 'PO_ISSUED',
                'label' => $isAccountingApproved ? 'أمر شراء معتمد' : 'أمر شراء صادر',
                'last_action' => $isAccountingApproved
                    ? "اعتماد أمر الشراء من الحسابات ({$latestPo->po_number})"
                    : ($isPendingAccounting
                        ? "تم تقديم أمر الشراء للحسابات ({$latestPo->po_number})"
                        : "تم إصدار أمر الشراء للمورد ({$latestPo->po_number})"),
                'po_number' => $latestPo->po_number,
                'po_id' => $latestPo->id,
                'is_actual_po' => false,
            ];
        }

        $statusLabels = [
            'DRAFT' => 'مسودة',
            'SUBMITTED' => 'تم الإرسال',
            'UNDER_REVIEW' => 'قيد المراجعة',
            'PENDING_EXECUTIVE_APPROVAL' => 'بانتظار قرار المدير التنفيذي',
            'PENDING_PROCUREMENT_APPROVAL' => 'بانتظار اعتماد المشتريات',
            'PENDING_ACCOUNTING_APPROVAL' => 'بانتظار الموافقة المالية',
            'APPROVED_BY_ACCOUNTING' => 'معتمد ماليًا — جاهز للمشتريات',
            'PENDING_QUOTE_RECOMMENDATIONS' => 'بانتظار إعداد عروض الأسعار',
            'PENDING_EXECUTIVE_QUOTE_DECISION' => 'بانتظار قرار العروض',
            'APPROVED_BY_REVIEWER' => 'معتمد من المراجع',
            'APPROVED_BY_PROCUREMENT' => 'معتمد من المشتريات',
            'REJECTED' => 'مرفوض',
            'ISSUED' => 'أمر شراء صادر',
        ];

        $actionLabels = [
            'CREATED' => 'تم إنشاء الطلب',
            'SUBMITTED' => 'تم إرسال الطلب للمراجعة',
            'REVIEW_STARTED' => 'بدأ المراجع المراجعة',
            'HEADER_UPDATED' => 'تم تعديل بيانات الطلب',
            'ITEM_UPDATED' => 'تم تعديل بند',
            'ITEM_ADDED' => 'تم إضافة بند',
            'ITEM_REMOVED' => 'تم حذف بند',
            'APPROVED_BY_REVIEWER' => 'تم اعتماد المراجع وإرساله للمدير التنفيذي',
            'APPROVED_BY_EXECUTIVE' => 'تم اعتماد المدير التنفيذي وإرساله للمشتريات',
            'THREE_QUOTES_REQUIRED' => 'بدأ تجهيز عروض الأسعار',
            'THREE_QUOTES_SUBMITTED' => 'تم إرسال عروض الأسعار للترشيح',
            'EXECUTIVE_SELECTED_QUOTE' => 'اختار المدير التنفيذي العرض',
            'EXECUTIVE_REJECTED_QUOTES' => 'رفض المدير التنفيذي العروض',
            'DIRECT_PURCHASE_REQUEST_CREATED' => 'تم إنشاء طلب شراء مباشر وإرساله للحسابات',
            'ACCOUNTING_APPROVED_DIRECT' => 'اعتماد الحسابات وإعادة الطلب للمشتريات',
            'REJECTED' => 'تم رفض الطلب',
        ];

        $latestHistoryAction = $this->relationLoaded('approvalHistory')
            ? $this->approvalHistory->last()?->action
            : null;

        $lastActionLabel = $latestHistoryAction && isset($actionLabels[$latestHistoryAction])
            ? $actionLabels[$latestHistoryAction]
            : ($statusLabels[$this->status] ?? $this->status);

        return [
            'status' => $this->status,
            'label' => $statusLabels[$this->status] ?? $this->status,
            'last_action' => $lastActionLabel,
            'po_number' => null,
            'po_id' => null,
            'is_actual_po' => false,
        ];
    }
}
