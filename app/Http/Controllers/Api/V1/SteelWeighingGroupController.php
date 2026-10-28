<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\PurchaseOrder;
use App\Models\WeighingGroup;
use App\Services\SteelWeighingGroupService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SteelWeighingGroupController extends Controller
{
    public function __construct(
        protected SteelWeighingGroupService $weighingService
    ) {}

    /**
     * Get eligible steel items that can be grouped in a Purchase Order.
     */
    public function eligibleItems(Request $request, int $poId): JsonResponse
    {
        $po = PurchaseOrder::findOrFail($poId);
        $eligible = $this->weighingService->getEligibleSteelItems($po, $request->user());

        return response()->json([
            'purchase_order_id' => $po->id,
            'po_number'         => $po->po_number,
            'supplier_id'       => $po->supplier_id,
            'items'             => $eligible,
            'count'             => count($eligible),
        ]);
    }

    /**
     * Create a new steel weighing group.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'purchase_order_id' => 'required|integer|exists:purchase_orders,id',
            'item_ids'          => 'required|array|min:1',
            'item_ids.*'        => 'required|integer|exists:purchase_order_items,id',
            'notes'             => 'nullable|string|max:1000',
        ]);

        $group = $this->weighingService->createWeighingGroup(
            $request->user(),
            (int) $validated['purchase_order_id'],
            $validated['item_ids'],
            $validated['notes'] ?? null
        );

        return response()->json([
            'message' => 'تم تجميع وزنة الحديد بنجاح وجاهزة للاستلام بالموقع كوزنة واحدة.',
            'data'    => $group,
        ], 201);
    }

    /**
     * Show details of a specific weighing group.
     */
    public function show(int $id): JsonResponse
    {
        $group = WeighingGroup::with([
            'items.purchaseOrderItem',
            'supplier',
            'purchaseOrder.purchaseRequest',
            'createdBy',
            'receivedBy',
            'receipts.items',
        ])->findOrFail($id);

        return response()->json([
            'data' => $group,
        ]);
    }

    /**
     * List weighing groups for a Purchase Order.
     */
    public function byPurchaseOrder(int $poId): JsonResponse
    {
        $groups = WeighingGroup::with([
            'items.purchaseOrderItem',
            'supplier',
            'receipts',
            'createdBy',
        ])
            ->where('purchase_order_id', $poId)
            ->orderBy('id', 'desc')
            ->get();

        return response()->json([
            'data' => $groups,
        ]);
    }

    /**
     * Retired: site receiving for a weighing group (see method body).
     */
    public function receive(int $id): JsonResponse
    {
        // Retired shortcut: it approved the receipt without site-engineer inspection and recorded the
        // ordered weights instead of the entered quantity. Steel is received through the warehouse
        // receipt (POST /purchase-receipts/purchase-orders/{po}) like every other material.
        return response()->json([
            'message' => 'تم إيقاف هذا المسار. يتم استلام وزنة الحديد من خلال إذن الاستلام بالمخزن ثم فحص واعتماد مهندس الموقع.',
        ], 410);
    }

    /**
     * Cancel an unreceived weighing group.
     */
    public function cancel(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'reason' => 'nullable|string|max:500',
        ]);

        $group = $this->weighingService->cancelWeighingGroup(
            $request->user(),
            $id,
            $validated['reason'] ?? 'إلغاء من مدير المشتريات'
        );

        return response()->json([
            'message' => 'تم إلغاء مجموعة الوزنة بنجاح.',
            'data'    => $group,
        ]);
    }

    /**
     * Safely un-group a steel weighing group.
     */
    public function ungroup(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'reason' => 'nullable|string|max:500',
        ]);

        $group = $this->weighingService->ungroupWeighingGroup(
            $request->user(),
            $id,
            $validated['reason'] ?? 'فك دمج وزنة الحديد'
        );

        return response()->json([
            'message' => 'تم فك دمج وزنة الحديد بنجاح وإعادة البنود كبنود مستقلة.',
            'data'    => $group,
        ]);
    }
}
