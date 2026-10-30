<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class PurchaseOrderResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'po_number' => $this->po_number,
            'purchase_request_id' => $this->purchase_request_id,
            'selected_quote_id' => $this->selected_quote_id,
            'selected_quote' => $this->whenLoaded('selectedQuote', function () {
                return $this->selectedQuote ? [
                    'id' => $this->selectedQuote->id,
                    'supplier_id' => $this->selectedQuote->supplier_id,
                    'unit_price' => \App\Support\DecimalHelper::formatCleanDecimal($this->selectedQuote->unit_price, 4),
                    'total_amount' => number_format((float) $this->selectedQuote->total_amount, 2, '.', ''),
                    'currency' => $this->selectedQuote->currency,
                    'status' => $this->selectedQuote->status,
                ] : null;
            }),
            'purchase_request' => new PurchaseRequestResource($this->whenLoaded('purchaseRequest')),
            'project_name' => $this->relationLoaded('purchaseRequest')
                ? ($this->purchaseRequest?->project_name ?? ($this->purchaseRequest?->request_type === 'OFFICE_SUPPLIES' ? 'المقر الرئيسي / إداري' : null))
                : null,
            'parcel_reference' => $this->relationLoaded('purchaseRequest')
                ? ($this->purchaseRequest?->parcel_reference ?? ($this->relationLoaded('items') ? $this->items->first()?->item_reference : null))
                : ($this->relationLoaded('items') ? $this->items->first()?->item_reference : null),
            'region' => $this->relationLoaded('purchaseRequest')
                ? ($this->purchaseRequest?->region ?? ($this->relationLoaded('items') ? $this->items->first()?->region : null))
                : ($this->relationLoaded('items') ? $this->items->first()?->region : null),
            'requested_by' => $this->when($this->relationLoaded('purchaseRequest') && $this->purchaseRequest?->relationLoaded('requester'), function () {
                return $this->purchaseRequest?->requester ? [
                    'id' => $this->purchaseRequest->requester->id,
                    'name' => $this->purchaseRequest->requester->name,
                    'email' => $this->purchaseRequest->requester->email,
                ] : null;
            }),
            'executive_approver' => $this->when($this->relationLoaded('purchaseRequest'), function () {
                $entry = $this->purchaseRequest?->relationLoaded('approvalHistory')
                    ? $this->purchaseRequest->approvalHistory->first(fn ($item) => in_array($item->action, ['APPROVED_BY_EXECUTIVE', 'EXECUTIVE_SELECTED_QUOTE'], true))
                    : null;
                return $entry?->actor ? ['id' => $entry->actor->id, 'name' => $entry->actor->name, 'email' => $entry->actor->email] : null;
            }),
            'department_approver' => $this->when($this->relationLoaded('purchaseRequest'), function () {
                $approvedEntry = $this->purchaseRequest?->relationLoaded('approvalHistory')
                    ? $this->purchaseRequest->approvalHistory->firstWhere('action', 'APPROVED_BY_REVIEWER')
                    : null;
                $approver = $approvedEntry?->actor
                    ?? ($this->purchaseRequest?->relationLoaded('assignedReviewer') ? $this->purchaseRequest->assignedReviewer : null);

                return $approver ? [
                    'id' => $approver->id,
                    'name' => $approver->name,
                    'email' => $approver->email,
                ] : null;
            }),
            'department' => $this->when($this->relationLoaded('purchaseRequest') && $this->purchaseRequest?->relationLoaded('department'), function () {
                return $this->purchaseRequest?->department ? [
                    'id' => $this->purchaseRequest->department->id,
                    'name' => $this->purchaseRequest->department->name,
                    'code' => $this->purchaseRequest->department->code,
                ] : null;
            }),
            'supplier_id' => $this->supplier_id,
            'supplier' => new SupplierResource($this->whenLoaded('supplier')),
            'created_by' => $this->whenLoaded('createdBy', function () {
                return [
                    'id' => $this->createdBy->id,
                    'name' => $this->createdBy->name,
                    'email' => $this->createdBy->email,
                ];
            }),
            'status'       => $this->status,
            'is_actual_po' => $this->isActualPo(),
            'is_supplementary' => (bool) ($this->is_supplementary ?? false),
            'currency'            => 'EGP',
            'subtotal'            => number_format((float) $this->subtotal,    2, '.', ''),
            'discount_type'       => $this->discount_type ?? 'NONE',
            'discount_percentage' => \App\Support\DecimalHelper::formatCleanDecimal($this->discount_percentage ?? 0, 4),
            'discount_amount'     => number_format((float) ($this->discount_amount ?? 0), 2, '.', ''),
            'tax_amount'          => number_format((float) ($this->tax_amount ?? 0), 2, '.', ''),
            'grand_total'         => number_format((float) $this->grand_total, 2, '.', ''),
            'payment_terms'    => $this->payment_terms,
            'delivery_terms' => $this->delivery_terms,
            'delivery_date' => $this->delivery_date ? $this->delivery_date->format('Y-m-d') : null,
            'delivery_status' => $this->delivery_status ?? 'NOT_STARTED',
            'actual_delivery_date' => $this->actual_delivery_date ? $this->actual_delivery_date->format('Y-m-d') : null,
            'delivery_notes' => $this->delivery_notes,
            'budget_code' => $this->budget_code,
            'financial_notes' => $this->financial_notes,
            'notes' => $this->notes,
            'purpose' => $this->purchaseRequest?->notes ?? $this->notes,
            'finalized_by_user_id' => $this->finalized_by_user_id,
            'finalized_at' => $this->finalized_at ? $this->finalized_at->toIso8601String() : null,
            'finalization_notes' => $this->finalization_notes,
            'consolidation_policy' => $this->consolidation_policy,
            'is_department_consolidated' => $this->isDepartmentConsolidated(),
            'high_value_reason' => $this->high_value_reason,
            'high_value_threshold' => $this->high_value_threshold !== null ? (float) $this->high_value_threshold : null,
            'high_value_acknowledged_by_user_id' => $this->high_value_acknowledged_by_user_id,
            'high_value_acknowledged_at' => $this->high_value_acknowledged_at ? $this->high_value_acknowledged_at->toIso8601String() : null,
            'finalized_by' => $this->whenLoaded('finalizedBy', function () {
                return $this->finalizedBy ? [
                    'id' => $this->finalizedBy->id,
                    'name' => $this->finalizedBy->name,
                    'email' => $this->finalizedBy->email,
                ] : null;
            }),
            'invoice_photo_url' => $this->invoice_photo_url,
            'invoice_photo_name' => $this->invoice_photo_name,
            'invoice_photo_size' => $this->invoice_photo_size,
            'invoice_photo_drive_id' => $this->invoice_photo_drive_id,
            'invoice_photo_uploaded_at' => $this->invoice_photo_uploaded_at ? \Illuminate\Support\Carbon::parse($this->invoice_photo_uploaded_at)->toIso8601String() : null,
            'has_invoice_attachment' => (bool) $this->has_invoice_attachment,
            'invoice_attachments' => $this->attachments()->latest('id')->get()->map(function ($att) {
                return [
                    'id' => $att->id,
                    'file_name' => $att->file_name,
                    'file_size' => $att->file_size,
                    'mime_type' => $att->mime_type,
                    'drive_id' => $att->drive_id,
                    'file_url' => "/api/v1/purchase-orders/{$this->id}/invoice-photo?attachment_id={$att->id}",
                    'download_url' => "/api/v1/purchase-orders/{$this->id}/invoice-photo?attachment_id={$att->id}&download=1",
                    'uploaded_at' => $att->created_at ? $att->created_at->toIso8601String() : null,
                ];
            })->values(),
            'rejection_reason' => $this->rejection_reason,
            'created_at' => $this->created_at ? $this->created_at->toIso8601String() : null,
            'updated_at' => $this->updated_at ? $this->updated_at->toIso8601String() : null,
            'items' => PurchaseOrderItemResource::collection($this->whenLoaded('items')),
            'receipts' => $this->whenLoaded('receipts', function () {
                return $this->receipts->map(function ($receipt) {
                    return [
                        'id' => $receipt->id,
                        'receipt_number' => $receipt->receipt_number,
                        'receipt_type' => $receipt->receipt_type,
                        'status' => $receipt->status,
                        'received_at' => $receipt->received_at ? $receipt->received_at->format('Y-m-d') : null,
                        'warehouse_submitted_at' => $receipt->warehouse_submitted_at ? $receipt->warehouse_submitted_at->toIso8601String() : null,
                        'site_engineer_approved_at' => $receipt->site_engineer_approved_at ? $receipt->site_engineer_approved_at->toIso8601String() : null,
                        'warehouse_notes' => $receipt->warehouse_notes,
                        'site_engineer_notes' => $receipt->site_engineer_notes,
                        'receiver_notes' => $receipt->receiver_notes,
                        'photo_url' => $receipt->photo_url,
                        'photo_name' => $receipt->photo_name,
                        'warehouse_keeper' => $receipt->relationLoaded('warehouseKeeper') && $receipt->warehouseKeeper ? [
                            'id' => $receipt->warehouseKeeper->id,
                            'name' => $receipt->warehouseKeeper->name,
                        ] : null,
                        'warehouse_keeper_pass_status' => $receipt->warehouse_keeper_pass_status,
                        'warehouse_keeper_pass_label' => $receipt->warehouse_keeper_pass_label,
                        'site_engineer' => $receipt->relationLoaded('siteEngineer') && $receipt->siteEngineer ? [
                            'id' => $receipt->siteEngineer->id,
                            'name' => $receipt->siteEngineer->name,
                        ] : null,
                        'receiver' => $receipt->relationLoaded('receiver') && $receipt->receiver ? [
                            'id' => $receipt->receiver->id,
                            'name' => $receipt->receiver->name,
                        ] : null,
                        'actual_receiver_name' => $receipt->actual_receiver_name,
                        'actual_receiver' => $receipt->relationLoaded('actualReceiver') && $receipt->actualReceiver ? [
                            'id' => $receipt->actualReceiver->id,
                            'name' => $receipt->actualReceiver->name,
                        ] : null,
                        'actual_receiver_display_name' => $receipt->actual_receiver_display_name,
                        'items' => $receipt->relationLoaded('items') ? $receipt->items->map(function ($item) {
                            return [
                                'id' => $item->id,
                                'purchase_order_item_id' => $item->purchase_order_item_id,
                                'ordered_quantity' => (string) $item->ordered_quantity,
                                'received_quantity' => (string) $item->received_quantity,
                                'notes' => $item->notes,
                                'purchase_order_item' => $item->relationLoaded('purchaseOrderItem') && $item->purchaseOrderItem ? [
                                    'id' => $item->purchaseOrderItem->id,
                                    'item_description' => $item->purchaseOrderItem->item_description,
                                    'item_name' => $item->purchaseOrderItem->item_name,
                                    'uom' => $item->purchaseOrderItem->uom,
                                    'unit_price' => (string) $item->purchaseOrderItem->unit_price,
                                    'is_supplementary' => (bool) $item->purchaseOrderItem->is_supplementary,
                                    'supplement_batch' => $item->purchaseOrderItem->supplement_batch ? (int) $item->purchaseOrderItem->supplement_batch : null,
                                ] : null,
                            ];
                        }) : [],
                    ];
                });
            }),
            'shipment_groups' => $this->whenLoaded('shipmentGroups', function () {
                return $this->shipmentGroups->map(function ($sg) {
                    return [
                        'id'                   => $sg->id,
                        'group_number'         => $sg->group_number,
                        'group_name'           => $sg->group_name,
                        'status'               => $sg->status,
                        'vehicle_plate_number' => $sg->vehicle_plate_number,
                        'driver_name'          => $sg->driver_name,
                        'notes'                => $sg->notes,
                        'items_count'          => $sg->relationLoaded('items') ? $sg->items->count() : $sg->items()->count(),
                        'items'                => $sg->relationLoaded('items') ? PurchaseOrderItemResource::collection($sg->items) : [],
                    ];
                });
            }),
            'weighing_groups' => $this->whenLoaded('weighingGroups', function () {
                return $this->weighingGroups->map(function ($wg) {
                    return [
                        'id'                    => $wg->id,
                        'group_number'          => $wg->group_number,
                        'group_type'            => $wg->group_type,
                        'status'                => $wg->status,
                        'total_ordered_weight'  => (string) $wg->total_ordered_weight,
                        'total_received_weight' => $wg->total_received_weight !== null ? (string) $wg->total_received_weight : null,
                        'weight_difference'     => $wg->weight_difference !== null ? (string) $wg->weight_difference : null,
                        'uom'                   => $wg->uom,
                        'unit_price'            => (string) $wg->unit_price,
                        'total_amount'          => (string) $wg->total_amount,
                        'items_count'           => $wg->relationLoaded('items') ? $wg->items->count() : $wg->items()->count(),
                        'items'                 => $wg->relationLoaded('items') ? $wg->items : [],
                    ];
                });
            }),
        ];
    }
}
