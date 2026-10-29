<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class PurchaseRequestResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $lifecycle = $this->getEffectiveLifecycle();
        $executiveStage = $this->getExecutiveDecisionStage();
        $isReturnedFromProcurement = ($executiveStage === 'FINAL_APPROVAL');

        $nextActorLabel = null;
        $requiredActionLabel = null;
        if ($this->status === 'PENDING_EXECUTIVE_APPROVAL') {
            if ($isReturnedFromProcurement) {
                $nextActorLabel = 'الإدارة المالية (الحسابات)';
                $requiredActionLabel = 'اعتماد تنفيذي نهائي (بعد التسعير)';
            } else {
                $nextActorLabel = 'إدارة المشتريات';
                $requiredActionLabel = 'موافقة مبدئية وإرسال للمشتريات';
            }
        } elseif ($this->status === 'PENDING_EXECUTIVE_QUOTE_DECISION') {
            $nextActorLabel = 'إدارة المشتريات (لإصدار أمر الشراء)';
            $requiredActionLabel = 'البت والترسية التنفيذية لعروض الأسعار';
        }

        return [
            'id' => $this->id,
            'request_number' => $this->request_number,
            'manual_request_number' => $this->manual_request_number,
            'request_type' => $this->request_type ?? 'PROJECT',
            'project_name' => $this->project_name ?? ($this->request_type === 'OFFICE_SUPPLIES' ? 'المقر الرئيسي / إداري' : null),
            'is_complementary' => $this->isComplementaryRequest(),
            'parcel_reference' => $this->parcel_reference,
            'region' => $this->region,
            'land_parcel_id' => $this->land_parcel_id,
            'land_parcel' => $this->relationLoaded('landParcel') && $this->landParcel ? [
                'id' => $this->landParcel->id,
                'parcel_reference' => $this->landParcel->parcel_reference,
                'region' => $this->landParcel->region,
            ] : null,
            'status' => $this->status,
            'effective_status' => $lifecycle['status'],
            'effective_status_label' => $lifecycle['label'],
            'effective_last_action' => $lifecycle['last_action'],
            'latest_purchase_order' => $lifecycle['po_number'] ? [
                'id' => $lifecycle['po_id'],
                'po_number' => $lifecycle['po_number'],
                'is_actual_po' => $lifecycle['is_actual_po'],
            ] : null,
            'procurement_route' => $this->procurement_route,
            'direct_supplier_id' => $this->direct_supplier_id,
            'executive_stage' => $executiveStage,
            'is_returned_from_procurement' => $isReturnedFromProcurement,
            'next_actor_label' => $nextActorLabel,
            'required_action_label' => $requiredActionLabel,
            'requires_warehouse_receipt' => (bool) ($this->requires_warehouse_receipt ?? true),
            'total_estimated_cost' => number_format((float) $this->total_estimated_cost, 2, '.', ''),
            'purchase_order_issued' => (int) ($this->issued_purchase_orders_count ?? 0) > 0 || (bool) $lifecycle['po_number'],
            'priority' => $this->priority,
            'date_needed' => $this->date_needed instanceof \DateTimeInterface
                ? $this->date_needed->format('Y-m-d')
                : ($this->date_needed ? substr((string) $this->date_needed, 0, 10) : null),
            'notes' => $this->notes,
            'purpose' => $this->notes,
            'rejection_reason' => $this->rejection_reason,
            'return_reason' => $this->return_reason,
            'submitted_at' => $this->submitted_at instanceof \DateTimeInterface
                ? $this->submitted_at->toIso8601String()
                : ($this->submitted_at ? (string) $this->submitted_at : null),
            'created_at' => $this->created_at instanceof \DateTimeInterface
                ? $this->created_at->toIso8601String()
                : ($this->created_at ? (string) $this->created_at : null),
            'updated_at' => $this->updated_at instanceof \DateTimeInterface
                ? $this->updated_at->toIso8601String()
                : ($this->updated_at ? (string) $this->updated_at : null),
            'requester' => $this->whenLoaded('requester', function () {
                if (! $this->requester) {
                    return null;
                }
                return [
                    'id' => $this->requester->id,
                    'name' => $this->requester->name,
                    'email' => $this->requester->email,
                    'role' => $this->requester->relationLoaded('roles')
                        ? $this->requester->roles->pluck('slug')->first()
                        : null,
                ];
            }),
            'requester_role' => $this->when(
                $this->relationLoaded('requester') && $this->requester && $this->requester->relationLoaded('roles'),
                fn () => $this->requester?->roles->pluck('slug')->first(),
            ),
            'is_general_manager_requester' => $this->when(
                $this->relationLoaded('requester') && $this->requester && $this->requester->relationLoaded('roles'),
                fn () => (bool) $this->requester?->roles->contains(fn ($role) => $role->slug === 'general_manager'),
            ),
            'department' => $this->relationLoaded('department') && $this->department ? [
                'id' => $this->department->id,
                'name' => $this->department->name,
                'code' => $this->department->code,
            ] : ($this->relationLoaded('targetDepartment') && $this->targetDepartment ? [
                'id' => $this->targetDepartment->id,
                'name' => $this->targetDepartment->name,
                'code' => $this->targetDepartment->code,
            ] : null),
            'department_id' => $this->department_id,
            'target_department_id' => $this->target_department_id ?? $this->department_id,
            // Department consolidation applies: the server issues one consolidated PO per supplier and scope.
            'consolidated_po_required' => $this->resource instanceof \App\Models\PurchaseRequest
                && \App\Services\PurchaseOrderSourceService::isMandatoryForRequest($this->resource),
            'site_engineer_user_id' => $this->site_engineer_user_id,
            'reviewer_user_id' => $this->reviewer_user_id,
            'target_department' => $this->relationLoaded('targetDepartment') && $this->targetDepartment ? [
                'id' => $this->targetDepartment->id,
                'name' => $this->targetDepartment->name,
                'code' => $this->targetDepartment->code,
                'manager' => $this->targetDepartment->relationLoaded('manager') && $this->targetDepartment->manager
                    ? ['id' => $this->targetDepartment->manager->id, 'name' => $this->targetDepartment->manager->name]
                    : null,
                'site_engineer' => $this->targetDepartment->relationLoaded('siteEngineer') && $this->targetDepartment->siteEngineer
                    ? ['id' => $this->targetDepartment->siteEngineer->id, 'name' => $this->targetDepartment->siteEngineer->name]
                    : null,
            ] : ($this->relationLoaded('department') && $this->department ? [
                'id' => $this->department->id,
                'name' => $this->department->name,
                'code' => $this->department->code,
            ] : null),
            'direct_supplier' => $this->whenLoaded('directSupplier', function () {
                return $this->directSupplier ? [
                    'id' => $this->directSupplier->id,
                    'company_name' => $this->directSupplier->company_name,
                    'code' => $this->directSupplier->code,
                ] : null;
            }),
            'assigned_reviewer' => $this->whenLoaded('assignedReviewer', function () {
                return $this->assignedReviewer ? [
                    'id' => $this->assignedReviewer->id,
                    'name' => $this->assignedReviewer->name,
                    'email' => $this->assignedReviewer->email,
                    'department_id' => $this->assignedReviewer->department_id,
                ] : null;
            }),
            'site_engineer' => $this->whenLoaded('siteEngineer', function () {
                return $this->siteEngineer ? [
                    'id' => $this->siteEngineer->id,
                    'name' => $this->siteEngineer->name,
                    'email' => $this->siteEngineer->email,
                    'department_id' => $this->siteEngineer->department_id,
                ] : null;
            }),
            'items' => PurchaseRequestItemResource::collection($this->whenLoaded('items')),
            'quotes' => $this->whenLoaded('quotes', function () {
                return $this->quotes->map(fn ($quote) => [
                    'id' => $quote->id,
                    'supplier_id' => $quote->supplier_id,
                    'supplier' => $quote->relationLoaded('supplier') && $quote->supplier ? [
                        'id' => $quote->supplier->id,
                        'company_name' => $quote->supplier->company_name,
                    ] : null,
                    'unit_price' => \App\Support\DecimalHelper::formatCleanDecimal($quote->unit_price, 4),
                    'total_amount' => number_format((float) $quote->total_amount, 2, '.', ''),
                    'currency' => $quote->currency,
                    'notes' => $quote->notes,
                    'file_path' => $quote->file_path,
                    'file_name' => $quote->file_name,
                    'file_size' => $quote->file_size,
                    'file_url' => $quote->file_url,
                    'file_drive_id' => $quote->file_drive_id,
                    'mime_type' => $quote->mime_type,
                    'status' => $quote->status,
                    'recommendations' => $quote->relationLoaded('recommendations')
                        ? $quote->recommendations->map(fn ($recommendation) => [
                            'id' => $recommendation->id,
                            'user_id' => $recommendation->user_id,
                            'role_type' => $recommendation->role_type,
                            'decision' => $recommendation->decision,
                            'comment' => $recommendation->comment,
                            'user' => $recommendation->relationLoaded('user') && $recommendation->user
                                ? ['id' => $recommendation->user->id, 'name' => $recommendation->user->name]
                                : null,
                        ])->values()
                        : [],
                ])->values();
            }),
            'selected_quote' => $this->whenLoaded('selectedQuote', function () {
                return $this->selectedQuote ? [
                    'id' => $this->selectedQuote->id,
                    'supplier_id' => $this->selectedQuote->supplier_id,
                    'supplier' => $this->selectedQuote->relationLoaded('supplier') && $this->selectedQuote->supplier
                        ? ['id' => $this->selectedQuote->supplier->id, 'company_name' => $this->selectedQuote->supplier->company_name]
                        : null,
                    'unit_price' => \App\Support\DecimalHelper::formatCleanDecimal($this->selectedQuote->unit_price, 4),
                    'total_amount' => number_format((float) $this->selectedQuote->total_amount, 2, '.', ''),
                    'currency' => $this->selectedQuote->currency,
                    'file_path' => $this->selectedQuote->file_path,
                    'file_name' => $this->selectedQuote->file_name,
                    'file_size' => $this->selectedQuote->file_size,
                    'file_url' => $this->selectedQuote->file_url,
                    'file_drive_id' => $this->selectedQuote->file_drive_id,
                    'mime_type' => $this->selectedQuote->mime_type,
                    'status' => $this->selectedQuote->status,
                ] : null;
            }),
            'approval_history' => $this->whenLoaded('approvalHistory', function () {
                return $this->approvalHistory->map(fn ($entry) => [
                    'action' => $entry->action,
                    'from_state' => $entry->from_state,
                    'to_state' => $entry->to_state,
                    'comments' => $entry->comments,
                    'created_at' => $entry->created_at?->toIso8601String(),
                    'actor' => $entry->relationLoaded('actor') && $entry->actor ? [
                        'id' => $entry->actor->id,
                        'name' => $entry->actor->name,
                        'role' => $entry->actor->relationLoaded('roles') ? ($entry->actor->roles->pluck('name')->first() ?? $entry->actor->roles->pluck('slug')->first()) : null,
                    ] : null,
                ])->values();
            }),
            'attachments' => $this->whenLoaded('attachments', function () {
                return $this->attachments->map(fn ($att) => [
                    'id' => $att->id,
                    'file_name' => $att->file_name,
                    'mime_type' => $att->mime_type,
                    'file_size' => $att->file_size,
                    'uploaded_by' => $att->relationLoaded('uploadedBy') && $att->uploadedBy
                        ? $att->uploadedBy->name
                        : null,
                    'created_at' => $att->created_at?->toIso8601String(),
                ])->values();
            }),
            'purchase_orders' => $this->whenLoaded('purchaseOrders', function () {
                return $this->purchaseOrders->map(fn ($po) => [
                    'id' => $po->id,
                    'po_number' => $po->po_number,
                    'status' => $po->status,
                    'delivery_status' => $po->delivery_status,
                    'total_amount' => $po->total_amount,
                    'finalized_at' => $po->finalized_at ? ($po->finalized_at instanceof \DateTimeInterface ? $po->finalized_at->toIso8601String() : (string) $po->finalized_at) : null,
                    'is_actual_po' => (bool) ($po->finalized_at !== null || $po->status === 'FINAL_APPROVED'),
                    'supplier' => $po->relationLoaded('supplier') && $po->supplier
                        ? ['id' => $po->supplier->id, 'company_name' => $po->supplier->company_name]
                        : null,
                    'has_approved_receipt' => $po->relationLoaded('receipts')
                        ? $po->receipts->contains(fn ($r) => $r->status === 'APPROVED')
                        : false,
                    'receipts' => $po->relationLoaded('receipts')
                        ? $po->receipts->map(fn ($r) => [
                            'id' => $r->id,
                            'receipt_number' => $r->receipt_number,
                            'receipt_type' => $r->receipt_type,
                            'status' => $r->status,
                            'received_at' => $r->received_at ? $r->received_at->format('Y-m-d') : null,
                            'receiver_notes' => $r->receiver_notes,
                        ])
                        : [],
                ])->values();
            }),
            'supplements' => $this->whenLoaded('supplements', function () {
                return $this->supplements->map(fn ($supp) => [
                    'id' => $supp->id,
                    'purchase_request_id' => $supp->purchase_request_id,
                    'supplement_number' => $supp->batch_number ? 'SUPP-' . $supp->batch_number : null,
                    'batch_number' => $supp->batch_number,
                    'status' => $supp->status,
                    'notes' => $supp->notes,
                    'rejection_reason' => $supp->rejection_reason,
                    'created_at' => $supp->created_at?->toIso8601String(),
                    'requester' => $supp->relationLoaded('requester') && $supp->requester ? [
                        'id' => $supp->requester->id,
                        'name' => $supp->requester->name,
                    ] : null,
                    'reviewer' => $supp->relationLoaded('reviewer') && $supp->reviewer ? [
                        'id' => $supp->reviewer->id,
                        'name' => $supp->reviewer->name,
                    ] : null,
                    'items' => $supp->relationLoaded('items') ? $supp->items->map(fn ($it) => [
                        'id' => $it->id,
                        'item_description' => $it->item_description,
                        'quantity' => $it->quantity,
                        'uom' => $it->uom,
                        'estimated_unit_price' => $it->estimated_unit_price,
                        'item_reference' => $it->item_reference,
                        'region' => $it->region,
                        'specifications' => $it->specifications,
                    ]) : [],
                ])->values();
            }),
        ];
    }
}

