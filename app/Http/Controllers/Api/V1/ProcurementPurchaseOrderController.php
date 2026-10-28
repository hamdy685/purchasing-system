<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\Procurement\AddPurchaseOrderItemRequest;
use App\Http\Requests\Procurement\CreatePurchaseOrderRequest;
use App\Http\Requests\Procurement\UpdatePurchaseOrderHeaderRequest;
use App\Http\Requests\Procurement\UpdatePurchaseOrderItemRequest;
use App\Http\Requests\Procurement\StoreDirectPurchaseOrderRequest;
use App\Http\Requests\Procurement\UpdateDeliveryStatusRequest;
use App\Http\Resources\PurchaseOrderResource;
use App\Http\Resources\PurchaseRequestResource;
use App\Http\Resources\SupplierResource;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Services\ProcurementPurchaseRequestService;
use App\Services\PurchaseOrderService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Support\Facades\DB;

class ProcurementPurchaseOrderController extends Controller
{
    public function __construct(
        protected PurchaseOrderService $poService,
        protected ProcurementPurchaseRequestService $procurementPrService,
    ) {}

    // ─────────────────────────────────────────────
    // PURCHASE REQUEST — PROCUREMENT APPROVAL QUEUE
    // ─────────────────────────────────────────────

    /**
     * List PRs pending procurement manager approval (PENDING_PROCUREMENT_APPROVAL).
     */
    public function indexApprovedPrs(Request $request): AnonymousResourceCollection
    {
        $perPage = min((int) $request->query('per_page', 15), 100);
        $prs = $this->procurementPrService->getPendingProcurementApprovalRequests($perPage);
        return PurchaseRequestResource::collection($prs);
    }

    /**
     * List PRs awaiting Executive Director / General Manager decisions.
     */
    public function indexExecutivePendingPrs(Request $request): AnonymousResourceCollection
    {
        $perPage = min((int) $request->query('per_page', 50), 100);
        $prs = $this->procurementPrService->getExecutivePendingRequests($perPage);
        return PurchaseRequestResource::collection($prs);
    }

    /**
     * List PRs waiting for three supplier quotes.
     */
    public function indexPendingQuoteRequests(Request $request): AnonymousResourceCollection
    {
        $perPage = min((int) $request->query('per_page', 15), 100);
        return PurchaseRequestResource::collection($this->procurementPrService->getPendingQuoteRequests($perPage, $request->user()));
    }

    /**
     * List PRs already approved by procurement (APPROVED_BY_PROCUREMENT) — ready for PO creation.
     */
    public function indexProcurementApprovedPrs(Request $request): AnonymousResourceCollection
    {
        $perPage = min((int) $request->query('per_page', 15), 100);
        $prs = $this->procurementPrService->getApprovedByProcurementRequests($perPage);
        return PurchaseRequestResource::collection($prs);
    }

