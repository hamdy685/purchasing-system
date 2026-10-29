<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\Department;
use App\Models\Item;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\SupplierInvoice;
use App\Models\User;
use App\Services\SupplierInvoiceService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * المرحلة 4: فواتير وحسابات وتقارير أوامر الشراء المجمعة — كل مورد بمفرده، ومن غير عدّ مزدوج.
 * السيناريو: طلب تشطيبات واحد (10 بنود على موردين) ← أمرين مجمعين ← استلام ← فعلي ← فواتير ← دفعة ← تقرير.
 */
class ConsolidatedPoInvoicesAndReportsTest extends TestCase
{
    use RefreshDatabase;

    private Department $finishing;
    private Department $execution;
    private User $procurementManager;
    private User $generalAccountant;
    private User $warehouseKeeper;
    private User $siteEngineer;
    private Supplier $supplierA;
    private Supplier $supplierB;
    private Category $category;
    private int $seq = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);
        config(['procurement.consolidated_po.enabled' => true]);

        $this->finishing = Department::create(['name' => 'التشطيبات', 'code' => 'FINISHING', 'is_active' => true]);
        $this->execution = Department::create(['name' => 'التنفيذ', 'code' => 'EXECUTION', 'is_active' => true]);

        $this->procurementManager = $this->makeUser('pm@inv.test', 'procurement_manager');
        $this->generalAccountant = $this->makeUser('ga@inv.test', 'general_accountant');
        $this->warehouseKeeper = $this->makeUser('wh@inv.test', 'warehouse_keeper');
        $this->siteEngineer = $this->makeUser('se@inv.test', 'site_engineer');

        $this->supplierA = Supplier::create(['code' => 'SUP-IA', 'company_name' => 'المورد أ', 'contact_name' => 'أ', 'is_active' => true, 'opening_balance' => 0]);
        $this->supplierB = Supplier::create(['code' => 'SUP-IB', 'company_name' => 'المورد ب', 'contact_name' => 'ب', 'is_active' => true, 'opening_balance' => 0]);
        $this->category = Category::create(['name' => 'خامات', 'code' => 'MAT', 'is_active' => true]);
    }

    private function makeUser(string $email, string $role): User
    {
        $user = User::create(['name' => $email, 'email' => $email, 'password' => bcrypt('Password123!'), 'department_id' => $this->finishing->id, 'is_active' => true]);
        $user->roles()->attach(Role::where('slug', $role)->firstOrFail());

        return $user;
    }

    private function catalogItem(string $name): Item
    {
        $this->seq++;

        return Item::create(['category_id' => $this->category->id, 'sku' => "SKU-INV-{$this->seq}", 'name' => $name, 'uom' => 'PCS', 'is_active' => true]);
    }

    /**
     * Supplier A: 2 identical tiles (one merged line) + 3 different lines (one in M2). Supplier B: 5 different lines.
     *
     * @return array{0: PurchaseRequest, 1: PurchaseOrder, 2: PurchaseOrder}
     */
    private function issueTenLines(): array
    {
        $tile = $this->catalogItem('سيراميك');
        $lines = [
            ['سيراميك', 100, 'PCS', 250, $this->supplierA, $tile],
            ['سيراميك', 40, 'PCS', 250, $this->supplierA, $tile],
            ['لاصق', 30, 'BAG', 90, $this->supplierA, null],
            ['ترويبة', 20, 'BAG', 45, $this->supplierA, null],
            ['بلاط حوائط', 60, 'M2', 180, $this->supplierA, null],
        ];
        foreach (['دهان بلاستيك', 'معجون', 'سيلر', 'ورق صنفرة', 'رولة دهان'] as $i => $name) {
            $lines[] = [$name, 10 + $i, 'PCS', 100 + $i * 10, $this->supplierB, null];
        }

        $this->seq++;
        $pr = PurchaseRequest::create([
            'request_number' => "PR-INV-{$this->seq}", 'request_type' => 'PROJECT',
            'department_id' => $this->finishing->id, 'target_department_id' => $this->finishing->id,
            'user_id' => $this->procurementManager->id, 'site_engineer_user_id' => $this->siteEngineer->id,
            'requires_warehouse_receipt' => true, 'status' => 'APPROVED_BY_PROCUREMENT',
        ]);
        foreach ($lines as [$desc, $qty, $uom, $price, $supplier, $item]) {
            $pr->items()->create([
                'item_id' => $item?->id, 'supplier_id' => $supplier->id, 'item_description' => $desc,
                'item_reference' => 'PARCEL-3', 'region' => 'المنطقة الثالثة', 'quantity' => $qty, 'uom' => $uom,
                'estimated_unit_price' => $price, 'estimated_line_total' => $qty * $price,
            ]);
        }
        $pr = $pr->fresh('items');

        $groups = $pr->items->map(fn ($i) => [
            'group_type' => 'NONE', 'supplier_id' => $i->supplier_id,
            'items' => [[
                'pr_item_id' => $i->id, 'item_id' => $i->item_id, 'item_description' => $i->item_description,
                'item_reference' => $i->item_reference, 'region' => $i->region, 'quantity' => (float) $i->quantity,
                'uom' => $i->uom, 'unit_price' => (float) $i->estimated_unit_price, 'supplier_id' => $i->supplier_id,
            ]],
        ])->values()->all();
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', ['purchase_request_id' => $pr->id, 'groups' => $groups])
            ->assertStatus(201)->assertJsonCount(2, 'data');

        $orders = PurchaseOrder::where('purchase_request_id', $pr->id)->with('items')->get()->keyBy('supplier_id');

        return [$pr, $orders[$this->supplierA->id], $orders[$this->supplierB->id]];
    }

    private function receiveApproveAndFinalize(PurchaseOrder $po, array $receivedOverride = [], array $finalizeExtra = []): PurchaseReceipt
    {
        $items = $po->items()->get()->map(fn ($l) => ['purchase_order_item_id' => $l->id, 'received_quantity' => $receivedOverride[$l->id] ?? (float) $l->quantity])->all();
        $receiptId = $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", ['items' => $items])
            ->assertStatus(201)->json('data.id');
        $this->actingAs($this->siteEngineer, 'sanctum')->postJson("/api/v1/purchase-receipts/{$receiptId}/approve")->assertStatus(200);

        $payload = $po->items()->orderBy('id')->get()->map(fn ($l) => [
            'id' => $l->id, 'item_description' => $l->item_description, 'item_reference' => $l->item_reference,
            'region' => $l->region, 'quantity' => (float) $l->quantity, 'uom' => $l->uom, 'unit_price' => (float) $l->unit_price,
        ])->all();
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/finalize", array_merge(['items' => $payload], $finalizeExtra))
            ->assertStatus(200);

        return PurchaseReceipt::findOrFail($receiptId);
    }

    private function invoice(PurchaseOrder $po, PurchaseReceipt $receipt, float $amount, ?int $supplierId = null): SupplierInvoice
    {
        return app(SupplierInvoiceService::class)->createInvoice(
            $this->generalAccountant, $po->fresh(), $receipt->fresh(), $amount, null, now()->toDateString(), null, [], null, $supplierId
        );
    }

    #[Test]
    public function each_supplier_order_is_invoiced_paid_and_reported_once_without_double_counting(): void
    {
        [, $poA, $poB] = $this->issueTenLines();
        $tiles = $poA->items->firstWhere('item_description', 'سيراميك');

        // A: 5% discount and a header tax; tiles received short (138 of 140) — contract stays 140.
        $poA->update(['tax_amount' => 1400]);
        $receiptA = $this->receiveApproveAndFinalize($poA, [$tiles->id => 138], ['discount_type' => 'TOTAL', 'discount_percentage' => 5]);
        $receiptB = $this->receiveApproveAndFinalize($poB);
        $poA->refresh();
        $poB->refresh();

        $subtotalA = 140 * 250 + 30 * 90 + 20 * 45 + 60 * 180;
        $grandA = round($subtotalA * 0.95 + 1400, 2);
        $grandB = (10 * 100) + (11 * 110) + (12 * 120) + (13 * 130) + (14 * 140);
        $this->assertEquals($grandA, (float) $poA->grand_total);
        $this->assertEquals($grandB, (float) $poB->grand_total);

        // Receipt value is the order's authoritative total (one receipt per supplier order).
        $service = app(SupplierInvoiceService::class);
        $this->assertEquals($grandA, $service->calculateReceiptValue($receiptA->fresh()));
        $this->assertEquals($grandB, $service->calculateReceiptValue($receiptB->fresh()));

        // An invoice for A's order cannot be booked to supplier B.
        try {
            $this->invoice($poA, $receiptA, $grandA, $this->supplierB->id);
            $this->fail('A consolidated order cannot be invoiced to another supplier.');
        } catch (ValidationException) {
            // expected
        }
        $this->assertSame(0, SupplierInvoice::count());

        $invA = $this->invoice($poA, $receiptA, $grandA);
        $invB = $this->invoice($poB, $receiptB, $grandB, $this->supplierB->id);
        $this->assertSame($this->supplierA->id, (int) $invA->supplier_id);
        $this->assertSame($this->supplierB->id, (int) $invB->supplier_id);

        // A second invoice on the same receipt is refused (no double booking).
        $this->expectExceptionOnce(fn () => $this->invoice($poA, $receiptA, 10));

        // Each supplier's balance carries only its own order.
        $this->assertEquals($grandA, $service->getSupplierBalance($this->supplierA->id)['total_invoiced']);
        $this->assertEquals($grandB, $service->getSupplierBalance($this->supplierB->id)['total_invoiced']);

        // A payment to A settles A only.
        $service->recordPayment($this->generalAccountant, $invA->fresh(), 20000, now()->toDateString());
        $this->assertEquals(20000.0, $service->getSupplierBalance($this->supplierA->id)['total_paid']);
        $this->assertEquals(0.0, $service->getSupplierBalance($this->supplierB->id)['total_paid']);
        $this->assertEquals(round($grandA - 20000, 2), (float) $invA->fresh()->outstanding_amount);

        // ── Report ──
        $report = $this->actingAs($this->generalAccountant, 'sanctum')->getJson('/api/v1/reports/purchases?' . http_build_query([
            'filter_type' => 'custom', 'from_date' => now()->subDay()->toDateString(), 'to_date' => now()->addDay()->toDateString(),
            'per_page' => 'ALL', 'department_id' => $this->finishing->id,
        ]))->assertStatus(200);

        $rows = collect($report->json('rows'));
        $this->assertCount(9, $rows, 'one row per PO line (4 + 5), never one per source line (10)');

        $tileRow = $rows->firstWhere('item_name', 'سيراميك');
        $this->assertEquals(140.0, $tileRow['contract_quantity']);
        $this->assertEquals(138.0, $tileRow['received_quantity']);
        $this->assertTrue($tileRow['is_department_consolidated']);
        $this->assertCount(2, $tileRow['sources']);
        $this->assertEqualsWithDelta($tileRow['total_price'], collect($tileRow['sources'])->sum('line_amount'), 0.01);

        $breakdown = collect($report->json('department_supplier_breakdown'))->keyBy('supplier_id');
        $this->assertCount(2, $breakdown);
        $a = $breakdown[$this->supplierA->id];
        $b = $breakdown[$this->supplierB->id];
        $this->assertSame(1, $a['orders_count']);
        $this->assertSame(4, $a['lines_count']);
        $this->assertSame(1, $a['invoices_count'], 'the invoice is counted once even though the order has 4 rows');
        $this->assertEquals($grandA, $a['orders_grand_total']);
        $this->assertEquals($grandA, $a['invoiced_amount']);
        $this->assertEquals(20000.0, $a['paid_amount']);
        $this->assertEquals(round($grandA - 20000, 2), $a['outstanding_amount']);
        $this->assertEquals($subtotalA, $a['lines_amount']);
        $this->assertEquals(['contract_quantity' => 140 + 0 + 0, 'received_quantity' => 138], array_intersect_key($a['quantities_by_uom']['PCS'], ['contract_quantity' => 1, 'received_quantity' => 1]));
        $this->assertEquals(['contract_quantity' => 50, 'received_quantity' => 50], $a['quantities_by_uom']['BAG']);
        $this->assertEquals(['contract_quantity' => 60, 'received_quantity' => 60], $a['quantities_by_uom']['M2']);
        $this->assertSame(1, $b['invoices_count']);
        $this->assertEquals($grandB, $b['orders_grand_total']);
        $this->assertEquals(0.0, $b['paid_amount']);

        $dept = collect($report->json('department_totals'))->sole();
        $this->assertSame('FINISHING', $dept['department_code']);
        $this->assertSame(2, $dept['suppliers_count']);
        $this->assertSame(2, $dept['orders_count']);
        $this->assertEquals(round($grandA + $grandB, 2), $dept['orders_grand_total']);
        $this->assertEquals(round($grandA + $grandB, 2), $dept['invoiced_amount']);
        $this->assertEquals(round($a['lines_amount'] + $b['lines_amount'], 2), $dept['lines_amount']);
    }

    #[Test]
    public function a_regular_order_of_another_department_is_reported_as_before(): void
    {
        [, $poA] = $this->issueTenLines();
        $this->receiveApproveAndFinalize($poA);

        $this->seq++;
        $pr = PurchaseRequest::create([
            'request_number' => "PR-INV-EX-{$this->seq}", 'request_type' => 'PROJECT',
            'department_id' => $this->execution->id, 'target_department_id' => $this->execution->id,
            'user_id' => $this->procurementManager->id, 'site_engineer_user_id' => $this->siteEngineer->id,
            'requires_warehouse_receipt' => true, 'status' => 'APPROVED_BY_PROCUREMENT',
        ]);
        $prItem = $pr->items()->create([
            'supplier_id' => $this->supplierB->id, 'item_description' => 'رمل', 'item_reference' => 'PARCEL-3', 'region' => 'المنطقة الثالثة',
            'quantity' => 10, 'uom' => 'M3', 'estimated_unit_price' => 200, 'estimated_line_total' => 2000,
        ]);
        $this->actingAs($this->procurementManager, 'sanctum')->postJson('/api/v1/procurement/purchase-orders', [
            'purchase_request_id' => $pr->id, 'supplier_id' => $this->supplierB->id,
            'items' => [['pr_item_id' => $prItem->id, 'item_reference' => 'PARCEL-3', 'region' => 'المنطقة الثالثة', 'quantity' => 10, 'unit_price' => 200]],
        ])->assertStatus(201)->assertJsonMissingPath('consolidated');
        $regular = PurchaseOrder::where('purchase_request_id', $pr->id)->with('items')->sole();
        $this->receiveApproveAndFinalize($regular);

        $report = $this->actingAs($this->generalAccountant, 'sanctum')->getJson('/api/v1/reports/purchases?' . http_build_query([
            'filter_type' => 'custom', 'from_date' => now()->subDay()->toDateString(), 'to_date' => now()->addDay()->toDateString(), 'per_page' => 'ALL',
        ]))->assertStatus(200);

        $row = collect($report->json('rows'))->firstWhere('item_name', 'رمل');
        $this->assertFalse($row['is_department_consolidated']);
        $this->assertSame([], $row['sources']);
        $this->assertEquals(10.0, $row['contract_quantity']);
        $this->assertEquals(10.0, $row['received_quantity']);

        $departments = collect($report->json('department_totals'))->keyBy('department_code');
        $this->assertEquals(2000.0, $departments['EXECUTION']['orders_grand_total']);
        $this->assertSame(1, $departments['FINISHING']['orders_count'], 'only supplier A was issued in this test');
    }

    private function expectExceptionOnce(callable $call): void
    {
        try {
            $call();
            $this->fail('Expected the call to be refused.');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('تم تسجيل فاتورة لهذا إذن الاستلام بالفعل', $e->getMessage());
        }
    }
}
