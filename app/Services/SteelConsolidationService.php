<?php

namespace App\Services;

use App\Models\PurchaseOrderItem;
use App\Models\PurchaseRequestItem;
use Illuminate\Support\Facades\DB;

/**
 * Consolidates several rebar lines of a direct purchase request into ONE
 * financial line named "حديد" (quantity in tons, value = sum of the original
 * line amounts). The original lines are kept as reference-only components.
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

    private const STEEL_KEYWORDS = ['حديد', 'تسليح', 'rebar', 'steel'];

    /**
     * Convert a quantity to tons using the system's established steel units.
     * Returns null when the unit has no reliable conversion (the line is then left untouched).
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

    /**
     * A line is consolidatable rebar only when its unit converts to tons AND it is steel
     * by catalog category (STEEL) or by description, excluding known non-rebar materials.
     */
    public function isRebarLine(array $item): bool
    {
        if ($this->toTons(1.0, $item['uom'] ?? null) === null) {
            return false;
        }

        if (! empty($item['item_id'])) {
            $categoryCode = DB::table('items')
                ->leftJoin('categories', 'items.category_id', '=', 'categories.id')
                ->where('items.id', $item['item_id'])
                ->value('categories.code');
            if (strtoupper(trim((string) $categoryCode)) === 'STEEL') {
                return true;
            }
        }

        $desc = mb_strtolower(trim((string) ($item['item_description'] ?? '')));
        foreach (SteelWeighingGroupService::EXCLUDED_KEYWORDS as $excluded) {
            if (mb_strpos($desc, $excluded) !== false) {
                return false;
            }
        }
        foreach (self::STEEL_KEYWORDS as $keyword) {
            if (mb_strpos($desc, $keyword) !== false) {
                return true;
            }
        }

        return false;
    }

    public function extractDiameter(array $item): ?string
    {
        $text = trim(($item['item_description'] ?? '') . ' ' . ($item['specifications'] ?? ''));
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
     * Split submitted direct-request lines into plain lines and consolidated steel lines.
     * Rebar lines sharing supplier + plot + region (two or more of them) become one "حديد" line.
     * Order is preserved: the consolidated line takes the position of its first member.
     *
     * @return array<int, array{type: string, item: array, components?: array}>
     */
    public function consolidate(array $items): array
    {
        $groups = [];
        foreach ($items as $index => $item) {
            if (! $this->isRebarLine($item)) {
                continue;
            }
            $key = implode('|', [
                (string) ($item['supplier_id'] ?? ''),
                trim((string) ($item['item_reference'] ?? '')),
                trim((string) ($item['region'] ?? '')),
            ]);
            $groups[$key][] = $index;
        }

        $groupOf = [];
        foreach ($groups as $key => $indexes) {
            if (count($indexes) >= 2) {
                foreach ($indexes as $index) {
                    $groupOf[$index] = $key;
                }
            }
        }

        $entries = [];
        $emitted = [];
        foreach ($items as $index => $item) {
            if (! isset($groupOf[$index])) {
                $entries[] = ['type' => 'plain', 'item' => $item];
                continue;
            }
            $key = $groupOf[$index];
            if (isset($emitted[$key])) {
                continue;
            }
            $emitted[$key] = true;
            $entries[] = $this->buildConsolidatedEntry(array_map(fn ($i) => $items[$i], $groups[$key]));
        }

        return $entries;
    }

    private function buildConsolidatedEntry(array $members): array
    {
        $totalTons = 0.0;
        $totalAmount = 0.0;
        $components = [];
        $summary = [];

        foreach ($members as $order => $member) {
            $qty = (float) $member['quantity'];
            $price = (float) $member['unit_price'];
            $tons = round($this->toTons($qty, $member['uom'] ?? null), 4);
            // Same per-line amount the request total is built from (quantity × unit price as entered).
            $amount = round($qty * $price, 2);

            $totalTons += $tons;
            $totalAmount += $amount;

            $diameter = $this->extractDiameter($member);
            $components[] = [
                'item_id' => $member['item_id'] ?? null,
                'item_description' => $member['item_description'],
                'size_or_diameter' => $diameter,
                'quantity' => $qty,
                'uom' => $member['uom'] ?? 'TON',
                'quantity_in_tons' => $tons,
                'unit_price' => $price,
                'line_amount' => $amount,
                'specifications' => $member['specifications'] ?? null,
                'sort_order' => $order,
            ];
            $summary[] = ($diameter ?: $member['item_description']) . ': ' . $this->formatNumber($tons) . ' طن';
        }

        $totalTons = round($totalTons, 4);
        $totalAmount = round($totalAmount, 2);
        // Weighted unit price: preserves the summed amount (never a plain average of prices).
        $unitPrice = $totalTons > 0 ? round($totalAmount / $totalTons, 4) : 0.0;
        $first = $members[0];

        return [
            'type' => 'steel',
            'item' => [
                'item_id' => null,
                'supplier_id' => $first['supplier_id'] ?? null,
                'item_description' => self::CONSOLIDATED_NAME,
                'item_reference' => $first['item_reference'],
                'region' => $first['region'],
                'quantity' => $totalTons,
                'uom' => 'TON',
                'unit_price' => $unitPrice,
                'line_total' => $totalAmount,
                'specifications' => 'حديد مجمع (' . count($members) . ' بنود): ' . implode(' + ', $summary),
            ],
            'components' => $components,
        ];
    }

    /**
     * Copy the reference-only diameter details of a consolidated request line to its PO line.
     */
    public function copyComponentsToPoItem(?PurchaseRequestItem $prItem, PurchaseOrderItem $poItem): void
    {
        if (! $prItem || ! $prItem->is_consolidated_steel) {
            return;
        }

        foreach ($prItem->steelComponents()->get() as $component) {
            $poItem->steelComponents()->create(
                collect($component->getAttributes())
                    ->only(['item_id', 'item_description', 'size_or_diameter', 'quantity', 'uom', 'quantity_in_tons', 'unit_price', 'line_amount', 'specifications', 'sort_order'])
                    ->all()
            );
        }
    }

    private function formatNumber(float $value): string
    {
        return rtrim(rtrim(number_format($value, 4, '.', ''), '0'), '.');
    }
}