    /**
     * View a purchase request (pending or approved by procurement).
     */
    public function showApprovedPr(Request $request, string|int $id): JsonResponse|PurchaseRequestResource
    {
        $pr = PurchaseRequest::with([
            'requester',
            'department',
            'assignedReviewer',
            'siteEngineer',
            'directSupplier',
            'items.item',
            'approvalHistory.actor',
            'quotes.supplier',
            'quotes.recommendations.user',
            'selectedQuote.supplier',
            'supplements.items.item',
            'supplements.requester',
            'supplements.reviewer',
            'purchaseOrders.supplier',
        ])
            ->findOrFail((int) $id);

        $hasPendingSupplement = $pr->supplements()->whereIn('status', ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED'])->exists();

        if (! $hasPendingSupplement && ! in_array($pr->status, ['PENDING_PROCUREMENT_APPROVAL', 'PENDING_EXECUTIVE_APPROVAL', 'PENDING_QUOTE_RECOMMENDATIONS', 'PENDING_EXECUTIVE_QUOTE_DECISION', 'APPROVED_BY_PROCUREMENT', 'APPROVED_BY_ACCOUNTING'])) {
            return response()->json(['message' => 'Purchase request is not in a procurement queue status.'], 409);
        }

        return new PurchaseRequestResource($pr);
    }

    /**
     * Procurement Manager chooses the next route: three quotes or direct accounting approval.
     */
    public function approvePurchaseRequest(Request $request, string|int $id): JsonResponse
    {
        $financialData = $request->input('financial_data');
        if (is_array($financialData)) {
            if (empty($financialData['supplier_id']) && !empty($financialData['one_time_supplier_name'])) {
                $sup = \App\Models\Supplier::firstOrCreate(
                    ['company_name' => trim($financialData['one_time_supplier_name'])],
                    ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
                );
                $financialData['supplier_id'] = $sup->id;
            }
            $globalSupplierId = $financialData['supplier_id'] ?? null;
            $items = $financialData['items'] ?? null;
            if (is_array($items)) {
                $firstItemSupplier = null;
                foreach ($items as $idx => $item) {
                    if (empty($item['supplier_id']) && !empty($item['one_time_supplier_name'])) {
                        $sup = \App\Models\Supplier::firstOrCreate(
                            ['company_name' => trim($item['one_time_supplier_name'])],
                            ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
                        );
                        $items[$idx]['supplier_id'] = $sup->id;
                    }
                    if (!empty($items[$idx]['supplier_id'])) {
                        $firstItemSupplier ??= $items[$idx]['supplier_id'];
                    } elseif ($globalSupplierId) {
                        $items[$idx]['supplier_id'] = $globalSupplierId;
                        $firstItemSupplier ??= $globalSupplierId;
                    }
                }
                if (!$globalSupplierId && $firstItemSupplier) {
                    $financialData['supplier_id'] = $firstItemSupplier;
                }
                $financialData['items'] = $items;
                $request->merge(['financial_data' => $financialData]);
            }
        }

        $validated = $request->validate([
            'use_quotes' => ['nullable', 'boolean'],
            'comment' => ['nullable', 'string', 'max:2000'],
            'financial_data' => ['nullable', 'array'],
            'financial_data.supplier_id' => ['nullable', 'integer', 'exists:suppliers,id'],
            'financial_data.items' => ['required_if:use_quotes,false', 'array', 'min:1'],
            'financial_data.items.*' => ['array'],
            'financial_data.items.*.pr_item_id' => ['required_if:use_quotes,false', 'integer', 'exists:purchase_request_items,id'],
            'financial_data.items.*.supplier_id' => ['required_if:use_quotes,false', 'integer', 'exists:suppliers,id'],
            'financial_data.items.*.quantity' => ['required_if:use_quotes,false', 'numeric', 'gt:0'],
            'financial_data.items.*.unit_price' => ['required_if:use_quotes,false', 'numeric', 'gte:0'],
            'financial_data.items.*.uom' => ['nullable', 'string', 'max:20'],
            'financial_data.notes' => ['nullable', 'string', 'max:5000'],
        ]);
        $pr = PurchaseRequest::with(['requester', 'department', 'items'])->findOrFail((int) $id);
        $useQuotes = array_key_exists('use_quotes', $validated) ? (bool) $validated['use_quotes'] : true;

        try {
            $approved = $useQuotes
                ? $this->procurementPrService->approvePurchaseRequest(
                    $request->user(),
                    $pr,
                    $validated['comment'] ?? null,
                )
                : $this->procurementPrService->sendToAccountingWithoutQuotes(
                    $request->user(),
                    $pr,
                    $validated['financial_data'] ?? [],
                    $validated['comment'] ?? null,
                );
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        $message = $useQuotes
            ? 'تم اعتماد الطلب وبدء مسار عروض الأسعار الثلاثة.'
            : ($approved->status === 'PENDING_EXECUTIVE_APPROVAL'
                ? 'تم إرسال الطلب بنجاح إلى المدير التنفيذي للاعتماد.'
                : 'تم إرسال الطلب إلى الإدارة المالية للموافقة.');

        return response()->json([
            'message' => $message,
            'data' => new PurchaseRequestResource($approved),
        ], 200);
    }

    /**
     * Reject a PR at procurement level (PENDING_PROCUREMENT_APPROVAL → REJECTED).
     */
    public function rejectPurchaseRequest(Request $request, string|int $id): JsonResponse
    {
        $validated = $request->validate([
            'comment' => ['required', 'string', 'min:3', 'max:1000'],
        ]);

        $pr = PurchaseRequest::with(['requester', 'department', 'items'])->findOrFail((int) $id);

        try {
            $rejected = $this->procurementPrService->rejectPurchaseRequest(
                $request->user(),
                $pr,
                $validated['comment']
            );
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return response()->json([
            'message' => 'تم رفض طلب الشراء من قِبَل مدير المشتريات.',
            'data' => new PurchaseRequestResource($rejected),
        ], 200);
    }

    /**
     * Revert PR route from PENDING_QUOTE_RECOMMENDATIONS back to PENDING_PROCUREMENT_APPROVAL
     * (e.g. if quotes was clicked by mistake and procurement manager wants to choose direct route / pricing).
     */
    public function resetRoute(Request $request, string|int $id): JsonResponse
    {
        $pr = PurchaseRequest::with(['requester', 'department', 'items'])->findOrFail((int) $id);

        try {
            $updated = $this->procurementPrService->resetRoute(
                $request->user(),
                $pr,
                $request->input('comment')
            );
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return response()->json([
            'message' => 'تم التراجع عن مسار عروض الأسعار وإعادة الطلب إلى قسم اختيار المسار وتحديد الأسعار بنجاح.',
            'data' => new PurchaseRequestResource($updated),
        ], 200);
    }

    // ─────────────────────────────────────────────
    // SUPPLIERS
    // ─────────────────────────────────────────────

    /**
     * List active suppliers for procurement selection.
     */
    public function indexSuppliers(Request $request): AnonymousResourceCollection
    {
        $suppliers = $this->poService->getActiveSuppliers();
        return SupplierResource::collection($suppliers);
    }

    // ─────────────────────────────────────────────
    // PURCHASE ORDERS
    // ─────────────────────────────────────────────

    /**
     * List all purchase orders.
     */
    public function indexPos(Request $request): AnonymousResourceCollection
    {
        $perPage = min(max((int) $request->query('per_page', 15), 1), 100);
        $search = trim((string) $request->query('search', ''));
        $status = trim((string) $request->query('status', ''));
        $supplierId = (int) $request->query('supplier_id', 0);
        $departmentId = (int) $request->query('department_id', 0);
        $dateFrom = $request->query('date_from');
        $dateTo = $request->query('date_to');

        $posQuery = PurchaseOrder::with([
                'purchaseRequest.requester',
                'purchaseRequest.department',
                'purchaseRequest.assignedReviewer',
                'purchaseRequest.approvalHistory.actor',
                'purchaseRequest.supplements',
                'supplier',
                'createdBy',
                'items.item',
                'items.supplier',
                'receipts.warehouseKeeper',
                'receipts.siteEngineer',
            ])
            ->when($status !== '', fn ($query) => $query->where('status', $status))
            ->when($supplierId > 0, fn ($query) => $query->where('supplier_id', $supplierId))
            ->when($departmentId > 0, fn ($query) => $query->whereHas('purchaseRequest', fn ($requestQuery) => $requestQuery->where('department_id', $departmentId)))
            ->when($dateFrom, fn ($query) => $query->whereDate('updated_at', '>=', $dateFrom))
            ->when($dateTo, fn ($query) => $query->whereDate('updated_at', '<=', $dateTo))
            ->when($search !== '', function ($query) use ($search): void {
                $term = '%' . mb_substr($search, 0, 100) . '%';
                $query->where(function ($searchQuery) use ($term): void {
                    $searchQuery
                        ->where('po_number', 'like', $term)
                        ->orWhereHas('supplier', fn ($supplierQuery) => $supplierQuery->where('company_name', 'like', $term))
                        ->orWhereHas('purchaseRequest', function ($requestQuery) use ($term): void {
                            $requestQuery
                                ->where('request_number', 'like', $term)
                                ->orWhereHas('requester', fn ($userQuery) => $userQuery->where('name', 'like', $term))
                                ->orWhereHas('department', fn ($departmentQuery) => $departmentQuery->where('name', 'like', $term));
                        });
                });
            })
            ->orderBy('updated_at', 'desc');

        return PurchaseOrderResource::collection($posQuery->paginate($perPage)->withQueryString());
    }

    /**
     * View purchase order details.
     */
    public function showPo(Request $request, string|int $id): PurchaseOrderResource
    {
        $po = PurchaseOrder::with([
            'purchaseRequest.requester',
            'purchaseRequest.department',
            'purchaseRequest.assignedReviewer',
            'purchaseRequest.approvalHistory.actor',
            'purchaseRequest.supplements.items.item',
            'purchaseRequest.supplements.requester',
            'purchaseRequest.supplements.reviewer',
            'supplier',
            'createdBy',
            'items.item',
            'items.supplier',
            'items.shipmentGroup',
            'items.weighingGroupItem.weighingGroup',
            'shipmentGroups.items',
            'weighingGroups.items.purchaseOrderItem',
            'receipts.items.purchaseOrderItem.supplier',
            'receipts.warehouseKeeper',
            'receipts.siteEngineer',
            'receipts.receiver',
        ])->findOrFail((int) $id);
        return new PurchaseOrderResource($po);
    }

    /**
     * Get combined Purchase Request + Actual Purchase Order + Site Receipt (GRN) document.
     */
    public function combinedDocument(Request $request, string|int $id): JsonResponse
    {
        $po = PurchaseOrder::with([
            'purchaseRequest.requester',
            'purchaseRequest.department',
            'purchaseRequest.assignedReviewer',
            'purchaseRequest.approvalHistory.actor',
            'purchaseRequest.items.item',
            'supplier',
            'createdBy',
            'finalizedBy',
            'items.item',
            'items.supplier',
            'receipts.items.purchaseOrderItem',
            'receipts.warehouseKeeper',
            'receipts.siteEngineer',
            'receipts.receiver',
            'receipts.actualReceiver',
        ])->findOrFail((int) $id);

        // عزل الحزمة المستندية للحسابات: حصر بنود طلب الشراء على البنود المرتبطة بأمر الشراء هذا فقط
        if ($po->purchaseRequest && $po->relationLoaded('items')) {
            $poPrItemIds = $po->items->pluck('pr_item_id')->filter()->all();
            if (!empty($poPrItemIds)) {
                $isolatedPrItems = $po->purchaseRequest->items->filter(function ($prItem) use ($poPrItemIds) {
                    return in_array($prItem->id, $poPrItemIds);
                })->values();
                $po->purchaseRequest->setRelation('items', $isolatedPrItems);
            }
        }

        $poResource = new PurchaseOrderResource($po);
        $prResource = new PurchaseRequestResource($po->purchaseRequest);
        $receipts = $poResource['receipts'] ?? [];
        $latestReceipt = !empty($receipts) ? $receipts[0] : null;

        return response()->json([
            'data' => [
                'purchase_order' => $poResource,
                'purchase_request' => $prResource,
                'receipt' => $latestReceipt,
                'receipts' => $receipts,
            ],
        ]);
    }


    /**
     * Create a new draft Purchase Order from a procurement-approved Purchase Request.
     */
    public function storePo(CreatePurchaseOrderRequest $request): JsonResponse
    {
        if ($request->filled('groups') && is_array($request->validated('groups')) && count($request->validated('groups')) > 0) {
            return $this->storeBatchPo($request);
        }

        $prId = (int) $request->validated('purchase_request_id');
        $supplierId = (int) $request->validated('supplier_id');

        if (!$supplierId && $request->filled('one_time_supplier_name')) {
            $supplier = \App\Models\Supplier::firstOrCreate(
                ['company_name' => trim($request->input('one_time_supplier_name'))],
                ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
            );
            $supplierId = $supplier->id;
        }

        try {
            $po = $this->poService->createPoFromPr(
                $request->user(),
                $prId,
                $supplierId,
                $request->validated()
            );

            // إصدار أمر الشراء وإرساله للحسابات فور اكتمال بياناته التجارية.
            $po = $this->poService->submitToAccounting($request->user(), $po);
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return (new PurchaseOrderResource($po))
            ->response()
            ->setStatusCode(201);
    }

    /**
     * Create batch Purchase Orders from groups of items (individual items or bundled shipments like steel).
     */
    public function storeBatchPo(CreatePurchaseOrderRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $prId = (int) $validated['purchase_request_id'];
        $groups = $validated['groups'] ?? [];

        if (empty($groups)) {
            return response()->json(['message' => 'لم يتم تحديد أي مجموعات بنود لإنشاء أوامر الشراء.'], 422);
        }

        $createdPos = [];

        try {
            DB::transaction(function () use ($request, $prId, $groups, &$createdPos) {
                foreach ($groups as $group) {
                    $groupSupplierId = !empty($group['supplier_id']) ? (int) $group['supplier_id'] : (int) ($request->validated('supplier_id') ?? 0);

                    if (!$groupSupplierId && !empty($group['one_time_supplier_name'])) {
                        $sup = \App\Models\Supplier::firstOrCreate(
                            ['company_name' => trim($group['one_time_supplier_name'])],
                            ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
                        );
                        $groupSupplierId = $sup->id;
                    } elseif (!$groupSupplierId && $request->filled('one_time_supplier_name')) {
                        $sup = \App\Models\Supplier::firstOrCreate(
                            ['company_name' => trim($request->input('one_time_supplier_name'))],
                            ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
                        );
                        $groupSupplierId = $sup->id;
                    }

                    if (!$groupSupplierId) {
                        throw new \RuntimeException('يجب تحديد مورد لكل حزمة/بند أو اختيار مورد عام للطلب.');
                    }

                    $payload = array_merge($request->validated(), $group);
                    $payload['supplier_id'] = $groupSupplierId;
                    $payload['items'] = $group['items'];

                    $po = $this->poService->createPoFromPr(
                        $request->user(),
                        $prId,
                        $groupSupplierId,
                        $payload
                    );

                    $po->load('items');
                    $createdItemIds = $po->items->pluck('id')->all();

                    $groupType = $group['group_type'] ?? null;

                    if ($groupType === 'STEEL_WEIGHING' && count($createdItemIds) > 0) {
                        // Procurement's "تجميع وزنة حديد": the diameters become ONE PO line "حديد"
                        // (diameters kept as reference details) before the PO is issued for receiving.
                        $steelLine = app(\App\Services\SteelConsolidationService::class)->consolidatePoItems(
                            $request->user(),
                            $po,
                            $createdItemIds
                        );
                        app(\App\Services\SteelWeighingGroupService::class)->createWeighingGroup(
                            $request->user(),
                            $po->id,
                            [$steelLine->id],
                            $group['notes'] ?? null
                        );
                    } elseif ($groupType === 'SHARED_SHIPMENT' && count($createdItemIds) > 0) {
                        app(\App\Services\SharedShipmentGroupService::class)->createShipmentGroup(
                            $request->user(),
                            $po->id,
                            $createdItemIds,
                            $group['group_name'] ?? null,
                            $group['notes'] ?? null
                        );
                    }

                    $po = $this->poService->submitToAccounting($request->user(), $po);
                    $po->load(['items.shipmentGroup', 'items.weighingGroupItem.weighingGroup', 'shipmentGroups.items', 'weighingGroups.items']);
                    $createdPos[] = $po;
                }
            });
        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'message' => $e->validator->errors()->first() ?: 'خطأ في التحقق من صحة بيانات التجميع.',
                'errors'  => $e->errors(),
            ], 422);
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return response()->json([
            'message' => 'تم إنشاء وإصدار ' . count($createdPos) . ' أمر شراء بنجاح وفق التوزيع المحدد وإرسالها للحسابات.',
            'data' => PurchaseOrderResource::collection(collect($createdPos)),
        ], 201);
    }


    /**
     * Update draft Purchase Order header details.
     */
    public function updateHeader(UpdatePurchaseOrderHeaderRequest $request, string|int $id): JsonResponse|PurchaseOrderResource
    {
        $po = PurchaseOrder::where('id', (int) $id)->firstOrFail();

        if ($po->finalized_at !== null) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء بعد اعتماده كأمر شراء فعلي نهائي.'], 409);
        }

        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء في هذه الحالة.'], 409);
        }

        try {
            $updatedPo = $this->poService->updateHeader($request->user(), $po, $request->validated());
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return new PurchaseOrderResource($updatedPo);
    }

    /**
     * Update commercial details for a PO line item.
     */
    public function updateItem(UpdatePurchaseOrderItemRequest $request, string|int $id, string|int $itemId): JsonResponse|PurchaseOrderResource
    {
        $po = PurchaseOrder::findOrFail((int) $id);
        $item = PurchaseOrderItem::findOrFail((int) $itemId);

        if ($po->finalized_at !== null) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء بعد اعتماده كأمر شراء فعلي نهائي.'], 409);
        }

        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء في هذه الحالة.'], 409);
        }

        if ($item->purchase_order_id !== $po->id) {
            return response()->json(['message' => 'Item does not belong to this purchase order.'], 422);
        }

        $updatedPo = $this->poService->updateItem($request->user(), $po, $item, $request->validated());
        return new PurchaseOrderResource($updatedPo);
    }

    /**
     * Add a new line item to a draft PO.
     */
    public function addItem(AddPurchaseOrderItemRequest $request, string|int $id): JsonResponse|PurchaseOrderResource
    {
        $po = PurchaseOrder::findOrFail((int) $id);

        if ($po->finalized_at !== null) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء بعد اعتماده كأمر شراء فعلي نهائي.'], 409);
        }

        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء في هذه الحالة.'], 409);
        }

