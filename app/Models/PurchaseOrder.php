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

class PurchaseOrder extends Model
{
    use HasFactory, SoftDeletes, RecordsSystemEvents, ScopesDataByUserRole;

    protected static function booted(): void
    {
        static::creating(function (PurchaseOrder $model) {
            if (empty($model->po_number)) {
                $model->po_number = app(\App\Services\PurchaseOrderService::class)->generatePoNumber();
            }
        });

        // A PO that stops holding its request lines frees them to be ordered again (history kept).
        static::updated(function (PurchaseOrder $model) {
            if ($model->wasChanged('status') && in_array($model->status, \App\Services\PurchaseOrderSourceService::INACTIVE_PO_STATUSES, true)) {
                \App\Services\DepartmentPoConsolidationService::releaseForOrder($model, "PO {$model->status}");
            }
        });

        static::deleted(function (PurchaseOrder $model) {
            \App\Services\DepartmentPoConsolidationService::releaseForOrder($model, 'PO deleted');
        });
    }

    protected $table = 'purchase_orders';

    protected $fillable = [
        'po_number',
        'manual_po_number',
        'purchase_request_id',
        'manual_pr_number',
        'selected_quote_id',
        'supplier_id',
        'created_by_user_id',
        'status',
        'subtotal',
        'discount_type',
        'discount_percentage',
        'discount_amount',
        'tax_amount',
        'grand_total',
        'payment_terms',
        'delivery_terms',
        'delivery_date',
        'delivery_status',
        'actual_delivery_date',
        'delivery_notes',
        'budget_code',
        'financial_notes',
        'reviewed_by_accounting_user_id',
        'reviewed_at_accounting',
        'notes',
        'rejection_reason',
        // Actual PO finalisation fields
        'finalized_by_user_id',
        'finalized_at',
        'finalization_notes',
        'invoice_photo_path',
        'invoice_photo_name',
        'invoice_photo_size',
        'invoice_photo_mime_type',
        'invoice_photo_drive_id',
        'invoice_photo_uploaded_at',
        'invoice_photo_uploaded_by_user_id',
        // Mandatory department consolidation (see config procurement.consolidated_po)
        'consolidation_policy',
        'consolidation_key',
        'idempotency_key',
        // Actual PO above the high-value threshold (config procurement.actual_po_high_value_threshold)
        'high_value_reason',
        'high_value_threshold',
        'high_value_acknowledged_by_user_id',
        'high_value_acknowledged_at',
    ];

    public const CONSOLIDATION_POLICY_DEPARTMENT = 'DEPARTMENT_MANDATORY';

    protected $appends = [
        'warehouse_approval',
        'site_engineer_approval',
        'is_supplementary',
        'invoice_photo_url',
        'has_invoice_attachment',
    ];

    public function getIsSupplementaryAttribute(): bool
    {
        if ($this->relationLoaded('items')) {
            return $this->items->contains('is_supplementary', true);
        }
        return $this->items()->where('is_supplementary', true)->exists();
    }

    public function getPurposeAttribute(): ?string
    {
        return $this->purchaseRequest?->notes ?? $this->notes;
    }

    public function invoiceUploadedBy(): \Illuminate\Database\Eloquent\Relations\BelongsTo
    {
        return $this->belongsTo(User::class, 'invoice_photo_uploaded_by_user_id');
    }

    public function getInvoicePhotoUrlAttribute(): ?string
    {
        if (! $this->invoice_photo_path) {
            return null;
        }

        if (filter_var($this->invoice_photo_path, FILTER_VALIDATE_URL)) {
            return $this->invoice_photo_path;
        }

        $r2Url = config('filesystems.disks.r2.url');
        if ($r2Url && config('filesystems.default') === 'r2') {
            return rtrim($r2Url, '/') . '/' . ltrim($this->invoice_photo_path, '/');
        }

        return "/api/v1/purchase-orders/{$this->id}/invoice-photo";
    }

    public function getHasInvoiceAttachmentAttribute(): bool
    {
        if (! empty($this->invoice_photo_path)) {
            return true;
        }
        if ($this->relationLoaded('supplierInvoices')) {
            return $this->supplierInvoices->isNotEmpty();
        }
        return false;
    }

    public function getWarehouseApprovalAttribute(): array
    {
        $requiresWarehouse = $this->requiresWarehouseReceipt();
        $latestReceipt = $this->relationLoaded('receipts')
            ? $this->receipts->sortByDesc('id')->first()
            : $this->receipts()->latest('id')->first();

        if (! $requiresWarehouse) {
            return [
                'status' => 'AUTO_APPROVED',
                'is_bypassed' => true,
                'approved' => true,
                'label' => 'تم التخطي التلقائي (لا يوجد مخزن)',
                'notes' => 'تم التخطي التلقائي / لا يتطلب استلام مخزني',
            ];
        }

        if ($latestReceipt && $latestReceipt->warehouse_submitted_at) {
            return [
                'status' => 'APPROVED',
                'is_bypassed' => false,
                'approved' => true,
                'label' => 'تم الاستلام بالمخزن',
                'notes' => $latestReceipt->warehouse_notes,
                'receipt_number' => $latestReceipt->receipt_number,
            ];
        }

        return [
            'status' => 'PENDING',
            'is_bypassed' => false,
            'approved' => false,
            'label' => 'بانتظار استلام المخزن',
            'notes' => null,
        ];
    }

