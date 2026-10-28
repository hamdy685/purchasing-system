<?php

namespace App\Services;

use App\Models\AuditLog;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Merges the rebar lines procurement grouped while issuing a PO into ONE financial
 * PO line named "حديد" (quantity in tons, value = sum of the original line totals).
 * The original diameter lines are kept as reference-only components.
 */
class SteelConsolidationService
{
    public const CONSOLIDATED_NAME = 'حديد';

    /** Same bar weights as PurchaseOrderService::normalizePoItemUnitAndQuantity. */
    private const BAR_TON_WEIGHTS = [
        'BAR_2_5LINIA' => 0.0047,
        'BAR_3LINIA'   => 0.0074,
        'BAR_4LINIA'   => 0.0104,
        'BAR_5LINIA'   => 0.0190,
    ];

    /**
     * Convert a quantity to tons using the system's established steel units.
     * Returns null when the unit has no reliable conversion.
     */
    public function toTons(float $quantity, ?string $uom): ?float
    {
        $raw = trim((string) $uom);
        $upper = strtoupper($raw);

        if ($upper === 'TON' || $raw === 'طن') {
            return $quantity;
        }
        if ($upper === 'KG' || in_array($raw, ['كجم', 'كيلو'], true)) {
            return $quantity / 1000;
        }
        if ($upper === 'PARCEL' || mb_strpos($raw, 'طرد') !== false) {
            return $quantity * 1.940;
        }
        if (isset(self::BAR_TON_WEIGHTS[$upper])) {
            return $quantity * self::BAR_TON_WEIGHTS[$upper];
        }

        return null;
    }

    public function extractDiameter(PurchaseOrderItem $item): ?string
    {
        $text = trim($item->item_description . ' ' . $item->specifications);
        if (preg_match('/(\d+(?:\.\d+)?)\s*(?:مم|ملل|ملى|ملي|mm)/iu', $text, $m)) {
            return "{$m[1]} مم";
        }
        if (preg_match('/قطر\s*(\d+(?:\.\d+)?)/iu', $text, $m)) {
            return "{$m[1]} مم";
        }
        if (preg_match('/(\d+(?:\.\d+)?)\s*(?:لينية|لنية|لينيا)/iu', $text, $m)) {
            return "{$m[1]} لينية";
        }

        return null;
    }

