<?php

namespace Tests\Feature;

use App\Models\Department;
use App\Models\LandParcel;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseReceiptItem;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\ShipmentGroup;
use App\Models\Supplier;
use App\Models\User;
use App\Models\WeighingGroup;
use App\Services\PurchaseReceiptService;
use App\Services\SharedShipmentGroupService;
use App\Services\SteelWeighingGroupService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * تجميع البنود في شحنة واحدة + تجميع وزنة الحديد داخل دورة أمر الشراء المباشر.
 *
 * Case A: عدة بنود (100 / 50 / 25) في شحنة واحدة.
 * Case B: عدة بنود حديد (أقطار مختلفة) على تذكرة بسكول واحدة.
 * Case C: تشغيل السيناريوهين عبر مسار أمر الشراء المباشر الحقيقي (API).
 */
class DirectPoConsolidationAndWeighingTest extends TestCase
{
    use RefreshDatabase;

    private Department $dept;
    private User $procurementManager;
    private User $generalManager;
    private User $accountant;
    private User $warehouseKeeper;
    private User $siteEngineer;
    private User $otherSiteEngineer;
    private Supplier $supplier;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $this->dept = Department::create(['name' => 'إدارة التنفيذ', 'code' => 'EXECUTION', 'is_active' => true]);

        $this->procurementManager = $this->makeUser('pm@direct.test', 'procurement_manager');
        $this->generalManager = $this->makeUser('gm@direct.test', 'general_manager');
        $this->accountant = $this->makeUser('acct@direct.test', 'accountant');
        $this->warehouseKeeper = $this->makeUser('wh@direct.test', 'warehouse_keeper');
        $this->siteEngineer = $this->makeUser('se@direct.test', 'site_engineer');
        $this->otherSiteEngineer = $this->makeUser('se2@direct.test', 'site_engineer');

        $this->supplier = Supplier::create([
            'code' => 'SUP-DIRECT-01',
            'company_name' => 'شركة توريدات الشحنة الموحدة',
            'contact_name' => 'م. اختبار',
            'is_active' => true,
            'opening_balance' => 0,
        ]);

