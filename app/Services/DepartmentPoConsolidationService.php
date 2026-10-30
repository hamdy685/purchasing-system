<?php

namespace App\Services;

use App\Models\AuditLog;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseOrderItemSource;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\Supplier;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Mandatory department-consolidated purchase orders (config procurement.consolidated_po).
 *
 * For a request of a consolidating department the server, not the UI, decides how the
 * request lines are split: ONE consolidated PO per compatible scope, where the scope is
 * (supplier, plot/item_reference, region, supplementary flag) inside the one request.
 * Different suppliers or plots are never merged. Inside a PO, different items stay separate
 * lines; only identical lines (same catalog item, unit, specifications and unit price) are
 * merged into one line. Every PO line records its request lines in purchase_order_item_sources.
 * Steel weighing and shared shipment groupings chosen in the UI are applied inside the PO.
 */
class DepartmentPoConsolidationService
{
    private const GROUP_TYPES = ['STEEL_WEIGHING', 'SHARED_SHIPMENT'];

    public function __construct(private PurchaseOrderService $poService)
    {
    }

    /**
     * Issue the consolidated POs of a request.
     *
     * @return array{orders: Collection<int, PurchaseOrder>, replayed: bool}
     */
    public function issue(User $user, PurchaseRequest $pr, array $data): array
    {
        $idempotencyKey = ! empty($data['idempotency_key']) ? trim((string) $data['idempotency_key']) : null;

        try {
            return DB::transaction(function () use ($user, $pr, $data, $idempotencyKey) {
                // Serialize issuing for this request (concurrent submissions wait here).
                PurchaseRequest::whereKey($pr->id)->lockForUpdate()->first();

                if ($idempotencyKey && ($existing = $this->ordersForKey($idempotencyKey, $pr))->isNotEmpty()) {
                    return ['orders' => $existing, 'replayed' => true];
                }

                $pr = PurchaseRequest::with(['items', 'selectedQuote', 'department', 'targetDepartment'])->findOrFail($pr->id);
                $groups = $this->planGroups($pr, $data);
                $runId = (string) Str::uuid();
                $header = $this->headerOptions($data);

                $orders = collect();
                foreach (array_values($groups) as $index => $group) {
                    $po = $this->poService->createPoFromPr($user, $pr->id, $group['supplier_id'], array_merge($header, [
                        'items' => $this->mergeIdenticalLines($group['lines']),
                        'consolidation' => [
                            'key' => $group['key'],
                            'run_id' => $runId,
                            'idempotency_key' => $idempotencyKey ? "{$idempotencyKey}#{$index}" : null,
                        ],
                    ]));

                    $this->applyGroupings($user, $po, $group['lines']);

                    $this->recordConsolidation($user, $po, $group, $runId);

                    $orders->push($this->poService->submitToAccounting($user, $po->fresh()));
                }

                return ['orders' => $orders, 'replayed' => false];
            });
        } catch (QueryException $e) {
            // Lost an idempotency race: the other submission already issued the orders.
            if ($idempotencyKey && ($existing = $this->ordersForKey($idempotencyKey, $pr))->isNotEmpty()) {
                return ['orders' => $existing, 'replayed' => true];
            }
            throw $e;
        }
    }

    /**
     * What issue() would create for this payload, without saving anything (shown to procurement before issuing).
     *
     * @return array<int, array> one entry per consolidated PO: supplier, scope, merged lines and subtotal
     */
    public function preview(PurchaseRequest $pr, array $data): array
    {
        DB::beginTransaction();
        try {
            $pr = PurchaseRequest::with(['items', 'selectedQuote', 'department', 'targetDepartment'])->findOrFail($pr->id);
            $groups = $this->planGroups($pr, $data);
            $suppliers = Supplier::whereIn('id', collect($groups)->pluck('supplier_id'))->pluck('company_name', 'id');

            return collect(array_values($groups))->map(function (array $group) use ($suppliers) {
                $lines = collect($this->mergeIdenticalLines($group['lines']))->map(fn (array $line) => [
                    'item_id' => $line['item_id'],
                    'item_description' => $line['item_description'],
                    'quantity' => round((float) $line['quantity'], 4),
                    'uom' => $line['uom'],
                    'unit_price' => (float) $line['unit_price'],
                    'line_total' => round((float) $line['quantity'] * (float) $line['unit_price'], 2),
                    'specifications' => $line['specifications'],
                    'source_pr_item_ids' => collect($line['sources'])->pluck('pr_item_id')->values()->all(),
                ])->values();

                return [
                    'supplier_id' => $group['supplier_id'],
                    'supplier_name' => $suppliers[$group['supplier_id']] ?? null,
                    'item_reference' => $group['item_reference'],
                    'region' => $group['region'],
                    'lines' => $lines->all(),
                    'subtotal' => round($lines->sum('line_total'), 2),
                ];
            })->all();
        } finally {
            // Discards e.g. one-time suppliers created while resolving the plan.
            DB::rollBack();
        }
    }