    /**
     * Replace the given PO lines by one consolidated "حديد" line. Must run inside the
     * PO creation transaction, before any receipt exists.
     */
    public function consolidatePoItems(User $user, PurchaseOrder $po, array $itemIds): PurchaseOrderItem
    {
        $items = $po->items()->whereIn('id', $itemIds)->orderBy('id')->get();
        if ($items->count() !== count($itemIds)) {
            throw ValidationException::withMessages(['items' => ['بعض البنود المحددة غير تابعة لأمر الشراء هذا.']]);
        }
        if ($items->count() < 2) {
            return $items->first();
        }

        if ($po->receipts()->exists()) {
            throw ValidationException::withMessages(['items' => ['لا يمكن تجميع الحديد بعد تسجيل إذن استلام لأمر الشراء.']]);
        }

        $weighingService = app(SteelWeighingGroupService::class);
        foreach ($items as $item) {
            if (! $weighingService->isSteelItem($item) || $this->toTons(1.0, $item->uom) === null) {
                throw ValidationException::withMessages([
                    'items' => ["البند ({$item->item_description}) ليس حديد تسليح بوحدة وزن معروفة، ولا يمكن تجميعه في بند حديد."],
                ]);
            }
        }

        $distinct = fn (callable $value) => $items->map($value)->map(fn ($v) => trim((string) $v))->unique();
        if ($distinct(fn ($it) => $it->supplier_id ?: $po->supplier_id)->count() > 1) {
            throw ValidationException::withMessages(['supplier' => ['لا يمكن تجميع الحديد لأن المورد مختلف بين البنود.']]);
        }
        if ($distinct(fn ($it) => $it->item_reference)->count() > 1 || $distinct(fn ($it) => $it->region)->count() > 1) {
            throw ValidationException::withMessages(['items' => ['لا يمكن تجميع الحديد لأن قطعة الأرض أو المنطقة مختلفة بين البنود (تكلفة كل قطعة تُحسب منفصلة).']]);
        }

        $totalTons = 0.0;
        $totalAmount = 0.0;
        $components = [];
        $summary = [];
        foreach ($items->values() as $order => $item) {
            $tons = round($this->toTons((float) $item->quantity, $item->uom), 4);
            $amount = round((float) $item->line_total, 2);
            $totalTons += $tons;
            $totalAmount += $amount;
            $diameter = $this->extractDiameter($item);

            $components[] = [
                'purchase_request_item_id' => $item->pr_item_id,
                'item_id' => $item->item_id,
                'item_description' => $item->item_description,
                'size_or_diameter' => $diameter,
                'quantity' => (float) $item->quantity,
                'uom' => $item->uom,
                'quantity_in_tons' => $tons,
                'unit_price' => (float) $item->unit_price,
                'line_amount' => $amount,
                'specifications' => $item->specifications,
                'sort_order' => $order,
            ];
            $summary[] = ($diameter ?: $item->item_description) . ': ' . rtrim(rtrim(number_format($tons, 4, '.', ''), '0'), '.') . ' طن';
        }

        $totalTons = round($totalTons, 4);
        $totalAmount = round($totalAmount, 2);
        $first = $items->first();

        $consolidated = $po->items()->create([
            'item_description' => self::CONSOLIDATED_NAME,
            'item_reference' => $first->item_reference,
            'region' => $first->region,
            'quantity' => $totalTons,
            'uom' => 'TON',
            // Weighted ton price that preserves the summed value (never a plain average of prices).
            'unit_price' => $totalTons > 0 ? round($totalAmount / $totalTons, 4) : 0,
            'specifications' => 'حديد مجمع (' . $items->count() . ' بنود): ' . implode(' + ', $summary),
            'supplier_id' => $first->supplier_id ?: $po->supplier_id,
            'is_supplementary' => (bool) $first->is_supplementary,
            'is_consolidated_steel' => true,
        ]);

        foreach ($components as $component) {
            $consolidated->steelComponents()->create($component);
        }

        PurchaseOrderItem::whereIn('id', $items->pluck('id'))->delete();

        AuditLog::create([
            'user_id' => $user->id,
            'entity_type' => PurchaseOrderItem::class,
            'entity_id' => $consolidated->id,
            'action' => 'STEEL_LINES_CONSOLIDATED',
            'field_name' => 'item_description',
            'old_value' => json_encode($items->map(fn ($it) => [
                'id' => $it->id,
                'pr_item_id' => $it->pr_item_id,
                'item_description' => $it->item_description,
                'quantity' => (float) $it->quantity,
                'uom' => $it->uom,
                'line_total' => (float) $it->line_total,
            ])->values()->all(), JSON_UNESCAPED_UNICODE),
            'new_value' => json_encode([
                'item_description' => self::CONSOLIDATED_NAME,
                'quantity' => $totalTons,
                'line_value' => $totalAmount,
            ], JSON_UNESCAPED_UNICODE),
        ]);

        return $consolidated->fresh();
    }

    /**
     * Purchase request lines merged into an active consolidated PO line still count as ordered.
     */
    public static function orderedThroughSteelComponent($prItemQuery): void
    {
        $prItemQuery->whereExists(function ($q) {
            $q->select(DB::raw(1))
                ->from('steel_item_components')
                ->join('purchase_order_items', 'purchase_order_items.id', '=', 'steel_item_components.purchase_order_item_id')
                ->join('purchase_orders', 'purchase_orders.id', '=', 'purchase_order_items.purchase_order_id')
                ->whereColumn('steel_item_components.purchase_request_item_id', 'purchase_request_items.id')
                ->whereNotIn('purchase_orders.status', ['REJECTED', 'CANCELLED', 'VOIDED']);
        });
    }
}
