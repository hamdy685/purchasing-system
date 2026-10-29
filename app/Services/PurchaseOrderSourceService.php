<?php

namespace App\Services;

use App\Models\PurchaseRequest;
use Illuminate\Support\Facades\DB;

/**
 * Single place that answers "is this purchase request line already ordered?" and
 * "is mandatory department consolidation on for this request?".
 *
 * A request line counts as ordered when an active PO covers it through any of:
 *  1. a PO line pointing at it directly (purchase_order_items.pr_item_id),
 *  2. a consolidated steel line's diameter component (steel_item_components),
 *  3. an active department-consolidation source (purchase_order_item_sources).
 */
class PurchaseOrderSourceService
{
    /** PO statuses whose lines no longer hold the request line. */
    public const INACTIVE_PO_STATUSES = ['REJECTED', 'CANCELLED', 'VOIDED'];

    /**
     * Constrain a purchase_request_items query to lines held by a PO whose status is not in $inactivePoStatuses.
     */
    public static function orderedScope($prItemQuery, array $inactivePoStatuses = self::INACTIVE_PO_STATUSES): void
    {
        $prItemQuery->where(function ($q) use ($inactivePoStatuses) {
            $q->whereExists(function ($sub) use ($inactivePoStatuses) {
                $sub->select(DB::raw(1))
                    ->from('purchase_order_items')
                    ->join('purchase_orders', 'purchase_orders.id', '=', 'purchase_order_items.purchase_order_id')
                    ->whereColumn('purchase_order_items.pr_item_id', 'purchase_request_items.id')
                    ->whereNull('purchase_orders.deleted_at')
                    ->whereNotIn('purchase_orders.status', $inactivePoStatuses);
            })
                ->orWhere(fn ($steel) => self::orderedThroughSteelComponent($steel, $inactivePoStatuses))
                ->orWhere(fn ($source) => self::orderedThroughActiveSource($source, $inactivePoStatuses));
        });
    }

    /**
     * Request lines merged into a consolidated "حديد" PO line.
     */
    public static function orderedThroughSteelComponent($prItemQuery, array $inactivePoStatuses = self::INACTIVE_PO_STATUSES): void
    {
        $prItemQuery->whereExists(function ($q) use ($inactivePoStatuses) {
            $q->select(DB::raw(1))
                ->from('steel_item_components')
                ->join('purchase_order_items', 'purchase_order_items.id', '=', 'steel_item_components.purchase_order_item_id')
                ->join('purchase_orders', 'purchase_orders.id', '=', 'purchase_order_items.purchase_order_id')
                ->whereColumn('steel_item_components.purchase_request_item_id', 'purchase_request_items.id')
                ->whereNotIn('purchase_orders.status', $inactivePoStatuses);
        });
    }

    /**
     * Request lines held by an active (not released) department-consolidation source.
     */
    public static function orderedThroughActiveSource($prItemQuery, array $inactivePoStatuses = self::INACTIVE_PO_STATUSES): void
    {
        $prItemQuery->whereExists(function ($q) use ($inactivePoStatuses) {
            $q->select(DB::raw(1))
                ->from('purchase_order_item_sources')
                ->join('purchase_order_items', 'purchase_order_items.id', '=', 'purchase_order_item_sources.purchase_order_item_id')
                ->join('purchase_orders', 'purchase_orders.id', '=', 'purchase_order_items.purchase_order_id')
                ->whereColumn('purchase_order_item_sources.purchase_request_item_id', 'purchase_request_items.id')
                ->where('purchase_order_item_sources.active_flag', 1)
                ->whereNull('purchase_orders.deleted_at')
                ->whereNotIn('purchase_orders.status', $inactivePoStatuses);
        });
    }

    /**
     * Department that owns the request for consolidation purposes: the handling
     * (target) department, falling back to the requester's department.
     */
    public static function owningDepartmentCode(PurchaseRequest $request): ?string
    {
        $request->loadMissing(['targetDepartment', 'department']);

        $code = $request->target_department_id
            ? $request->targetDepartment?->code
            : $request->department?->code;

        return $code !== null ? strtoupper(trim($code)) : null;
    }

    /**
     * Whether mandatory department consolidation applies. Matches departments.code only, never the display name.
     */
    public static function isMandatoryForRequest(PurchaseRequest $request): bool
    {
        if (! config('procurement.consolidated_po.enabled', false)) {
            return false;
        }

        $code = self::owningDepartmentCode($request);
        if ($code === null) {
            return false;
        }

        $codes = array_map(fn ($c) => strtoupper(trim((string) $c)), (array) config('procurement.consolidated_po.department_codes', []));

        return in_array($code, $codes, true);
    }
}
