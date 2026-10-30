<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\PurchaseOrderResource;
use App\Services\GeneralManagerPurchaseOrderService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

class GeneralManagerPurchaseOrderController extends Controller
{
    public function __construct(
        protected GeneralManagerPurchaseOrderService $gmService
    ) {}

    /**
     * Display Purchase Orders approved by accounting — read-only for General Manager.
     */
    public function index(Request $request): AnonymousResourceCollection|JsonResponse
    {
        if ($request->boolean('summary')) {
            return response()->json(['data' => $this->gmService->getGmPurchaseOrderSummaries($request->user())]);
        }

        $perPageParam = $request->query('per_page');
        $perPage = ($perPageParam === 'all' || $request->boolean('all'))
            ? 'all'
            : (int) ($perPageParam ?: 100);

        $pos = $this->gmService->getGmPurchaseOrders($perPage, $request->user());
        return PurchaseOrderResource::collection($pos);
    }

    /**
     * Display complete Purchase Order details for General Manager — read-only.
     */
    public function show(Request $request, string|int $id): JsonResponse|PurchaseOrderResource
    {
        $po = $this->gmService->getPoForGmView((int) $id, $request->user());
        return new PurchaseOrderResource($po);
    }

    /**
     * Prohibited: General Manager has read-only access.
     */
    public function approve(Request $request, string|int $id): JsonResponse
    {
        return response()->json([
            'message' => 'Prohibited action: General Manager has read-only access. Approval is not allowed.',
        ], 403);
    }

    /**
     * Prohibited: General Manager has read-only access.
     */
    public function reject(Request $request, string|int $id): JsonResponse
    {
        return response()->json([
            'message' => 'Prohibited action: General Manager has read-only access. Rejection is not allowed.',
        ], 403);
    }

    /**
     * Prohibited: General Manager has read-only access.
     */
    public function returnToProcurement(Request $request, string|int $id): JsonResponse
    {
        return response()->json([
            'message' => 'Prohibited action: General Manager has read-only access. Returning PO is not allowed.',
        ], 403);
    }
}
