<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use App\Models\Concerns\RecordsSystemEvents;

class PurchaseOrderItem extends Model
{
    use HasFactory, RecordsSystemEvents;

    protected $table = 'purchase_order_items';

    protected $fillable = [
        'purchase_order_id',
        'pr_item_id',
        'item_id',
        'item_description',
        'item_reference',
        'region',
        'quantity',
        'uom',
        'unit_price',
        'is_discount_applied',
        'discount_amount',
        'tax_amount',
        'line_total',
        'is_supplementary',
        'supplement_batch',
        'specifications',
        'supplier_id',
        'shipment_group_id',
        'is_consolidated_steel',
    ];

    protected function casts(): array
    {
        return [
            'is_discount_applied' => 'boolean',
            'is_supplementary' => 'boolean',
            'is_consolidated_steel' => 'boolean',
            'supplement_batch' => 'integer',
            'quantity' => 'decimal:4',
            'unit_price' => 'decimal:4',
            'discount_amount' => 'decimal:2',
            'tax_amount' => 'decimal:2',
            'line_total' => 'decimal:2',
        ];
    }

    public function getQuantityAttribute($value): ?string
    {
        return $value !== null ? \App\Support\DecimalHelper::formatCleanDecimal($value, 4) : null;
    }

    public function getUnitPriceAttribute($value): ?string
    {
        return $value !== null ? \App\Support\DecimalHelper::formatCleanDecimal($value, 4) : null;
    }

    protected $appends = [
        'pr_item_quantity',
    ];

    public function getPrItemQuantityAttribute(): ?float
    {
        if ($this->relationLoaded('prItem') && $this->prItem) {
            return (float) $this->prItem->quantity;
        }
        return null;
    }

    protected static function booted(): void
    {
        static::saving(function (PurchaseOrderItem $item): void {
            if ($item->quantity !== null && $item->unit_price !== null) {
                $item->line_total = round((float) $item->quantity * (float) $item->unit_price, 2);
            }
        });
    }

    public function getFinalQuantityAttribute(): float
    {
        return (float) ($this->quantity ?? 0);
    }

    public function getFinalUnitPriceAttribute(): float
    {
        return (float) ($this->unit_price ?? 0);
    }

    public function getFinalLineTotalAttribute(): float
    {
        if ($this->line_total !== null && (float) $this->line_total > 0) {
            return (float) $this->line_total;
        }

        return round($this->final_quantity * $this->final_unit_price, 2);
    }

    public function purchaseOrder(): BelongsTo
    {
        return $this->belongsTo(PurchaseOrder::class, 'purchase_order_id');
    }

    public function prItem(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequestItem::class, 'pr_item_id');
    }

    public function item(): BelongsTo
    {
        return $this->belongsTo(Item::class, 'item_id');
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class, 'supplier_id');
    }

    public function receiptItems(): \Illuminate\Database\Eloquent\Relations\HasMany
    {
        return $this->hasMany(PurchaseReceiptItem::class, 'purchase_order_item_id');
    }

    public function weighingGroupItem(): \Illuminate\Database\Eloquent\Relations\HasOne
    {
        return $this->hasOne(WeighingGroupItem::class, 'purchase_order_item_id');
    }

    public function steelComponents(): \Illuminate\Database\Eloquent\Relations\HasMany
    {
        return $this->hasMany(SteelItemComponent::class, 'purchase_order_item_id')->orderBy('sort_order');
    }

    public function sources(): \Illuminate\Database\Eloquent\Relations\HasMany
    {
        return $this->hasMany(PurchaseOrderItemSource::class, 'purchase_order_item_id')->orderBy('id');
    }

    public function shipmentGroup(): BelongsTo
    {
        return $this->belongsTo(ShipmentGroup::class, 'shipment_group_id');
    }

    public function getActualQuantityAttribute(): float
    {
        return (float) ($this->quantity ?? 0);
    }

    public function getActualLineTotalAttribute(): float
    {
        if ($this->line_total !== null && (float) $this->line_total > 0) {
            return (float) $this->line_total;
        }

        return round((float) ($this->quantity ?? 0) * (float) ($this->unit_price ?? 0), 2);
    }

    public function getReceivedQuantityAttribute(): ?float
    {
        if ($this->relationLoaded('receiptItems')) {
            $approved = $this->receiptItems->filter(fn ($ri) => $ri->receipt && in_array($ri->receipt->status, ['APPROVED', 'PENDING_SITE_ENGINEER', 'DELIVERED'], true));
            if ($approved->isNotEmpty()) {
                return (float) $approved->sum('received_quantity');
            }
        }
        return null;
    }
}

