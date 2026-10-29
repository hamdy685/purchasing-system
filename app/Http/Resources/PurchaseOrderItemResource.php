<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class PurchaseOrderItemResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id'               => $this->id,
            'purchase_order_id'=> $this->purchase_order_id,
            'pr_item_id'       => $this->pr_item_id,
            'item_id'          => $this->item_id,
            'item_name'        => $this->relationLoaded('item') ? ($this->item?->name ?? $this->item_description) : $this->item_description,
            'item'             => $this->whenLoaded('item', function () {
                return [
                    'id'   => $this->item->id,
                    'name' => $this->item->name,
                    'sku'  => $this->item->sku,
                ];
            }),
            'item_description' => $this->item_description,
            'item_reference'   => $this->item_reference,
            'region'           => $this->region,
            'quantity'         => \App\Support\DecimalHelper::formatCleanDecimal($this->quantity, 4),
            'original_quantity'=> \App\Support\DecimalHelper::formatCleanDecimal($this->quantity, 4),
            'actual_quantity'  => \App\Support\DecimalHelper::formatCleanDecimal($this->quantity, 4),
            'uom'              => $this->uom,
            'pr_item_quantity' => $this->whenLoaded('prItem', function () {
                return $this->prItem ? \App\Support\DecimalHelper::formatCleanDecimal($this->prItem->quantity, 4) : null;
            }, function () {
                return $this->pr_item_id && $this->relationLoaded('prItem') && $this->prItem ? \App\Support\DecimalHelper::formatCleanDecimal($this->prItem->quantity, 4) : null;
            }),
            'unit_price'       => \App\Support\DecimalHelper::formatCleanDecimal($this->unit_price, 4),
            'actual_unit_price'=> \App\Support\DecimalHelper::formatCleanDecimal($this->unit_price, 4),
            'line_total'          => number_format((float) ($this->line_total > 0 ? $this->line_total : round((float)$this->quantity * (float)$this->unit_price, 2)), 2, '.', ''),
            'actual_line_total'   => number_format((float) ($this->line_total > 0 ? $this->line_total : round((float)$this->quantity * (float)$this->unit_price, 2)), 2, '.', ''),
            'final_quantity'      => \App\Support\DecimalHelper::formatCleanDecimal($this->quantity, 4),
            'final_unit_price'    => \App\Support\DecimalHelper::formatCleanDecimal($this->unit_price, 4),
            'final_line_total'    => number_format((float) ($this->line_total > 0 ? $this->line_total : round((float)$this->quantity * (float)$this->unit_price, 2)), 2, '.', ''),
            'is_discount_applied' => (bool) ($this->is_discount_applied ?? false),
            'discount_amount'     => number_format((float) ($this->discount_amount ?? 0), 2, '.', ''),
            'specifications'      => $this->specifications,
            'is_supplementary' => (bool) $this->is_supplementary,
            'is_consolidated_steel' => (bool) $this->is_consolidated_steel,
            'steel_components' => $this->whenLoaded('steelComponents'),
            // Request lines a department-consolidated line stands for (reference only; never summed with the line).
            'sources'          => $this->whenLoaded('sources', fn () => $this->sources->map(fn ($source) => [
                'id'                       => $source->id,
                'purchase_request_id'      => $source->purchase_request_id,
                'purchase_request_item_id' => $source->purchase_request_item_id,
                'item_description'         => $source->purchaseRequestItem?->item_description,
                'source_quantity'          => \App\Support\DecimalHelper::formatCleanDecimal($source->source_quantity, 4),
                'source_uom'               => $source->source_uom,
                'line_quantity'            => \App\Support\DecimalHelper::formatCleanDecimal($source->line_quantity, 4),
                'line_amount'              => number_format((float) $source->line_amount, 2, '.', ''),
                'is_active'                => $source->isActive(),
            ])->values()),
            'supplement_batch' => $this->supplement_batch ? (int) $this->supplement_batch : null,
            'supplier_id'      => $this->supplier_id,
            'supplier'         => $this->relationLoaded('supplier') && $this->supplier ? [
                'id'           => $this->supplier->id,
                'company_name' => $this->supplier->company_name,
                'code'         => $this->supplier->code,
            ] : ($this->supplier_id ? [
                'id'           => $this->supplier_id,
                'company_name' => $this->supplier?->company_name,
                'code'         => $this->supplier?->code,
            ] : null),
            'shipment_group_id' => $this->shipment_group_id,
            'shipment_group'    => $this->whenLoaded('shipmentGroup', function () {
                return $this->shipmentGroup ? [
                    'id'           => $this->shipmentGroup->id,
                    'group_number' => $this->shipmentGroup->group_number,
                    'group_name'   => $this->shipmentGroup->group_name,
                    'status'       => $this->shipmentGroup->status,
                ] : null;
            }),
            'weighing_group_item' => $this->whenLoaded('weighingGroupItem', function () {
                return $this->weighingGroupItem ? [
                    'id'                => $this->weighingGroupItem->id,
                    'weighing_group_id' => $this->weighingGroupItem->weighing_group_id,
                    'group_number'      => $this->weighingGroupItem->weighingGroup?->group_number,
                    'ordered_weight'    => (string) $this->weighingGroupItem->ordered_weight,
                    'received_weight'   => $this->weighingGroupItem->received_weight !== null ? (string) $this->weighingGroupItem->received_weight : null,
                ] : null;
            }),
        ];
    }
}