        LandParcel::create(['parcel_reference' => 'PARCEL-900', 'region' => 'المنطقة التاسعة', 'is_active' => true]);
    }

    private function makeUser(string $email, string $role): User
    {
        $user = User::create([
            'name' => $email,
            'email' => $email,
            'password' => bcrypt('Password123!'),
            'department_id' => $this->dept->id,
            'is_active' => true,
        ]);
        $user->roles()->attach(Role::where('slug', $role)->firstOrFail());

        return $user;
    }

    private function item(string $desc, float $qty, string $uom, float $price): array
    {
        return [
            'item_description' => $desc,
            'item_reference' => 'PARCEL-900',
            'region' => 'المنطقة التاسعة',
            'quantity' => $qty,
            'uom' => $uom,
            'unit_price' => $price,
        ];
    }

    /**
     * Direct request through GM + accounting approval (PO not yet created).
     */
    private function approveDirectRequest(array $items): PurchaseRequest
    {
        $response = $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/direct-po', [
                'supplier_id' => $this->supplier->id,
                'department_id' => $this->dept->id,
                'site_engineer_user_id' => $this->siteEngineer->id,
                'requires_warehouse_receipt' => true,
                'items' => $items,
            ]);
        $response->assertStatus(201)->assertJsonPath('data.status', 'PENDING_EXECUTIVE_APPROVAL');
        $pr = PurchaseRequest::findOrFail($response->json('data.id'));

        // Approval gate: a PO cannot be created before GM + accounting approval.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
            ])
            ->assertStatus(409);
        $this->assertSame(0, PurchaseOrder::where('purchase_request_id', $pr->id)->count());

        $this->actingAs($this->generalManager, 'sanctum')
            ->postJson("/api/v1/general-manager/purchase-requests/{$pr->id}/approve", ['comment' => 'معتمد'])
            ->assertStatus(200)
            ->assertJsonPath('data.status', 'PENDING_ACCOUNTING_APPROVAL');

        $this->actingAs($this->accountant, 'sanctum')
            ->postJson("/api/v1/accounting/purchase-requests/{$pr->id}/direct-approve", ['comment' => 'معتمد مالياً'])
            ->assertStatus(200)
            ->assertJsonPath('data.status', 'APPROVED_BY_ACCOUNTING');

        return $pr->fresh('items');
    }

    /**
     * Drive a direct PR through the real API until its PO exists.
     * In the direct route the PO is issued as soon as procurement creates it.
     * Returns [PurchaseRequest, PurchaseOrder(ISSUED)].
     */
    private function createDirectPo(array $items, ?int $expectedPoItems = null): array
    {
        $pr = $this->approveDirectRequest($items);

        $poResponse = $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
            ]);
        $poResponse->assertStatus(201);

        $po = PurchaseOrder::with('items')->findOrFail($poResponse->json('data.id'));
        $this->assertSame('ISSUED', $po->status);
        $this->assertCount($expectedPoItems ?? count($items), $po->items);

        return [$pr, $po];
    }

    private function receivedFor(int $poItemId): float
    {
        return (float) PurchaseReceiptItem::where('purchase_order_item_id', $poItemId)
            ->whereHas('receipt', fn ($q) => $q->whereIn('status', ['PENDING_SITE_ENGINEER', 'APPROVED']))
            ->sum('received_quantity');
    }

    // ───────────────────────────── Case A + C ─────────────────────────────

    public function test_case_a_multi_item_shipment_through_direct_po_flow_keeps_quantities_per_item(): void
    {
        [, $po] = $this->createDirectPo([
            $this->item('أسمنت بورتلاندي', 100, 'BAG', 150),
            $this->item('مواسير بلاستيك 4 بوصة', 50, 'M', 40),
            $this->item('محابس نحاس', 25, 'PCS', 90),
        ]);
        [$cement, $pipes, $valves] = $po->items->sortBy('id')->values()->all();

        $this->assertSame('BAG', $cement->uom);
        $this->assertSame('M', $pipes->uom);
        $this->assertSame('PCS', $valves->uom);

        // Group all three lines into one shared shipment (one truck).
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/shipment-groups', [
                'purchase_order_id' => $po->id,
                'item_ids' => [$cement->id, $pipes->id, $valves->id],
                'vehicle_plate_number' => 'ن ق ل 123',
            ])
            ->assertStatus(201);
        $shipment = ShipmentGroup::where('purchase_order_id', $po->id)->firstOrFail();

        // Cross-item receiving: an item from another PO is rejected and nothing is persisted.
        [, $otherPo] = $this->createDirectPo([$this->item('بلاط سيراميك', 10, 'M2', 200)]);
        $foreignItem = $otherPo->items->first();
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'items' => [
                    ['purchase_order_item_id' => $cement->id, 'received_quantity' => 100],
                    ['purchase_order_item_id' => $foreignItem->id, 'received_quantity' => 10],
                ],
            ])
            ->assertStatus(422);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());

        // Partial delivery: 100 / 30 / 0.
        $payload = [
            'items' => [
                ['purchase_order_item_id' => $cement->id, 'received_quantity' => 100],
                ['purchase_order_item_id' => $pipes->id, 'received_quantity' => 30],
                ['purchase_order_item_id' => $valves->id, 'received_quantity' => 0],
            ],
        ];
        $first = $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", $payload);
        $first->assertStatus(201)->assertJsonPath('data.status', 'PENDING_SITE_ENGINEER');

        // Idempotency: a repeated submission does not create a second receipt.
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", $payload)
            ->assertStatus(409);
        $this->assertSame(1, PurchaseReceipt::where('purchase_order_id', $po->id)->count());

        $this->assertEquals(100.0, $this->receivedFor($cement->id));
        $this->assertEquals(30.0, $this->receivedFor($pipes->id));
        $this->assertEquals(0.0, $this->receivedFor($valves->id));

        // Each receipt line keeps its own ordered quantity (no mixing across items).
        $receipt = PurchaseReceipt::with('items')->findOrFail($first->json('data.id'));
        $this->assertEquals(
            [$cement->id => 100.0, $pipes->id => 50.0, $valves->id => 25.0],
            $receipt->items->mapWithKeys(fn ($ri) => [$ri->purchase_order_item_id => (float) $ri->ordered_quantity])->all()
        );

        $this->assertSame('PARTIALLY_RECEIVED', $shipment->fresh()->status);

        // Inspection by an unrelated site engineer is refused.
        $denied = $this->actingAs($this->otherSiteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve");
        $this->assertContains($denied->status(), [403, 404]);
        $this->assertSame('PENDING_SITE_ENGINEER', $receipt->fresh()->status);

        $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve")
            ->assertStatus(200);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);
        $this->assertSame('PARTIALLY_RECEIVED', $shipment->fresh()->status);

        // Actual PO keeps every line with its own received quantity.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/finalize", [
                'items' => [
                    ['id' => $cement->id, 'item_description' => $cement->item_description, 'item_reference' => 'PARCEL-900', 'region' => 'المنطقة التاسعة', 'quantity' => 100, 'unit_price' => 150, 'uom' => 'BAG'],
                    ['id' => $pipes->id, 'item_description' => $pipes->item_description, 'item_reference' => 'PARCEL-900', 'region' => 'المنطقة التاسعة', 'quantity' => 30, 'unit_price' => 40, 'uom' => 'M'],
                    ['id' => $valves->id, 'item_description' => $valves->item_description, 'item_reference' => 'PARCEL-900', 'region' => 'المنطقة التاسعة', 'quantity' => 0, 'unit_price' => 90, 'uom' => 'PCS'],
                ],
            ])
            ->assertStatus(200);

        $final = PurchaseOrder::with('items')->findOrFail($po->id);
        $this->assertSame('ISSUED', $final->status);
        $this->assertNotNull($final->finalized_at);
        $this->assertEquals(100 * 150 + 30 * 40, (float) $final->grand_total);
        $qtyByUom = $final->items->mapWithKeys(fn ($i) => [$i->uom => (float) $i->quantity])->all();
        $this->assertEquals(['BAG' => 100.0, 'M' => 30.0, 'PCS' => 0.0], $qtyByUom);
    }

    public function test_case_a_duplicate_lines_for_same_item_are_rejected(): void
    {
        [, $po] = $this->createDirectPo([
            $this->item('أسمنت بورتلاندي', 100, 'BAG', 150),
            $this->item('محابس نحاس', 25, 'PCS', 90),
        ]);
        $cement = $po->items->firstWhere('uom', 'BAG');

        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'items' => [
                    ['purchase_order_item_id' => $cement->id, 'received_quantity' => 60],
                    ['purchase_order_item_id' => $cement->id, 'received_quantity' => 60],
                ],
            ])
            ->assertStatus(422);

        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
        $this->assertEquals(0.0, $this->receivedFor($cement->id));
    }

    public function test_case_a_shipment_status_is_judged_per_item_not_by_mixed_unit_totals(): void
    {
        [, $po] = $this->createDirectPo([
            $this->item('أسمنت بورتلاندي', 100, 'BAG', 150),
            $this->item('مواسير بلاستيك 4 بوصة', 50, 'M', 40),
            $this->item('محابس نحاس', 25, 'PCS', 90),
        ]);
        [$cement, $pipes, $valves] = $po->items->sortBy('id')->values()->all();
        $shipment = app(SharedShipmentGroupService::class)->createShipmentGroup(
            $this->procurementManager, $po->id, [$cement->id, $pipes->id, $valves->id]
        );

        // 100 + 75 + 0 = 175 = 100 + 50 + 25, but the valves were never delivered.
        $receipt = PurchaseReceipt::create([
            'receipt_number' => 'REC-MIX-1',
            'purchase_order_id' => $po->id,
            'status' => 'APPROVED',
        ]);
        foreach ([[$cement, 100], [$pipes, 75], [$valves, 0]] as [$poItem, $qty]) {
            $receipt->items()->create([
                'purchase_order_item_id' => $poItem->id,
                'ordered_quantity' => $poItem->quantity,
                'received_quantity' => $qty,
            ]);
        }

        $this->assertSame('PARTIALLY_RECEIVED', app(SharedShipmentGroupService::class)->updateShipmentStatus($shipment->id));
    }

    // ───────────────────────────── Case B + C ─────────────────────────────
    // The request keeps every diameter; procurement groups the steel while issuing the PO
    // ("تجميع وزنة حديد"), and the issued PO carries ONE financial line "حديد".

    private function steelLines(): array
    {
        // 5 t 12 mm + 10 t 8 mm + 56 t 12 mm, same supplier / plot / region, plus cement.
        return [
            $this->item('حديد تسليح 12 مم', 5, 'TON', 38000),
            $this->item('حديد تسليح 8 مم', 10, 'TON', 39000),
            $this->item('حديد تسليح 12 مم', 56, 'TON', 38000),
            $this->item('أسمنت بورتلاندي', 100, 'BAG', 150),
        ];
    }

    private function poItemPayload($prItem): array
    {
        return [
            'pr_item_id' => $prItem->id,
            'item_id' => $prItem->item_id,
            'item_description' => $prItem->item_description,
            'item_reference' => $prItem->item_reference,
            'region' => $prItem->region,
            'quantity' => (float) $prItem->quantity,
            'uom' => $prItem->uom,
            'unit_price' => (float) $prItem->estimated_unit_price,
            'supplier_id' => $this->supplier->id,
        ];
    }

    /**
     * Issue screen in "separate" mode: steel lines grouped as STEEL_WEIGHING, the rest as its own PO.
     */
    private function issueWithSteelGroup(PurchaseRequest $pr, ?array $steelPrItems = null)
    {
        $prItems = $pr->items()->orderBy('id')->get();
        $steel = $steelPrItems ?? $prItems->filter(fn ($i) => str_contains($i->item_description, 'حديد'))->values()->all();
        $steelIds = collect($steel)->pluck('id')->all();
        $others = $prItems->reject(fn ($i) => in_array($i->id, $steelIds, true))->values();

        $groups = [[
            'group_name' => 'حديد',
            'group_type' => 'STEEL_WEIGHING',
            'supplier_id' => $this->supplier->id,
            'items' => array_map(fn ($i) => $this->poItemPayload($i), $steel),
        ]];
        foreach ($others as $other) {
            $groups[] = [
                'group_name' => $other->item_description,
                'group_type' => 'NONE',
                'supplier_id' => $this->supplier->id,
                'items' => [$this->poItemPayload($other)],
            ];
        }

        return $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
                'groups' => $groups,
            ]);
    }

    private function createSteelPo(): array
    {
        $pr = $this->approveDirectRequest($this->steelLines());
        $this->issueWithSteelGroup($pr)->assertStatus(201);

        $steel = PurchaseOrderItem::where('is_consolidated_steel', true)
            ->whereHas('purchaseOrder', fn ($q) => $q->where('purchase_request_id', $pr->id))
            ->firstOrFail();
        $po = PurchaseOrder::with('items')->findOrFail($steel->purchase_order_id);

        return [$po, $steel, $pr];
    }

    private function steelGroupOf(PurchaseOrder $po): WeighingGroup
    {
        return WeighingGroup::with('items')->where('purchase_order_id', $po->id)->firstOrFail();
    }

    private function receiveSteel(PurchaseOrder $po, WeighingGroup $group, $steel, $steelQty, ?float $net)
    {
        $payload = [
            'weighing_group_id' => $group->id,
            'items' => [['purchase_order_item_id' => $steel->id, 'received_quantity' => $steelQty]],
        ];
        if ($net !== null) {
            $payload['scale_ticket_weight'] = $net;
        }

        return $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", $payload);
    }

    public function test_case_b_request_keeps_diameters_until_procurement_groups_them_on_the_po(): void
    {
        $pr = $this->approveDirectRequest($this->steelLines());

        // The request reaches procurement with every diameter as its own line.
        $this->assertCount(4, $pr->items);
        $this->assertSame(0, $pr->items->where('item_description', 'حديد')->count());

        $this->issueWithSteelGroup($pr)->assertStatus(201);
        $amount = 5 * 38000 + 10 * 39000 + 56 * 38000; // 2,708,000

        $pos = PurchaseOrder::with('items.steelComponents')->where('purchase_request_id', $pr->id)->orderBy('id')->get();
        $this->assertCount(2, $pos); // steel PO + cement PO (separate mode)
        $steelPo = $pos->first(fn ($po) => $po->items->contains('is_consolidated_steel', true));

        // Exactly one financial line "حديد" on the steel PO.
        $this->assertCount(1, $steelPo->items);
        $steel = $steelPo->items->first();
        $this->assertSame('حديد', $steel->item_description);
        $this->assertSame('TON', $steel->uom);
        $this->assertEquals(71.0, (float) $steel->quantity);
        $this->assertEquals($amount, (float) $steel->line_total);
        $this->assertEquals(round($amount / 71, 4), (float) $steel->unit_price); // weighted, not an average
        $this->assertEquals($amount, (float) $steelPo->grand_total);
        $this->assertSame('ISSUED', $steelPo->status);

        // Diameters kept as reference rows (12 mm twice, as requested), linked to their request lines.
        $this->assertCount(3, $steel->steelComponents);
        $this->assertSame(['12 مم', '8 مم', '12 مم'], $steel->steelComponents->pluck('size_or_diameter')->all());
        $this->assertEquals($amount, (float) $steel->steelComponents->sum('line_amount'));
        $this->assertEqualsCanonicalizing(
            $pr->items->filter(fn ($i) => str_contains($i->item_description, 'حديد'))->pluck('id')->all(),
            $steel->steelComponents->pluck('purchase_request_item_id')->all()
        );

        // One weighing ticket on the single steel line.
        $group = $this->steelGroupOf($steelPo);
        $this->assertCount(1, $group->items);
        $this->assertEquals(71.0, (float) $group->total_ordered_weight);
        $this->assertEquals($amount, (float) $group->total_amount);

        // Every request line counts as ordered: the request is fully issued and cannot be ordered twice.
        $this->assertTrue($pr->items->every(fn ($i) => $i->fresh()->isOrdered()));
        $this->assertSame('ISSUED', $pr->fresh()->status);
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
                'items' => [$this->poItemPayload($pr->items->first())],
            ])
            ->assertStatus(409);
    }

    public function test_case_b_grouping_rejects_other_plots_and_non_rebar_lines(): void
    {
        // Different plots: grouping refused, nothing is issued (whole issue rolls back).
        $pr = $this->approveDirectRequest([
            array_merge($this->item('حديد تسليح 12 مم', 5, 'TON', 38000), ['item_reference' => 'PARCEL-900']),
            array_merge($this->item('حديد تسليح 16 مم', 7, 'TON', 38000), ['item_reference' => 'PARCEL-901']),
        ]);
        $this->issueWithSteelGroup($pr)->assertStatus(422);
        $this->assertSame(0, PurchaseOrder::where('purchase_request_id', $pr->id)->count());

        // A non-rebar line (no weight unit) cannot be merged into "حديد".
        $pr2 = $this->approveDirectRequest([
            $this->item('حديد تسليح 12 مم', 5, 'TON', 38000),
            $this->item('باب حديد', 2, 'PCS', 3500),
        ]);
        $this->issueWithSteelGroup($pr2, $pr2->items()->orderBy('id')->get()->all())->assertStatus(422);
        $this->assertSame(0, PurchaseOrder::where('purchase_request_id', $pr2->id)->count());

        // Without procurement grouping, nothing is merged.
        [, $po] = $this->createDirectPo([
            $this->item('حديد تسليح 12 مم', 5, 'TON', 38000),
            $this->item('حديد تسليح 16 مم', 7, 'TON', 38000),
        ]);
        $this->assertSame(0, $po->items->where('is_consolidated_steel', true)->count());
    }

    public function test_case_b_one_ticket_one_receipt_with_one_steel_line_through_actual_po(): void
    {
        [$po, $steel] = $this->createSteelPo();
        $unitPrice = (float) $steel->unit_price;
        $group = $this->steelGroupOf($po);
        $this->assertSame('أقطار مجمعة', $group->items->first()->size_or_diameter);

        // Receiver enters 70.5 t once; the scale ticket says 70.8 t net. Neither is forced to the other.
        $response = $this->receiveSteel($po, $group, $steel, 70.5, 70.8);
        $response->assertStatus(201);
        $receipt = PurchaseReceipt::with('items')->findOrFail($response->json('data.id'));

        $this->assertSame($group->id, (int) $receipt->weighing_group_id);
        $this->assertCount(1, $receipt->items);
        $this->assertEquals(70.5, (float) $receipt->items->first()->received_quantity);

        $group->refresh();
        $this->assertSame('RECEIVED', $group->status);
        $this->assertEquals(70.8, (float) $group->total_received_weight);
        $this->assertEquals(-0.2, (float) $group->weight_difference);
        $this->assertEquals(round(70.5 * $unitPrice, 2), (float) $group->total_amount); // valued once, on the entered quantity

        // Retry / double click: no second receipt, no extra lines.
        $this->receiveSteel($po, $group, $steel, 70.5, 70.8)->assertStatus(409);
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/weighing-groups/{$group->id}/receive", ['received_total_weight' => 70.8])
            ->assertStatus(410);
        $this->assertSame(1, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
        $this->assertSame(1, PurchaseReceiptItem::where('purchase_receipt_id', $receipt->id)->count());

        // Site engineer inspection is unchanged.
        $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve")
            ->assertStatus(200);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);

        // Actual PO keeps the single steel line.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/finalize", [
                'items' => [
                    ['id' => $steel->id, 'item_description' => 'حديد', 'item_reference' => 'PARCEL-900', 'region' => 'المنطقة التاسعة', 'quantity' => 70, 'unit_price' => $unitPrice, 'uom' => 'TON'],
                ],
            ])
            ->assertStatus(200);

        $final = PurchaseOrder::with('items')->findOrFail($po->id);
        $this->assertSame('ISSUED', $final->status);
        $this->assertCount(1, $final->items);
        $this->assertTrue((bool) $final->items->first()->is_consolidated_steel);
        $this->assertEquals(round(70 * $unitPrice, 2), (float) $final->grand_total);
        $this->assertCount(3, $steel->steelComponents()->get()); // reference rows untouched

        // The received quantity is never overwritten by the Actual PO (70.5 received, 70 priced).
        $this->assertEquals(70.5, $this->receivedFor($steel->id));
        $this->assertSame(1, PurchaseReceiptItem::where('purchase_receipt_id', $receipt->id)->count());

        // Accounting value of the receipt = Actual PO total (steel counted once).
        $this->assertEquals(
            (float) $final->grand_total,
            app(\App\Services\SupplierInvoiceService::class)->calculateReceiptValue($receipt->fresh())
        );

        // Supplier ledger: one steel supply row valued on the Actual PO (70 t), matching the invoice,
        // while still showing the 70.5 t actually received.
        $ledger = app(\App\Services\SupplierInvoiceService::class)->buildSupplierLedger($this->supplier->fresh());
        $supplyRows = collect($ledger['rows'] ?? $ledger)->where('type', 'SUPPLY')->where('purchase_order_id', $po->id)->values();
        $this->assertCount(1, $supplyRows);
        $this->assertSame('حديد', $supplyRows[0]['description']);
        $this->assertEquals(70.0, $supplyRows[0]['quantity']);
        $this->assertEquals(70.5, $supplyRows[0]['received_quantity']);
        $this->assertEquals((float) $final->grand_total, $supplyRows[0]['value']);
    }

    public function test_case_b_entered_quantity_above_net_weight_or_without_ticket_weight_is_kept(): void
    {
        [$po, $steel] = $this->createSteelPo();
        $group = $this->steelGroupOf($po);

        // 75 t entered (over-receipt vs 71 ordered and above the 70.8 t ticket) is accepted as is.
        $this->receiveSteel($po, $group, $steel, 75, 70.8)->assertStatus(201);
        $this->assertEquals(75.0, $this->receivedFor($steel->id));
        $this->assertEquals(70.8, (float) $group->fresh()->total_received_weight);

        // Without a ticket weight, the net weight stays empty instead of copying the entered quantity.
        [$po2, $steel2] = $this->createSteelPo();
        $group2 = $this->steelGroupOf($po2);
        $this->receiveSteel($po2, $group2, $steel2, 69.25, null)->assertStatus(201);
        $this->assertEquals(69.25, $this->receivedFor($steel2->id));
        $this->assertNull($group2->fresh()->total_received_weight);
        $this->assertNull($group2->fresh()->weight_difference);
    }

    public function test_case_b_invalid_or_missing_steel_quantity_and_unauthorized_users_are_rejected(): void
    {
        [$po, $steel] = $this->createSteelPo();
        $group = $this->steelGroupOf($po);

        $this->receiveSteel($po, $group, $steel, 'abc', 70.8)->assertStatus(422);
        $this->receiveSteel($po, $group, $steel, -1, 70.8)->assertStatus(422);

        // Every seeded role holds purchase_receipt.edit (RolePermissionSeeder), so use a user without a role.
        $noRole = User::create([
            'name' => 'no-role', 'email' => 'norole@direct.test', 'password' => bcrypt('Password123!'),
            'department_id' => $this->dept->id, 'is_active' => true,
        ]);
        $this->actingAs($noRole, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'weighing_group_id' => $group->id,
                'items' => [['purchase_order_item_id' => $steel->id, 'received_quantity' => 70]],
            ])
            ->assertStatus(403);

        $this->assertSame('PENDING_RECEIPT', $group->fresh()->status);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
        $this->assertSame(0, PurchaseReceiptItem::count());
    }

    public function test_case_b_cancelled_weighing_group_cannot_be_reactivated_by_a_receipt(): void
    {
        [$po, $steel] = $this->createSteelPo();
        $group = $this->steelGroupOf($po);
        app(SteelWeighingGroupService::class)->cancelWeighingGroup($this->procurementManager, $group->id, 'أُلغيت');

        $this->receiveSteel($po, $group, $steel, 71, 71)->assertStatus(422);

        $this->assertSame('CANCELLED', $group->fresh()->status);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_case_b_weighing_receipt_cannot_bypass_po_state(): void
    {
        [$po, $steel] = $this->createSteelPo();
        $group = $this->steelGroupOf($po);

        // PO sent back to procurement after grouping: it is no longer approved for delivery.
        $po->update(['status' => 'RETURNED_TO_PROCUREMENT']);

        $this->receiveSteel($po, $group, $steel, 71, 71)->assertStatus(409);
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/weighing-groups/{$group->id}/receive", ['received_total_weight' => 71])
            ->assertStatus(410);

        $this->assertSame('PENDING_RECEIPT', $group->fresh()->status);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_case_b_rollback_leaves_ticket_pending_when_receipt_fails(): void
    {
        [$po, $steel] = $this->createSteelPo();
        $group = $this->steelGroupOf($po);

        try {
            app(PurchaseReceiptService::class)->createByWarehouse($this->warehouseKeeper, $po, [
                ['purchase_order_item_id' => $steel->id, 'received_quantity' => -1],
            ], null, null, null, null, null, $group->id, 70.8);
            $this->fail('Negative quantity must be rejected.');
        } catch (ValidationException) {
            // expected
        }

        $this->assertSame('PENDING_RECEIPT', $group->fresh()->status);
        $this->assertNull($group->fresh()->total_received_weight);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
        $this->assertSame(0, PurchaseReceiptItem::count());
    }
}
