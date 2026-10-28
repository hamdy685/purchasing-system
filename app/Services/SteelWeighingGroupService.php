<?php

namespace App\Services;

use App\Models\AuditLog;
use App\Models\Notification;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\User;
use App\Models\WeighingGroup;
use App\Models\WeighingGroupItem;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class SteelWeighingGroupService
{
    /**
     * Non-steel keywords that must strictly be rejected from steel weighing groups.
     */
    private const EXCLUDED_KEYWORDS = [
        'رمل',
        'سن',
        'زلط',
        'ركام',
        'أسمنت',
        'اسمنت',
        'خشب',
        'طوب',
        'بلوك',
        'سلك',
    ];

    /**
     * Check if a purchase order item qualifies as a steel/rebar material.
     */
    public function isSteelItem(PurchaseOrderItem $item): bool
    {
        // 1. Check official category if catalog item is linked
        if ($item->relationLoaded('item') && $item->item) {
            $catCode = strtoupper(trim((string) ($item->item->category?->code ?? '')));
            if ($catCode === 'STEEL') {
                return true;
            }
        } elseif ($item->item_id) {
            $catalogItem = DB::table('items')
                ->leftJoin('categories', 'items.category_id', '=', 'categories.id')
                ->where('items.id', $item->item_id)
                ->select('categories.code as cat_code', 'categories.name as cat_name')
                ->first();

            if ($catalogItem && strtoupper(trim((string) ($catalogItem->cat_code ?? ''))) === 'STEEL') {
                return true;
            }
        }

        $desc = mb_strtolower(trim((string) ($item->item_description ?? '')));
        $uomUpper = strtoupper(trim((string) ($item->uom ?? '')));

        // 2. Strict exclusions: non-steel keywords
        foreach (self::EXCLUDED_KEYWORDS as $excluded) {
            if (mb_strpos($desc, $excluded) !== false) {
                return false;
            }
        }

        // 3. Known rebar bar/parcel UOMs
        $rebarUoms = ['BAR_2_5LINIA', 'BAR_3LINIA', 'BAR_4LINIA', 'BAR_5LINIA', 'PARCEL', 'TON', 'طن'];
        $hasRebarUom = in_array($uomUpper, $rebarUoms, true);

        // 4. Description check for steel/rebar terms
        $steelKeywords = ['حديد', 'تسليح', 'كانات', 'قطاعات', 'سيخ', 'اشاير', 'rebar', 'steel'];
        foreach ($steelKeywords as $kw) {
            if (mb_strpos($desc, $kw) !== false) {
                return true;
            }
        }

        return $hasRebarUom && (mb_strpos($desc, 'حديد') !== false || mb_strpos($desc, 'صلب') !== false);
    }

    /**
     * Extract diameter or size specification string (e.g. "12 مم", "16 مم", "4 لينية").
     */
    public function extractSizeOrDiameter(PurchaseOrderItem $item): string
    {
        $desc = (string) ($item->item_description ?? '');
        $spec = (string) ($item->specifications ?? '');
        $combined = "{$desc} {$spec}";

        // Match patterns like "12 مم" or "16mm" or "4 لينية"
        if (preg_match('/(\d+(?:\.\d+)?)\s*(?:مم|ملل|لنية|لينية|mm)/iu', $combined, $m)) {
            return trim($m[0]);
        }

        if (preg_match('/قطر\s*(\d+(?:\.\d+)?)/iu', $combined, $m)) {
            return "قطر {$m[1]} مم";
        }

        $uomUpper = strtoupper(trim((string) ($item->uom ?? '')));
        $barMap = [
            'BAR_2_5LINIA' => '2.5 لينية (8 مم)',
            'BAR_3LINIA'   => '3 لينية (10 مم)',
            'BAR_4LINIA'   => '4 لينية (12 مم)',
            'BAR_5LINIA'   => '5 لينية (16 مم)',
            'PARCEL'       => 'طرد حديد',
        ];

        return $barMap[$uomUpper] ?? ($item->uom ?: '—');
    }

    /**
     * Convert item quantity to standard weight in Tons.
     */
    public function calculateWeightInTons(PurchaseOrderItem $item): float
    {
        $qty = (float) ($item->quantity ?? 0);
        $uomUpper = strtoupper(trim((string) ($item->uom ?? '')));

        if ($uomUpper === 'TON' || $uomUpper === 'طن') {
            return round($qty, 3);
        }

        if ($uomUpper === 'KG' || $uomUpper === 'كجم' || $uomUpper === 'كيلو') {
            return round($qty / 1000, 3);
        }

        if ($uomUpper === 'PARCEL' || mb_strpos($uomUpper, 'طرد') !== false) {
            return round($qty * 1.940, 3);
        }

        $barWeights = [
            'BAR_2_5LINIA' => 0.0047,
            'BAR_3LINIA'   => 0.0074,
            'BAR_4LINIA'   => 0.0104,
            'BAR_5LINIA'   => 0.0190,
        ];

        if (isset($barWeights[$uomUpper])) {
            return round($qty * $barWeights[$uomUpper], 3);
        }

        return round($qty, 3);
    }

    /**
     * Generate sequential unique weighing group number (WG-1, WG-2, ...).
     */
    public function generateUniqueGroupNumber(string $prefix = 'WG-'): string
    {
        $existing = DB::table('weighing_groups')
            ->where('group_number', 'like', "{$prefix}%")
            ->pluck('group_number');

        $maxSeq = 0;
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
        while (DB::table('weighing_groups')->where('group_number', "{$prefix}{$nextNumber}")->exists()) {
            $nextNumber++;
        }

        return "{$prefix}{$nextNumber}";
    }

    /**
     * Check authorization: Only Procurement Manager and Admin can create or manage groups.
     */
    public function authorizeProcurementManager(User $user): void
    {
        $allowed = $user->hasRole('procurement_manager') || $user->hasRole('admin');
        if (! $allowed) {
            throw ValidationException::withMessages([
                'user' => ['صلاحية تجميع الوزنة مقتصرة حصراً على مدير المشتريات.'],
            ]);
        }
    }

    /**
     * Get eligible items for steel weighing group in a Purchase Order.
     */
    public function getEligibleSteelItems(PurchaseOrder $order, User $user): array
    {
        $this->authorizeProcurementManager($user);

        $order->loadMissing(['items.item.category', 'items.weighingGroupItem.weighingGroup', 'supplier']);

        $eligible = [];
        foreach ($order->items as $item) {
            // Must be steel
            if (! $this->isSteelItem($item)) {
                continue;
            }

            // Must not be already in an active weighing group
            if ($item->weighingGroupItem && ($item->weighingGroupItem->weighingGroup?->status ?? '') !== 'CANCELLED') {
                continue;
            }

            // Must not be already received in full
            $receivedQty = (float) DB::table('purchase_receipt_items')
                ->where('purchase_order_item_id', $item->id)
                ->sum('received_quantity');

            if ($receivedQty >= (float) $item->quantity && (float) $item->quantity > 0) {
                continue;
            }

            $weightInTons = $this->calculateWeightInTons($item);
            $size = $this->extractSizeOrDiameter($item);
            $effectiveSupplierId = $item->supplier_id ?: $order->supplier_id;

            $eligible[] = [
                'id'               => $item->id,
                'item_description' => $item->item_description,
                'size_or_diameter' => $size,
                'quantity'         => (float) $item->quantity,
                'uom'              => $item->uom,
                'weight_in_tons'   => $weightInTons,
                'unit_price'       => (float) $item->unit_price,
                'line_total'       => (float) $item->line_total,
                'supplier_id'      => $effectiveSupplierId,
                'supplier_name'    => $item->supplier?->company_name ?? ($order->supplier?->company_name ?? '—'),
                'region'           => $item->region,
                'land_plot_number' => $item->item_reference,
                'purpose'          => $item->specifications,
            ];
        }

        return $eligible;
    }

    /**
     * Create a new steel weighing group from selected line items.
     */
    public function createWeighingGroup(User $user, int $poId, array $itemIds, ?string $notes = null): WeighingGroup
    {
        $this->authorizeProcurementManager($user);

        if (empty($itemIds)) {
            throw ValidationException::withMessages([
                'items' => ['يجب اختيار بندين على الأقل لتجميع الوزنة.'],
            ]);
        }

        return DB::transaction(function () use ($user, $poId, $itemIds, $notes) {
            $po = PurchaseOrder::with(['items.item.category', 'supplier'])->findOrFail($poId);

            // 1. Status check: PO must not be cancelled, rejected or voided
            $disallowedStatuses = ['REJECTED', 'CANCELLED', 'VOIDED'];
            if (in_array($po->status, $disallowedStatuses, true)) {
                throw ValidationException::withMessages([
                    'purchase_order' => ['حالة أمر الشراء الحالية لا تسمح بإنشاء مجموعة وزنة.'],
                ]);
            }

            $selectedItems = $po->items->whereIn('id', $itemIds);

            if ($selectedItems->count() !== count($itemIds)) {
                throw ValidationException::withMessages([
                    'items' => ['بعض البنود المحددة غير تابعة لأمر الشراء هذا.'],
                ]);
            }

            // 2. Validate steel classification: ALL items must be steel
            foreach ($selectedItems as $item) {
                if (! $this->isSteelItem($item)) {
                    throw ValidationException::withMessages([
                        'items' => ["البند ({$item->item_description}) ليس من نوع حديد التسليح. يمنع تجميع حديد مع بنود أخرى."],
                    ]);
                }
            }

            // 3. Validate single supplier rule: ALL items must share the exact same supplier_id
            $supplierIds = $selectedItems->map(fn ($it) => $it->supplier_id ?: $po->supplier_id)->unique();
            if ($supplierIds->count() > 1) {
                throw ValidationException::withMessages([
                    'supplier' => ['لا يمكن تجميع البنود لأن المورد مختلف.'],
                ]);
            }

            $targetSupplierId = $supplierIds->first();
            if (! $targetSupplierId) {
                throw ValidationException::withMessages([
                    'supplier' => ['لم يتم تحديد مورد رسمي لبنود أمر الشراء.'],
                ]);
            }

            // 3.5. Validate uniform unit_price rule: ALL items must share the exact same unit_price
            $unitPrices = $selectedItems->map(fn ($it) => round((float) $it->unit_price, 2))->unique();
            if ($unitPrices->count() > 1) {
                throw ValidationException::withMessages([
                    'items' => ['لا يمكن تجميع البنود لأن سعر الطن مختلف بين البنود.'],
                ]);
            }
            $unifiedUnitPrice = (float) ($unitPrices->first() ?? 0);

            // 4. Validate no prior active weighing group for these items
            $alreadyGroupedIds = DB::table('weighing_group_items')
                ->join('weighing_groups', 'weighing_group_items.weighing_group_id', '=', 'weighing_groups.id')
                ->whereIn('weighing_group_items.purchase_order_item_id', $itemIds)
                ->where('weighing_groups.status', '!=', 'CANCELLED')
                ->pluck('weighing_group_items.purchase_order_item_id')
                ->all();

            if (! empty($alreadyGroupedIds)) {
                throw ValidationException::withMessages([
                    'items' => ['بعض البنود المختارة مجمعة بالفعل في مجموعة وزنة سابقة نشطة.'],
                ]);
            }

            // 4.5. Cross-feature conflict validation: MUST NOT be in an active shared shipment group
            $alreadyInShipment = PurchaseOrderItem::whereIn('id', $itemIds)
                ->whereNotNull('shipment_group_id')
                ->whereHas('shipmentGroup', function ($q) {
                    $q->where('status', '!=', 'CANCELLED');
                })
                ->pluck('id')
                ->all();

            if (! empty($alreadyInShipment)) {
                $conflictItem = $selectedItems->firstWhere('id', $alreadyInShipment[0]);
                throw ValidationException::withMessages([
                    'items' => ["البند [{$conflictItem?->item_description}] مدمج بالفعل في شحنة مشتركة نشطة. يجب فك دمج الشحنة أولاً قبل تجميعها كوزنة حديد."],
                ]);
            }

            // 5. Calculate total ordered weight in tons
            $totalOrderedWeight = 0.0;
            $itemsData = [];

            foreach ($selectedItems as $item) {
                $weight = $this->calculateWeightInTons($item);
                $size = $this->extractSizeOrDiameter($item);
                $totalOrderedWeight += $weight;

                $itemsData[] = [
                    'purchase_order_item_id' => $item->id,
                    'item_description'       => $item->item_description,
                    'size_or_diameter'       => $size,
                    'ordered_weight'         => $weight,
                    'received_weight'        => null,
                    'uom'                    => 'TON',
                    'unit_price'             => (float) $item->unit_price,
                    'line_total'             => (float) $item->line_total,
                    'region'                 => $item->region,
                    'land_plot_number'       => $item->item_reference,
                    'purpose'                => $item->specifications,
                ];
            }

            $groupNumber = $this->generateUniqueGroupNumber();

            // 6. Create WeighingGroup entity
            $group = WeighingGroup::create([
                'group_number'         => $groupNumber,
                'purchase_order_id'    => $po->id,
                'supplier_id'          => $targetSupplierId,
                'group_type'           => 'STEEL_WEIGHT',
                'status'               => 'PENDING_RECEIPT',
                'total_ordered_weight' => round($totalOrderedWeight, 3),
                'uom'                  => 'TON',
                'unit_price'           => $unifiedUnitPrice,
                'total_amount'         => round($totalOrderedWeight * $unifiedUnitPrice, 2),
                'notes'                => $notes,
                'created_by_user_id'   => $user->id,
            ]);

            // 7. Create granular line items
            foreach ($itemsData as $data) {
                $group->items()->create($data);
            }

            // 8. Record in AuditLog
            AuditLog::create([
                'user_id'     => $user->id,
                'entity_type' => WeighingGroup::class,
                'entity_id'   => $group->id,
                'action'      => 'STEEL_WEIGHT_GROUP_CREATED',
                'field_name'  => 'status',
                'old_value'   => null,
                'new_value'   => json_encode([
                    'group_number'         => $group->group_number,
                    'purchase_order_id'    => $po->id,
                    'supplier_id'          => $targetSupplierId,
                    'items_count'          => count($itemsData),
                    'total_ordered_weight' => $group->total_ordered_weight,
                    'item_ids'             => $itemIds,
                ], JSON_UNESCAPED_UNICODE),
            ]);

            // 9. Notify site receiver / site engineer
            $siteEngineerId = $po->purchaseRequest?->site_engineer_user_id;
            if ($siteEngineerId) {
                Notification::create([
                    'user_id'   => $siteEngineerId,
                    'title'     => 'تم تجميع وزنة حديد بانتظار الاستلام بالموقع',
                    'message'   => "أصدر مدير المشتريات وزنة حديد مجمعة ({$group->group_number}) لأمر الشراء {$po->po_number} بإجمالي {$group->total_ordered_weight} طن. يُرجى مراجعة وصل ميزان البسكول عند التوريد.",
                    'type'      => 'WEIGHING_GROUP_READY',
                    'action_url'=> "/receipts?po_id={$po->id}",
                ]);
            }

            return $group->load(['items', 'supplier', 'purchaseOrder']);
        });
    }

    /**
     * Record receiving for a steel weighing group with scale ticket weight and item breakdown.
     */
    public function recordReceiving(
        User $user,
        int $weighingGroupId,
        float $receivedTotalWeight,
        ?string $scaleTicketPhoto = null,
        array $itemDistributions = [],
        ?string $receiverNotes = null
    ): PurchaseReceipt {
        // Authorization: Warehouse keeper, site engineer, or admin
        $isReceiver = $user->hasRole('warehouse_keeper')
            || $user->hasRole('site_engineer')
            || $user->hasRole('admin')
            || $user->hasRole('procurement_manager');

        if (! $isReceiver) {
            throw ValidationException::withMessages([
                'user' => ['غير مصرح لك بتسجيل استلام وزنة الموقع.'],
            ]);
        }

        if ($receivedTotalWeight <= 0) {
            throw ValidationException::withMessages([
                'received_total_weight' => ['يجب إدخال إجمالي وزن مستلم صحيح من ميزان البسكول أكبر من صفر.'],
            ]);
        }

        return DB::transaction(function () use ($user, $weighingGroupId, $receivedTotalWeight, $scaleTicketPhoto, $itemDistributions, $receiverNotes) {
            $group = WeighingGroup::with(['items.purchaseOrderItem', 'purchaseOrder.purchaseRequest'])
                ->lockForUpdate()
                ->findOrFail($weighingGroupId);

            if ($group->status === 'RECEIVED') {
                throw ValidationException::withMessages([
                    'weighing_group' => ['تم استلام واعتماد هذه الوزنة مسبقاً.'],
                ]);
            }

            if ($group->status === 'CANCELLED') {
                throw ValidationException::withMessages([
                    'weighing_group' => ['مجموعة الوزنة هذه ملغاة ولا يمكن استلامها.'],
                ]);
            }

            // Same delivery gate as the warehouse receipt: the PO must be issued/approved.
            $receivableStatuses = ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'];
            if (! in_array($group->purchaseOrder?->status, $receivableStatuses, true)) {
                throw ValidationException::withMessages([
                    'purchase_order' => ['لا يمكن تسجيل استلام الوزنة في حالة أمر الشراء الحالية.'],
                ]);
            }

            // One receipt per PO: never add a second set of lines for items already received.
            $hasActiveReceipt = PurchaseReceipt::where('purchase_order_id', $group->purchase_order_id)
                ->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED'])
                ->exists();
            if ($hasActiveReceipt) {
                throw ValidationException::withMessages([
                    'weighing_group' => ['يوجد إذن استلام نشط لأمر الشراء هذا بالفعل؛ لا يمكن تسجيل استلام الوزنة مرة أخرى.'],
                ]);
            }

            $orderedTotal = (float) $group->total_ordered_weight;
            $diff = round($receivedTotalWeight - $orderedTotal, 3);
            $unitPrice = (float) ($group->unit_price ?: ($group->items->first()?->unit_price ?? 0));
            $receivedTotalAmount = round($receivedTotalWeight * $unitPrice, 2);

            // Maintain internal items for tracking without proportional distortion
            foreach ($group->items as $wgItem) {
                $wgItem->update([
                    'received_weight' => $wgItem->ordered_weight,
                ]);
            }

            $photoPath = $scaleTicketPhoto ?: $group->scale_ticket_photo;
            $photoDriveId = null;

            if ($photoPath && (str_starts_with($photoPath, 'data:') || str_contains($photoPath, ';base64,'))) {
                $customName = \App\Services\DocumentNamingService::generateScaleTicketName(
                    $group,
                    $group->group_number,
                    'jpg',
                    1
                );
                $stored = \App\Services\StorageService::storeBase64(
                    $photoPath,
                    'receipts',
                    $customName
                );
                if ($stored) {
                    $photoPath = $stored['path'];
                    $photoDriveId = $stored['drive_id'] ?? null;
                }
            } elseif ($photoPath) {
                $photoDriveId = \App\Services\GoogleDriveService::extractFileId($photoPath);
            }

            // Update weighing group record with received scale weight and exact total value
            $group->update([
                'status'                => 'RECEIVED',
                'total_received_weight' => round($receivedTotalWeight, 3),
                'total_amount'          => $receivedTotalAmount,
                'weight_difference'     => $diff,
                'scale_ticket_photo'    => $photoPath,
                'receiver_notes'        => $receiverNotes,
                'received_by_user_id'   => $user->id,
                'received_at'           => now(),
            ]);

            // Create single PurchaseReceipt entity (REC)
            $receiptService = app(\App\Services\PurchaseReceiptService::class);
            $receiptNumber = $receiptService->generateUniqueReceiptNumber();

            $receipt = PurchaseReceipt::create([
                'purchase_order_id'       => $group->purchase_order_id,
                'purchase_request_id'     => $group->purchaseOrder?->purchase_request_id,
                'supplier_id'             => $group->supplier_id,
                'weighing_group_id'       => $group->id,
                'receipt_number'          => $receiptNumber,
                'receipt_type'            => 'STEEL_WEIGHING_GROUP',
                'status'                  => 'APPROVED',
                'received_at'             => now()->toDateString(),
                'warehouse_keeper_user_id'=> $user->hasRole('warehouse_keeper') ? $user->id : null,
                'site_engineer_user_id'   => $user->hasRole('site_engineer') ? $user->id : null,
                'actual_receiver_name'    => $user->name,
                'actual_receiver_user_id' => $user->id,
                'warehouse_submitted_at'  => now(),
                'site_engineer_approved_at'=> now(),
                'photo_path'              => $photoPath,
                'photo_drive_id'          => $photoDriveId,
                'warehouse_notes'         => "استلام وزنة حديد مجمعة ({$group->group_number}) - إجمالي البسكول: {$receivedTotalWeight} طن" . ($diff != 0 ? " (فرق: {$diff} طن)" : ''),
                'site_engineer_notes'     => $receiverNotes,
            ]);

            // Create receipt items preserving links to each purchase_order_item
            foreach ($group->items as $wgItem) {
                $poItem = $wgItem->purchaseOrderItem;
                if ($poItem) {
                    $receipt->items()->create([
                        'purchase_order_item_id' => $poItem->id,
                        'ordered_quantity'       => $wgItem->ordered_weight,
                        'received_quantity'      => $wgItem->received_weight ?? $wgItem->ordered_weight,
                        'notes'                  => "ضمن وزنة حديد {$group->group_number} - مقاس {$wgItem->size_or_diameter}",
                    ]);
                }
            }

            // Record in AuditLog
            AuditLog::create([
                'user_id'     => $user->id,
                'entity_type' => WeighingGroup::class,
                'entity_id'   => $group->id,
                'action'      => 'STEEL_WEIGHT_GROUP_RECEIVED',
                'field_name'  => 'status',
                'old_value'   => 'PENDING_RECEIPT',
                'new_value'   => json_encode([
                    'group_number'          => $group->group_number,
                    'receipt_id'            => $receipt->id,
                    'receipt_number'        => $receipt->receipt_number,
                    'total_ordered_weight'  => $orderedTotal,
                    'total_received_weight' => $receivedTotalWeight,
                    'weight_difference'     => $diff,
                ], JSON_UNESCAPED_UNICODE),
            ]);

            return $receipt->load(['items.purchaseOrderItem', 'weighingGroup.items']);
        });
    }

    /**
     * Cancel an unreceived weighing group.
     */
    public function cancelWeighingGroup(User $user, int $weighingGroupId, ?string $reason = null): WeighingGroup
    {
        $this->authorizeProcurementManager($user);

        return DB::transaction(function () use ($user, $weighingGroupId, $reason) {
            $group = WeighingGroup::findOrFail($weighingGroupId);

            if ($group->status === 'RECEIVED') {
                throw ValidationException::withMessages([
                    'weighing_group' => ['لا يمكن إلغاء وزنة تم استلامها واعتمادها بالفعل.'],
                ]);
            }

            $group->update([
                'status' => 'CANCELLED',
                'notes'  => $group->notes ? "{$group->notes} | تم الإلغاء: {$reason}" : "تم الإلغاء: {$reason}",
            ]);

            AuditLog::create([
                'user_id'     => $user->id,
                'entity_type' => WeighingGroup::class,
                'entity_id'   => $group->id,
                'action'      => 'STEEL_WEIGHT_GROUP_CANCELLED',
                'field_name'  => 'status',
                'old_value'   => 'PENDING_RECEIPT',
                'new_value'   => json_encode([
                    'group_number' => $group->group_number,
                    'reason'       => $reason,
                ], JSON_UNESCAPED_UNICODE),
            ]);

            return $group;
        });
    }

    /**
     * Safely un-group a steel weighing group and release its member items.
     */
    public function ungroupWeighingGroup(User $user, int $weighingGroupId, ?string $reason = null): WeighingGroup
    {
        return $this->cancelWeighingGroup($user, $weighingGroupId, $reason ?: 'فك دمج وزنة الحديد');
    }
}
