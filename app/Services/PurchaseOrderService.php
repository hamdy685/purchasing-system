<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseRequest;
use App\Models\Supplier;
use App\Models\User;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

class PurchaseOrderService
{
    /**
     * Generate sequential unique Purchase Order number (PO-1, PO-2, ...).
     * Simple, clean, ascending starting from 1 with no leading zeros.
     */
    public function generatePoNumber(string $prefix = 'PO-'): string
    {
        $latestOrder = DB::table('purchase_orders')
            ->where('po_number', 'like', "{$prefix}%")
            ->orderBy('id', 'desc')
            ->lockForUpdate()
            ->first();

        $maxSeq = 0;
        if ($latestOrder) {
            $parts = explode('-', $latestOrder->po_number);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $maxSeq = (int) $lastPart;
            }
        }

        $existing = DB::table('purchase_orders')
            ->where('po_number', 'like', "{$prefix}%")
            ->pluck('po_number');

        foreach ($existing as $num) {
            $parts = explode('-', (string) $num);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $seq = (int) $lastPart;
                if ($seq > $maxSeq) {
                    $maxSeq = $seq;
                }
            }
        }

        $nextNumber = max(1, $maxSeq + 1);

        while (DB::table('purchase_orders')->where('po_number', "{$prefix}{$nextNumber}")->exists()) {
            $nextNumber++;
        }

        return "{$prefix}{$nextNumber}";
    }

    /**
     * Recalculate PO totals:
     * - Line base value = quantity × unit_price
     * - subtotal = SUM(quantity × unit_price)
     * - Discount:
     *     - TOTAL: discount_amount = subtotal × (discount_percentage / 100)
     *     - SELECTED_ITEMS: discount_amount = SUM(selected_items base value) × (discount_percentage / 100)
     * - grand_total = max(0, subtotal - discount_amount + tax_amount)
     */
    public function recalculateTotals(
        PurchaseOrder $po,
        ?string $discountType = null,
        ?float $discountPercentage = null,
        ?array $targetedItemIds = null
    ): void {
        $po->loadMissing('items');
        $items = $po->items;

        $subtotal = 0.00;
        foreach ($items as $item) {
            $qty = (float) ($item->quantity ?? 0);
            $price = (float) ($item->unit_price ?? 0);
            $lineBase = round($qty * $price, 2);
            $subtotal += $lineBase;
        }
        $subtotal = round($subtotal, 2);

        // Determine effective discount parameters:
        $effectiveType = $discountType !== null ? strtoupper(trim($discountType)) : ($po->discount_type ?? 'NONE');
        if (! in_array($effectiveType, ['NONE', 'TOTAL', 'SELECTED_ITEMS'], true)) {
            $effectiveType = 'NONE';
        }

        $effectivePercentage = $discountPercentage !== null
            ? max(0.0, min(100.0, (float) $discountPercentage))
            : max(0.0, min(100.0, (float) ($po->discount_percentage ?? 0)));

        $discountAmount = 0.00;

        if ($effectiveType === 'TOTAL' && $effectivePercentage > 0) {
            $discountAmount = round($subtotal * ($effectivePercentage / 100), 2);

            foreach ($items as $item) {
                $itemSub = round((float) $item->quantity * (float) $item->unit_price, 2);
                $itemDiscount = $subtotal > 0 ? round($itemSub * ($effectivePercentage / 100), 2) : 0.00;
                $item->updateQuietly([
                    'is_discount_applied' => false,
                    'discount_amount'     => $itemDiscount,
                ]);
            }
        } elseif ($effectiveType === 'SELECTED_ITEMS' && $effectivePercentage > 0) {
            $totalSelectedItemsDiscount = 0.00;

            foreach ($items as $item) {
                $isTargeted = false;
                if ($targetedItemIds !== null) {
                    $isTargeted = in_array((int) $item->id, $targetedItemIds, true);
                } else {
                    $isTargeted = (bool) $item->is_discount_applied;
                }

                $itemSub = round((float) $item->quantity * (float) $item->unit_price, 2);

                if ($isTargeted) {
                    $itemDiscount = round($itemSub * ($effectivePercentage / 100), 2);
                    $totalSelectedItemsDiscount += $itemDiscount;
                    $item->updateQuietly([
                        'is_discount_applied' => true,
                        'discount_amount'     => $itemDiscount,
                    ]);
                } else {
                    $item->updateQuietly([
                        'is_discount_applied' => false,
                        'discount_amount'     => 0.00,
                    ]);
                }
            }
            $discountAmount = round($totalSelectedItemsDiscount, 2);
        } else {
            // NONE or percentage is 0
            $effectiveType = 'NONE';
            $effectivePercentage = 0.00;
            $discountAmount = 0.00;
            foreach ($items as $item) {
                if ($item->is_discount_applied || (float) $item->discount_amount > 0) {
                    $item->updateQuietly([
                        'is_discount_applied' => false,
                        'discount_amount'     => 0.00,
                    ]);
                }
            }
        }

        $taxAmount = (float) ($po->tax_amount ?? 0);
        $grandTotal = max(0.00, round($subtotal - $discountAmount + $taxAmount, 2));

        $po->update([
            'subtotal'            => $subtotal,
            'discount_type'       => $effectiveType,
            'discount_percentage' => $effectivePercentage,
            'discount_amount'     => $discountAmount,
            'tax_amount'          => $taxAmount,
            'grand_total'         => $grandTotal,
        ]);
    }

    /**
     * List approved PRs eligible for PO creation.
     */
    public function getApprovedPurchaseRequests(): Collection
    {
        return PurchaseRequest::with(['requester', 'department', 'assignedReviewer', 'approvalHistory.actor', 'items.item', 'items.supplier'])
            ->where('status', 'APPROVED_BY_PROCUREMENT')
            ->orderBy('updated_at', 'desc')
            ->limit(500)
            ->get();
    }

    /**
     * List active suppliers for procurement.
     */
    public function getActiveSuppliers(): Collection
    {
        return Supplier::where('is_active', true)
            ->orderBy('company_name', 'asc')
            ->limit(500)
            ->get();
    }

    /**
     * Create a new draft Purchase Order from an approved Purchase Request.
     */
    public function createPoFromPr(User $user, int $prId, int $supplierId, array $options = []): PurchaseOrder
    {
        $pr = PurchaseRequest::with(['items', 'selectedQuote.supplier'])->findOrFail($prId);

        $isDirectPath = $pr->procurement_route === 'DIRECT';
        $canCreateFromDirectAccountingApproval = $isDirectPath && in_array($pr->status, ['APPROVED_BY_ACCOUNTING', 'APPROVED_BY_PROCUREMENT', 'APPROVED_BY_EXECUTIVE', 'PENDING_PROCUREMENT_APPROVAL'], true);
        $canCreateFromQuoteDecision = ! $isDirectPath && in_array($pr->status, ['APPROVED_BY_PROCUREMENT', 'APPROVED_BY_ACCOUNTING', 'APPROVED_BY_EXECUTIVE', 'PENDING_PROCUREMENT_APPROVAL'], true);

        if (! $canCreateFromDirectAccountingApproval && ! $canCreateFromQuoteDecision) {
            throw new \RuntimeException('لا يمكن إنشاء أمر الشراء قبل اعتماد الحسابات للطلب المباشر أو اكتمال قرار عروض الأسعار.');
        }

        $selectedQuote = $pr->selectedQuote;
        if ($selectedQuote && (int) $selectedQuote->supplier_id !== (int) $supplierId) {
            throw new \RuntimeException('لا يمكن تغيير مورد العرض الذي اختاره المدير التنفيذي.');
        }

        if ($selectedQuote) {
            $supplierId = (int) $selectedQuote->supplier_id;
        } elseif ($isDirectPath && empty($supplierId)) {
            $firstItemSupplier = $pr->items->firstWhere('supplier_id', '!=', null)?->supplier_id;
            $supplierId = (int) ($firstItemSupplier ?? $pr->direct_supplier_id ?? 0);
        }

        $supplier = $supplierId ? Supplier::find($supplierId) : null;
        if ($supplier && ! $supplier->is_active) {
            throw ValidationException::withMessages([
                'supplier_id' => ['The selected supplier is inactive.'],
            ]);
        }

        return DB::transaction(function () use ($user, $pr, $supplier, $options, $selectedQuote, $isDirectPath) {
            $sourceState = $pr->status;
            // Lock PR row to prevent race condition during concurrent PO creation
            $lockedPr = PurchaseRequest::where('id', $pr->id)->lockForUpdate()->first();

            $pendingSupplement = $pr->supplements()
                ->whereIn('status', ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED'])
                ->latest()
                ->first();

            $allowedStatuses = ['APPROVED_BY_ACCOUNTING', 'APPROVED_BY_PROCUREMENT', 'APPROVED_BY_EXECUTIVE', 'PENDING_PROCUREMENT_APPROVAL', 'APPROVED_BY_REVIEWER', 'APPROVED_BY_GM'];
            if ($pendingSupplement) {
                $allowedStatuses = array_merge($allowedStatuses, ['PO_ISSUED', 'ISSUED']);
            }
            if (! in_array($lockedPr->status, $allowedStatuses, true)) {
                throw new \RuntimeException('تغيرت حالة طلب الشراء أثناء الإنشاء. أعد تحميل الطلب وحاول مرة أخرى.');
            }

            // Check if items or PO already exist for this PR
            $itemsInput = $options['items'] ?? null;
            // A consolidated line carries the request lines it merges in 'sources'.
            $targetPrItemIds = !empty($itemsInput)
                ? collect($itemsInput)
                    ->flatMap(fn ($input) => ! empty($input['sources'])
                        ? collect($input['sources'])->pluck('pr_item_id')->all()
                        : [$input['pr_item_id'] ?? null])
                    ->filter()->map(fn ($v) => (int) $v)->unique()->values()->all()
                : [];
            $consolidation = $options['consolidation'] ?? null;

            if (! $pendingSupplement) {
                if (!empty($targetPrItemIds)) {
                    // Check if any of these specific PR items are already in an active (non-draft) PO
                    $alreadyOrderedItems = PurchaseOrderItem::whereIn('pr_item_id', $targetPrItemIds)
                        ->whereHas('purchaseOrder', function ($q) {
                            $q->whereNotIn('status', ['REJECTED', 'CANCELLED', 'VOIDED', 'PO_DRAFT', 'RETURNED_TO_PROCUREMENT']);
                        })
                        ->with('purchaseOrder')
                        ->get();

                    if ($alreadyOrderedItems->isNotEmpty()) {
                        $firstConflict = $alreadyOrderedItems->first();
                        throw new \RuntimeException("البند [{$firstConflict->item_description}] تم إصدار أمر شراء سابق له بالفعل (#{$firstConflict->purchaseOrder?->po_number}).");
                    }

                    // Lines merged into a consolidated "حديد" PO line are ordered too.
                    $mergedSteelConflict = \App\Models\SteelItemComponent::whereIn('purchase_request_item_id', $targetPrItemIds)
                        ->whereHas('purchaseOrderItem.purchaseOrder', function ($q) {
                            $q->whereNotIn('status', ['REJECTED', 'CANCELLED', 'VOIDED', 'PO_DRAFT', 'RETURNED_TO_PROCUREMENT']);
                        })
                        ->with('purchaseOrderItem.purchaseOrder')
                        ->first();

                    if ($mergedSteelConflict) {
                        throw new \RuntimeException("البند [{$mergedSteelConflict->item_description}] تم إصدار أمر شراء سابق له بالفعل ضمن بند حديد مجمع (#{$mergedSteelConflict->purchaseOrderItem?->purchaseOrder?->po_number}).");
                    }

                    // Lines held by an active department-consolidated PO line are ordered too.
                    $consolidatedConflict = \App\Models\PurchaseOrderItemSource::active()
                        ->whereIn('purchase_request_item_id', $targetPrItemIds)
                        ->whereHas('purchaseOrderItem.purchaseOrder', function ($q) {
                            $q->whereNotIn('status', ['REJECTED', 'CANCELLED', 'VOIDED', 'PO_DRAFT', 'RETURNED_TO_PROCUREMENT']);
                        })
                        ->with(['purchaseRequestItem', 'purchaseOrderItem.purchaseOrder'])
                        ->first();

                    if ($consolidatedConflict) {
                        throw new \RuntimeException("البند [{$consolidatedConflict->purchaseRequestItem?->item_description}] تم إصدار أمر شراء سابق له بالفعل ضمن أمر شراء مجمع (#{$consolidatedConflict->purchaseOrderItem?->purchaseOrder?->po_number}).");
                    }
                } else {
                    // Fallback when no items array provided
                    $existingPo = PurchaseOrder::where('purchase_request_id', $pr->id)
                        ->whereNotIn('status', ['REJECTED'])
                        ->first();

                    if ($existingPo) {
                        if (in_array($existingPo->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT'], true)) {
                            $existingPo->update([
                                'supplier_id' => $supplier?->id ?? $existingPo->supplier_id,
                                'payment_terms' => $options['payment_terms'] ?? $existingPo->payment_terms,
                                'delivery_terms' => $options['delivery_terms'] ?? $existingPo->delivery_terms,
                                'delivery_date' => !empty($options['delivery_date']) ? $options['delivery_date'] : ($existingPo->delivery_date ?? now()->toDateString()),
                                'budget_code' => $options['budget_code'] ?? $existingPo->budget_code,
                                'notes' => $options['notes'] ?? $existingPo->notes,
                            ]);
                            return $existingPo;
                        }
                        if ($existingPo->status === 'PENDING_ACCOUNTING_REVIEW') {
                            return $existingPo;
                        }

                        $unassignedCount = $pr->items()
                            ->whereNot(fn ($q) => PurchaseOrderSourceService::orderedScope($q))
                            ->count();

                        if ($unassignedCount === 0) {
                            throw new \RuntimeException('يوجد أمر شراء مصدر بالفعل لهذا الطلب (' . $existingPo->po_number . ').');
                        }
                    }
                }
            }

            $poNumber = $this->generatePoNumber();

            $po = PurchaseOrder::create([
                'po_number' => $poNumber,
                'purchase_request_id' => $pr->id,
                'selected_quote_id' => $selectedQuote?->id,
                'supplier_id' => $supplier?->id,
                'created_by_user_id' => $user->id,
                'status' => 'PO_DRAFT',
                'payment_terms' => $options['payment_terms'] ?? null,
                'delivery_terms' => $options['delivery_terms'] ?? null,
                'delivery_date' => !empty($options['delivery_date']) ? $options['delivery_date'] : now()->toDateString(),
                'budget_code' => $options['budget_code'] ?? null,
                'notes' => $options['notes'] ?? null,
                'consolidation_policy' => $consolidation ? PurchaseOrder::CONSOLIDATION_POLICY_DEPARTMENT : null,
                'consolidation_key' => $consolidation['key'] ?? null,
                'idempotency_key' => $consolidation['idempotency_key'] ?? null,
            ]);

            // Copy or map PR items to PO items
            $itemsInput = $options['items'] ?? null;

            if (! empty($itemsInput)) {
                foreach ($itemsInput as $inputIndex => $input) {
                    $sourcesInput = $input['sources'] ?? null;
                    $isMergedLine = is_array($sourcesInput) && count($sourcesInput) > 1;
                    $prItemId = $input['pr_item_id'] ?? ($sourcesInput[0]['pr_item_id'] ?? null);
                    $prItem = $prItemId ? $pr->items->firstWhere('id', $prItemId) : null;
                    [$itemReference, $region] = $this->requireReferenceFields(
                        $prItem?->item_reference,
                        $prItem?->region,
                        "items.{$inputIndex}"
                    );

                    $qty       = isset($input['quantity'])   ? (float) $input['quantity']   : ($prItem ? (float) $prItem->quantity : 1.0);
                    $uom       = $input['uom'] ?? $prItem?->uom ?? 'PCS';
                    $specs     = $input['specifications'] ?? $prItem?->specifications;

                    [$qty, $uom, $specs] = $this->normalizePoItemUnitAndQuantity($qty, $uom, $specs);

                    // Procurement sets the commercial unit price. PR estimated price is ignored.
                    $unitPrice = $selectedQuote
                        ? (float) $selectedQuote->unit_price
                        : (isset($input['unit_price']) ? (float) $input['unit_price'] : 0.0);
                    $lineTotal = round($qty * $unitPrice, 2);
                    $itemSupplierId = $input['supplier_id'] ?? $prItem?->supplier_id ?? $supplier?->id;

                    $isItemSupplementary = $pr->isComplementaryRequest() || !empty($input['is_supplementary']) || (bool)($prItem?->is_supplementary);

                    $poItem = $po->items()->create([
                        // A line merging several request lines points at none of them directly (see its sources).
                        'pr_item_id'      => $isMergedLine ? null : $prItem?->id,
                        'item_id'         => $input['item_id'] ?? $prItem?->item_id,
                        'item_description'=> $input['item_description'] ?? $prItem?->item_description ?? '',
                        'item_reference'  => $itemReference,
                        'region'          => $region,
                        'quantity'        => $qty,
                        'uom'             => $uom,
                        'unit_price'      => $unitPrice,
                        'line_total'      => $lineTotal,
                        'specifications'  => $specs,
                        'supplier_id'     => $itemSupplierId,
                        'is_supplementary'=> $isItemSupplementary,
                    ]);

                    if ($prItem && ! $isMergedLine && (float) $prItem->quantity !== $qty && $uom !== 'TON') {
                        AuditLog::create([
                            'user_id'     => $user->id,
                            'entity_type' => PurchaseOrderItem::class,
                            'entity_id'   => $poItem->id,
                            'action'      => 'QUANTITY_CHANGED',
                            'field_name'  => 'quantity',
                            'old_value'   => (string) $prItem->quantity,
                            'new_value'   => (string) $qty,
                        ]);
                    }

                    if (is_array($sourcesInput)) {
                        app(DepartmentPoConsolidationService::class)->writeSources($user, $pr, $poItem, $sourcesInput, $consolidation['run_id'] ?? null);
                    }
                }

                if ($consolidation) {
                    app(DepartmentPoConsolidationService::class)->assertSingleSupplier($po);
                }
            } else {
                // When no items array supplied: copy unassigned PR items
                $prItems = $pr->items->filter(fn ($item) => ! $item->isOrdered());
                if ($prItems->isEmpty()) {
                    $prItems = $pr->items;
                }
                foreach ($prItems as $prItem) {
                    [$itemReference, $region] = $this->requireReferenceFields(
                        $prItem->item_reference,
                        $prItem->region,
                        "pr_item.{$prItem->id}"
                    );
                    $qty = (float) $prItem->quantity;
                    $uom = $prItem->uom;
                    $specs = $prItem->specifications;
                    [$qty, $uom, $specs] = $this->normalizePoItemUnitAndQuantity($qty, $uom, $specs);

                    $unitPrice = $isDirectPath
                        ? (float) ($prItem->estimated_unit_price ?? 0.00)
                        : (float) ($selectedQuote?->unit_price ?? 0.00);

                    $po->items()->create([
                        'pr_item_id'      => $prItem->id,
                        'item_id'         => $prItem->item_id,
                        'item_description'=> $prItem->item_description,
                        'item_reference'  => $itemReference,
                        'region'          => $region,
                        'quantity'        => $qty,
                        'uom'             => $uom,
                        'unit_price'      => $unitPrice,
                        'line_total'      => round($qty * $unitPrice, 2),
                        'specifications'  => $specs,
                        'supplier_id'     => $prItem->supplier_id ?? $supplier?->id,
                        'is_supplementary'=> $pr->isComplementaryRequest() || (bool)($prItem?->is_supplementary),
                    ]);
                }
            }

            $this->recalculateTotals($po);



            app(\App\Services\NotificationService::class)->markEntityNotificationsAsRead($pr);

            ApprovalHistory::create([
                'target_type' => PurchaseOrder::class,
                'target_id' => $po->id,
                'actor_user_id' => $user->id,
                'action' => 'PO_CREATED',
                'from_state' => $sourceState,
                'to_state' => 'PO_DRAFT',
                'comments' => 'Purchase order created by procurement manager.',
            ]);

            app(SystemEventService::class)->recordAction(
                $po,
                'PO_CREATED',
                'أنشأ مدير المشتريات أمر شراء من طلب معتمد.',
                ['event_type' => 'purchase_order.created', 'from_state' => $sourceState, 'to_state' => 'PO_DRAFT', 'actor_user_id' => $user->id, 'metadata' => ['supplier_id' => $supplier?->id, 'selected_quote_id' => $selectedQuote?->id]]
            );


            AuditLog::create([
                'user_id' => $user->id,
                'entity_type' => PurchaseOrder::class,
                'entity_id' => $po->id,
                'action' => 'CREATED',
                'field_name' => 'po_number',
                'old_value' => null,
                'new_value' => $po->po_number,
            ]);

            if ($pendingSupplement) {
                $pendingSupplement->update([
                    'status' => 'PROCESSED_TO_PO',
                    'purchase_order_id' => $po->id,
                    'processed_at' => now(),
                ]);
            }

            return $po->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'selectedQuote', 'supplier', 'createdBy', 'items.item']);
        });
    }

    /**
     * Update draft Purchase Order header details.
     */
    public function updateHeader(User $user, PurchaseOrder $po, array $data): PurchaseOrder
    {
        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            throw new \RuntimeException('لا يمكن تعديل أمر شراء بهذه الحالة.');
        }

        return DB::transaction(function () use ($user, $po, $data) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->first();

            $allowedFields = [
                'supplier_id',
                'payment_terms',
                'delivery_terms',
                'delivery_date',
                'budget_code',
                'financial_notes',
                'notes',
                'finalization_notes',
                'discount_type',
                'discount_percentage',
            ];
            $updateFields = [];

            foreach ($allowedFields as $field) {
                if (array_key_exists($field, $data)) {
                    $oldVal = (string) ($lockedPo->{$field} ?? '');
                    $newVal = (string) ($data[$field] ?? '');

                    if ($oldVal !== $newVal) {
                        $updateFields[$field] = $data[$field];

                        AuditLog::create([
                            'user_id' => $user->id,
                            'entity_type' => PurchaseOrder::class,
                            'entity_id' => $lockedPo->id,
                            'action' => 'PO_HEADER_UPDATED',
                            'field_name' => $field,
                            'old_value' => $oldVal,
                            'new_value' => $newVal,
                        ]);
                    }
                }
            }

            if (! empty($updateFields)) {
                $lockedPo->update($updateFields);

                if (! empty($updateFields['supplier_id'])) {
                    $newSupId = (int) $updateFields['supplier_id'];
                    $lockedPo->receipts()->update(['supplier_id' => $newSupId]);

                    $openInvoices = \App\Models\SupplierInvoice::where('purchase_order_id', $lockedPo->id)
                        ->where('paid_amount', 0)
                        ->get();
                    foreach ($openInvoices as $inv) {
                        $oldSupId = $inv->supplier_id;
                        $inv->update(['supplier_id' => $newSupId]);
                        if ($oldSupId) {
                            app(SupplierInvoiceService::class)->refreshSupplierBalance($oldSupId);
                        }
                        app(SupplierInvoiceService::class)->refreshSupplierBalance($newSupId);
                    }
                }
            }

            if ($lockedPo->purchaseRequest) {
                $prUpdates = [];
                if (!empty($data['parcel_reference'])) {
                    $prUpdates['parcel_reference'] = trim((string) $data['parcel_reference']);
                }
                if (!empty($data['region'])) {
                    $prUpdates['region'] = trim((string) $data['region']);
                }
                if (!empty($prUpdates)) {
                    $lockedPo->purchaseRequest->update($prUpdates);
                }
            }

            if (! empty($data['items']) && is_array($data['items'])) {
                $this->syncPoItems($user, $lockedPo, $data['items']);
            }

            $discountType = array_key_exists('discount_type', $data) ? $data['discount_type'] : null;
            $discountPct = array_key_exists('discount_percentage', $data) ? (float) $data['discount_percentage'] : null;
            $discountItemIds = array_key_exists('discount_item_ids', $data) ? (array) $data['discount_item_ids'] : null;

            if ($discountType !== null || $discountPct !== null || $discountItemIds !== null) {
                $this->recalculateTotals($lockedPo, $discountType, $discountPct, $discountItemIds);
            }

            return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'selectedQuote', 'supplier', 'createdBy', 'items.item']);
        });
    }

    /**
     * Update commercial line item details on a PO.
     */
    public function updateItem(User $user, PurchaseOrder $po, PurchaseOrderItem $item, array $data): PurchaseOrder
    {
        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            throw new \RuntimeException('لا يمكن تعديل أمر شراء بهذه الحالة.');
        }

        if ($item->purchase_order_id !== $po->id) {
            throw new \InvalidArgumentException('Item does not belong to this purchase order.');
        }

        return DB::transaction(function () use ($user, $po, $item, $data) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->first();
            $lockedItem = PurchaseOrderItem::where('id', $item->id)->lockForUpdate()->first();

            $newQty       = array_key_exists('quantity',   $data) ? (float) $data['quantity']   : (float) $lockedItem->quantity;
            $newUnitPrice = array_key_exists('unit_price', $data) ? (float) $data['unit_price'] : (float) $lockedItem->unit_price;
            $newLineTotal = round($newQty * $newUnitPrice, 2);
            [$itemReference, $region] = $this->requireReferenceFields(
                array_key_exists('item_reference', $data) ? $data['item_reference'] : $lockedItem->item_reference,
                array_key_exists('region', $data) ? $data['region'] : $lockedItem->region,
                'item'
            );

            $updatePayload = [
                'item_id'         => $data['item_id'] ?? $lockedItem->item_id,
                'item_description'=> $data['item_description'] ?? $lockedItem->item_description,
                'item_reference'  => $itemReference,
                'region'          => $region,
                'quantity'        => $newQty,
                'uom'             => $data['uom'] ?? $lockedItem->uom,
                'unit_price'      => $newUnitPrice,
                'line_total'      => $newLineTotal,
                'specifications'  => array_key_exists('specifications', $data) ? $data['specifications'] : $lockedItem->specifications,
            ];

            foreach ($updatePayload as $field => $newVal) {
                $oldVal = (string) ($lockedItem->{$field} ?? '');
                $strNewVal = (string) ($newVal ?? '');

                if ($oldVal !== $strNewVal) {
                    AuditLog::create([
                        'user_id' => $user->id,
                        'entity_type' => PurchaseOrderItem::class,
                        'entity_id' => $lockedItem->id,
                        'action' => 'PO_ITEM_UPDATED',
                        'field_name' => $field,
                        'old_value' => $oldVal,
                        'new_value' => $strNewVal,
                    ]);
                }
            }

            $lockedItem->update($updatePayload);

            $this->recalculateTotals($lockedPo);

            return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'selectedQuote', 'supplier', 'createdBy', 'items.item']);
        });
    }

    /**
     * Add line item to a PO.
     */
    public function addItem(User $user, PurchaseOrder $po, array $data): PurchaseOrder
    {
        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            throw new \RuntimeException('لا يمكن تعديل أمر شراء بهذه الحالة.');
        }

        if ($po->isDepartmentConsolidated() && ! empty($data['supplier_id']) && (int) $data['supplier_id'] !== (int) $po->supplier_id) {
            throw ValidationException::withMessages([
                'supplier_id' => ['لا يمكن إضافة بند لمورد مختلف في أمر شراء مجمع. كل مورد له أمر شراء مستقل.'],
            ]);
        }

        return DB::transaction(function () use ($user, $po, $data) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->first();

            $qty       = (float) $data['quantity'];
            $unitPrice = (float) $data['unit_price'];
            $lineTotal = round($qty * $unitPrice, 2);
            [$itemReference, $region] = $this->requireReferenceFields(
                $data['item_reference'] ?? null,
                $data['region'] ?? null,
                'item'
            );

            $newItem = $lockedPo->items()->create([
                'item_id'         => $data['item_id'] ?? null,
                'item_description'=> $data['item_description'],
                'item_reference'  => $itemReference,
                'region'          => $region,
                'quantity'        => $qty,
                'uom'             => $data['uom'] ?? 'PCS',
                'unit_price'      => $unitPrice,
                'line_total'      => $lineTotal,
                'specifications'  => $data['specifications'] ?? null,
                // Lines added to a consolidated PO always belong to its one supplier.
                'supplier_id'     => $lockedPo->isDepartmentConsolidated() ? $lockedPo->supplier_id : null,
            ]);

            AuditLog::create([
                'user_id' => $user->id,
                'entity_type' => PurchaseOrderItem::class,
                'entity_id' => $newItem->id,
                'action' => 'PO_ITEM_ADDED',
                'field_name' => 'item_description',
                'old_value' => null,
                'new_value' => $newItem->item_description,
            ]);

            $this->recalculateTotals($lockedPo);

            return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'selectedQuote', 'supplier', 'createdBy', 'items.item']);
        });
    }

    /**
     * Delete line item from a PO.
     */
    public function deleteItem(User $user, PurchaseOrder $po, PurchaseOrderItem $item): PurchaseOrder
    {
        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            throw new \RuntimeException('لا يمكن تعديل أمر شراء بهذه الحالة.');
        }

        if ($item->purchase_order_id !== $po->id) {
            throw new \InvalidArgumentException('Item does not belong to this purchase order.');
        }

        $this->assertLineHasNoSources($item);

        return DB::transaction(function () use ($user, $po, $item) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->first();

            AuditLog::create([
                'user_id' => $user->id,
                'entity_type' => PurchaseOrderItem::class,
                'entity_id' => $item->id,
                'action' => 'PO_ITEM_REMOVED',
                'field_name' => 'item_description',
                'old_value' => $item->item_description,
                'new_value' => null,
            ]);

            $item->delete();

            $this->recalculateTotals($lockedPo);

            return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'selectedQuote', 'supplier', 'createdBy', 'items.item']);
        });
    }

    /**
     * Synchronize line items of a Purchase Order with an incoming items array.
     * Deletes removed items, updates existing items, creates new items, and recalculates totals.
     */
    public function syncPoItems(User $user, PurchaseOrder $lockedPo, array $items): float
    {
        $existingItems = $lockedPo->items()->get()->keyBy('id');
        $incomingIds   = collect($items)->pluck('id')->filter()->map(fn ($v) => (int) $v);

        // Delete items that were removed
        foreach ($existingItems as $existingId => $existingItem) {
            if (! $incomingIds->contains($existingId)) {
                $this->assertLineHasNoSources($existingItem);
                AuditLog::create([
                    'user_id'     => $user->id,
                    'entity_type' => PurchaseOrderItem::class,
                    'entity_id'   => $existingItem->id,
                    'action'      => 'PO_ITEM_REMOVED',
                    'field_name'  => 'item_description',
                    'old_value'   => $existingItem->item_description,
                    'new_value'   => null,
                ]);
                $existingItem->delete();
            }
        }

        $grandTotal = 0.0;

        foreach ($items as $input) {
            $qty       = max(0.0, (float) ($input['quantity'] ?? 0));
            $unitPrice = max(0.0, (float) ($input['unit_price'] ?? 0));

            $existingItemId = !empty($input['id']) ? (int) $input['id'] : null;
            $existingItem   = ($existingItemId && $existingItems->has($existingItemId)) ? $existingItems->get($existingItemId) : null;

            $uom = $input['uom'] ?? ($existingItem?->uom ?? 'PCS');
            $uomUpper = strtoupper(trim((string) $uom));
            $itemDesc = (string) ($input['item_description'] ?? ($existingItem?->item_description ?? ''));
            $isThousandBricks = $uomUpper === 'THOUSAND_BRICKS'
                || str_contains($uomUpper, 'ألف')
                || str_contains($uomUpper, 'الف')
                || str_contains($uomUpper, 'طوب')
                || str_contains($itemDesc, 'طوب');

            if ($isThousandBricks && $qty >= 100 && $unitPrice >= 500) {
                $qty = round($qty / 1000, 3);
            }

            $lineTotal = round($qty * $unitPrice, 2);
            $grandTotal += $lineTotal;

            $rawRef = !empty($input['item_reference']) ? $input['item_reference'] : ($existingItem?->item_reference ?? 'عام');
            $rawReg = !empty($input['region']) ? $input['region'] : ($existingItem?->region ?? 'عام');

            [$itemReference, $region] = $this->requireReferenceFields(
                $rawRef,
                $rawReg,
                'item'
            );

            if ($existingItem) {
                // Update existing item
                $existingItem->update([
                    'item_description' => $input['item_description'] ?? $existingItem->item_description,
                    'item_reference'   => $itemReference,
                    'region'           => $region,
                    'quantity'         => $qty,
                    'uom'              => $input['uom'] ?? $existingItem->uom,
                    'unit_price'       => $unitPrice,
                    'line_total'       => $lineTotal,
                    'supplier_id'      => !empty($input['supplier_id']) ? (int) $input['supplier_id'] : ($existingItem->supplier_id ?? $lockedPo->supplier_id),
                    'specifications'   => array_key_exists('specifications', $input) ? $input['specifications'] : $existingItem->specifications,
                    'is_supplementary' => isset($input['is_supplementary']) ? (bool) $input['is_supplementary'] : $existingItem->is_supplementary,
                    'supplement_batch' => isset($input['supplement_batch']) ? $input['supplement_batch'] : $existingItem->supplement_batch,
                    'is_discount_applied' => array_key_exists('is_discount_applied', $input) ? (bool) $input['is_discount_applied'] : ($existingItem->is_discount_applied ?? false),
                ]);

                AuditLog::create([
                    'user_id'     => $user->id,
                    'entity_type' => PurchaseOrderItem::class,
                    'entity_id'   => $existingItem->id,
                    'action'      => 'PO_ITEM_UPDATED',
                    'field_name'  => 'line_total',
                    'old_value'   => (string) $existingItem->getOriginal('line_total'),
                    'new_value'   => (string) $lineTotal,
                ]);
            } else {
                // Create new item added by procurement
                $newItem = $lockedPo->items()->create([
                    'item_id'          => $input['item_id'] ?? null,
                    'pr_item_id'       => $input['pr_item_id'] ?? null,
                    'item_description' => $input['item_description'] ?? 'بند جديد',
                    'item_reference'   => $itemReference,
                    'region'           => $region,
                    'quantity'         => $qty,
                    'uom'              => $input['uom'] ?? 'PCS',
                    'unit_price'       => $unitPrice,
                    'line_total'       => $lineTotal,
                    'specifications'   => $input['specifications'] ?? null,
                    'supplier_id'      => $input['supplier_id'] ?? $lockedPo->supplier_id ?? null,
                    'is_supplementary' => !empty($input['is_supplementary']),
                    // The column is NOT NULL (default 1): a line added in the Actual PO used to fail on NULL here.
                    'supplement_batch' => !empty($input['supplement_batch']) ? (int) $input['supplement_batch'] : 1,
                    'is_discount_applied' => !empty($input['is_discount_applied']),
                ]);

                AuditLog::create([
                    'user_id'     => $user->id,
                    'entity_type' => PurchaseOrderItem::class,
                    'entity_id'   => $newItem->id,
                    'action'      => 'PO_ITEM_ADDED',
                    'field_name'  => 'item_description',
                    'old_value'   => null,
                    'new_value'   => $newItem->item_description,
                ]);
            }
        }

        $this->recalculateTotals($lockedPo);

        return round($grandTotal, 2);
    }

    /**
     * Finalise the Actual Purchase Order after GRN approval.
     *
     * Procurement provides the definitive set of line items (reflecting what was
     * actually delivered / accepted). All existing items are replaced via a full
     * sync: items omitted from $items are deleted, existing items are updated,
     * and new items (no 'id') are inserted.
     *
     * After finalisation the PO transitions:
     *   PENDING_ACTUAL_PO → ISSUED   (then accounting sees it via ISSUED status)
     *
     * The GRN received_quantity values are passed through from the UI as a display
     * hint only (stored in notes if they differ) — they do NOT overwrite anything.
     */
    public function finalizeActualPo(
        User $user,
        PurchaseOrder $po,
        array $items,
        ?string $notes = null,
        ?int $headerSupplierId = null,
        ?string $parcelReference = null,
        ?string $region = null,
        ?string $discountType = null,
        ?float $discountPercentage = null,
        ?array $discountItemIds = null,
        ?string $highValueReason = null
    ): PurchaseOrder {
        if ($po->status !== 'PENDING_ACTUAL_PO') {
            throw new \RuntimeException('لا يمكن إصدار أمر الشراء الفعلي إلا بعد اعتماد إذن الاستلام وانتقال الملف لمرحلة بانتظار الإصدار الفعلي.');
        }

        if (empty($items)) {
            throw ValidationException::withMessages([
                'items' => ['يجب توفير بند واحد على الأقل في أمر الشراء الفعلي.'],
            ]);
        }

        return DB::transaction(function () use ($user, $po, $items, $notes, $headerSupplierId, $parcelReference, $region, $discountType, $discountPercentage, $discountItemIds, $highValueReason) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->firstOrFail();

            if ($lockedPo->status !== 'PENDING_ACTUAL_PO') {
                throw new \RuntimeException('تغيرت حالة أمر الشراء أثناء المعالجة. أعد المحاولة.');
            }

            // A consolidated line stands for several request lines: only its id identifies it.
            $isConsolidated = $lockedPo->isDepartmentConsolidated();

            // Update Purchase Request parcel reference and region if provided
            if ($lockedPo->purchaseRequest) {
                $prUpdates = [];
                if (!empty($parcelReference)) {
                    $prUpdates['parcel_reference'] = trim((string) $parcelReference);
                }
                if (!empty($region)) {
                    $prUpdates['region'] = trim((string) $region);
                }
                if (!empty($prUpdates)) {
                    $lockedPo->purchaseRequest->update($prUpdates);
                }
            }

            // ── Comprehensive Actual PO Line Items Preservation ──────────────────
            // Retain ALL items from the Master PO in the Actual PO.
            // Items with received quantity = 0 are preserved with actual_quantity = 0.
            // Procurement Manager has full authority to review, adjust quantities (e.g. correcting a 0),
            // edit prices, descriptions, and other line item details.
            $approvedReceipt = $lockedPo->receipts()->whereIn('status', ['APPROVED', 'PENDING_SITE_ENGINEER'])->latest('id')->first();
            $receiptItems = $approvedReceipt ? $approvedReceipt->items()->get() : collect();
            $receivedMap = $receiptItems->pluck('received_quantity', 'purchase_order_item_id');

            $existingPoItems = $lockedPo->items()->get();
            $inputCollection = collect($items);
            $matchedInputKeys = collect();
            $finalizedItems = [];

            foreach ($existingPoItems as $existingPoItem) {
                // Find matching item in submitted $items by id, pr_item_id, item_id, or description
                $matchKey = $inputCollection->search(function ($input, $key) use ($existingPoItem, $matchedInputKeys, $isConsolidated) {
                    if ($matchedInputKeys->contains($key)) {
                        return false;
                    }
                    if (!empty($input['id']) && (int) $input['id'] === (int) $existingPoItem->id) {
                        return true;
                    }
                    if ($isConsolidated) {
                        return false;
                    }
                    if (!empty($input['pr_item_id']) && (int) $input['pr_item_id'] === (int) $existingPoItem->pr_item_id) {
                        return true;
                    }
                    if (!empty($input['item_id']) && (int) $input['item_id'] === (int) $existingPoItem->item_id) {
                        return true;
                    }
                    if (!empty($input['item_description']) && trim((string) $input['item_description']) === trim((string) $existingPoItem->item_description)) {
                        return true;
                    }
                    return false;
                });

                if ($matchKey !== false) {
                    $matchedInputKeys->push($matchKey);
                    $input = $inputCollection->get($matchKey);
                    $input['id'] = $existingPoItem->id;
                    $qty = max(0.0, (float) ($input['quantity'] ?? 0));
                    $unitPrice = max(0.0, (float) ($input['unit_price'] ?? $existingPoItem->unit_price));
                    $input['quantity'] = $qty;
                    $input['unit_price'] = $unitPrice;
                    if (!empty($input['supplier_id'])) {
                        $input['supplier_id'] = (int) $input['supplier_id'];
                    } elseif ($headerSupplierId) {
                        $input['supplier_id'] = (int) $headerSupplierId;
                    } elseif ($existingPoItem->supplier_id) {
                        $input['supplier_id'] = (int) $existingPoItem->supplier_id;
                    } elseif ($lockedPo->supplier_id) {
                        $input['supplier_id'] = (int) $lockedPo->supplier_id;
                    }
                    if (empty($input['item_reference']) && !empty($parcelReference)) {
                        $input['item_reference'] = trim((string) $parcelReference);
                    }
                    if (empty($input['region']) && !empty($region)) {
                        $input['region'] = trim((string) $region);
                    }
                    if ($discountItemIds !== null) {
                        $input['is_discount_applied'] = in_array((int) $existingPoItem->id, $discountItemIds, true)
                            || (!empty($input['id']) && in_array((int) $input['id'], $discountItemIds, true))
                            || !empty($input['is_discount_applied']);
                    }
                    $finalizedItems[] = $input;
                } else {
                    // Item was in Master PO but omitted from input: preserve it with actual received quantity or 0
                    $rcvQty = $receivedMap->has($existingPoItem->id) ? (float) $receivedMap->get($existingPoItem->id) : 0.0;
                    $finalizedItems[] = [
                        'id' => $existingPoItem->id,
                        'item_id' => $existingPoItem->item_id,
                        'pr_item_id' => $existingPoItem->pr_item_id,
                        'item_description' => $existingPoItem->item_description,
                        'item_reference' => !empty($parcelReference) ? trim((string) $parcelReference) : $existingPoItem->item_reference,
                        'region' => !empty($region) ? trim((string) $region) : $existingPoItem->region,
                        'quantity' => max(0.0, $rcvQty),
                        'uom' => $existingPoItem->uom,
                        'unit_price' => (float) $existingPoItem->unit_price,
                        'specifications' => $existingPoItem->specifications,
                        'supplier_id' => $existingPoItem->supplier_id ?? ($headerSupplierId ?: $lockedPo->supplier_id),
                        'is_supplementary' => $existingPoItem->is_supplementary,
                        'supplement_batch' => $existingPoItem->supplement_batch,
                        'is_discount_applied' => $discountItemIds !== null ? in_array((int) $existingPoItem->id, $discountItemIds, true) : (bool) $existingPoItem->is_discount_applied,
                    ];
                }
            }

            // Include any additional new items added by procurement manager
            foreach ($inputCollection as $key => $newItem) {
                if (! $matchedInputKeys->contains($key)) {
                    if (empty($newItem['supplier_id'])) {
                        $newItem['supplier_id'] = $headerSupplierId ?: (int) $lockedPo->supplier_id;
                    }
                    if (empty($newItem['item_reference']) && !empty($parcelReference)) {
                        $newItem['item_reference'] = trim((string) $parcelReference);
                    }
                    if (empty($newItem['region']) && !empty($region)) {
                        $newItem['region'] = trim((string) $region);
                    }
                    if ($discountItemIds !== null && !empty($newItem['id'])) {
                        $newItem['is_discount_applied'] = in_array((int) $newItem['id'], $discountItemIds, true) || !empty($newItem['is_discount_applied']);
                    }
                    $finalizedItems[] = $newItem;
                }
            }

            if (empty($finalizedItems)) {
                throw ValidationException::withMessages([
                    'items' => ['يجب توفير بنود أمر الشراء لإصدار أمر الشراء الفعلي.'],
                ]);
            }

            if ($isConsolidated) {
                $finalizedItems = $this->keepSingleSupplier($lockedPo, $finalizedItems, $headerSupplierId);
            }

            // ── Full items sync (preserves all items, sets actual quantities including 0) ──
            $this->syncPoItems($user, $lockedPo, $finalizedItems);

            // Authoritative recalculation of subtotal, discount, tax, and grand total
            $this->recalculateTotals($lockedPo, $discountType, $discountPercentage, $discountItemIds);

            $highValue = $this->resolveHighValueAcknowledgement($lockedPo->refresh(), $highValueReason);

            // Determine effective PO header supplier:
            $allItemSuppliers = $lockedPo->items()->pluck('supplier_id')->filter()->unique();
            if ($headerSupplierId) {
                $newHeaderSupplierId = (int) $headerSupplierId;
            } elseif ($allItemSuppliers->count() === 1) {
                $newHeaderSupplierId = (int) $allItemSuppliers->first();
            } elseif ($allItemSuppliers->isNotEmpty()) {
                $newHeaderSupplierId = (int) $allItemSuppliers->first();
            } else {
                $newHeaderSupplierId = (int) $lockedPo->supplier_id;
            }

            // Update PO header status and transition to ISSUED so accounting can see it
            $lockedPo->update(array_merge([
                'supplier_id'          => $newHeaderSupplierId,
                'status'               => 'ISSUED',
                'finalized_by_user_id' => $user->id,
                'finalized_at'         => now(),
                'finalization_notes'   => $notes,
            ], $highValue ? [
                'high_value_reason'                  => $highValue['reason'],
                'high_value_threshold'               => $highValue['threshold'],
                'high_value_acknowledged_by_user_id' => $user->id,
                'high_value_acknowledged_at'         => now(),
            ] : []));

            if ($highValue) {
                AuditLog::create([
                    'user_id'     => $user->id,
                    'entity_type' => PurchaseOrder::class,
                    'entity_id'   => $lockedPo->id,
                    'action'      => 'ACTUAL_PO_HIGH_VALUE_ACKNOWLEDGED',
                    'field_name'  => 'high_value_reason',
                    'old_value'   => null,
                    'new_value'   => json_encode([
                        'grand_total' => (float) $lockedPo->grand_total,
                        'threshold'   => $highValue['threshold'],
                        'reason'      => $highValue['reason'],
                    ], JSON_UNESCAPED_UNICODE),
                ]);
                app(SystemEventService::class)->recordAction(
                    $lockedPo,
                    'ACTUAL_PO_HIGH_VALUE_ACKNOWLEDGED',
                    "أمر شراء فعلي بقيمة تتجاوز الحد ({$lockedPo->po_number}). السبب: {$highValue['reason']}",
                    ['event_type' => 'purchase_order.high_value', 'actor_user_id' => $user->id, 'metadata' => ['grand_total' => (float) $lockedPo->grand_total, 'threshold' => $highValue['threshold']]]
                );
            }

            if ($newHeaderSupplierId) {
                $lockedPo->receipts()->update(['supplier_id' => $newHeaderSupplierId]);

                $openInvoices = \App\Models\SupplierInvoice::where('purchase_order_id', $lockedPo->id)
                    ->where('paid_amount', 0)
                    ->get();
                foreach ($openInvoices as $inv) {
                    $oldSupId = $inv->supplier_id;
                    $inv->update(['supplier_id' => $newHeaderSupplierId]);
                    if ($oldSupId) {
                        app(SupplierInvoiceService::class)->refreshSupplierBalance($oldSupId);
                    }
                    app(SupplierInvoiceService::class)->refreshSupplierBalance($newHeaderSupplierId);
                }
            }

            // Link approved receipts to the finalized Actual PO. Quantities the receiver actually recorded are
            // never overwritten here (over/under receipt must stay visible); only lines for items that had no
            // receipt line yet (e.g. added by procurement) are created from the Actual PO quantity.
            $approvedReceipts = $lockedPo->receipts()->where('status', 'APPROVED')->get();
            if ($approvedReceipts->isNotEmpty()) {
                $poItems = $lockedPo->items()->get();
                $poItemIds = $poItems->pluck('id')->all();

                foreach ($approvedReceipts as $receipt) {
                    if ($newHeaderSupplierId && (int) $receipt->supplier_id !== (int) $newHeaderSupplierId) {
                        $receipt->update(['supplier_id' => $newHeaderSupplierId]);
                    }
                    $receipt->items()->whereNotIn('purchase_order_item_id', $poItemIds)->delete();

                    foreach ($poItems as $poItem) {
                        $hasReceiptItem = $receipt->items()->where('purchase_order_item_id', $poItem->id)->exists();
                        if (! $hasReceiptItem) {
                            $receipt->items()->create([
                                'purchase_order_item_id' => $poItem->id,
                                'ordered_quantity' => $poItem->quantity,
                                'received_quantity' => $poItem->quantity,
                                'notes' => 'تم اعتماده في أمر الشراء الفعلي',
                            ]);
                        }
                    }
                }
            }

            ApprovalHistory::create([
                'target_type' => PurchaseOrder::class,
                'target_id'   => $lockedPo->id,
                'actor_user_id' => $user->id,
                'action'      => 'ACTUAL_PO_FINALIZED',
                'from_state'  => 'PENDING_ACTUAL_PO',
                'to_state'    => 'ISSUED',
                'user_note'    => ApprovalHistory::typedNote($notes),
                'comments'    => $notes ?? 'أصدر مدير المشتريات أمر الشراء الفعلي بعد اعتماد إذن الاستلام وأرسله للحسابات.',
            ]);

            if ($lockedPo->purchaseRequest) {
                $pr = $lockedPo->purchaseRequest;
                $prFromState = $pr->status;
                $prUpdates = ['status' => 'ISSUED'];
                if (!empty($parcelReference)) {
                    $prUpdates['parcel_reference'] = trim((string) $parcelReference);
                }
                if (!empty($region)) {
                    $prUpdates['region'] = trim((string) $region);
                }
                $pr->update($prUpdates);

                ApprovalHistory::create([
                    'target_type' => PurchaseRequest::class,
                    'target_id'   => $pr->id,
                    'actor_user_id' => $user->id,
                    'action'      => 'ACTUAL_PO_ISSUED',
                    'from_state'  => $prFromState,
                    'to_state'    => 'ISSUED',
                    'comments'    => 'تم إصدار وتثبيت أمر الشراء الفعلي رقم ' . $lockedPo->po_number,
                ]);
            }

            AuditLog::create([
                'user_id'     => $user->id,
                'entity_type' => PurchaseOrder::class,
                'entity_id'   => $lockedPo->id,
                'action'      => 'ACTUAL_PO_FINALIZED',
                'field_name'  => 'status',
                'old_value'   => 'PENDING_ACTUAL_PO',
                'new_value'   => 'ISSUED',
            ]);

            // Notify accountants about the finalised PO
            $notificationService = app(NotificationService::class);
            $accountants = $notificationService->resolveUsersWithPermission('purchase_order.view_accounting');

            $lockedPo->loadMissing('purchaseRequest.department');
            $deptCode = $lockedPo->purchaseRequest?->department?->code;
            $deptAccountants = app(SupplierInvoiceService::class)->getAccountantsForDepartment($deptCode);

            $targetAccountants = $deptAccountants->isNotEmpty() ? $deptAccountants : $accountants;

            if ($targetAccountants->isNotEmpty()) {
                $receipt = $lockedPo->receipts()->where('status', 'APPROVED')->latest()->first();
                if ($receipt) {
                    $notificationService->queueAccountingWithPurchaseOrderAndReceipt(
                        $targetAccountants,
                        $lockedPo,
                        $receipt
                    );
                } else {
                    $notificationService->queueUsers(
                        $targetAccountants,
                        'purchase_order_actual_issued_accounting',
                        'أمر شراء فعلي جاهز للمراجعة المحاسبية',
                        "تم إصدار أمر الشراء الفعلي {$lockedPo->po_number} بعد اعتماد إذن الاستلام وهو جاهز للمراجعة المحاسبية.",
                        $lockedPo
                    );
                }
            }

            if ($highValue) {
                $generalManagers = User::where('is_active', true)
                    ->whereHas('roles', fn ($q) => $q->where('slug', 'general_manager'))
                    ->get();
                $notificationService->queueUsers(
                    $generalManagers->merge($targetAccountants),
                    NotificationService::GM_HIGH_VALUE_ACTUAL_PO_TYPE,
                    'أمر شراء فعلي يتجاوز حد القيمة',
                    'تم إصدار أمر الشراء الفعلي ' . $lockedPo->po_number . ' بقيمة ' . number_format((float) $lockedPo->grand_total, 2)
                        . ' جنيه (أعلى من ' . number_format($highValue['threshold'], 0) . '). السبب: ' . $highValue['reason'],
                    $lockedPo
                );
            }

            app(NotificationService::class)->markEntityNotificationsAsRead($lockedPo, $user);

            return $lockedPo->fresh([
                'purchaseRequest.requester',
                'purchaseRequest.department',
                'purchaseRequest.assignedReviewer',
                'purchaseRequest.approvalHistory.actor',
                'supplier',
                'createdBy',
                'finalizedBy',
                'items.item',
                'items.supplier',
                'receipts.items.purchaseOrderItem',
                'receipts.warehouseKeeper',
                'receipts.siteEngineer',
                'receipts.receiver',
            ]);
        });
    }

    /**
     * Submit draft Purchase Order to Accounting for financial audit (PO_DRAFT -> PENDING_ACCOUNTING_REVIEW).
     */
    public function submitToAccounting(User $user, PurchaseOrder $po): PurchaseOrder
    {
        if ($po->status !== 'PO_DRAFT' && $po->status !== 'RETURNED_TO_PROCUREMENT') {
            throw new \RuntimeException('Only draft or returned purchase orders can be submitted.');
        }

        if ($po->items()->count() === 0) {
            throw ValidationException::withMessages([
                'items' => ['Cannot submit a purchase order with no line items.'],
            ]);
        }

        if (! $po->supplier || ! $po->supplier->is_active) {
            throw ValidationException::withMessages([
                'supplier_id' => ['Purchase order supplier is inactive or missing.'],
            ]);
        }

        return DB::transaction(function () use ($user, $po) {
            $lockedPo = PurchaseOrder::where('id', $po->id)->lockForUpdate()->firstOrFail();

            if ($lockedPo->status === 'ISSUED') {
                return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'selectedQuote', 'supplier', 'createdBy', 'items.item']);
            }

            $fromState = $lockedPo->status;

            $this->recalculateTotals($lockedPo);

            $lockedPo->update([
                'status' => 'ISSUED',
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseOrder::class,
                'target_id' => $lockedPo->id,
                'actor_user_id' => $user->id,
                'action' => 'PO_ISSUED',
                'from_state' => $fromState,
                'to_state' => 'ISSUED',
                'comments' => 'Purchase order issued by procurement manager.',
            ]);

            if ($lockedPo->purchaseRequest) {
                $pr = $lockedPo->purchaseRequest;
                $allPrItemsCount = $pr->items()->count();
                $coveredPrItemsCount = $pr->items()
                    ->where(fn ($q) => PurchaseOrderSourceService::orderedScope($q))
                    ->count();

                if ($allPrItemsCount > 0 && $coveredPrItemsCount >= $allPrItemsCount) {
                    $prFromState = $pr->status;
                    $pr->update(['status' => 'ISSUED']);

                    ApprovalHistory::create([
                        'target_type' => PurchaseRequest::class,
                        'target_id'   => $pr->id,
                        'actor_user_id' => $user->id,
                        'action'      => 'PO_ISSUED',
                        'from_state'  => $prFromState,
                        'to_state'    => 'ISSUED',
                        'comments'    => 'تم إصدار أوامر الشراء لجميع بنود طلب الشراء بالكامل (' . $lockedPo->po_number . ').',
                    ]);
                }
            }

            app(SystemEventService::class)->recordAction(
                $lockedPo,
                'PO_ISSUED',
                'أصدر مدير المشتريات أمر الشراء وأرسله للاطلاع المالي والإداري.',
                ['event_type' => 'purchase_order.issued', 'from_state' => $fromState, 'to_state' => 'ISSUED', 'actor_user_id' => $user->id]
            );

            AuditLog::create([
                'user_id' => $user->id,
                'entity_type' => PurchaseOrder::class,
                'entity_id' => $lockedPo->id,
                'action' => 'PO_ISSUED',
                'field_name' => 'status',
                'old_value' => $fromState,
                'new_value' => 'ISSUED',
            ]);

            // Notify Accountants (Read-only access notification)
            $notificationService = app(\App\Services\NotificationService::class);
            $accountants = $notificationService->resolveUsersWithPermission('purchase_order.view_accounting');

            // Auto-resolve pending notifications on this PO and PR for the issuing procurement manager
            $notificationService->markEntityNotificationsAsRead($lockedPo, $user);
            if ($lockedPo->purchaseRequest) {
                $notificationService->markEntityNotificationsAsRead($lockedPo->purchaseRequest, $user);
            }

            $lockedPo->loadMissing('purchaseRequest.department');
            $deptCode = $lockedPo->purchaseRequest?->department?->code;
            $deptAccountants = app(SupplierInvoiceService::class)->getAccountantsForDepartment($deptCode);

            // Exclude Financial Director (role 'accountant') - notify only scoped department accountant for awareness
            $targetAccountants = ($deptAccountants->isNotEmpty() ? $deptAccountants : $accountants)
                ->reject(fn ($u) => $u->hasRole('accountant'));

            if ($targetAccountants->isNotEmpty()) {
                $notificationService->queueUsers(
                    $targetAccountants,
                    'purchase_order_issued_accounting',
                    'تم إصدار أمر شراء جديد',
                    "تم إصدار أمر الشراء {$lockedPo->po_number} للاطلاع المالي وتجهيز الفواتير.",
                    $lockedPo
                );
            }

            // Notify requester if the request was created by the General Manager or user
            if ($lockedPo->purchaseRequest && $lockedPo->purchaseRequest->user_id) {
                $notificationService->queueNotification(
                    $lockedPo->purchaseRequest->user_id,
                    'purchase_order_issued_requester',
                    'تم إصدار أمر الشراء لطلبك',
                    "تم إصدار أمر الشراء {$lockedPo->po_number} لطلب الشراء {$lockedPo->purchaseRequest->request_number}.",
                    $lockedPo
                );
            }

            // Notify Warehouse Keepers when a purchase order is issued and delivered to warehouse
            if ($lockedPo->requiresWarehouseReceipt()) {
                $warehouseKeepers = User::whereHas('roles', fn ($q) => $q->where('slug', 'warehouse_keeper'))
                    ->where('is_active', true)
                    ->get();
                if ($warehouseKeepers->isEmpty()) {
                    $warehouseKeepers = User::where('email', 'salam@gmail.com')->where('is_active', true)->get();
                }

                $notificationService->queueUsers(
                    $warehouseKeepers,
                    'purchase_order_ready_for_warehouse',
                    'أمر شراء بانتظار استلام المواد بالمخزن',
                    "تم إصدار أمر الشراء {$lockedPo->po_number} بانتظار استلام الأصناف وفحصها وإصدار إذن الاستلام.",
                    $lockedPo
                );
            } else {
                // If this purchase order bypasses the warehouse, route directly to site engineer
                if (! $lockedPo->purchaseRequest?->isOfficeRequest()) {
                    app(PurchaseReceiptService::class)->createDirectSiteReceipt($lockedPo);
                }
            }

            return $lockedPo->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'purchaseRequest.assignedReviewer', 'purchaseRequest.approvalHistory.actor', 'selectedQuote', 'supplier', 'createdBy', 'items.item']);
        });
    }

    /**
     * Convert rebar parcel or bar units to tons for commercial Purchase Order pricing.
     */
    public function normalizePoItemUnitAndQuantity(float $quantity, string $uom, ?string $specifications): array
    {
        $uomUpper = strtoupper(trim($uom));
        $cleanSpec = trim((string) ($specifications ?? ''));

        // Check if PARCEL (طرد حديد = 1.940 طن)
        if ($uomUpper === 'PARCEL' || mb_strpos($uomUpper, 'طرد') !== false || mb_strpos(mb_strtolower($uom), 'طرد') !== false) {
            $tons = round($quantity * 1.940, 3);
            $note = "(ما يعادل {$quantity} طرد حديد - زنة الطرد 1.940 طن)";
            if ($cleanSpec !== '' && mb_strpos($cleanSpec, 'ما يعادل') === false) {
                $cleanSpec .= ' - ' . $note;
            } elseif ($cleanSpec === '') {
                $cleanSpec = $note;
            }
            return [$tons, 'TON', $cleanSpec];
        }

        // Check rebar bars
        $barWeights = [
            'BAR_2_5LINIA' => 0.0047,
            'BAR_3LINIA'   => 0.0074,
            'BAR_4LINIA'   => 0.0104,
            'BAR_5LINIA'   => 0.0190,
        ];

        foreach ($barWeights as $code => $weight) {
            if ($uomUpper === $code) {
                $tons = round($quantity * $weight, 3);
                $note = "(ما يعادل {$quantity} سيخ حديد - زنة السيخ " . ($weight * 1000) . " كجم)";
                if ($cleanSpec !== '' && mb_strpos($cleanSpec, 'ما يعادل') === false) {
                    $cleanSpec .= ' - ' . $note;
                } elseif ($cleanSpec === '') {
                    $cleanSpec = $note;
                }
                return [$tons, 'TON', $cleanSpec];
            }
        }

        return [$quantity, $uom, $cleanSpec ?: null];
    }

    /**
     * A consolidated Actual PO keeps one supplier: the whole order may move to another supplier,
     * but its lines may never end up split between suppliers.
     */
    private function keepSingleSupplier(PurchaseOrder $po, array $finalizedItems, ?int $headerSupplierId): array
    {
        $suppliers = collect($finalizedItems)->pluck('supplier_id')->filter()->map(fn ($v) => (int) $v);
        if ($headerSupplierId) {
            $suppliers->push((int) $headerSupplierId);
        }
        $suppliers = $suppliers->unique()->values();

        if ($suppliers->count() > 1) {
            throw ValidationException::withMessages([
                'supplier_id' => ['أمر الشراء المجمع لمورد واحد. يمكن تغيير مورد الأمر بالكامل، لكن لا يمكن جعل بند لمورد مختلف عن باقي البنود.'],
            ]);
        }

        $target = (int) ($suppliers->first() ?? $po->supplier_id);

        return array_map(fn (array $item) => array_merge($item, ['supplier_id' => $target]), $finalizedItems);
    }

    /**
     * Above the high-value threshold the Actual PO needs a written reason (a warning, not a block).
     *
     * @return array{reason: string, threshold: float}|null
     */
    private function resolveHighValueAcknowledgement(PurchaseOrder $po, ?string $reason): ?array
    {
        $threshold = (float) config('procurement.actual_po_high_value_threshold', 500000);
        $grandTotal = round((float) $po->grand_total, 2);

        if ($threshold <= 0 || $grandTotal <= $threshold) {
            return null;
        }

        $reason = trim((string) $reason);
        if (mb_strlen($reason) < (int) config('procurement.actual_po_high_value_reason_min_length', 10)) {
            throw new \App\Exceptions\HighValueReasonRequiredException($grandTotal, $threshold);
        }

        return ['reason' => $reason, 'threshold' => $threshold];
    }

    /**
     * A line that consolidates request lines is their only record: set its quantity to 0 instead of deleting it.
     */
    private function assertLineHasNoSources(PurchaseOrderItem $item): void
    {
        if ($item->sources()->exists()) {
            throw ValidationException::withMessages([
                'items' => ["لا يمكن حذف البند [{$item->item_description}] لأنه بند مجمع من بنود طلب الشراء. يمكن تعديل كميته إلى صفر بدلاً من حذفه."],
            ]);
        }
    }

    /**
     * Validate and normalize fields that are mandatory for financial traceability.
     */
    private function requireReferenceFields($itemReference, $region, string $key): array
    {
        $itemReference = trim((string) ($itemReference ?? ''));
        $region = trim((string) ($region ?? ''));
        $errors = [];

        if ($itemReference === '') {
            $errors["{$key}.item_reference"] = ['رقم قطعة الأرض مطلوب ولا يمكن أن يكون فارغًا.'];
        }
        if ($region === '') {
            $errors["{$key}.region"] = ['المنطقة مطلوبة ولا يمكن أن تكون فارغة.'];
        }

        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return [$itemReference, $region];
    }
}
