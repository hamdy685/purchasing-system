<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One purchase request line's contribution to a department-consolidated PO line.
 * Reference/provenance only: never part of any financial total (the PO line carries
 * quantity and value). Rows are released (active_flag = NULL), never deleted.
 */
class PurchaseOrderItemSource extends Model
{
    protected $fillable = [
        'purchase_order_item_id',
        'purchase_request_id',
        'purchase_request_item_id',
        'department_id',
        'land_parcel_id',
        'item_reference',
        'region',
        'supplier_id',
        'source_quantity',
        'source_uom',
        'line_quantity',
        'unit_price',
        'line_amount',
        'active_flag',
        'released_at',
        'released_reason',
        'consolidation_run_id',
        'created_by_user_id',
    ];

    protected function casts(): array
    {
        return [
            'source_quantity' => 'decimal:4',
            'line_quantity' => 'decimal:4',
            'unit_price' => 'decimal:4',
            'line_amount' => 'decimal:2',
            'active_flag' => 'integer',
            'released_at' => 'datetime',
        ];
    }

    public function scopeActive(Builder $query): Builder
    {
        return $query->where('active_flag', 1);
    }

    public function isActive(): bool
    {
        return (int) $this->active_flag === 1;
    }

    public function purchaseOrderItem(): BelongsTo
    {
        return $this->belongsTo(PurchaseOrderItem::class);
    }

    public function purchaseRequest(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequest::class);
    }

    public function purchaseRequestItem(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequestItem::class);
    }

    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class);
    }

    public function landParcel(): BelongsTo
    {
        return $this->belongsTo(LandParcel::class);
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class);
    }
}
