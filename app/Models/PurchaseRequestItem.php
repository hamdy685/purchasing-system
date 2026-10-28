<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use App\Models\Concerns\RecordsSystemEvents;

class PurchaseRequestItem extends Model
{
    use HasFactory, RecordsSystemEvents;

    protected $table = 'purchase_request_items';

    protected static function booted(): void
    {
        static::creating(function (PurchaseRequestItem $item) {
            if (!empty($item->item_description) && empty($item->item_id)) {
                $name = trim($item->item_description);
                if ($name !== '') {
                    $catalogItem = Item::whereRaw('LOWER(TRIM(name)) = ?', [mb_strtolower($name)])->first();
                    if (!$catalogItem) {
                        $catalogItem = Item::create([
                            'name' => $name,
                            'sku' => 'SKU-' . strtoupper(substr(md5($name . microtime()), 0, 6)),
                            'uom' => $item->uom ?: 'PCS',
                            'category_id' => null,
                            'description' => $item->specifications ?: null,
                            'default_estimated_price' => $item->estimated_unit_price ?: 0.00,
                            'is_active' => true,
                        ]);
                    }
                    $item->item_id = $catalogItem->id;
                }
            }
        });

        static::updating(function (PurchaseRequestItem $item) {
            if ($item->isDirty('item_description') && !empty($item->item_description)) {
                $name = trim($item->item_description);
                if ($name !== '') {
                    $catalogItem = Item::whereRaw('LOWER(TRIM(name)) = ?', [mb_strtolower($name)])->first();
                    if (!$catalogItem) {
                        $catalogItem = Item::create([
                            'name' => $name,
                            'sku' => 'SKU-' . strtoupper(substr(md5($name . microtime()), 0, 6)),
                            'uom' => $item->uom ?: 'PCS',
                            'category_id' => null,
                            'description' => $item->specifications ?: null,
                            'default_estimated_price' => $item->estimated_unit_price ?: 0.00,
                            'is_active' => true,
                        ]);
                    }
                    $item->item_id = $catalogItem->id;
                }
            }
        });
    }

    protected $fillable = [
        'purchase_request_id',
        'item_id',
        'supplier_id',
        'item_description',
        'item_reference',
        'region',
        'quantity',
        'uom',
        'estimated_unit_price',
        'estimated_line_total',
        'is_supplementary',
        'supplement_id',
        'supplement_batch',
        'specifications',
        'notes',
        'is_consolidated_steel',
    ];

    protected function casts(): array
    {
        return [
            'is_supplementary' => 'boolean',
            'is_consolidated_steel' => 'boolean',
            'supplement_batch' => 'integer',
            'quantity' => 'decimal:4',
            'estimated_unit_price' => 'decimal:4',
            'estimated_line_total' => 'decimal:2',
        ];
    }

    public function getQuantityAttribute($value): ?string
    {
        return $value !== null ? \App\Support\DecimalHelper::formatCleanDecimal($value, 4) : null;
    }

    public function getEstimatedUnitPriceAttribute($value): ?string
    {
        return $value !== null ? \App\Support\DecimalHelper::formatCleanDecimal($value, 4) : null;
    }

    public function purchaseRequest(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequest::class, 'purchase_request_id');
    }

    public function supplement(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequestSupplement::class, 'supplement_id');
    }

    public function item(): BelongsTo
    {
        return $this->belongsTo(Item::class, 'item_id');
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class, 'supplier_id');
    }

    public function steelComponents(): HasMany
    {
        return $this->hasMany(SteelItemComponent::class, 'purchase_request_item_id')->orderBy('sort_order');
    }

    public function purchaseOrderItems(): HasMany
    {
        return $this->hasMany(PurchaseOrderItem::class, 'pr_item_id');
    }

    public function isOrdered(): bool
    {
        return $this->purchaseOrderItems()
            ->whereHas('purchaseOrder', function ($q) {
                $q->whereNotIn('status', ['REJECTED', 'CANCELLED', 'VOIDED']);
            })
            ->exists();
    }
}