    public function getSiteEngineerApprovalAttribute(): array
    {
        $latestReceipt = $this->relationLoaded('receipts')
            ? $this->receipts->sortByDesc('id')->first()
            : $this->receipts()->latest('id')->first();

        if ($latestReceipt && ($latestReceipt->status === 'APPROVED' || $latestReceipt->site_engineer_approved_at)) {
            return [
                'status' => 'APPROVED',
                'approved' => true,
                'label' => 'معتمد ومطابق هندسيًا',
                'notes' => $latestReceipt->site_engineer_notes,
            ];
        }

        if ($latestReceipt && $latestReceipt->status === 'PENDING_SITE_ENGINEER') {
            return [
                'status' => 'PENDING',
                'approved' => false,
                'label' => 'بانتظار فحص واعتماد مهندس الموقع',
                'notes' => null,
            ];
        }

        return [
            'status' => 'WAITING_WAREHOUSE',
            'approved' => false,
            'label' => 'بانتظار استلام المخزن أولاً',
            'notes' => null,
        ];
    }

    protected function casts(): array
    {
        return [
            'subtotal' => 'decimal:2',
            'discount_percentage' => 'decimal:4',
            'discount_amount' => 'decimal:2',
            'tax_amount' => 'decimal:2',
            'grand_total' => 'decimal:2',
            'delivery_date' => 'date',
            'actual_delivery_date' => 'date',
            'reviewed_at_accounting' => 'datetime',
            'finalized_at' => 'datetime',
            'high_value_threshold' => 'decimal:2',
            'high_value_acknowledged_at' => 'datetime',
            'invoice_photo_uploaded_at' => 'datetime',
        ];
    }

    public function purchaseRequest(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequest::class, 'purchase_request_id');
    }

    public function requiresWarehouseReceipt(): bool
    {
        $this->loadMissing('purchaseRequest');

        return $this->purchaseRequest?->requiresWarehouseReceipt() ?? true;
    }

    public function isBuildingsDirectDelivery(): bool
    {
        $this->loadMissing([
            'purchaseRequest.department',
            'purchaseRequest.targetDepartment',
            'purchaseRequest.assignedReviewer.department',
        ]);

        return $this->purchaseRequest?->isBuildingsDirectDelivery() ?? false;
    }

    public function selectedQuote(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequestQuote::class, 'selected_quote_id');
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class, 'supplier_id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by_user_id');
    }

    public function accountingReviewer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'reviewed_by_accounting_user_id');
    }

    public function finalizedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'finalized_by_user_id');
    }

    public function items(): HasMany
    {
        return $this->hasMany(PurchaseOrderItem::class, 'purchase_order_id');
    }

    public function isDepartmentConsolidated(): bool
    {
        return $this->consolidation_policy === self::CONSOLIDATION_POLICY_DEPARTMENT;
    }

    public function receipts(): HasMany
    {
        return $this->hasMany(PurchaseReceipt::class, 'purchase_order_id');
    }

    public function weighingGroups(): HasMany
    {
        return $this->hasMany(WeighingGroup::class, 'purchase_order_id');
    }

    public function shipmentGroups(): HasMany
    {
        return $this->hasMany(ShipmentGroup::class, 'purchase_order_id');
    }

    public function purchaseReceipts(): HasMany
    {
        return $this->receipts();
    }

    public function creator(): BelongsTo
    {
        return $this->createdBy();
    }

    public function supplierInvoices(): HasMany
    {
        return $this->hasMany(SupplierInvoice::class, 'purchase_order_id');
    }

    public function invoices(): HasMany
    {
        return $this->supplierInvoices();
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
     * Scope to filter only Actual Purchase Orders (excluding preliminary/unfinalized orders).
     * Strictly requires finalized_at IS NOT NULL, or formal final approval, or valid supplier invoices.
     */
    public function scopeActualPo($query)
    {
        return $query->where(function ($q) {
            $q->whereNotNull('finalized_at')
              ->orWhereIn('status', ['APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'])
              ->orWhereHas('supplierInvoices', fn ($iq) => $iq->whereNotIn('status', ['VOIDED', 'CANCELLED']));
        })->whereNotIn('status', ['PO_DRAFT', 'PENDING_ACTUAL_PO', 'REJECTED', 'CANCELLED', 'VOIDED']);
    }

    /**
     * Scope to filter orders that are strictly finalized (whereNotNull('finalized_at')).
     */
    public function scopeFinalizedActual($query)
    {
        return $query->whereNotNull('finalized_at')
            ->whereNotIn('status', ['PO_DRAFT', 'PENDING_ACTUAL_PO', 'REJECTED', 'CANCELLED', 'VOIDED']);
    }

    /**
     * Check if this purchase order is an Actual PO.
     */
    /**
     * Check if this purchase order is an Actual PO.
     */
    public function isActualPo(): bool
    {
        if (in_array($this->status, ['PO_DRAFT', 'PENDING_ACTUAL_PO', 'REJECTED', 'CANCELLED', 'VOIDED'], true)) {
            return false;
        }

        return ! is_null($this->finalized_at)
            || in_array($this->status, ['APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'], true)
            || $this->supplierInvoices()->whereNotIn('status', ['VOIDED', 'CANCELLED'])->exists();
    }

    /**
     * Check if this purchase order represents an internal stock withdrawal / warehouse movement.
     */
    public function isInternalWarehouse(): bool
    {
        return $this->supplier?->isInternalWarehouse()
            || ($this->supplier_id && $this->supplier_id === Supplier::getOrCreateInternalWarehouseSupplier()->id);
    }
}
