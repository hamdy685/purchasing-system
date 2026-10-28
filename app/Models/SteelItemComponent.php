<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Reference-only diameter detail under a consolidated steel (حديد) line.
 * Never part of any financial total: the parent line carries quantity and value.
 */
class SteelItemComponent extends Model
{
    protected $fillable = [
        'purchase_request_item_id',
        'purchase_order_item_id',
        'item_id',
        'item_description',
        'size_or_diameter',
        'quantity',
        'uom',
        'quantity_in_tons',
        'unit_price',
        'line_amount',
        'specifications',
        'sort_order',
    ];

    protected function casts(): array
    {
        return [
            'quantity' => 'decimal:4',
            'quantity_in_tons' => 'decimal:4',
            'unit_price' => 'decimal:4',
            'line_amount' => 'decimal:2',
            'sort_order' => 'integer',
        ];
    }

    public function purchaseRequestItem(): BelongsTo
    {
        return $this->belongsTo(PurchaseRequestItem::class);
    }

    public function purchaseOrderItem(): BelongsTo
    {
        return $this->belongsTo(PurchaseOrderItem::class);
    }
}