    /**
     * Record which request lines a PO line consolidates, with their share of quantity and value.
     *
     * @param array<int, array{pr_item_id:int, line_quantity:float}> $sources
     */
    public function writeSources(User $user, PurchaseRequest $pr, PurchaseOrderItem $line, array $sources, ?string $runId = null): void
    {
        $prItemIds = collect($sources)->pluck('pr_item_id')->map(fn ($v) => (int) $v)->all();
        $this->releaseStaleSources($prItemIds);

        $unitPrice = (float) $line->unit_price;
        $lineTotal = round((float) $line->line_total, 2);
        $allocated = 0.0;
        $last = count($sources) - 1;

        foreach (array_values($sources) as $i => $source) {
            $prItem = $pr->items->firstWhere('id', (int) $source['pr_item_id']) ?? PurchaseRequestItem::findOrFail((int) $source['pr_item_id']);
            $lineQuantity = round((float) $source['line_quantity'], 4);
            // The last share absorbs rounding so the shares always add up to the line value.
            $amount = $i === $last ? round($lineTotal - $allocated, 2) : round($lineQuantity * $unitPrice, 2);
            $allocated += $amount;

            try {
                PurchaseOrderItemSource::create([
                    'purchase_order_item_id' => $line->id,
                    'purchase_request_id' => $pr->id,
                    'purchase_request_item_id' => $prItem->id,
                    'department_id' => $pr->target_department_id ?: $pr->department_id,
                    'land_parcel_id' => $pr->land_parcel_id,
                    'item_reference' => $line->item_reference,
                    'region' => $line->region,
                    'supplier_id' => $line->supplier_id,
                    'source_quantity' => (float) $prItem->quantity,
                    'source_uom' => (string) $prItem->uom,
                    'line_quantity' => $lineQuantity,
                    'unit_price' => $unitPrice,
                    'line_amount' => $amount,
                    'active_flag' => 1,
                    'consolidation_run_id' => $runId,
                    'created_by_user_id' => $user->id,
                ]);
            } catch (QueryException) {
                throw new \RuntimeException("البند [{$prItem->item_description}] تم إصدار أمر شراء له بالفعل في نفس اللحظة. أعد تحميل الطلب.");
            }
        }
    }

    /**
     * A consolidated PO belongs to exactly one supplier: header and every line.
     */
    public function assertSingleSupplier(PurchaseOrder $po): void
    {
        $suppliers = $po->items()->pluck('supplier_id')
            ->push($po->supplier_id)
            ->filter()->map(fn ($v) => (int) $v)->unique();

        if ($suppliers->count() > 1) {
            throw ValidationException::withMessages([
                'supplier_id' => ['لا يمكن أن يحتوي أمر الشراء المجمع على أكثر من مورد. كل مورد له أمر شراء مستقل.'],
            ]);
        }
    }

    /**
     * Release the sources of a PO that no longer holds its request lines (rejected, cancelled, voided, deleted).
     * Rows are kept for history; only active_flag is cleared.
     */
    public static function releaseForOrder(PurchaseOrder $po, string $reason): void
    {
        PurchaseOrderItemSource::active()
            ->whereIn('purchase_order_item_id', PurchaseOrderItem::where('purchase_order_id', $po->id)->select('id'))
            ->update(['active_flag' => null, 'released_at' => now(), 'released_reason' => mb_substr($reason, 0, 255)]);
    }

    // ── Planning ────────────────────────────────────────────────────────────

