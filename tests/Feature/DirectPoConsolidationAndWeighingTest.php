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
    private function createDirectPo(array $items): array
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
        $this->assertCount(count($items), $po->items);

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

    private function createSteelPo(): array
    {
        [, $po] = $this->createDirectPo([
            $this->item('حديد تسليح قطر 12 مم', 6, 'TON', 38000),
            $this->item('حديد تسليح قطر 16 مم', 4, 'TON', 38000),
            $this->item('أسمنت بورتلاندي', 100, 'BAG', 150),
        ]);
        $steel12 = $po->items->first(fn ($i) => str_contains($i->item_description, '12'));
        $steel16 = $po->items->first(fn ($i) => str_contains($i->item_description, '16'));
        $cement = $po->items->firstWhere('uom', 'BAG');

        return [$po, $steel12, $steel16, $cement];
    }

    public function test_case_b_two_diameters_share_one_scale_ticket_through_direct_po_flow(): void
    {
        [$po, $steel12, $steel16, $cement] = $this->createSteelPo();

        // Only the procurement manager may group.
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson('/api/v1/weighing-groups', ['purchase_order_id' => $po->id, 'item_ids' => [$steel12->id, $steel16->id]])
            ->assertStatus(422);

        // Non-steel lines cannot join a steel weighing group.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/weighing-groups', ['purchase_order_id' => $po->id, 'item_ids' => [$steel12->id, $cement->id]])
            ->assertStatus(422);

        $groupResponse = $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/weighing-groups', ['purchase_order_id' => $po->id, 'item_ids' => [$steel12->id, $steel16->id]]);
        $groupResponse->assertStatus(201);
        $group = WeighingGroup::with('items')->findOrFail($groupResponse->json('data.id'));

        // Diameters stay separate lines inside the group.
        $this->assertEquals(10.0, (float) $group->total_ordered_weight);
        $this->assertEqualsCanonicalizing(['12 مم', '16 مم'], $group->items->pluck('size_or_diameter')->all());

        // Same item cannot be placed in a second active group.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/weighing-groups', ['purchase_order_id' => $po->id, 'item_ids' => [$steel12->id]])
            ->assertStatus(422);

        // Scale ticket net = 9.8 t for both diameters together.
        $receiptResponse = $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'weighing_group_id' => $group->id,
                'scale_ticket_weight' => 9.8,
                'items' => [
                    ['purchase_order_item_id' => $steel12->id, 'received_quantity' => 5.9],
                    ['purchase_order_item_id' => $steel16->id, 'received_quantity' => 3.9],
                    ['purchase_order_item_id' => $cement->id, 'received_quantity' => 100],
                ],
            ]);
        $receiptResponse->assertStatus(201);
        $receipt = PurchaseReceipt::with('items')->findOrFail($receiptResponse->json('data.id'));
        $this->assertSame($group->id, (int) $receipt->weighing_group_id);

        $group->refresh();
        $this->assertSame('RECEIVED', $group->status);
        $this->assertEquals(9.8, (float) $group->total_received_weight);
        $this->assertEquals(-0.2, (float) $group->weight_difference);
        // Net weight is priced exactly once.
        $this->assertEquals(round(9.8 * 38000, 2), (float) $group->total_amount);

        // Per-diameter lines keep their own received quantity; cement is not merged into the ticket.
        $this->assertEquals(5.9, $this->receivedFor($steel12->id));
        $this->assertEquals(3.9, $this->receivedFor($steel16->id));
        $this->assertEquals(100.0, $this->receivedFor($cement->id));

        // Re-using the same ticket is refused on both entry points and does not create new receipt lines.
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/weighing-groups/{$group->id}/receive", ['received_total_weight' => 9.8])
            ->assertStatus(422);
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'weighing_group_id' => $group->id,
                'scale_ticket_weight' => 9.8,
                'items' => [['purchase_order_item_id' => $steel12->id, 'received_quantity' => 5.9]],
            ])
            ->assertStatus(409);
        $this->assertSame(1, PurchaseReceipt::where('weighing_group_id', $group->id)->count());
        $this->assertEquals(5.9, $this->receivedFor($steel12->id));

        $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve")
            ->assertStatus(200);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);

        // A received ticket can no longer be cancelled.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/weighing-groups/{$group->id}/cancel", ['reason' => 'test'])
            ->assertStatus(422);
        $this->assertSame('RECEIVED', $group->fresh()->status);
    }

    public function test_case_b_cancelled_weighing_group_cannot_be_reactivated_by_a_receipt(): void
    {
        [$po, $steel12, $steel16] = $this->createSteelPo();
        $service = app(SteelWeighingGroupService::class);

        $group = $service->createWeighingGroup($this->procurementManager, $po->id, [$steel12->id, $steel16->id]);
        $service->cancelWeighingGroup($this->procurementManager, $group->id, 'أُلغيت');

        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'weighing_group_id' => $group->id,
                'scale_ticket_weight' => 10,
                'items' => [
                    ['purchase_order_item_id' => $steel12->id, 'received_quantity' => 6],
                    ['purchase_order_item_id' => $steel16->id, 'received_quantity' => 4],
                ],
            ])
            ->assertStatus(422);

        $this->assertSame('CANCELLED', $group->fresh()->status);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_case_b_direct_weighing_receive_cannot_bypass_po_approval(): void
    {
        [$po, $steel12, $steel16] = $this->createSteelPo();
        $group = app(SteelWeighingGroupService::class)
            ->createWeighingGroup($this->procurementManager, $po->id, [$steel12->id, $steel16->id]);

        // PO sent back to procurement after grouping: it is no longer approved for delivery.
        $po->update(['status' => 'RETURNED_TO_PROCUREMENT']);

        // The regular warehouse entry point already refuses this state.
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", [
                'weighing_group_id' => $group->id,
                'items' => [['purchase_order_item_id' => $steel12->id, 'received_quantity' => 6]],
            ])
            ->assertStatus(409);

        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/weighing-groups/{$group->id}/receive", ['received_total_weight' => 10])
            ->assertStatus(422);

        $this->assertSame('PENDING_RECEIPT', $group->fresh()->status);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_case_b_direct_weighing_receive_does_not_double_count_an_existing_receipt(): void
    {
        [$po, $steel12, $steel16] = $this->createSteelPo();

        // Warehouse receives the steel normally (no group yet).
        app(PurchaseReceiptService::class)->createByWarehouse($this->warehouseKeeper, $po, [
            ['purchase_order_item_id' => $steel12->id, 'received_quantity' => 6],
            ['purchase_order_item_id' => $steel16->id, 'received_quantity' => 4],
        ]);

        // Grouping afterwards and receiving the ticket again must not add a second set of lines.
        $group = app(SteelWeighingGroupService::class)
            ->createWeighingGroup($this->procurementManager, $po->id, [$steel12->id, $steel16->id]);

        try {
            app(SteelWeighingGroupService::class)->recordReceiving($this->warehouseKeeper, $group->id, 10);
            $this->fail('Receiving a ticket for already-received items must be rejected.');
        } catch (ValidationException) {
            // expected
        }

        $this->assertEquals(6.0, $this->receivedFor($steel12->id));
        $this->assertEquals(4.0, $this->receivedFor($steel16->id));
        $this->assertSame(1, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_case_b_rollback_leaves_ticket_pending_when_receipt_fails(): void
    {
        [$po, $steel12, $steel16] = $this->createSteelPo();
        $group = app(SteelWeighingGroupService::class)
            ->createWeighingGroup($this->procurementManager, $po->id, [$steel12->id, $steel16->id]);

        // Second line is negative -> whole submission must roll back.
        try {
            app(PurchaseReceiptService::class)->createByWarehouse($this->warehouseKeeper, $po, [
                ['purchase_order_item_id' => $steel12->id, 'received_quantity' => 6],
                ['purchase_order_item_id' => $steel16->id, 'received_quantity' => -1],
            ], null, null, null, null, null, $group->id, 10.0);
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
