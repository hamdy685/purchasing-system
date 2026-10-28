<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use App\Models\Concerns\RecordsSystemEvents;

class ShipmentGroup extends Model
{
    use HasFactory, RecordsSystemEvents;

    protected $table = 'shipment_groups';

    protected $fillable = [
        'group_number',
        'purchase_order_id',
        'supplier_id',
        'group_name',
        'status',
        'vehicle_plate_number',
        'driver_name',
        'driver_phone',
        'notes',
        'created_by_user_id',
    ];

    public function purchaseOrder(): BelongsTo
    {
        return $this->belongsTo(PurchaseOrder::class, 'purchase_order_id');
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class, 'supplier_id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by_user_id');
    }

    public function items(): HasMany
    {
        return $this->hasMany(PurchaseOrderItem::class, 'shipment_group_id');
    }

    /**
     * Determine shipment receiving status based on member items received quantities.
     */
    public function resolveDynamicStatus(): string
    {
        if ($this->status === 'CANCELLED') {
            return 'CANCELLED';
        }

        $items = $this->items()->with(['receiptItems.receipt'])->get();
        if ($items->isEmpty()) {
            return 'PENDING_DELIVERY';
        }

        // Items carry different units (bags, meters, pieces...), so completion is judged per item:
        // a surplus on one line must never cover a shortage on another.
        $allItemsComplete = true;
        $hasAnyReceived = false;

        foreach ($items as $item) {
            $receivedForItem = (float) ($item->received_quantity ?? 0);
            if ($receivedForItem > 0) {
                $hasAnyReceived = true;
            }
            if ($receivedForItem < (float) $item->quantity) {
                $allItemsComplete = false;
            }
        }

        if ($allItemsComplete && $hasAnyReceived) {
            return 'RECEIVED';
        }

        if ($hasAnyReceived) {
            return 'PARTIALLY_RECEIVED';
        }

        return 'PENDING_DELIVERY';
    }
}