    /**
     * Resolve every requested line and group them into consolidated POs.
     *
     * @return array<string, array{key:string, supplier_id:int, lines:array<int, array>}>
     */
    private function planGroups(PurchaseRequest $pr, array $data): array
    {
        $lines = $this->collectLines($pr, $data);

        $groups = [];
        foreach ($lines as $line) {
            $scope = implode('|', [$line['supplier_id'], $line['item_reference'], $line['region'], $line['is_supplementary'] ? 1 : 0]);
            if (! isset($groups[$scope])) {
                $groups[$scope] = [
                    'key' => hash('sha256', json_encode([
                        'pr' => $pr->id,
                        'department' => PurchaseOrderSourceService::owningDepartmentCode($pr),
                        'supplier' => $line['supplier_id'],
                        'item_reference' => $line['item_reference'],
                        'region' => $line['region'],
                        'supplementary' => $line['is_supplementary'],
                        'request_type' => $pr->request_type,
                        'route' => $pr->procurement_route,
                        'quote' => $pr->selected_quote_id,
                    ], JSON_UNESCAPED_UNICODE)),
                    'supplier_id' => $line['supplier_id'],
                    'item_reference' => $line['item_reference'],
                    'region' => $line['region'],
                    'lines' => [],
                ];
            }
            $groups[$scope]['lines'][] = $line;
        }

        // A steel weighing or shared shipment chosen in the UI must fall inside one PO.
        $scopeByUiGroup = [];
        foreach ($groups as $scope => $group) {
            foreach ($group['lines'] as $line) {
                if ($line['group_type'] === null) {
                    continue;
                }
                $uiGroup = $line['group_index'];
                if (isset($scopeByUiGroup[$uiGroup]) && $scopeByUiGroup[$uiGroup] !== $scope) {
                    throw ValidationException::withMessages([
                        'groups' => ['بنود وزنة الحديد أو الشحنة المشتركة يجب أن تكون لنفس المورد ونفس قطعة الأرض والمنطقة.'],
                    ]);
                }
                $scopeByUiGroup[$uiGroup] = $scope;
            }
        }

        return $groups;
    }

    /**
     * @return array<int, array> resolved request lines, one per requested PR line
     */
    private function collectLines(PurchaseRequest $pr, array $data): array
    {
        $inputs = [];
        if (! empty($data['groups']) && is_array($data['groups'])) {
            foreach (array_values($data['groups']) as $groupIndex => $group) {
                $type = strtoupper((string) ($group['group_type'] ?? 'NONE'));
                foreach ((array) ($group['items'] ?? []) as $input) {
                    $inputs[] = [
                        'input' => (array) $input,
                        'group' => $group,
                        'group_index' => $groupIndex,
                        'group_type' => in_array($type, self::GROUP_TYPES, true) ? $type : null,
                    ];
                }
            }
        } elseif (! empty($data['items']) && is_array($data['items'])) {
            foreach ($data['items'] as $input) {
                $inputs[] = ['input' => (array) $input, 'group' => [], 'group_index' => null, 'group_type' => null];
            }
        } else {
            $open = $pr->items()->whereNot(fn ($q) => PurchaseOrderSourceService::orderedScope($q))->orderBy('id')->get();
            foreach ($open as $prItem) {
                $input = ['pr_item_id' => $prItem->id];
                if ($pr->procurement_route === 'DIRECT') {
                    $input['unit_price'] = (float) ($prItem->estimated_unit_price ?? 0);
                }
                $inputs[] = ['input' => $input, 'group' => [], 'group_index' => null, 'group_type' => null];
            }
        }

        if (empty($inputs)) {
            throw new \RuntimeException('لا توجد بنود متاحة لإصدار أمر الشراء (تم إصدار أوامر شراء لكل البنود).');
        }

        $seen = [];
        $lines = [];
        foreach ($inputs as $index => $entry) {
            $input = $entry['input'];
            $prItemId = (int) ($input['pr_item_id'] ?? 0);
            $prItem = $prItemId ? $pr->items->firstWhere('id', $prItemId) : null;

            if (! $prItem) {
                throw ValidationException::withMessages([
                    "items.{$index}.pr_item_id" => ['كل بند في أمر الشراء المجمع يجب أن يكون من بنود طلب الشراء نفسه.'],
                ]);
            }
            if (isset($seen[$prItemId])) {
                throw ValidationException::withMessages([
                    "items.{$index}.pr_item_id" => ["البند [{$prItem->item_description}] مكرر في نفس الإصدار."],
                ]);
            }
            $seen[$prItemId] = true;

            $supplierId = $this->resolveSupplier($pr, $prItem, $input, $entry['group'], $data);
            if (! $supplierId) {
                throw ValidationException::withMessages([
                    "items.{$index}.supplier_id" => ["يجب تحديد مورد للبند [{$prItem->item_description}] قبل إصدار أمر الشراء المجمع."],
                ]);
            }

            $quantity = isset($input['quantity']) ? (float) $input['quantity'] : (float) $prItem->quantity;
            [$quantity, $uom, $specs] = $this->poService->normalizePoItemUnitAndQuantity(
                $quantity,
                (string) ($input['uom'] ?? $prItem->uom ?? 'PCS'),
                $input['specifications'] ?? $prItem->specifications
            );

            $unitPrice = $pr->selectedQuote
                ? (float) $pr->selectedQuote->unit_price
                : (isset($input['unit_price']) ? (float) $input['unit_price'] : 0.0);

            $lines[] = [
                'pr_item_id' => $prItem->id,
                'item_id' => $input['item_id'] ?? $prItem->item_id,
                'item_description' => $input['item_description'] ?? $prItem->item_description,
                'item_reference' => trim((string) $prItem->item_reference),
                'region' => trim((string) $prItem->region),
                'quantity' => $quantity,
                'uom' => $uom,
                'specifications' => $specs,
                'unit_price' => $unitPrice,
                'supplier_id' => $supplierId,
                'is_supplementary' => $pr->isComplementaryRequest() || ! empty($input['is_supplementary']) || (bool) $prItem->is_supplementary,
                'group_type' => $entry['group_type'],
                'group_index' => $entry['group_index'],
                'group' => $entry['group'],
            ];
        }

        return $lines;
    }

