<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class PurchaseRequestItemResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'item_id' => $this->item_id,
            'item' => $this->whenLoaded('item', function () {
                return [
                    'id' => $this->item->id,
                    'name' => $this->item->name,
                    'sku' => $this->item->sku,
                ];
            }),
            'supplier_id' => $this->supplier_id,
            'supplier' => $this->relationLoaded('supplier') && $this->supplier ? [
                'id' => $this->supplier->id,
                'company_name' => $this->supplier->company_name,
                'code' => $this->supplier->code ?? null,
            ] : ($this->supplier_id && $this->supplier ? [
                'id' => $this->supplier->id,
                'company_name' => $this->supplier->company_name,
                'code' => $this->supplier->code ?? null,
            ] : null),
            'item_description' => $this->item_description,
            'item_reference' => $this->item_reference,
            'region' => $this->region,
            'quantity' => \App\Support\DecimalHelper::formatCleanDecimal($this->quantity, 4),
            'uom' => $this->uom,
            'estimated_unit_price' => \App\Support\DecimalHelper::formatCleanDecimal($this->estimated_unit_price, 4),
            'estimated_line_total' => number_format((float) $this->estimated_line_total, 2, '.', ''),
            'specifications' => $this->specifications,
            'notes' => $this->notes,
            'is_supplementary' => (bool) $this->is_supplementary,
            'is_consolidated_steel' => (bool) $this->is_consolidated_steel,
            'steel_components' => $this->whenLoaded('steelComponents'),
            'supplement_batch' => $this->supplement_batch ? (int) $this->supplement_batch : null,
            'is_ordered' => method_exists($this->resource, 'isOrdered') ? $this->isOrdered() : false,
            'purchase_order_id' => $this->relationLoaded('purchaseOrderItems')
                ? $this->purchaseOrderItems->firstWhere('purchaseOrder.status', '!==', 'REJECTED')?->purchase_order_id
                : null,
        ];
    }
}
