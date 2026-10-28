<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class PurchaseReceiptService
{
    /**
     * Generate sequential unique receipt number (REC-1, REC-2, ...).
     * Simple, clean, ascending starting from 1 with no leading zeros.
     */
    public function generateUniqueReceiptNumber(string $prefix = 'REC-'): string
    {
        $latestReceipt = DB::table('purchase_receipts')
            ->where('receipt_number', 'like', "{$prefix}%")
            ->orderBy('id', 'desc')
            ->lockForUpdate()
            ->first();

        $maxSeq = 0;
        if ($latestReceipt) {
            $parts = explode('-', $latestReceipt->receipt_number);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $maxSeq = (int) $lastPart;
            }
        }

        $existing = DB::table('purchase_receipts')
            ->where('receipt_number', 'like', "{$prefix}%")
            ->pluck('receipt_number');

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

        while (DB::table('purchase_receipts')->where('receipt_number', "{$prefix}{$nextNumber}")->exists()) {
            $nextNumber++;
        }

        return "{$prefix}{$nextNumber}";
    }
    public function warehouseQueue(User|int|null $userOrPerPage = null, int $perPage = 15)
    {
        $user = null;
        if ($userOrPerPage instanceof User) {
            $user = $userOrPerPage;
        } elseif (is_int($userOrPerPage)) {
            $perPage = $userOrPerPage;
        }

        $query = PurchaseOrder::withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
            ->with([
                'supplier',
                'purchaseRequest' => fn ($prQ) => $prQ->withoutGlobalScope(\App\Scopes\DataIsolationScope::class),
                'purchaseRequest.requester',
                'purchaseRequest.department',
                'purchaseRequest.targetDepartment',
                'purchaseRequest.assignedReviewer.department',
                'purchaseRequest.siteEngineer',
                'purchaseRequest.supplements',
                'items.item',
                'items.prItem',
                'items.weighingGroupItem',
                'items.shipmentGroup',
                'weighingGroups.items',
                'shipmentGroups.items',
                'receipts.warehouseKeeper',
            ])
            // 1. Status allows receiving (issued or approved)
            ->where(function ($q) {
                $q->whereIn('status', [
                    'ISSUED',
                    'PO_ISSUED',
                    'APPROVED',
                    'approved',
                    'issued',
                    'APPROVED_BY_ACCOUNTING',
                    'PENDING_ACCOUNTING_REVIEW',
                    'FINAL_APPROVED',
                ])
                ->orWhere('status', 'like', '%ISSUED%')
                ->orWhere('status', 'like', '%APPROVED%');
            })
            ->whereNotIn('status', ['PO_DRAFT', 'REJECTED', 'CANCELLED', 'VOIDED', 'PENDING_ACTUAL_PO'])
            // Must contain items to be eligible for warehouse receiving
            ->whereHas('items')
            // 2. Delivery status means delivery is not completed (pending, partial, not_started, null, not delivered/completed)
            ->where(function ($q) {
                $q->whereNull('delivery_status')
                  ->orWhereIn('delivery_status', [
                      'NOT_STARTED',
                      'not_started',
                      'PENDING',
                      'pending',
                      'IN_RECEIPT',
                      'in_receipt',
                      'PARTIAL',
                      'partial',
                      'LATE',
                      'late',
                  ])
                  ->orWhereNotIn('delivery_status', [
                      'DELIVERED',
                      'delivered',
                      'COMPLETE',
                      'complete',
                      'COMPLETED',
                      'completed',
                  ]);
            })
            // 3. Receipt status: allows receipt if no approved/submitted receipt yet, or if partial delivery
            ->where(function ($q) {
                $q->whereDoesntHave('receipts', fn ($rq) => $rq->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED']))
                  ->orWhere(function ($partialQ) {
                      $partialQ->whereIn('delivery_status', ['PARTIAL', 'partial', 'IN_RECEIPT', 'in_receipt'])
                               ->whereDoesntHave('receipts', fn ($rq) => $rq->where('status', 'PENDING_SITE_ENGINEER'));
                  });
            })
            // 4. Warehouse keeper assignment check:
            // Never exclude orders where warehouse_keeper_user_id is null!
            ->where(function ($q) use ($user) {
                $q->whereDoesntHave('receipts')
                  ->orWhereHas('receipts', function ($rq) use ($user) {
                      $rq->whereNull('warehouse_keeper_user_id');
                      if ($user) {
                          $rq->orWhere('warehouse_keeper_user_id', $user->id);
                      }
                  });
            })
            // 5. Conditions matching notifications:
            // requires_warehouse_receipt is true (or null/default) and not office supplies
            ->whereHas('purchaseRequest', function ($prQuery) use ($user) {
                $prQuery->withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                    ->where('request_type', '!=', 'OFFICE_SUPPLIES')
                    ->where(function ($sub) {
                        $sub->where('requires_warehouse_receipt', true)
                            ->orWhereNull('requires_warehouse_receipt');
                    });

                // Department scoping only if user is constrained to department and not a warehouse keeper / global manager
                if ($user && $user->department_id && ! $user->hasRole('warehouse_keeper') && ! $user->hasAnyRole(['admin', 'general_manager', 'procurement_manager'])) {
                    $prQuery->where(function ($deptQ) use ($user) {
                        $deptQ->where('department_id', $user->department_id)
                              ->orWhere('target_department_id', $user->department_id);
                    });
                }
            })
            ->orderByDesc('updated_at');

        return $query->paginate($perPage);
    }

    public function pendingWarehouseTasks(User|int|null $userOrPerPage = null, int $perPage = 15)
    {
        return $this->warehouseQueue($userOrPerPage, $perPage);
    }

    public function receiptArchive(User $user, int $perPage = 25)
    {
        $query = PurchaseReceipt::with([
            'supplier',
            'purchaseOrder.supplier',
            'purchaseOrder.purchaseRequest.department',
            'purchaseOrder.purchaseRequest.requester',
            'purchaseOrder.purchaseRequest.siteEngineer',
            'purchaseOrder.items.item',
            'purchaseOrder.items.prItem',
            'purchaseOrder.items.shipmentGroup',
            'purchaseOrder.shipmentGroups.items',
            'purchaseRequest.department',
            'purchaseRequest.requester',
            'purchaseRequest.siteEngineer',
            'warehouseKeeper',
            'siteEngineer',
            'items.purchaseOrderItem.item',
            'items.purchaseOrderItem.prItem',
            'items.purchaseOrderItem.shipmentGroup',
            'weighingGroup.items',
        ])->orderByDesc('created_at');

        if (! $user->hasAnyRole(['admin', 'general_manager', 'accountant', 'procurement_manager'])) {
            if ($user->hasRole('warehouse_keeper')) {
                $query->where(function ($q) use ($user) {
                    $q->where('warehouse_keeper_user_id', $user->id)
                      ->orWhereNull('warehouse_keeper_user_id');
                });
            } else {
                $query->where(function ($q) use ($user) {
                    $q->where('site_engineer_user_id', $user->id)
                      ->orWhere('receiver_user_id', $user->id)
                      ->orWhereHas('purchaseOrder.purchaseRequest', function ($prQ) use ($user) {
                          $prQ->where('site_engineer_user_id', $user->id);
                          $parcelId = $user->parcel_id ?? $user->land_parcel_id ?? null;
                          if ($parcelId) {
                              $prQ->orWhere('land_parcel_id', $parcelId);
                          }
                      });

                    if ($user->hasRole('reviewer') || $user->hasPermission('purchase_request.review')) {
                        $q->orWhereHas('purchaseOrder.purchaseRequest', function ($prQ) use ($user) {
                            $prQ->where('reviewer_user_id', $user->id)
                                ->when($user->department_id, fn ($sub) => $sub->orWhere('department_id', $user->department_id)->orWhere('target_department_id', $user->department_id));
                        })->orWhereHas('purchaseRequest', function ($prQ) use ($user) {
                            $prQ->where('reviewer_user_id', $user->id)
                                ->when($user->department_id, fn ($sub) => $sub->orWhere('department_id', $user->department_id)->orWhere('target_department_id', $user->department_id));
                        });
                    }
                });
            }
        }

        return $query->paginate($perPage);
    }

    public function createByWarehouse(
        User $warehouseKeeper,
        PurchaseOrder $purchaseOrder,
        array $items,
        ?string $receivedAt = null,
        ?string $notes = null,
        ?array $photoData = null,
        ?string $actualReceiverName = null,
        ?int $actualReceiverUserId = null,
        ?int $weighingGroupId = null,
        ?float $scaleTicketWeight = null
    ): PurchaseReceipt {
        $purchaseOrder->loadMissing([
            'purchaseRequest.targetDepartment',
            'purchaseRequest.department',
            'purchaseRequest.assignedReviewer.department',
            'items.prItem',
        ]);

        if (! $purchaseOrder->requiresWarehouseReceipt()) {
            throw new \RuntimeException('لا يمكن لأمين المخزن استلام هذا الطلب؛ حيث تم تحديده من قبل المراجع كتوريد مباشر لا يتطلب المرور على المخزن.');
        }

        if ($purchaseOrder->purchaseRequest?->isOfficeRequest()) {
            throw new \RuntimeException('هذا الطلب يخص مستلزمات مكتبية ويتم تأكيد استلامه مباشرة من قبل مقدم الطلب.');
        }

        $siteEngineerId = $purchaseOrder->purchaseRequest?->site_engineer_user_id;

        if (! $siteEngineerId) {
            $fallbackEngineerId = $purchaseOrder->purchaseRequest?->targetDepartment?->site_engineer_user_id
                ?? $purchaseOrder->purchaseRequest?->department?->site_engineer_user_id
                ?? User::whereHas('roles', fn ($q) => $q->where('slug', 'site_engineer'))->where('is_active', true)->value('id');

            if ($fallbackEngineerId) {
                $siteEngineerId = $fallbackEngineerId;
                if ($purchaseOrder->purchaseRequest) {
                    $purchaseOrder->purchaseRequest->update(['site_engineer_user_id' => $fallbackEngineerId]);
                }
            }
        }

        if (! $siteEngineerId) {
            throw new \RuntimeException('لا يوجد مهندس موقع محدد لهذا الطلب.');
        }
        if (! in_array($purchaseOrder->status, ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'], true)) {
            throw new \RuntimeException('لا يمكن تسجيل الاستلام في حالة أمر الشراء الحالية.');
        }
        if (PurchaseReceipt::where('purchase_order_id', $purchaseOrder->id)->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED'])->exists()) {
            throw new \RuntimeException('تم إنشاء إذن استلام لهذا الأمر بالفعل.');
        }

        if ($purchaseOrder->purchase_request_id && \App\Models\PurchaseRequestSupplement::where('purchase_request_id', $purchaseOrder->purchase_request_id)->whereIn('status', ['PENDING_PROCUREMENT_APPROVAL', 'SUBMITTED', 'REVIEWER_APPROVED'])->exists()) {
            throw new \RuntimeException('لا يمكن إتمام الاستلام حالياً؛ يوجد طلب كمالة قيد التسعير وإصدار أمر الشراء لدى إدارة المشتريات (م. أحمد). يرجى الانتظار حتى يتم تحميل البنود على أمر الشراء.');
        }

        if (empty($items)) {
            throw ValidationException::withMessages(['items' => ['يجب تسجيل صنف واحد على الأقل في إذن الاستلام.']]);
        }

        $submittedItemIds = array_map(fn ($item) => (int) ($item['purchase_order_item_id'] ?? 0), $items);
        if (count($submittedItemIds) !== count(array_unique($submittedItemIds))) {
            throw ValidationException::withMessages(['items' => ['لا يمكن تكرار نفس البند أكثر من مرة في إذن الاستلام.']]);
        }

        $orderItems = $purchaseOrder->items->keyBy('id');

        return DB::transaction(function () use ($warehouseKeeper, $purchaseOrder, $items, $receivedAt, $notes, $siteEngineerId, $orderItems, $photoData, $actualReceiverName, $actualReceiverUserId, $weighingGroupId, $scaleTicketWeight): PurchaseReceipt {
            // Serialize concurrent submissions for the same PO and re-check under the lock.
            PurchaseOrder::whereKey($purchaseOrder->id)->lockForUpdate()->first();
            if (PurchaseReceipt::where('purchase_order_id', $purchaseOrder->id)->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED'])->exists()) {
                throw new \RuntimeException('تم إنشاء إذن استلام لهذا الأمر بالفعل.');
            }

            $supplierId = $purchaseOrder->supplier_id ?: \App\Models\Supplier::getOrCreateInternalWarehouseSupplier()->id;
            if (! $purchaseOrder->supplier_id) {
                $purchaseOrder->update(['supplier_id' => $supplierId]);
            }

            // Check for weighing group (either explicitly passed or active pending on PO)
            $weighingGroup = null;
            if ($weighingGroupId) {
                $weighingGroup = \App\Models\WeighingGroup::where('id', $weighingGroupId)
                    ->where('purchase_order_id', $purchaseOrder->id)
                    ->lockForUpdate()
                    ->first();

                // A cancelled or already-received ticket must never be (re)applied to a new receipt.
                if ($weighingGroup && $weighingGroup->status !== 'PENDING_RECEIPT') {
                    throw ValidationException::withMessages([
                        'weighing_group_id' => ['مجموعة الوزنة المحددة ملغاة أو تم استلامها مسبقاً ولا يمكن ربطها بإذن استلام جديد.'],
                    ]);
                }
            } else {
                $weighingGroup = \App\Models\WeighingGroup::where('purchase_order_id', $purchaseOrder->id)
                    ->where('status', 'PENDING_RECEIPT')
                    ->lockForUpdate()
                    ->first();
            }

            $receipt = PurchaseReceipt::create([
                'purchase_order_id' => $purchaseOrder->id,
                'purchase_request_id' => $purchaseOrder->purchase_request_id,
                'supplier_id' => $supplierId,
                'weighing_group_id' => $weighingGroup?->id,
                'warehouse_keeper_user_id' => $warehouseKeeper->id,
                'site_engineer_user_id' => $siteEngineerId,
                'actual_receiver_name' => $actualReceiverName,
                'actual_receiver_user_id' => $actualReceiverUserId,
                'receipt_number' => $this->generateUniqueReceiptNumber('REC-'),
                'status' => 'PENDING_SITE_ENGINEER',
                'received_at' => $receivedAt ?: now()->toDateString(),
                'warehouse_submitted_at' => now(),
                'warehouse_notes' => $notes,
                'photo_path' => $photoData['path'] ?? null,
                'photo_name' => $photoData['name'] ?? null,
                'photo_size' => $photoData['size'] ?? null,
                'photo_mime_type' => $photoData['mime_type'] ?? null,
                'photo_drive_id' => $photoData['drive_id'] ?? null,
            ]);

            foreach ($items as $item) {
                $orderItemId = (int) ($item['purchase_order_item_id'] ?? 0);
                $orderItem = $orderItems->get($orderItemId);
                if (! $orderItem) {
                    throw ValidationException::withMessages(['items' => ['يوجد بند غير مرتبط بأمر الشراء.']]);
                }
                $receivedQuantity = (float) ($item['received_quantity'] ?? -1);
                if ($receivedQuantity < 0) {
                    throw ValidationException::withMessages(['items' => ['الكمية المستلمة لا يمكن أن تكون سالبة.']]);
                }

                $prItem = $orderItem->prItem;
                $finalReceivedQuantity = $receivedQuantity;
                $noteText = $item['notes'] ?? null;

                // Handle case where requester requested in PR UOM (e.g. BAR) and PO was issued in another UOM (e.g. TON)
                if ($prItem && $prItem->uom && $orderItem->uom && strtoupper((string)$prItem->uom) !== strtoupper((string)$orderItem->uom)) {
                    $prQty = (float) $prItem->quantity;
                    $poQty = (float) $orderItem->quantity;
                    if ($prQty > 0 && $poQty > 0) {
                        $ratio = $poQty / $prQty;
                        // If entered quantity is in the scale of PR items (e.g. entered 40 bars for a 0.416 ton PO item)
                        if ($receivedQuantity > ($poQty * 2) && $ratio < 0.2) {
                            $finalReceivedQuantity = round($receivedQuantity * $ratio, 3);
                            $notePrefix = "[المستلم بالموقع: {$receivedQuantity} {$prItem->uom}]";
                            $noteText = $noteText ? "{$notePrefix} - {$noteText}" : $notePrefix;
                        }
                    }
                }

                $receipt->items()->create([
                    'purchase_order_item_id' => $orderItem->id,
                    'ordered_quantity' => $orderItem->quantity,
                    'received_quantity' => $finalReceivedQuantity,
                    'notes' => $noteText,
                ]);
            }

            $affectedShipmentGroupIds = $orderItems->pluck('shipment_group_id')->filter()->unique()->all();
            foreach ($affectedShipmentGroupIds as $sgId) {
                app(\App\Services\SharedShipmentGroupService::class)->updateShipmentStatus($sgId);
            }

            if ($weighingGroup) {
                $weighingGroup->loadMissing('items');
                $wgItemMap = $weighingGroup->items->keyBy('purchase_order_item_id');
                $totalReceivedWeight = 0.0;

                foreach ($items as $item) {
                    $orderItemId = (int) ($item['purchase_order_item_id'] ?? 0);
                    $recQty = (float) ($item['received_quantity'] ?? 0);
                    if ($wgItem = $wgItemMap->get($orderItemId)) {
                        $wgItem->update(['received_weight' => $recQty]);
                        $totalReceivedWeight += $recQty;
                    }
                }

                $finalTotalWeight = ($scaleTicketWeight !== null && $scaleTicketWeight > 0)
                    ? (float) $scaleTicketWeight
                    : round($totalReceivedWeight, 3);

                $diff = round($finalTotalWeight - (float) $weighingGroup->total_ordered_weight, 3);
                $unitPrice = (float) ($weighingGroup->unit_price ?: ($weighingGroup->items->first()?->unit_price ?? 0));
                $receivedTotalAmount = round($finalTotalWeight * $unitPrice, 2);

                $weighingGroup->update([
                    'status' => 'RECEIVED',
                    'received_at' => now(),
                    'received_by_user_id' => $warehouseKeeper->id,
                    'total_received_weight' => $finalTotalWeight,
                    'total_amount' => $receivedTotalAmount,
                    'weight_difference' => $diff,
                    'scale_ticket_photo' => $photoData['path'] ?? $weighingGroup->scale_ticket_photo,
                    'receiver_notes' => $notes ?: $weighingGroup->receiver_notes,
                ]);

                \App\Models\AuditLog::create([
                    'user_id'     => $warehouseKeeper->id,
                    'entity_type' => \App\Models\WeighingGroup::class,
                    'entity_id'   => $weighingGroup->id,
                    'action'      => 'STEEL_WEIGHT_GROUP_RECEIVED',
                    'field_name'  => 'status',
                    'old_value'   => 'PENDING_RECEIPT',
                    'new_value'   => json_encode([
                        'group_number'          => $weighingGroup->group_number,
                        'receipt_id'            => $receipt->id,
                        'receipt_number'        => $receipt->receipt_number,
                        'total_ordered_weight'  => (float) $weighingGroup->total_ordered_weight,
                        'total_received_weight' => $finalTotalWeight,
                        'weight_difference'     => $diff,
                    ], JSON_UNESCAPED_UNICODE),
                ]);
            }

            $purchaseOrder->update(['delivery_status' => 'IN_RECEIPT']);

            ApprovalHistory::create([
                'target_type' => PurchaseReceipt::class,
                'target_id' => $receipt->id,
                'actor_user_id' => $warehouseKeeper->id,
                'action' => 'WAREHOUSE_RECEIPT_SUBMITTED',
                'from_state' => 'PENDING_WAREHOUSE',
                'to_state' => 'PENDING_SITE_ENGINEER',
                'comments' => $notes ?: 'سجل أمين المخزن الكميات المستلمة وأرسل إذن الاستلام للمستلم/مهندس الموقع للفحص والاعتماد.',
            ]);

            $notificationService = app(NotificationService::class);

            // Notify the assigned site engineer / receiver to review and approve the receipt
            $siteEngineer = User::find($siteEngineerId);
            if ($siteEngineer) {
                $notificationService->queueNotification(
                    $siteEngineer,
                    'purchase_receipt_pending_site_engineer',
                    'إذن استلام بانتظار اعتمادك',
                    "إذن الاستلام {$receipt->receipt_number} لأمر الشراء {$purchaseOrder->po_number} بانتظار فحصك واعتمادك.",
                    $receipt
                );
            }

            $notificationService->markEntityNotificationsAsRead($purchaseOrder, $warehouseKeeper);

            return $receipt->fresh(['purchaseOrder.supplier', 'purchaseOrder.items.item', 'purchaseRequest', 'warehouseKeeper', 'siteEngineer', 'items.purchaseOrderItem']);
        });
    }

    public function updateBySiteEngineer(User $siteEngineer, PurchaseReceipt $receipt, array $items, ?string $notes = null): PurchaseReceipt
    {
        $receipt->loadMissing(['items.purchaseOrderItem.prItem', 'purchaseOrder.purchaseRequest.department', 'purchaseRequest.department']);
        $assignedSiteId = (int) ($receipt->site_engineer_user_id ?: $receipt->purchaseOrder?->purchaseRequest?->site_engineer_user_id ?: $receipt->purchaseRequest?->site_engineer_user_id);
        $pr = $receipt->purchaseOrder?->purchaseRequest ?: $receipt->purchaseRequest;
        $isOfficeReceipt = $receipt->receipt_type === 'REQUESTER_OFFICE';

        $isAuthorized = $siteEngineer->hasAnyRole(['admin', 'general_manager'])
            || $assignedSiteId === (int) $siteEngineer->id
            || (int) $receipt->receiver_user_id === (int) $siteEngineer->id
            || ($isOfficeReceipt && (
                (int) $receipt->actual_receiver_user_id === (int) $siteEngineer->id
                || (int) ($pr?->user_id) === (int) $siteEngineer->id
            ));

        if (! $isAuthorized) {
            throw new \Illuminate\Auth\Access\AuthorizationException('هذا الإذن غير مسند إليك.');
        }
        if ($receipt->status !== 'PENDING_SITE_ENGINEER') {
            throw new \RuntimeException('لا يمكن تعديل إذن الاستلام بعد اعتماده أو إرساله للحسابات.');
        }

        return DB::transaction(function () use ($siteEngineer, $receipt, $items, $notes): PurchaseReceipt {
            $receiptItems = $receipt->items->keyBy('id');
            foreach ($items as $input) {
                $receiptItem = $receiptItems->get((int) ($input['id'] ?? 0));
                if (! $receiptItem) {
                    throw ValidationException::withMessages(['items' => ['يوجد بند غير مرتبط بإذن الاستلام.']]);
                }
                $receivedQuantity = (float) ($input['received_quantity'] ?? -1);
                if ($receivedQuantity < 0) {
                    throw ValidationException::withMessages(['items' => ['الكمية المستلمة لا يمكن أن تكون سالبة.']]);
                }

                $orderItem = $receiptItem->purchaseOrderItem;
                $prItem = $orderItem?->prItem;
                $finalReceivedQuantity = $receivedQuantity;
                $noteText = $input['notes'] ?? $receiptItem->notes;

                if ($prItem && $prItem->uom && $orderItem && $orderItem->uom && strtoupper((string)$prItem->uom) !== strtoupper((string)$orderItem->uom)) {
                    $prQty = (float) $prItem->quantity;
                    $poQty = (float) $orderItem->quantity;
                    if ($prQty > 0 && $poQty > 0) {
                        $ratio = $poQty / $prQty;
                        if ($receivedQuantity > ($poQty * 2) && $ratio < 0.2) {
                            $finalReceivedQuantity = round($receivedQuantity * $ratio, 3);
                            $notePrefix = "[المعتمد بالموقع: {$receivedQuantity} {$prItem->uom}]";
                            $noteText = $noteText ? "{$notePrefix} - {$noteText}" : $notePrefix;
                        }
                    }
                }

                $receiptItem->update([
                    'received_quantity' => $finalReceivedQuantity,
                    'notes' => $noteText,
                ]);
            }
            if ($notes !== null) {
                $receipt->update(['site_engineer_notes' => $notes]);
            }

            ApprovalHistory::create([
                'target_type' => PurchaseReceipt::class,
                'target_id' => $receipt->id,
                'actor_user_id' => $siteEngineer->id,
                'action' => 'SITE_ENGINEER_RECEIPT_UPDATED',
                'from_state' => 'PENDING_SITE_ENGINEER',
                'to_state' => 'PENDING_SITE_ENGINEER',
                'comments' => 'عدّل مهندس الموقع كميات إذن الاستلام قبل إرساله للحسابات.',
            ]);

            return $receipt->fresh(['purchaseOrder.supplier', 'purchaseOrder.items.item', 'purchaseRequest', 'warehouseKeeper', 'siteEngineer', 'items.purchaseOrderItem']);
        });
    }

    public function approveBySiteEngineer(User $siteEngineer, PurchaseReceipt $receipt, ?string $notes = null): PurchaseReceipt
    {
        $receipt->loadMissing(['purchaseOrder.purchaseRequest.department', 'purchaseRequest.department', 'items']);
        $assignedSiteId = (int) ($receipt->site_engineer_user_id ?: $receipt->purchaseOrder?->purchaseRequest?->site_engineer_user_id ?: $receipt->purchaseRequest?->site_engineer_user_id);
        $pr = $receipt->purchaseOrder?->purchaseRequest ?: $receipt->purchaseRequest;
        $isOfficeReceipt = $receipt->receipt_type === 'REQUESTER_OFFICE';

        $isAuthorized = $siteEngineer->hasAnyRole(['admin', 'general_manager'])
            || $assignedSiteId === (int) $siteEngineer->id
            || (int) $receipt->receiver_user_id === (int) $siteEngineer->id
            || ($isOfficeReceipt && (
                (int) $receipt->actual_receiver_user_id === (int) $siteEngineer->id
                || (int) ($pr?->user_id) === (int) $siteEngineer->id
            ));

        if (! $isAuthorized) {
            throw new \Illuminate\Auth\Access\AuthorizationException('هذا الإذن غير مسند إليك.');
        }

        if ($receipt->status === 'APPROVED') {
            return $receipt;
        }

        if ($receipt->status !== 'PENDING_SITE_ENGINEER') {
            throw new \RuntimeException('إذن الاستلام ليس بانتظار اعتماد مهندس الموقع.');
        }

        if ($receipt->purchaseOrder?->purchase_request_id && \App\Models\PurchaseRequestSupplement::where('purchase_request_id', $receipt->purchaseOrder->purchase_request_id)->whereIn('status', ['PENDING_PROCUREMENT_APPROVAL', 'SUBMITTED', 'REVIEWER_APPROVED'])->exists()) {
            throw new \RuntimeException('لا يمكن إتمام الاستلام حالياً؛ يوجد طلب كمالة قيد التسعير وإصدار أمر الشراء لدى إدارة المشتريات (م. أحمد). يرجى الانتظار حتى يتم تحميل البنود على أمر الشراء.');
        }

        return DB::transaction(function () use ($siteEngineer, $receipt, $notes, $pr): PurchaseReceipt {
            $receipt->loadMissing(['purchaseOrder.supplier', 'supplier']);
            $isInternalWarehouse = $receipt->isInternalWarehouse();

            $receipt->update([
                'status' => 'APPROVED',
                'site_engineer_approved_at' => now(),
                'site_engineer_notes' => $notes,
                'site_engineer_user_id' => $receipt->site_engineer_user_id ?: $siteEngineer->id,
                'receiver_user_id' => $receipt->receiver_user_id ?: $siteEngineer->id,
                'receiver_approved_at' => $receipt->receipt_type === 'REQUESTER_OFFICE' ? now() : $receipt->receiver_approved_at,
                'receiver_notes' => $receipt->receipt_type === 'REQUESTER_OFFICE' ? ($notes ?: $receipt->receiver_notes) : $receipt->receiver_notes,
            ]);

            // Regardless of whether it is an internal warehouse order or an external supplier,
            // once the Site Engineer approves the GRN, the order moves to PENDING_ACTUAL_PO waiting for Actual PO!
            $receipt->purchaseOrder?->update([
                'delivery_status' => 'DELIVERED',
                'actual_delivery_date' => $receipt->received_at ?: now()->toDateString(),
                'status' => 'PENDING_ACTUAL_PO',
            ]);

            app(NotificationService::class)->markEntityNotificationsAsRead($receipt);
            if ($receipt->purchaseOrder) {
                app(NotificationService::class)->markEntityNotificationsAsRead($receipt->purchaseOrder);
            }

            $affectedShipmentGroupIds = $receipt->items()
                ->join('purchase_order_items', 'purchase_receipt_items.purchase_order_item_id', '=', 'purchase_order_items.id')
                ->whereNotNull('purchase_order_items.shipment_group_id')
                ->pluck('purchase_order_items.shipment_group_id')
                ->unique()
                ->all();

            foreach ($affectedShipmentGroupIds as $sgId) {
                app(\App\Services\SharedShipmentGroupService::class)->updateShipmentStatus($sgId);
            }

            $itemDescriptions = $receipt->items->map(function ($item) {
                return $item->item_description ?: ($item->purchaseOrderItem?->item_description ?: null);
            })->filter()->unique()->values()->all();
            $itemsSummary = !empty($itemDescriptions) ? ' [البنود: ' . implode('، ', array_slice($itemDescriptions, 0, 3)) . (count($itemDescriptions) > 3 ? '...' : '') . ']' : '';

            $isOffice = $receipt->receipt_type === 'REQUESTER_OFFICE';
            $actorRoleLabel = $isOffice
                ? 'مقدم الطلب / المستلم'
                : ($siteEngineer->hasRole('reviewer') ? 'المراجع الفني/رئيس القسم' : 'مهندس الموقع');

            ApprovalHistory::create([
                'target_type' => PurchaseReceipt::class,
                'target_id' => $receipt->id,
                'actor_user_id' => $siteEngineer->id,
                'action' => $isOffice
                    ? 'OFFICE_RECEIPT_APPROVED'
                    : ($isInternalWarehouse ? 'INTERNAL_STOCK_RECEIPT_APPROVED' : 'SITE_ENGINEER_RECEIPT_APPROVED'),
                'from_state' => 'PENDING_SITE_ENGINEER',
                'to_state' => 'APPROVED',
                'comments' => $isOffice
                    ? ($notes ? "{$notes} — استلام المستلزمات المكتبية بمقر الشركة{$itemsSummary}، وأُحيل الملف للمشتريات لإصدار أمر الشراء الفعلي." : "اعتمد {$actorRoleLabel} استلام وفحص المستلزمات المكتبية{$itemsSummary} بمقر الشركة، وبانتظار أمر الشراء الفعلي.")
                    : ($isInternalWarehouse
                        ? ($notes ? "{$notes} — استلام وتفريغ{$itemsSummary} من المخزن الداخلي، بانتظار إصدار أمر الشراء الفعلي." : "اعتمد {$actorRoleLabel} استلام المواد{$itemsSummary} المنصرفة من المخزن الداخلي، وبانتظار مراجعة وإصدار أمر الشراء الفعلي.")
                        : ($notes ? "{$notes} — البنود المستلمة{$itemsSummary}" : "اعتمد {$actorRoleLabel} فحص واستلام البنود{$itemsSummary} وأُعيد الملف لإدارة المشتريات لإصدار أمر الشراء الفعلي المستقل الخاص بها.")),
            ]);

            $notificationService = app(NotificationService::class);

            // Notify Procurement Managers to issue the Actual PO (for external vendors and internal warehouse alike)
            $procurementUsers = $notificationService->resolveUsersWithPermission('purchase_order.create');

            if ($procurementUsers->isNotEmpty()) {
                $notificationService->queueUsers(
                    $procurementUsers,
                    'grn_approved_pending_actual_po',
                    'مطلوب إنشاء أمر شراء فعلي',
                    $isInternalWarehouse
                        ? "اعتمد مهندس الموقع إذن استلام المخزن {$receipt->receipt_number} لأمر الشراء {$receipt->purchaseOrder->po_number}{$itemsSummary}. يرجى مراجعة الكميات وإصدار أمر الشراء الفعلي الخاص بها."
                        : "اعتمد وفحص مهندس الموقع إذن الاستلام {$receipt->receipt_number} لأمر الشراء {$receipt->purchaseOrder->po_number}{$itemsSummary}. هذا البند/الشحنة جاهز الآن لإصدار أمر الشراء الفعلي المستقل الخاص به.",
                    $receipt->purchaseOrder
                );
            }

            if ($receipt->warehouse_keeper_user_id) {
                $notificationService->queueNotification(
                    $receipt->warehouse_keeper_user_id,
                    'purchase_receipt_approved_site_engineer',
                    $isInternalWarehouse ? 'تم اعتماد إذن الصرف والاستلام من مهندس الموقع (بانتظار أمر الشراء الفعلي)' : 'تم اعتماد إذن الاستلام من مهندس الموقع',
                    "اعتمد مهندس الموقع إذن الاستلام {$receipt->receipt_number} لأمر الشراء {$receipt->purchaseOrder->po_number}.",
                    $receipt
                );
            }

            // Accounting notifications:
            // CRITICAL BUSINESS RULE:
            // For internal warehouse orders, NO data or notifications may be sent to accounting before Actual PO issuance.
            // For external vendors, existing receipt notification is maintained for awareness.
            if (! $isInternalWarehouse) {
                $receipt->purchaseOrder->loadMissing('purchaseRequest.department');
                $deptCode = $receipt->purchaseOrder->purchaseRequest?->department?->code;
                $deptAccountants = app(\App\Services\SupplierInvoiceService::class)->getAccountantsForDepartment($deptCode);
                $targetAccountants = $deptAccountants->isNotEmpty()
                    ? $deptAccountants
                    : User::whereHas('roles', fn ($q) => $q->whereIn('slug', ['general_accountant', 'site_accountant', 'accountant']))
                        ->where('is_active', true)
                        ->get();

                if ($targetAccountants->isEmpty()) {
                    $targetAccountants = $notificationService->resolveUsersWithPermission('purchase_order.view_accounting');
                }

                if ($targetAccountants->isNotEmpty()) {
                    $notificationService->queueAccountingWithPurchaseOrderAndReceipt(
                        $targetAccountants,
                        $receipt->purchaseOrder,
                        $receipt
                    );
                }
            }

            return $receipt->fresh(['supplier', 'purchaseOrder.supplier', 'purchaseOrder.items.item', 'purchaseRequest', 'warehouseKeeper', 'siteEngineer', 'items.purchaseOrderItem']);
        });
    }

    public function confirmByRequester(User $requester, PurchaseOrder $purchaseOrder, array $items = [], ?string $notes = null): PurchaseReceipt
    {
        $purchaseOrder->loadMissing(['purchaseRequest', 'items']);
        $pr = $purchaseOrder->purchaseRequest;

        if (!$pr) {
            throw new \RuntimeException('لا يوجد طلب شراء مرتبط بأمر الشراء هذا.');
        }

        if ($pr->request_type !== 'OFFICE_SUPPLIES') {
            throw new \RuntimeException('هذا الأمر يخص مشروعاً ويتطلب استلام أمين المخزن واعتماد مهندس الموقع.');
        }

        $isRequester = (int) $pr->user_id === (int) $requester->id;
        $isPrivileged = $requester->hasAnyRole(['admin', 'general_manager', 'procurement_manager']);
        if (!$isRequester && !$isPrivileged) {
            throw new \RuntimeException('فقط مقدم الطلب أو إدارة المشتريات/الإدارة العامة يمكنهم تأكيد استلام هذا الطلب المكتبي.');
        }

        if (! in_array($purchaseOrder->status, ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'], true)) {
            throw new \RuntimeException('لا يمكن تأكيد الاستلام في حالة أمر الشراء الحالية.');
        }

        if (PurchaseReceipt::where('purchase_order_id', $purchaseOrder->id)->where('status', 'APPROVED')->exists()) {
            throw new \RuntimeException('تم تأكيد استلام هذا الطلب المكتبي بالفعل.');
        }

        $orderItems = $purchaseOrder->items->keyBy('id');
        $itemsMap = collect($items)->keyBy('purchase_order_item_id');

        return DB::transaction(function () use ($requester, $purchaseOrder, $pr, $orderItems, $itemsMap, $notes): PurchaseReceipt {
            $existingReceipt = PurchaseReceipt::where('purchase_order_id', $purchaseOrder->id)
                ->where('status', 'PENDING_SITE_ENGINEER')
                ->first();

            if ($existingReceipt) {
                $existingReceipt->loadMissing('items');
                $receiptItems = $existingReceipt->items->keyBy('purchase_order_item_id');

                foreach ($orderItems as $orderItem) {
                    $itemPayload = $itemsMap->get($orderItem->id);
                    $receivedQuantity = $itemPayload && isset($itemPayload['received_quantity'])
                        ? (float) $itemPayload['received_quantity']
                        : (float) $orderItem->quantity;

                    if ($receivedQuantity < 0) {
                        $receivedQuantity = (float) $orderItem->quantity;
                    }

                    $rItem = $receiptItems->get($orderItem->id);
                    if ($rItem) {
                        $rItem->update([
                            'received_quantity' => $receivedQuantity,
                            'notes' => $itemPayload['notes'] ?? $rItem->notes ?? 'تم الاستلام بواسطة مقدم الطلب',
                        ]);
                    } else {
                        $existingReceipt->items()->create([
                            'purchase_order_item_id' => $orderItem->id,
                            'ordered_quantity' => $orderItem->quantity,
                            'received_quantity' => $receivedQuantity,
                            'notes' => $itemPayload['notes'] ?? 'تم الاستلام بواسطة مقدم الطلب',
                        ]);
                    }
                }

                $existingReceipt->update([
                    'status' => 'APPROVED',
                    'receiver_user_id' => $requester->id,
                    'site_engineer_user_id' => $existingReceipt->site_engineer_user_id ?: $requester->id,
                    'receiver_approved_at' => now(),
                    'site_engineer_approved_at' => now(),
                    'receiver_notes' => $notes,
                    'site_engineer_notes' => $notes,
                ]);

                $receipt = $existingReceipt;
            } else {
                $supplierId = $purchaseOrder->supplier_id ?: \App\Models\Supplier::getOrCreateInternalWarehouseSupplier()->id;
                $receipt = PurchaseReceipt::create([
                    'purchase_order_id' => $purchaseOrder->id,
                    'purchase_request_id' => $pr->id,
                    'supplier_id' => $supplierId,
                    'warehouse_keeper_user_id' => null,
                    'site_engineer_user_id' => $requester->id,
                    'receiver_user_id' => $requester->id,
                    'receipt_number' => $this->generateUniqueReceiptNumber('REC-OFFICE-'),
                    'receipt_type' => 'REQUESTER_OFFICE',
                    'status' => 'APPROVED',
                    'received_at' => now()->toDateString(),
                    'receiver_approved_at' => now(),
                    'site_engineer_approved_at' => now(),
                    'receiver_notes' => $notes,
                    'site_engineer_notes' => $notes,
                ]);

                foreach ($orderItems as $orderItem) {
                    $itemPayload = $itemsMap->get($orderItem->id);
                    $receivedQuantity = $itemPayload && isset($itemPayload['received_quantity'])
                        ? (float) $itemPayload['received_quantity']
                        : (float) $orderItem->quantity;

                    if ($receivedQuantity < 0) {
                        $receivedQuantity = (float) $orderItem->quantity;
                    }

                    $receipt->items()->create([
                        'purchase_order_item_id' => $orderItem->id,
                        'ordered_quantity' => $orderItem->quantity,
                        'received_quantity' => $receivedQuantity,
                        'notes' => $itemPayload['notes'] ?? 'تم الاستلام بواسطة مقدم الطلب',
                    ]);
                }
            }

            $purchaseOrder->update([
                'delivery_status' => 'DELIVERED',
                'actual_delivery_date' => now()->toDateString(),
                'status' => 'PENDING_ACTUAL_PO',
            ]);

            ApprovalHistory::create([
                'target_type' => PurchaseReceipt::class,
                'target_id' => $receipt->id,
                'actor_user_id' => $requester->id,
                'action' => 'OFFICE_RECEIPT_CONFIRMED',
                'from_state' => 'ISSUED',
                'to_state' => 'APPROVED',
                'comments' => $notes ?: 'أكد مقدم الطلب استلام المستلزمات المكتبية بالكامل، وأُحيل الملف لإدارة المشتريات لإصدار أمر الشراء الفعلي.',
            ]);

            $notificationService = app(NotificationService::class);
            $procurementUsers = $notificationService->resolveUsersWithPermission('purchase_order.create');

            if ($procurementUsers->isNotEmpty()) {
                $notificationService->queueUsers(
                    $procurementUsers,
                    'grn_approved_pending_actual_po',
                    'استلام مكتبي معتمد — بانتظار إصدار أمر الشراء الفعلي',
                    "أكد مقدم الطلب استلام المستلزمات المكتبية بإذن الاستلام {$receipt->receipt_number} لأمر الشراء {$receipt->purchaseOrder->po_number}. يرجى مراجعة الأصناف وإصدار أمر الشراء الفعلي.",
                    $receipt->purchaseOrder
                );
            }

            return $receipt->fresh(['purchaseOrder.supplier', 'purchaseOrder.items.item', 'purchaseRequest', 'receiver', 'items.purchaseOrderItem']);
        });
    }

    /**
     * Automatically create a direct site receipt for orders bypassing the warehouse,
     * routing the receipt straight to the site engineer (Auto-Bypassing warehouse approval).
     */
    public function createDirectSiteReceipt(PurchaseOrder $purchaseOrder): PurchaseReceipt
    {
        $purchaseOrder->loadMissing([
            'purchaseRequest.targetDepartment',
            'purchaseRequest.department',
            'purchaseRequest.assignedReviewer.department',
            'purchaseRequest.siteEngineer',
            'items',
        ]);

        $existingReceipt = PurchaseReceipt::where('purchase_order_id', $purchaseOrder->id)
            ->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED'])
            ->first();

        if ($existingReceipt) {
            return $existingReceipt;
        }

        $siteEngineerId = $purchaseOrder->purchaseRequest?->site_engineer_user_id;

        if (! $siteEngineerId) {
            $fallbackEngineerId = $purchaseOrder->purchaseRequest?->targetDepartment?->site_engineer_user_id
                ?? $purchaseOrder->purchaseRequest?->department?->site_engineer_user_id
                ?? User::whereHas('roles', fn ($q) => $q->where('slug', 'site_engineer'))->where('is_active', true)->value('id');

            if ($fallbackEngineerId) {
                $siteEngineerId = $fallbackEngineerId;
                if ($purchaseOrder->purchaseRequest) {
                    $purchaseOrder->purchaseRequest->update(['site_engineer_user_id' => $fallbackEngineerId]);
                }
            }
        }

        if (! $siteEngineerId) {
            throw new \RuntimeException('لا يمكن إنشاء إذن استلام مباشر بالموقع دون تحديد مهندس الموقع/المستلم الميداني.');
        }

        if ($purchaseOrder->purchase_request_id && \App\Models\PurchaseRequestSupplement::where('purchase_request_id', $purchaseOrder->purchase_request_id)->whereIn('status', ['PENDING_PROCUREMENT_APPROVAL', 'SUBMITTED', 'REVIEWER_APPROVED'])->exists()) {
            throw new \RuntimeException('لا يمكن إتمام الاستلام حالياً؛ يوجد طلب كمالة قيد التسعير وإصدار أمر الشراء لدى إدارة المشتريات (م. أحمد). يرجى الانتظار حتى يتم تحميل البنود على أمر الشراء.');
        }

        $deptName = $purchaseOrder->purchaseRequest?->department?->name ?? 'الموقع';

        return DB::transaction(function () use ($purchaseOrder, $siteEngineerId, $deptName): PurchaseReceipt {
            $supplierId = $purchaseOrder->supplier_id ?: \App\Models\Supplier::getOrCreateInternalWarehouseSupplier()->id;
            $receipt = PurchaseReceipt::create([
                'purchase_order_id' => $purchaseOrder->id,
                'purchase_request_id' => $purchaseOrder->purchase_request_id,
                'supplier_id' => $supplierId,
                'warehouse_keeper_user_id' => null,
                'site_engineer_user_id' => $siteEngineerId,
                'receipt_number' => $this->generateUniqueReceiptNumber('REC-SITE-'),
                'receipt_type' => 'SITE_DIRECT',
                'status' => 'PENDING_SITE_ENGINEER',
                'received_at' => now()->toDateString(),
                'warehouse_submitted_at' => now(),
                'warehouse_notes' => "توريد مباشر للموقع ({$deptName}) — تم تخطي الاستلام المخزني تلقائياً (Auto-Bypassed) واستلام فوري بالموقع من المورد.",
            ]);

            foreach ($purchaseOrder->items as $orderItem) {
                $receipt->items()->create([
                    'purchase_order_item_id' => $orderItem->id,
                    'ordered_quantity' => $orderItem->quantity,
                    'received_quantity' => $orderItem->quantity,
                    'notes' => "توريد مباشر لموقع {$deptName}",
                ]);
            }

            $purchaseOrder->update(['delivery_status' => 'IN_RECEIPT']);

            ApprovalHistory::create([
                'target_type' => PurchaseReceipt::class,
                'target_id' => $receipt->id,
                'actor_user_id' => $purchaseOrder->created_by_user_id ?? $siteEngineerId,
                'action' => 'SITE_DIRECT_RECEIPT_CREATED',
                'from_state' => 'ISSUED',
                'to_state' => 'PENDING_SITE_ENGINEER',
                'comments' => 'تم التخطي التلقائي للاستلام المخزني (Auto-Bypass) لعدم اشتراط المخزن لهذا الطلب، وتوجيه الإذن مباشرة إلى مهندس الموقع للفحص والاعتماد.',
            ]);

            $siteEngineer = User::find($siteEngineerId);
            if ($siteEngineer) {
                app(NotificationService::class)->queueNotification(
                    $siteEngineer,
                    'purchase_receipt_pending_site_engineer',
                    'توريد مباشر بالموقع بانتظار استلامك وفحصك',
                    "أمر الشراء {$purchaseOrder->po_number} تم توجيهه إليك مباشرة لاستلام المواد بالموقع واعتماد إذن الاستلام {$receipt->receipt_number} (تم تخطي المخزن تلقائياً).",
                    $receipt
                );
            }

            return $receipt->fresh(['purchaseOrder.supplier', 'purchaseOrder.items.item', 'purchaseRequest', 'warehouseKeeper', 'siteEngineer', 'items.purchaseOrderItem']);
        });
    }

    /**
     * Backward-compatible alias for createDirectSiteReceipt.
     */
    public function createDirectSiteReceiptForBuildings(PurchaseOrder $purchaseOrder): PurchaseReceipt
    {
        return $this->createDirectSiteReceipt($purchaseOrder);
    }

    /**
     * Sync and generate any missing direct site receipts for orders bypassing the warehouse assigned to this engineer.
     */
    public function syncPendingDirectSiteReceiptsForEngineer(User $siteEngineer): void
    {
        $pendingPos = PurchaseOrder::with([
            'purchaseRequest.department',
            'purchaseRequest.targetDepartment',
            'purchaseRequest.assignedReviewer.department',
            'items',
        ])
            ->where('status', 'ISSUED')
            ->whereDoesntHave('receipts', fn ($query) => $query->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED']))
            ->whereHas('purchaseRequest', function ($query) use ($siteEngineer) {
                $query->where('site_engineer_user_id', $siteEngineer->id);
            })
            ->get();

        foreach ($pendingPos as $po) {
            if (! $po->requiresWarehouseReceipt()) {
                $this->createDirectSiteReceipt($po);
            }
        }
    }

    /**
     * Backward-compatible alias for syncPendingDirectSiteReceiptsForEngineer.
     */
    public function syncPendingBuildingsReceiptsForEngineer(User $siteEngineer): void
    {
        $this->syncPendingDirectSiteReceiptsForEngineer($siteEngineer);
    }

    /**
     * Automatically create a pending office receipt for office supplies orders bypassing the warehouse,
     * assigning inspection and acceptance to the requester directly.
     */
    public function createOfficeReceipt(PurchaseOrder $purchaseOrder, int $requesterId): PurchaseReceipt
    {
        $existing = PurchaseReceipt::where('purchase_order_id', $purchaseOrder->id)
            ->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED'])
            ->first();

        if ($existing) {
            return $existing;
        }

        return DB::transaction(function () use ($purchaseOrder, $requesterId): PurchaseReceipt {
            $supplierId = $purchaseOrder->supplier_id ?: \App\Models\Supplier::getOrCreateInternalWarehouseSupplier()->id;
            $receipt = PurchaseReceipt::create([
                'purchase_order_id' => $purchaseOrder->id,
                'purchase_request_id' => $purchaseOrder->purchase_request_id,
                'supplier_id' => $supplierId,
                'warehouse_keeper_user_id' => null,
                'site_engineer_user_id' => $requesterId,
                'receiver_user_id' => $requesterId,
                'receipt_number' => $this->generateUniqueReceiptNumber('REC-OFFICE-'),
                'receipt_type' => 'REQUESTER_OFFICE',
                'status' => 'PENDING_SITE_ENGINEER',
                'received_at' => now()->toDateString(),
                'warehouse_submitted_at' => now(),
                'warehouse_notes' => 'توريد مستلزمات مكتبية لمقر الشركة — تم تخطي المخزن وتوجيه إذن الاستلام لمقدم الطلب للفحص والاعتماد.',
            ]);

            foreach ($purchaseOrder->items as $orderItem) {
                $receipt->items()->create([
                    'purchase_order_item_id' => $orderItem->id,
                    'ordered_quantity' => $orderItem->quantity,
                    'received_quantity' => $orderItem->quantity,
                    'notes' => 'مستلزمات مكتبية',
                ]);
            }

            if (! in_array($purchaseOrder->delivery_status, ['DELIVERED', 'COMPLETED', 'COMPLETE'], true)) {
                $purchaseOrder->update(['delivery_status' => 'IN_RECEIPT']);
            }

            ApprovalHistory::create([
                'target_type' => PurchaseReceipt::class,
                'target_id' => $receipt->id,
                'actor_user_id' => $purchaseOrder->created_by_user_id ?? $requesterId,
                'action' => 'OFFICE_RECEIPT_CREATED',
                'from_state' => 'ISSUED',
                'to_state' => 'PENDING_SITE_ENGINEER',
                'comments' => 'تم إنشاء إذن استلام المستلزمات المكتبية وتوجيهه لمقدم الطلب للفحص وتعديل الكميات المستلمة واعتمادها.',
            ]);

            $requester = User::find($requesterId);
            if ($requester) {
                app(NotificationService::class)->queueNotification(
                    $requester,
                    'purchase_receipt_pending_site_engineer',
                    'استلام مستلزمات مكتبية بانتظار فحصك واعتمادك',
                    "أمر الشراء {$purchaseOrder->po_number} تم توجيهه إليك لاستلام الأصناف المكتبية واعتماد إذن الاستلام {$receipt->receipt_number}.",
                    $receipt
                );
            }

            return $receipt->fresh(['purchaseOrder.supplier', 'purchaseOrder.items.item', 'purchaseRequest', 'warehouseKeeper', 'siteEngineer', 'receiver', 'items.purchaseOrderItem']);
        });
    }

    /**
     * Sync and generate any missing pending office receipts for office supplies orders assigned to this requester.
     */
    public function syncPendingOfficeReceiptsForRequester(User $user): void
    {
        $pendingPos = PurchaseOrder::with([
            'purchaseRequest',
            'items',
        ])
            ->whereIn('status', ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'])
            ->whereDoesntHave('receipts', fn ($query) => $query->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED']))
            ->whereHas('purchaseRequest', function ($query) use ($user) {
                $query->withoutGlobalScope(\App\Scopes\DataIsolationScope::class)
                    ->where('request_type', 'OFFICE_SUPPLIES');

                if (! $user->hasAnyRole(['admin', 'procurement_manager', 'general_manager'])) {
                    $query->where('user_id', $user->id);
                }
            })
            ->get();

        foreach ($pendingPos as $po) {
            $requesterId = (int) ($po->purchaseRequest?->user_id ?? $user->id);
            $this->createOfficeReceipt($po, $requesterId);
        }
    }

    public function cancelPendingReceipt(User $user, PurchaseReceipt $receipt): void
    {
        if (! $user->hasAnyRole(['admin', 'general_manager', 'procurement_manager', 'warehouse_keeper', 'site_engineer'])) {
            throw new \Illuminate\Auth\Access\AuthorizationException('غير مصرح لك بإلغاء إذن الاستلام.');
        }

        if ($receipt->status === 'APPROVED') {
            throw new \RuntimeException('لا يمكن إلغاء إذن استلام تم اعتماده نهائياً.');
        }

        DB::transaction(function () use ($receipt, $user) {
            $po = $receipt->purchaseOrder;
            if ($receipt->weighing_group_id) {
                $wg = \App\Models\WeighingGroup::find($receipt->weighing_group_id);
                if ($wg && $wg->status === 'RECEIVED') {
                    $wg->update([
                        'status' => 'PENDING_RECEIPT',
                        'received_at' => null,
                        'received_by_user_id' => null,
                        'total_received_weight' => null,
                        'weight_difference' => null,
                    ]);
                }
            }

            $receipt->items()->delete();
            ApprovalHistory::where('target_type', PurchaseReceipt::class)->where('target_id', $receipt->id)->delete();
            $receipt->delete();

            if ($po) {
                $po->update(['delivery_status' => 'PENDING']);
            }
        });
    }
}


