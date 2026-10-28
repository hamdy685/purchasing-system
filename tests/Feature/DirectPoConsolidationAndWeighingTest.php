<?php

namespace Tests\Feature;

use App\Models\Department;
use App\Models\LandParcel;
use App\Models\PurchaseOrder;
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
     * Drive a direct PR through the real API until its PO exists.
     * In the direct route the PO is issued as soon as procurement creates it.
     * Returns [PurchaseRequest, PurchaseOrder(ISSUED)].
     */
    private function createDirectPo(array $items, ?int $expectedPoItems = null): array
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
    // Several rebar diameters are ONE financial line "حديد" from the direct request onwards.

    private function steelLines(): array
    {
        // 5 t 12 mm + 10 t 8 mm + 56 t 12 mm, same supplier / plot / region.
        return [
            $this->item('حديد تسليح 12 مم', 5, 'TON', 38000),
            $this->item('حديد تسليح 8 مم', 10, 'TON', 39000),
            $this->item('حديد تسليح 12 مم', 56, 'TON', 38000),
            $this->item('أسمنت بورتلاندي', 100, 'BAG', 150),
        ];
    }

    private function createSteelPo(): array
    {
        [$pr, $po] = $this->createDirectPo($this->steelLines(), 2);
        $steel = $po->items->firstWhere('is_consolidated_steel', true);
        $cement = $po->items->firstWhere('uom', 'BAG');

        return [$po, $steel, $cement, $pr];
    }

    private function groupSteel(PurchaseOrder $po, $steel): WeighingGroup
    {
        $response = $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/weighing-groups', ['purchase_order_id' => $po->id, 'item_ids' => [$steel->id]]);
        $response->assertStatus(201);

        return WeighingGroup::with('items')->findOrFail($response->json('data.id'));
    }

    private function receiveSteel(PurchaseOrder $po, WeighingGroup $group, $steel, $cement, $steelQty, ?float $net)
    {
        $payload = [
            'weighing_group_id' => $group->id,
            'items' => [
                ['purchase_order_item_id' => $steel->id, 'received_quantity' => $steelQty],
                ['purchase_order_item_id' => $cement->id, 'received_quantity' => 100],
            ],
        ];
        if ($net !== null) {
            $payload['scale_ticket_weight'] = $net;
        }

        return $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", $payload);
    }

    public function test_case_b_direct_request_consolidates_diameters_into_one_steel_line(): void
    {
        [$po, $steel, $cement, $pr] = $this->createSteelPo();
        $amount = 5 * 38000 + 10 * 39000 + 56 * 38000; // 2,708,000

        // Purchase request: one "حديد" line + cement, value = sum of the diameter amounts.
        $pr->load('items.steelComponents');
        $this->assertCount(2, $pr->items);
        $prSteel = $pr->items->firstWhere('is_consolidated_steel', true);
        $this->assertSame('حديد', $prSteel->item_description);
        $this->assertSame('TON', $prSteel->uom);
        $this->assertEquals(71.0, (float) $prSteel->quantity);
        $this->assertEquals($amount, (float) $prSteel->estimated_line_total);
        $this->assertEquals(round($amount / 71, 4), (float) $prSteel->estimated_unit_price); // weighted, not an average
        $this->assertEquals($amount + 100 * 150, (float) $pr->fresh()->total_estimated_cost);

        // Diameters are kept as reference rows, as entered (12 mm appears twice).
        $this->assertCount(3, $prSteel->steelComponents);
        $this->assertSame(['12 مم', '8 مم', '12 مم'], $prSteel->steelComponents->pluck('size_or_diameter')->all());
        $this->assertEquals($amount, (float) $prSteel->steelComponents->sum('line_amount'));

        // Purchase order: still one steel line; its components are not PO items and not in any total.
        $this->assertSame('حديد', $steel->item_description);
        $this->assertEquals(71.0, (float) $steel->quantity);
        $this->assertEquals($amount, (float) $steel->line_total);
        $this->assertCount(3, $steel->steelComponents()->get());
        $this->assertEquals($amount + 100 * 150, (float) $po->fresh()->grand_total);
        $this->assertEquals(100.0, (float) $cement->quantity);
    }

    public function test_case_b_only_matching_rebar_lines_are_consolidated(): void
    {
        [, $po] = $this->createDirectPo([
            // Different plots: each keeps its own line (plot cost attribution).
            array_merge($this->item('حديد تسليح 12 مم', 5, 'TON', 38000), ['item_reference' => 'PARCEL-900']),
            array_merge($this->item('حديد تسليح 16 مم', 7, 'TON', 38000), ['item_reference' => 'PARCEL-901']),
            // Not rebar (no ton conversion) even though it mentions حديد.
            $this->item('باب حديد', 2, 'PCS', 3500),
        ], 3);

        $this->assertSame(0, $po->items->where('is_consolidated_steel', true)->count());
        $this->assertEqualsCanonicalizing(
            ['حديد تسليح 12 مم', 'حديد تسليح 16 مم', 'باب حديد'],
            $po->items->pluck('item_description')->all()
        );
    }

    public function test_case_b_one_ticket_one_receipt_with_one_steel_line_through_actual_po(): void
    {
        [$po, $steel, $cement] = $this->createSteelPo();
        $unitPrice = (float) $steel->unit_price;

        // Only the procurement manager may group; cement cannot join a steel group.
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson('/api/v1/weighing-groups', ['purchase_order_id' => $po->id, 'item_ids' => [$steel->id]])
            ->assertStatus(422);
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/weighing-groups', ['purchase_order_id' => $po->id, 'item_ids' => [$steel->id, $cement->id]])
            ->assertStatus(422);

        $group = $this->groupSteel($po, $steel);
        $this->assertEquals(71.0, (float) $group->total_ordered_weight);
        $this->assertEquals((float) $steel->line_total, (float) $group->total_amount);
        $this->assertSame('أقطار مجمعة', $group->items->first()->size_or_diameter);

        // Receiver enters 70.5 t once; the scale ticket says 70.8 t net. Neither is forced to the other.
        $response = $this->receiveSteel($po, $group, $steel, $cement, 70.5, 70.8);
        $response->assertStatus(201);
        $receipt = PurchaseReceipt::with('items')->findOrFail($response->json('data.id'));

        $this->assertSame($group->id, (int) $receipt->weighing_group_id);
        $this->assertCount(2, $receipt->items);
        $steelLines = $receipt->items->where('purchase_order_item_id', $steel->id);
        $this->assertCount(1, $steelLines);
        $this->assertEquals(70.5, (float) $steelLines->first()->received_quantity);
        $this->assertEquals(100.0, $this->receivedFor($cement->id));

        $group->refresh();
        $this->assertSame('RECEIVED', $group->status);
        $this->assertEquals(70.8, (float) $group->total_received_weight);
        $this->assertEquals(-0.2, (float) $group->weight_difference);
        $this->assertEquals(round(70.5 * $unitPrice, 2), (float) $group->total_amount); // valued once, on the entered quantity

        // Retry / double click: no second receipt, no extra lines.
        $this->receiveSteel($po, $group, $steel, $cement, 70.5, 70.8)->assertStatus(409);
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/weighing-groups/{$group->id}/receive", ['received_total_weight' => 70.8])
            ->assertStatus(410);
        $this->assertSame(1, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
        $this->assertSame(2, PurchaseReceiptItem::count());

        // Site engineer inspection is unchanged.
        $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve")
            ->assertStatus(200);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);

        // Actual PO keeps a single steel line; procurement prices cement at 90 bags.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/finalize", [
                'items' => [
                    ['id' => $steel->id, 'item_description' => 'حديد', 'item_reference' => 'PARCEL-900', 'region' => 'المنطقة التاسعة', 'quantity' => 70.5, 'unit_price' => $unitPrice, 'uom' => 'TON'],
                    ['id' => $cement->id, 'item_description' => $cement->item_description, 'item_reference' => 'PARCEL-900', 'region' => 'المنطقة التاسعة', 'quantity' => 90, 'unit_price' => 150, 'uom' => 'BAG'],
                ],
            ])
            ->assertStatus(200);

        $final = PurchaseOrder::with('items')->findOrFail($po->id);
        $this->assertSame('ISSUED', $final->status);
        $this->assertCount(2, $final->items);
        $this->assertSame(1, $final->items->where('is_consolidated_steel', true)->count());
        $this->assertEquals(round(70.5 * $unitPrice, 2) + 90 * 150, (float) $final->grand_total);
        $this->assertCount(3, $steel->steelComponents()->get()); // reference rows untouched

        // Received quantities are never overwritten by the Actual PO.
        $this->assertEquals(70.5, $this->receivedFor($steel->id));
        $this->assertEquals(100.0, $this->receivedFor($cement->id));
        $this->assertSame(2, PurchaseReceiptItem::count());

        // Accounting value of the receipt = Actual PO total (steel counted once).
        $this->assertEquals(
            (float) $final->grand_total,
            app(\App\Services\SupplierInvoiceService::class)->calculateReceiptValue($receipt->fresh())
        );
    }

    public function test_case_b_entered_quantity_above_net_weight_or_without_ticket_weight_is_kept(): void
    {
        [$po, $steel, $cement] = $this->createSteelPo();
        $group = $this->groupSteel($po, $steel);

        // 75 t entered (over-receipt vs 71 ordered and above the 70.8 t ticket) is accepted as is.
        $this->receiveSteel($po, $group, $steel, $cement, 75, 70.8)->assertStatus(201);
        $this->assertEquals(75.0, $this->receivedFor($steel->id));
        $this->assertEquals(70.8, (float) $group->fresh()->total_received_weight);

        // Without a ticket weight, the net weight stays empty instead of copying the entered quantity.
        [$po2, $steel2, $cement2] = $this->createSteelPo();
        $group2 = $this->groupSteel($po2, $steel2);
        $this->receiveSteel($po2, $group2, $steel2, $cement2, 69.25, null)->assertStatus(201);
        $this->assertEquals(69.25, $this->receivedFor($steel2->id));
        $this->assertNull($group2->fresh()->total_received_weight);
        $this->assertNull($group2->fresh()->weight_difference);
    }

    public function test_case_b_invalid_or_missing_steel_quantity_and_unauthorized_users_are_rejected(): void
    {
        [$po, $steel, $cement] = $this->createSteelPo();
        $group = $this->groupSteel($po, $steel);

        // Missing steel line while the ticket is attached.
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'weighing_group_id' => $group->id,
                'items' => [['purchase_order_item_id' => $cement->id, 'received_quantity' => 100]],
            ])
            ->assertStatus(422);

        $this->receiveSteel($po, $group, $steel, $cement, 'abc', 70.8)->assertStatus(422);
        $this->receiveSteel($po, $group, $steel, $cement, -1, 70.8)->assertStatus(422);

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
        [$po, $steel, $cement] = $this->createSteelPo();
        $service = app(SteelWeighingGroupService::class);

        $group = $service->createWeighingGroup($this->procurementManager, $po->id, [$steel->id]);
        $service->cancelWeighingGroup($this->procurementManager, $group->id, 'أُلغيت');

        $this->receiveSteel($po, $group, $steel, $cement, 71, 71)->assertStatus(422);

        $this->assertSame('CANCELLED', $group->fresh()->status);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_case_b_weighing_receipt_cannot_bypass_po_state(): void
    {
        [$po, $steel, $cement] = $this->createSteelPo();
        $group = $this->groupSteel($po, $steel);

        // PO sent back to procurement after grouping: it is no longer approved for delivery.
        $po->update(['status' => 'RETURNED_TO_PROCUREMENT']);

        $this->receiveSteel($po, $group, $steel, $cement, 71, 71)->assertStatus(409);
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/weighing-groups/{$group->id}/receive", ['received_total_weight' => 71])
            ->assertStatus(410);

        $this->assertSame('PENDING_RECEIPT', $group->fresh()->status);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_case_b_rollback_leaves_ticket_pending_when_receipt_fails(): void
    {
        [$po, $steel, $cement] = $this->createSteelPo();
        $group = app(SteelWeighingGroupService::class)
            ->createWeighingGroup($this->procurementManager, $po->id, [$steel->id]);

        // Cement line is negative -> the whole submission, steel included, must roll back.
        try {
            app(PurchaseReceiptService::class)->createByWarehouse($this->warehouseKeeper, $po, [
                ['purchase_order_item_id' => $steel->id, 'received_quantity' => 70],
                ['purchase_order_item_id' => $cement->id, 'received_quantity' => -1],
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