    /**
     * Same precedence as PO creation: quote supplier, then line, request line, group and request-level choices.
     */
    private function resolveSupplier(PurchaseRequest $pr, PurchaseRequestItem $prItem, array $input, array $group, array $data): ?int
    {
        if ($pr->selectedQuote) {
            return (int) $pr->selectedQuote->supplier_id;
        }

        $candidates = [
            $input['supplier_id'] ?? null,
            $prItem->supplier_id,
            $group['supplier_id'] ?? null,
            $this->oneTimeSupplierId($group['one_time_supplier_name'] ?? null),
            $data['supplier_id'] ?? null,
            $this->oneTimeSupplierId($data['one_time_supplier_name'] ?? null),
            $pr->direct_supplier_id,
        ];

        foreach ($candidates as $candidate) {
            if (! empty($candidate)) {
                return (int) $candidate;
            }
        }

        return null;
    }

    private function oneTimeSupplierId(?string $name): ?int
    {
        $name = trim((string) $name);
        if ($name === '') {
            return null;
        }

        return Supplier::firstOrCreate(
            ['company_name' => $name],
            ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
        )->id;
    }

    /**
     * Merge identical lines (same catalog item, unit, specifications and unit price) into one PO line input.
     * Lines without a catalog item are never merged.
     */
    private function mergeIdenticalLines(array $lines): array
    {
        $merged = [];
        foreach ($lines as $i => $line) {
            $identity = $line['item_id']
                ? implode('|', [
                    (int) $line['item_id'],
                    strtoupper(trim((string) $line['uom'])),
                    trim((string) $line['specifications']),
                    number_format((float) $line['unit_price'], 4, '.', ''),
                    $line['group_type'] ? 'g' . $line['group_index'] : '-',
                ])
                : "line-{$i}";

            if (! isset($merged[$identity])) {
                $merged[$identity] = [
                    'item_id' => $line['item_id'],
                    'item_description' => $line['item_description'],
                    'quantity' => 0.0,
                    'uom' => $line['uom'],
                    'unit_price' => $line['unit_price'],
                    'specifications' => $line['specifications'],
                    'supplier_id' => $line['supplier_id'],
                    'is_supplementary' => $line['is_supplementary'],
                    'sources' => [],
                ];
            }

            $merged[$identity]['quantity'] = round($merged[$identity]['quantity'] + (float) $line['quantity'], 4);
            $merged[$identity]['sources'][] = ['pr_item_id' => $line['pr_item_id'], 'line_quantity' => (float) $line['quantity']];
        }

        return array_values(array_map(function (array $input) {
            if (count($input['sources']) === 1) {
                $input['pr_item_id'] = $input['sources'][0]['pr_item_id'];
            }

            return $input;
        }, $merged));
    }