        $updatedPo = $this->poService->addItem($request->user(), $po, $request->validated());
        return new PurchaseOrderResource($updatedPo);
    }

    /**
     * Remove a line item from a draft PO.
     */
    public function deleteItem(Request $request, string|int $id, string|int $itemId): JsonResponse|PurchaseOrderResource
    {
        $po = PurchaseOrder::findOrFail((int) $id);
        $item = PurchaseOrderItem::findOrFail((int) $itemId);

        if ($po->finalized_at !== null) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء بعد اعتماده كأمر شراء فعلي نهائي.'], 409);
        }

        if (! in_array($po->status, ['PO_DRAFT', 'RETURNED_TO_PROCUREMENT', 'PENDING_ACTUAL_PO', 'ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING'], true)) {
            return response()->json(['message' => 'لا يمكن تعديل أمر الشراء في هذه الحالة.'], 409);
        }

        if ($item->purchase_order_id !== $po->id) {
            return response()->json(['message' => 'Item does not belong to this purchase order.'], 422);
        }

        $updatedPo = $this->poService->deleteItem($request->user(), $po, $item);
        return new PurchaseOrderResource($updatedPo);
    }

    /**
     * Submit draft Purchase Order to Accounting for financial audit.
     */
    public function submitPoToAccounting(Request $request, string|int $id): JsonResponse
    {
        $po = PurchaseOrder::with(['purchaseRequest.requester', 'purchaseRequest.department', 'items', 'supplier', 'createdBy'])->findOrFail((int) $id);

        if (in_array($po->status, ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'], true)) {
            return response()->json([
                'message' => 'تم تقديم أمر الشراء للحسابات بنجاح.',
                'data' => new PurchaseOrderResource($po),
            ], 200);
        }

        if ($po->status !== 'PO_DRAFT' && $po->status !== 'RETURNED_TO_PROCUREMENT') {
            return response()->json(['message' => 'Only draft or returned purchase orders can be submitted.'], 409);
        }

        $submittedPo = $this->poService->submitToAccounting($request->user(), $po);

        return response()->json([
            'message' => 'Purchase order submitted to accounting successfully.',
            'data' => new PurchaseOrderResource($submittedPo),
        ], 200);
    }

    /**
     * Create a direct purchase request. It must be approved by accounting and
     * the executive manager before procurement can create its purchase order.
     */
    public function storeDirectPo(StoreDirectPurchaseOrderRequest $request): JsonResponse
    {
        $validated = $request->validated();

        $engineerIsAssigned = \App\Models\User::query()
            ->whereKey($validated['site_engineer_user_id'])
            ->where('is_active', true)
            ->exists();

        if (! $engineerIsAssigned) {
            return response()->json(['message' => 'يجب اختيار مستلم نشط من مستخدمي النظام.'], 422);
        }

        if (empty($validated['supplier_id']) && !empty($validated['one_time_supplier_name'])) {
            $supplier = \App\Models\Supplier::firstOrCreate(
                ['company_name' => trim($validated['one_time_supplier_name'])],
                ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
            );
            $validated['supplier_id'] = $supplier->id;
        }

        if (!empty($validated['items']) && is_array($validated['items'])) {
            foreach ($validated['items'] as $idx => $item) {
                if (empty($item['supplier_id']) && !empty($item['one_time_supplier_name'])) {
                    $sup = \App\Models\Supplier::firstOrCreate(
                        ['company_name' => trim($item['one_time_supplier_name'])],
                        ['contact_name' => 'مورد لعملية واحدة', 'is_active' => true, 'opening_balance' => 0]
                    );
                    $validated['items'][$idx]['supplier_id'] = $sup->id;
                } elseif (empty($item['supplier_id']) && !empty($validated['supplier_id'])) {
                    $validated['items'][$idx]['supplier_id'] = $validated['supplier_id'];
                }
            }
        }

        try {
            $pr = $this->procurementPrService->createDirectPurchaseRequest(
                $request->user(),
                $validated,
            );
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return response()->json([
            'message' => 'تم إنشاء طلب الشراء المباشر وإرساله إلى المدير التنفيذي للاعتماد.',
            'data' => new PurchaseRequestResource($pr),
        ], 201);
    }

    /**
     * Update delivery tracking details for a PO.
     */
    public function updateDeliveryStatus(UpdateDeliveryStatusRequest $request, string|int $id): JsonResponse
    {
        $validated = $request->validated();

        $po = PurchaseOrder::findOrFail((int) $id);
        $oldStatus = $po->delivery_status;

        $po->update([
            'delivery_status' => $validated['delivery_status'],
            'actual_delivery_date' => array_key_exists('actual_delivery_date', $validated) ? $validated['actual_delivery_date'] : $po->actual_delivery_date,
            'delivery_notes' => array_key_exists('delivery_notes', $validated) ? $validated['delivery_notes'] : $po->delivery_notes,
        ]);

        \App\Models\AuditLog::create([
            'user_id' => $request->user()->id,
            'entity_type' => PurchaseOrder::class,
            'entity_id' => $po->id,
            'action' => 'DELIVERY_STATUS_UPDATED',
            'field_name' => 'delivery_status',
            'old_value' => $oldStatus,
            'new_value' => $validated['delivery_status'],
        ]);

        return response()->json([
            'message' => 'Delivery status updated successfully.',
            'data' => new PurchaseOrderResource($po->fresh(['purchaseRequest.requester', 'purchaseRequest.department', 'supplier', 'createdBy', 'items.prItem'])),
        ]);
    }
    /**
     * List Purchase Orders pending the Actual PO issuance after GRN approval.
     * These are POs in PENDING_ACTUAL_PO status waiting for procurement to finalise.
     */
    public function indexPendingActualPos(Request $request): AnonymousResourceCollection
    {
        $perPage = min(max((int) $request->query('per_page', 15), 1), 100);
        $search  = trim((string) $request->query('search', ''));

        $query = PurchaseOrder::with([
            'purchaseRequest.requester',
            'purchaseRequest.department',
            'purchaseRequest.assignedReviewer',
            'supplier',
            'createdBy',
            'items.item',
            'receipts.items.purchaseOrderItem',
            'receipts.warehouseKeeper',
            'receipts.siteEngineer',
            'receipts.receiver',
        ])
        ->where('status', 'PENDING_ACTUAL_PO')
        ->when($search !== '', function ($q) use ($search) {
            $term = '%' . mb_substr($search, 0, 100) . '%';
            $q->where(function ($sq) use ($term) {
                $sq->where('po_number', 'like', $term)
                   ->orWhereHas('supplier', fn ($s) => $s->where('company_name', 'like', $term))
                   ->orWhereHas('purchaseRequest', function ($prQ) use ($term) {
                       $prQ->where('request_number', 'like', $term)
                           ->orWhereHas('requester', fn ($u) => $u->where('name', 'like', $term))
                           ->orWhereHas('department', fn ($d) => $d->where('name', 'like', $term));
                   });
            });
        })
        ->orderBy('updated_at', 'desc');

        return PurchaseOrderResource::collection($query->paginate($perPage)->withQueryString());
    }

    /**
     * Finalise the Actual Purchase Order after GRN approval.
     * Procurement provides the definitive item list (full sync: update/delete/add).
     * After finalisation the PO moves to ISSUED and accounting is notified.
     */
    public function finalizeActualPo(Request $request, string|int $id): JsonResponse
    {
        $validated = $request->validate([
            'supplier_id'              => ['nullable', 'integer', 'exists:suppliers,id'],
            'parcel_reference'         => ['nullable', 'string', 'max:100'],
            'region'                   => ['nullable', 'string', 'max:150'],
            'items'                    => ['required', 'array', 'min:1'],
            'items.*.id'               => ['nullable', 'integer'],
            'items.*.item_id'          => ['nullable', 'integer', 'exists:items,id'],
            'items.*.pr_item_id'       => ['nullable', 'integer', 'exists:purchase_request_items,id'],
            'items.*.item_description' => ['required', 'string', 'max:500'],
            'items.*.item_reference'   => ['nullable', 'string', 'max:100'],
            'items.*.region'           => ['nullable', 'string', 'max:150'],
            'items.*.quantity'         => ['required', 'numeric', 'gte:0'],
            'items.*.uom'              => ['nullable', 'string', 'max:20'],
            'items.*.unit_price'       => ['required', 'numeric', 'gte:0'],
            'items.*.is_discount_applied' => ['nullable', 'boolean'],
            'items.*.specifications'   => ['nullable', 'string'],
            'items.*.supplier_id'      => ['nullable', 'integer', 'exists:suppliers,id'],
            'discount_type'            => ['nullable', 'string', 'in:NONE,TOTAL,SELECTED_ITEMS'],
            'discount_percentage'      => ['nullable', 'numeric', 'gte:0', 'lte:100'],
            'discount_item_ids'        => ['nullable', 'array'],
            'discount_item_ids.*'      => ['integer'],
            'notes'                    => ['nullable', 'string', 'max:3000'],
            'invoice_file'             => ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png,webp', 'max:20480'],
            'invoice_photo'            => ['nullable', 'string'],
            'invoice_photo_name'       => ['nullable', 'string', 'max:255'],
        ]);

        $po = PurchaseOrder::with([
            'purchaseRequest.requester',
            'purchaseRequest.department',
            'supplier',
            'createdBy',
            'items',
            'receipts',
        ])->findOrFail((int) $id);

        if ($po->status !== 'PENDING_ACTUAL_PO') {
            return response()->json([
                'message' => 'لا يمكن إصدار أمر الشراء الفعلي لأمر شراء ليس في مرحلة بانتظار الإصدار الفعلي.',
            ], 409);
        }

        // Validate that all discount_item_ids belong to this PO
        $poItemIds = $po->items->pluck('id')->all();
        if (!empty($validated['discount_item_ids'])) {
            foreach ($validated['discount_item_ids'] as $discountItemId) {
                if (!in_array((int) $discountItemId, $poItemIds, true)) {
                    return response()->json([
                        'message' => 'البند المحدد للخصم لا ينتمي لأمر الشراء الحالي.',
                        'errors' => [
                            'discount_item_ids' => ['البند المحدد للخصم لا ينتمي لأمر الشراء الحالي.']
                        ]
                    ], 422);
                }
            }
        }

        try {
            $finalizedPo = $this->poService->finalizeActualPo(
                $request->user(),
                $po,
                $validated['items'],
                $validated['notes'] ?? null,
                !empty($validated['supplier_id']) ? (int) $validated['supplier_id'] : null,
                !empty($validated['parcel_reference']) ? trim((string) $validated['parcel_reference']) : null,
                !empty($validated['region']) ? trim((string) $validated['region']) : null,
                $validated['discount_type'] ?? null,
                isset($validated['discount_percentage']) ? (float) $validated['discount_percentage'] : null,
                $validated['discount_item_ids'] ?? null
            );

            // Handle optional invoice attachment uploaded during actual PO finalization
            $uploadedData = null;
            $invoiceNumber = $request->input('invoice_number');
            if ($request->hasFile('invoice_file')) {
                $ext = $request->file('invoice_file')->getClientOriginalExtension() ?: 'pdf';
                $customName = \App\Services\DocumentNamingService::generateInvoiceName(
                    $finalizedPo,
                    $invoiceNumber,
                    $ext,
                    1
                );
                $uploadedData = \App\Services\StorageService::storeUploadedFile($request->file('invoice_file'), 'invoices', $customName);
            } elseif ($request->filled('invoice_photo')) {
                $customName = \App\Services\DocumentNamingService::generateInvoiceName(
                    $finalizedPo,
                    $invoiceNumber,
                    'pdf',
                    1
                );
                $uploadedData = \App\Services\StorageService::storeBase64File(
                    $request->input('invoice_photo'),
                    'invoices',
                    $customName
                );
            }

            if ($uploadedData && ! empty($uploadedData['path'])) {
                $finalizedPo->update([
                    'invoice_photo_path' => $uploadedData['path'],
                    'invoice_photo_name' => $uploadedData['name'] ?? 'invoice_' . time(),
                    'invoice_photo_size' => $uploadedData['size'] ?? null,
                    'invoice_photo_mime_type' => $uploadedData['mime_type'] ?? null,
                    'invoice_photo_drive_id' => $uploadedData['drive_id'] ?? null,
                    'invoice_photo_uploaded_at' => now(),
                    'invoice_photo_uploaded_by_user_id' => $request->user()->id,
                ]);

                $finalizedPo->attachments()->create([
                    'uploaded_by_user_id' => $request->user()->id,
                    'file_name' => $uploadedData['name'] ?? 'invoice_' . time(),
                    'file_path' => $uploadedData['path'],
                    'drive_id' => $uploadedData['drive_id'] ?? null,
                    'mime_type' => $uploadedData['mime_type'] ?? 'application/pdf',
                    'file_size' => $uploadedData['size'] ?? 0,
                ]);

                app(\App\Services\SystemEventService::class)->recordAction(
                    $finalizedPo,
                    'INVOICE_ATTACHED',
                    "تم إرفاق فاتورة أمر الشراء الفعلي ({$finalizedPo->po_number}) وتخزينها في Google Drive بمجلد الفواتير.",
                    ['user_id' => $request->user()->id, 'invoice_path' => $uploadedData['path'], 'drive_id' => $uploadedData['drive_id'] ?? null]
                );
            }
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return response()->json([
            'message' => 'تم إصدار أمر الشراء الفعلي بنجاح وإرساله للحسابات.',
            'data'    => new PurchaseOrderResource($finalizedPo->fresh()),
        ]);
    }

    public function uploadInvoice(Request $request, string|int $id): JsonResponse
    {
        $request->validate([
            'invoice_file' => ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png,webp', 'max:20480'],
            'invoice_photo' => ['nullable', 'string'],
            'invoice_photo_name' => ['nullable', 'string', 'max:255'],
        ]);

        $po = PurchaseOrder::with(['items.item', 'supplier', 'purchaseRequest.landParcel'])->findOrFail((int) $id);

        $uploadedData = null;
        $invoiceNumber = $request->input('invoice_number');
        try {
            if ($request->hasFile('invoice_file')) {
                $ext = $request->file('invoice_file')->getClientOriginalExtension() ?: 'pdf';
                $customName = \App\Services\DocumentNamingService::generateInvoiceName(
                    $po,
                    $invoiceNumber,
                    $ext,
                    1
                );
                $uploadedData = \App\Services\StorageService::storeUploadedFile($request->file('invoice_file'), 'invoices', $customName);
            } elseif ($request->filled('invoice_photo')) {
                $customName = \App\Services\DocumentNamingService::generateInvoiceName(
                    $po,
                    $invoiceNumber,
                    'pdf',
                    1
                );
                $uploadedData = \App\Services\StorageService::storeBase64File(
                    $request->input('invoice_photo'),
                    'invoices',
                    $customName
                );
            }
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        if (! $uploadedData || empty($uploadedData['path'])) {
            return response()->json(['message' => 'لم يتم استلام ملف الفاتورة بشكل صحيح.'], 422);
        }

        $po->update([
            'invoice_photo_path' => $uploadedData['path'],
            'invoice_photo_name' => $uploadedData['name'] ?? 'invoice_' . time(),
            'invoice_photo_size' => $uploadedData['size'] ?? null,
            'invoice_photo_mime_type' => $uploadedData['mime_type'] ?? null,
            'invoice_photo_drive_id' => $uploadedData['drive_id'] ?? null,
            'invoice_photo_uploaded_at' => now(),
            'invoice_photo_uploaded_by_user_id' => $request->user()->id,
        ]);

        $po->attachments()->create([
            'uploaded_by_user_id' => $request->user()->id,
            'file_name' => $uploadedData['name'] ?? 'invoice_' . time(),
            'file_path' => $uploadedData['path'],
            'drive_id' => $uploadedData['drive_id'] ?? null,
            'mime_type' => $uploadedData['mime_type'] ?? 'application/pdf',
            'file_size' => $uploadedData['size'] ?? 0,
        ]);

        app(\App\Services\SystemEventService::class)->recordAction(
            $po,
            'INVOICE_UPLOADED',
            "تم إرفاق فاتورة أمر الشراء الفعلي ({$po->po_number}) وتخزينها في Google Drive بمجلد الفواتير.",
            ['user_id' => $request->user()->id, 'invoice_path' => $uploadedData['path'], 'drive_id' => $uploadedData['drive_id'] ?? null]
        );

        return response()->json([
            'message' => 'تم إرفاق الفاتورة وحفظها في مجلد الفواتير بنجاح ✅',
            'data' => new PurchaseOrderResource($po->fresh()),
        ]);
    }

    public function viewInvoicePhoto(Request $request, string|int $id)
    {
        $user = $request->user() ?: auth('sanctum')->user();
        if (! $user && $request->filled('token')) {
            $tokenModel = \Laravel\Sanctum\PersonalAccessToken::findToken($request->query('token'));
            if ($tokenModel) {
                $user = $tokenModel->tokenable;
            }
        }

        if (! $user) {
            abort(401, 'انتهت جلسة الدخول. يرجى تسجيل الدخول أولاً.');
        }

        $po = PurchaseOrder::withoutGlobalScopes()->findOrFail((int) $id);

        $attachmentId = $request->query('attachment_id');
        $filePath = $po->invoice_photo_path;
        $fileName = $po->invoice_photo_name ?: "invoice_po_{$po->id}.pdf";
        $mimeType = $po->invoice_photo_mime_type ?: 'application/pdf';
        $driveId = $po->invoice_photo_drive_id;

        if ($attachmentId) {
            $att = $po->attachments()->find((int) $attachmentId);
            if ($att) {
                $filePath = $att->file_path;
                $fileName = $att->file_name;
                $mimeType = $att->mime_type;
                $driveId = $att->drive_id ?: \App\Services\GoogleDriveService::extractFileId($att->file_path);
            }
        }

        if (! $filePath) {
            abort(404, 'لم يتم إرفاق فاتورة لهذا الأمر.');
        }

        $download = $request->boolean('download');

        // 1. Google Drive direct stream check
        $driveId = $driveId ?: \App\Services\GoogleDriveService::extractFileId($filePath);
        if ($driveId && \App\Services\GoogleDriveService::isConfigured()) {
            try {
                return \App\Services\GoogleDriveService::streamFile(
                    $driveId,
                    $fileName,
                    $mimeType,
                    $download
                );
            } catch (\Throwable $e) {
                \Illuminate\Support\Facades\Log::warning("Drive stream failed for invoice {$po->id}: " . $e->getMessage());
                if (filter_var($filePath, FILTER_VALIDATE_URL)) {
                    return redirect()->away($filePath);
                }
            }
        }

        if (filter_var($filePath, FILTER_VALIDATE_URL)) {
            return redirect()->away($filePath);
        }

        try {
            return \App\Services\StorageService::streamResponse(
                $filePath,
                $fileName,
                $mimeType,
                $download
            );
        } catch (\Throwable) {
            abort(404, 'ملف الفاتورة مفقود من الخادم القديم (تم حذفه في عملية نشر سابقة قبل ربط التخزين الدائم). يرجى إعادة إرفاق الفاتورة.');
        }
    }

    public function pendingWarehouseTasks(Request $request)
    {
        return response()->json(app(\App\Services\PurchaseReceiptService::class)->warehouseQueue(
            $request->user(),
            min((int) $request->query('per_page', 15), 100)
        ));
    }

    /**
     * List all pending / in-progress purchase receipts for Procurement Manager
     * with detailed receiver information and item breakdown.
     */
    public function indexPendingReceipts(Request $request): JsonResponse
    {
        $q = trim((string) $request->query('q', ''));
        $supplierId = $request->filled('supplier_id') ? (int) $request->query('supplier_id') : null;
        $status = $request->query('status', 'PENDING');

        $recQuery = PurchaseReceipt::withoutGlobalScopes()
            ->with([
                'supplier',
                'purchaseOrder.items',
                'purchaseOrder.purchaseRequest.department',
                'purchaseOrder.purchaseRequest.landParcel',
                'purchaseOrder.purchaseRequest.requester',
                'purchaseRequest.department',
                'purchaseRequest.landParcel',
                'purchaseRequest.requester',
                'items.purchaseOrderItem',
                'items.item',
                'siteEngineer',
                'actualReceiver',
                'receiver',
                'warehouseKeeper',
                'weighingGroup.items',
                'supplierInvoices',
            ])
            ->when($q, function ($query, $term) {
                $query->where(function ($sub) use ($term) {
                    $sub->where('receipt_number', 'like', "%{$term}%")
                        ->orWhere('actual_receiver_name', 'like', "%{$term}%")
                        ->orWhereHas('supplier', fn ($s) => $s->where('company_name', 'like', "%{$term}%"))
                        ->orWhereHas('siteEngineer', fn ($se) => $se->where('name', 'like', "%{$term}%"))
                        ->orWhereHas('actualReceiver', fn ($ar) => $ar->where('name', 'like', "%{$term}%"))
                        ->orWhereHas('purchaseOrder', fn ($po) => $po->where('po_number', 'like', "%{$term}%"))
                        ->orWhereHas('items.purchaseOrderItem', fn ($poi) => $poi->where('item_description', 'like', "%{$term}%")
                            ->orWhere('item_reference', 'like', "%{$term}%"));
                });
            })
            ->when($supplierId, fn ($query) => $query->where('supplier_id', $supplierId))
            ->when($status && $status !== 'ALL', function ($query) use ($status) {
                if ($status === 'PENDING') {
                    $query->whereIn('status', ['PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED', 'PENDING']);
                } elseif ($status === 'APPROVED') {
                    $query->where('status', 'APPROVED');
                } else {
                    $query->where('status', $status);
                }
            })
            ->orderByDesc('id')
            ->get();

        $data = [];
        foreach ($recQuery as $rec) {
            $po = $rec->purchaseOrder;
            $pr = $rec->purchaseRequest ?: $po?->purchaseRequest;

            $itemsList = [];
            $calculatedAmount = 0;
            $totalQty = 0;

            foreach ($rec->items as $ri) {
                $poi = $ri->purchaseOrderItem;
                $desc = $poi?->item_description ?: ($ri->item?->name ?: "بند #{$ri->id}");
                $ordered = (float) $ri->ordered_quantity;
                $received = (float) $ri->received_quantity;
                $uom = $poi?->uom ?: 'PCS';
                $unitPrice = (float) ($poi?->unit_price ?: 0);
                $lineTotal = round($received * $unitPrice, 2);

                $calculatedAmount += $lineTotal;
                $totalQty += $received;

                $itemsList[] = [
                    'id' => $ri->id,
                    'item_description' => $desc,
                    'ordered_quantity' => $ordered,
                    'received_quantity' => $received,
                    'uom' => $uom,
                    'unit_price' => $unitPrice,
                    'line_total' => $lineTotal,
                    'item_reference' => $poi?->item_reference,
                    'region' => $poi?->region,
                ];
            }

            $finalAmount = $calculatedAmount > 0
                ? $calculatedAmount
                : (float) ($po?->grand_total ?? ($po?->total_amount ?? 0));

            if (count($itemsList) === 1) {
                $itemsSummary = $itemsList[0]['item_description'] . ' (' . (float) $itemsList[0]['received_quantity'] . ' ' . $itemsList[0]['uom'] . ')';
            } elseif (count($itemsList) > 1) {
                $itemsSummary = $itemsList[0]['item_description'] . ' (' . (float) $itemsList[0]['received_quantity'] . ' ' . $itemsList[0]['uom'] . ') + ' . (count($itemsList) - 1) . ' آخرين';
            } else {
                $itemsSummary = $po?->items->first()?->item_description ?: '—';
            }

            $parcelRef = $rec->items->first()?->purchaseOrderItem?->item_reference
                ?: ($po?->items->first()?->item_reference
                ?: ($pr?->landParcel?->parcel_reference
                ?: ($pr?->landParcel?->parcel_number
                ?: null)));

            $region = $rec->items->first()?->purchaseOrderItem?->region
                ?: ($po?->items->first()?->region
                ?: ($pr?->landParcel?->region
                ?: ($pr?->landParcel?->zone
                ?: null)));

            $projectSiteRaw = $pr?->project_site ?: ($po?->purchaseRequest?->project_site ?: null);

            $plotDisplay = '';
            if ($parcelRef) {
                $plotDisplay = 'قطعة ' . $parcelRef;
            }
            if ($region) {
                $plotDisplay .= ($plotDisplay ? ' - ' : '') . 'منطقة ' . $region;
            }
            if ($projectSiteRaw) {
                $plotDisplay = $projectSiteRaw . ($plotDisplay ? " ({$plotDisplay})" : '');
            }
            if (empty($plotDisplay)) {
                $plotDisplay = '—';
            }

            $invoiceStatus = 'PENDING_INVOICE';
            $invoiceStatusLabel = 'بانتظار الفاتورة والتسجيل المحاسبي';
            if ($rec->accountant_recorded_at) {
                $invoiceStatus = 'RECORDED';
                $invoiceStatusLabel = 'مسقط ومسجل بالحسابات';
            } elseif ($rec->supplierInvoices && $rec->supplierInvoices->isNotEmpty()) {
                $latestInv = $rec->supplierInvoices->first();
                if ($latestInv->status === 'VERIFIED') {
                    $invoiceStatus = 'VERIFIED';
                    $invoiceStatusLabel = 'مطابق ومسجل بالحسابات';
                } else {
                    $invoiceStatus = 'INVOICED';
                    $invoiceStatusLabel = 'له فاتورة جارية بالقسم المالي';
                }
            }

            $receiverName = $rec->actual_receiver_name
                ?: ($rec->actualReceiver?->name
                ?: ($rec->siteEngineer?->name
                ?: ($rec->receiver?->name ?? 'غير محدد')));

            $receiverRole = $rec->actualReceiver
                ? 'مستلم فعلي مسند'
                : ($rec->siteEngineer ? 'مهندس الموقع' : 'مستلم ميداني');

            $data[] = [
                'entity_type' => 'PURCHASE_RECEIPT',
                'id' => $rec->id,
                'code' => $rec->receipt_number,
                'title' => "إذن استلام مواد: " . ($rec->receipt_number ?: "REC-{$rec->id}"),
                'status' => $rec->status,
                'department' => $pr?->department?->name ?: ($rec->purchaseRequest?->department?->name ?? '—'),
                'supplier' => $rec->supplier?->company_name ?: ($po?->supplier?->company_name ?? '—'),
                'receiver' => $receiverName,
                'receiver_role' => $receiverRole,
                'receiver_user_id' => $rec->actual_receiver_user_id ?: ($rec->site_engineer_user_id ?: $rec->receiver_user_id),
                'amount' => $finalAmount,
                'date' => $rec->created_at?->format('Y-m-d H:i') ?: ($rec->received_at ?? '—'),
                'received_at' => $rec->received_at,
                'items_count' => count($itemsList),
                'weighing_group_id' => $rec->weighing_group_id,
                'project_site' => $plotDisplay,
                'parcel_reference' => $parcelRef,
                'region' => $region,
                'pending_with' => $rec->status === 'PENDING_SITE_ENGINEER' ? "المستلم: {$receiverName} ({$receiverRole})" : 'الإدارة المالية',
                'fulfillment_status' => $rec->status === 'APPROVED' ? 'مستلم ومطابق بالموقع' : 'بانتظار فحص المستلم بالموقع',
                'days_elapsed' => $rec->created_at ? (int) $rec->created_at->diffInDays(now()) : 0,
                'po_id' => $po?->id,
                'po_number' => $po?->po_number,
                'pr_id' => $pr?->id,
                'pr_number' => $pr?->request_number,
                'requester_name' => $pr?->requester?->name,
                'items_summary' => $itemsSummary,
                'total_quantity' => $totalQty,
                'has_photo' => (bool) ($rec->photo_path || $rec->photo_url),
                'photo_url' => $rec->photo_url ?: ($rec->photo_path ? "/api/v1/purchase-receipts/{$rec->id}/photo" : null),
                'invoice_status' => $invoiceStatus,
                'invoice_status_label' => $invoiceStatusLabel,
                'site_engineer_notes' => $rec->site_engineer_notes,
                'warehouse_notes' => $rec->warehouse_notes,
                'items_list' => $itemsList,
            ];
        }

        return response()->json([
            'success' => true,
            'count' => count($data),
            'data' => $data,
        ]);
    }
}