    /**
     * Apply the UI's steel weighing / shared shipment choices to lines of the issued PO.
     */
    private function applyGroupings(User $user, PurchaseOrder $po, array $lines): void
    {
        $byUiGroup = collect($lines)->filter(fn ($l) => $l['group_type'] !== null)->groupBy('group_index');

        foreach ($byUiGroup as $uiLines) {
            $prItemIds = $uiLines->pluck('pr_item_id')->all();
            $poItemIds = PurchaseOrderItemSource::active()
                ->whereIn('purchase_request_item_id', $prItemIds)
                ->whereIn('purchase_order_item_id', $po->items()->select('id'))
                ->pluck('purchase_order_item_id')->unique()->values()->all();

            if (empty($poItemIds)) {
                continue;
            }

            $first = $uiLines->first();
            if ($first['group_type'] === 'STEEL_WEIGHING') {
                $steelLine = app(SteelConsolidationService::class)->consolidatePoItems($user, $po, $poItemIds);
                app(SteelWeighingGroupService::class)->createWeighingGroup($user, $po->id, [$steelLine->id], $first['group']['notes'] ?? null);
            } else {
                app(SharedShipmentGroupService::class)->createShipmentGroup(
                    $user,
                    $po->id,
                    $poItemIds,
                    $first['group']['group_name'] ?? null,
                    $first['group']['notes'] ?? null
                );
            }
        }
    }

    private function recordConsolidation(User $user, PurchaseOrder $po, array $group, string $runId): void
    {
        $prItemIds = collect($group['lines'])->pluck('pr_item_id')->values()->all();

        AuditLog::create([
            'user_id' => $user->id,
            'entity_type' => PurchaseOrder::class,
            'entity_id' => $po->id,
            'action' => 'PO_DEPARTMENT_CONSOLIDATED',
            'field_name' => 'consolidation_key',
            'old_value' => json_encode(['pr_item_ids' => $prItemIds], JSON_UNESCAPED_UNICODE),
            'new_value' => json_encode([
                'consolidation_key' => $group['key'],
                'run_id' => $runId,
                'supplier_id' => $group['supplier_id'],
                'item_reference' => $group['item_reference'],
                'region' => $group['region'],
                'po_lines' => $po->items()->count(),
            ], JSON_UNESCAPED_UNICODE),
        ]);

        app(SystemEventService::class)->recordAction(
            $po,
            'PO_DEPARTMENT_CONSOLIDATED',
            'تم إصدار أمر شراء مجمع للقسم لمورد واحد (' . count($prItemIds) . ' بند من الطلب).',
            ['event_type' => 'purchase_order.consolidated', 'actor_user_id' => $user->id, 'metadata' => ['run_id' => $runId, 'consolidation_key' => $group['key'], 'pr_item_ids' => $prItemIds]]
        );
    }

    private function headerOptions(array $data): array
    {
        $firstGroup = is_array($data['groups'] ?? null) ? (array) (array_values($data['groups'])[0] ?? []) : [];

        return [
            'payment_terms' => $data['payment_terms'] ?? $firstGroup['payment_terms'] ?? null,
            'delivery_terms' => $data['delivery_terms'] ?? null,
            'delivery_date' => $data['delivery_date'] ?? $firstGroup['delivery_date'] ?? null,
            'budget_code' => $data['budget_code'] ?? null,
            'notes' => $data['notes'] ?? $firstGroup['notes'] ?? null,
        ];
    }

    private function ordersForKey(string $key, PurchaseRequest $pr): Collection
    {
        $orders = PurchaseOrder::where('idempotency_key', 'like', $key . '#%')->orderBy('id')->get();

        if ($orders->contains(fn (PurchaseOrder $po) => (int) $po->purchase_request_id !== (int) $pr->id)) {
            throw new \RuntimeException('مفتاح منع التكرار مستخدم لطلب شراء آخر.');
        }

        return $orders->map(fn (PurchaseOrder $po) => $po->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'supplier', 'createdBy', 'items.item', 'items.sources']));
    }

    /**
     * Sources still flagged active although their PO no longer holds them (e.g. a status changed by a raw query).
     */
    private function releaseStaleSources(array $prItemIds): void
    {
        PurchaseOrderItemSource::active()
            ->whereIn('purchase_request_item_id', $prItemIds)
            ->whereIn('purchase_order_item_id', PurchaseOrderItem::query()
                ->select('purchase_order_items.id')
                ->join('purchase_orders', 'purchase_orders.id', '=', 'purchase_order_items.purchase_order_id')
                ->where(fn ($q) => $q->whereNotNull('purchase_orders.deleted_at')
                    ->orWhereIn('purchase_orders.status', PurchaseOrderSourceService::INACTIVE_PO_STATUSES)))
            ->update(['active_flag' => null, 'released_at' => now(), 'released_reason' => 'PO no longer active']);
    }
}
