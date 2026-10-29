<?php

namespace Tests\Feature;

use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseOrderItemSource;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\Role;
use App\Models\SteelItemComponent;
use App\Models\Supplier;
use App\Models\User;
use App\Services\ProcurementPurchaseRequestService;
use App\Services\PurchaseOrderService;
use App\Services\PurchaseOrderSourceService;
use App\Services\SystemPurgeService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

/**
 * المرحلة 1 من أوامر الشراء المجمعة إلزامياً حسب القسم:
 * جدول مصادر البنود، فحص "البند اتطلب" الموحد، وتحديد الأقسام بالكود فقط.
 * لا يوجد أي تجميع فعلي بعد — السلوك الحالي يجب أن يبقى كما هو.
 */
class ConsolidatedPoFoundationTest extends TestCase
{
    use RefreshDatabase;

    private Department $dept;
    private User $procurementManager;
    private Supplier $supplier;
    private int $seq = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $this->dept = Department::create(['name' => 'التشطيبات', 'code' => 'FINISHING', 'is_active' => true]);

        $this->procurementManager = User::create([
            'name' => 'pm',
            'email' => 'pm@consolidated.test',
            'password' => bcrypt('Password123!'),
            'department_id' => $this->dept->id,
            'is_active' => true,
        ]);
        $this->procurementManager->roles()->attach(Role::where('slug', 'procurement_manager')->firstOrFail());

        $this->supplier = Supplier::create([
            'code' => 'SUP-CONS-01',
            'company_name' => 'مورد التجميع',
            'contact_name' => 'اختبار',
            'is_active' => true,
            'opening_balance' => 0,
        ]);
    }

    private function makeRequest(array $attributes = [], int $items = 2): PurchaseRequest
    {
        $this->seq++;
        $pr = PurchaseRequest::create(array_merge([
            'request_number' => "PR-CONS-{$this->seq}",
            'request_type' => 'PROJECT',
            'department_id' => $this->dept->id,
            'target_department_id' => $this->dept->id,
            'user_id' => $this->procurementManager->id,
            'status' => 'APPROVED_BY_PROCUREMENT',
        ], $attributes));

        for ($i = 1; $i <= $items; $i++) {
            $pr->items()->create([
                'item_description' => "بند {$i}",
                'item_reference' => 'PARCEL-1',
                'region' => 'المنطقة الأولى',
                'quantity' => 10 * $i,
                'uom' => 'PCS',
                'estimated_unit_price' => 5,
                'estimated_line_total' => 50 * $i,
            ]);
        }

        return $pr->fresh('items');
    }

    private function makePo(PurchaseRequest $pr, string $status = 'ISSUED'): PurchaseOrder
    {
        $this->seq++;

        return PurchaseOrder::create([
            'po_number' => "PO-CONS-{$this->seq}",
            'purchase_request_id' => $pr->id,
            'supplier_id' => $this->supplier->id,
            'created_by_user_id' => $this->procurementManager->id,
            'status' => $status,
            'consolidation_policy' => PurchaseOrder::CONSOLIDATION_POLICY_DEPARTMENT,
        ]);
    }

    /** A consolidated PO line (no pr_item_id) whose provenance is the given request lines. */
    private function consolidatedLine(PurchaseOrder $po, PurchaseRequest $pr, array $prItems): PurchaseOrderItem
    {
        $qty = collect($prItems)->sum(fn ($i) => (float) $i->quantity);
        $line = $po->items()->create([
            'item_description' => 'بند مجمع',
            'item_reference' => 'PARCEL-1',
            'region' => 'المنطقة الأولى',
            'quantity' => $qty,
            'uom' => 'PCS',
            'unit_price' => 5,
            'line_total' => $qty * 5,
            'supplier_id' => $this->supplier->id,
        ]);

        foreach ($prItems as $prItem) {
            $this->source($line, $pr, $prItem);
        }

        return $line;
    }

    private function source(PurchaseOrderItem $line, PurchaseRequest $pr, PurchaseRequestItem $prItem, array $overrides = []): PurchaseOrderItemSource
    {
        return PurchaseOrderItemSource::create(array_merge([
            'purchase_order_item_id' => $line->id,
            'purchase_request_id' => $pr->id,
            'purchase_request_item_id' => $prItem->id,
            'department_id' => $this->dept->id,
            'item_reference' => $prItem->item_reference,
            'region' => $prItem->region,
            'supplier_id' => $this->supplier->id,
            'source_quantity' => (float) $prItem->quantity,
            'source_uom' => $prItem->uom,
            'line_quantity' => (float) $prItem->quantity,
            'unit_price' => 5,
            'line_amount' => (float) $prItem->quantity * 5,
            'created_by_user_id' => $this->procurementManager->id,
        ], $overrides));
    }

    // ── Schema ──────────────────────────────────────────────────────────────

    /** @test */
    public function migration_adds_sources_table_and_po_columns_and_rolls_back_cleanly(): void
    {
        $this->assertTrue(Schema::hasTable('purchase_order_item_sources'));
        foreach (['consolidation_policy', 'consolidation_key', 'idempotency_key'] as $column) {
            $this->assertTrue(Schema::hasColumn('purchase_orders', $column), $column);
        }

        // This migration and the later high-value one (Phase 3) are the two most recent.
        $this->artisan('migrate:rollback', ['--step' => 2])->assertExitCode(0);
        $this->assertFalse(Schema::hasTable('purchase_order_item_sources'));
        $this->assertFalse(Schema::hasColumn('purchase_orders', 'idempotency_key'));
        $this->assertTrue(Schema::hasTable('steel_item_components'), 'earlier migrations are untouched');

        $this->artisan('migrate')->assertExitCode(0);
        $this->assertTrue(Schema::hasTable('purchase_order_item_sources'));
        $this->assertTrue(Schema::hasColumn('purchase_orders', 'idempotency_key'));
    }

    /** @test */
    public function new_sources_default_to_active_and_a_request_line_cannot_be_active_twice(): void
    {
        $pr = $this->makeRequest();
        $prItem = $pr->items->first();
        $lineA = $this->consolidatedLine($this->makePo($pr), $pr, [$prItem]);

        $first = PurchaseOrderItemSource::where('purchase_order_item_id', $lineA->id)->firstOrFail();
        $this->assertTrue($first->isActive());

        $lineB = $this->makePo($pr)->items()->create([
            'item_description' => 'سطر آخر', 'quantity' => 1, 'uom' => 'PCS', 'unit_price' => 1, 'line_total' => 1,
        ]);

        $this->expectException(QueryException::class);
        $this->source($lineB, $pr, $prItem);
    }

    /** @test */
    public function a_released_source_lets_the_same_request_line_be_held_again_and_keeps_history(): void
    {
        $pr = $this->makeRequest();
        $prItem = $pr->items->first();
        $lineA = $this->consolidatedLine($this->makePo($pr, 'CANCELLED'), $pr, [$prItem]);
        PurchaseOrderItemSource::where('purchase_order_item_id', $lineA->id)
            ->update(['active_flag' => null, 'released_at' => now(), 'released_reason' => 'PO cancelled']);

        $lineB = $this->consolidatedLine($this->makePo($pr), $pr, [$prItem]);

        $this->assertSame(2, PurchaseOrderItemSource::where('purchase_request_item_id', $prItem->id)->count());
        $this->assertSame(1, PurchaseOrderItemSource::active()->where('purchase_request_item_id', $prItem->id)->count());
        $this->assertSame($lineB->id, (int) PurchaseOrderItemSource::active()->where('purchase_request_item_id', $prItem->id)->value('purchase_order_item_id'));
    }

    /** @test */
    public function a_po_line_with_sources_cannot_be_hard_deleted(): void
    {
        $pr = $this->makeRequest();
        $line = $this->consolidatedLine($this->makePo($pr), $pr, $pr->items->all());

        try {
            $line->delete();
            $this->fail('Deleting a PO line that has provenance rows must be refused.');
        } catch (QueryException) {
            // expected: restrictOnDelete
        }

        $this->assertDatabaseHas('purchase_order_items', ['id' => $line->id]);
        $this->assertSame(2, $line->sources()->count());
    }

    // ── Unified "already ordered" check ─────────────────────────────────────

    /** @test */
    public function request_lines_held_by_an_active_source_count_as_ordered(): void
    {
        $pr = $this->makeRequest([], 3);
        [$a, $b, $c] = $pr->items->all();
        $this->consolidatedLine($this->makePo($pr), $pr, [$a, $b]);

        $this->assertTrue($a->isOrdered());
        $this->assertTrue($b->isOrdered());
        $this->assertFalse($c->isOrdered());

        $orderedIds = PurchaseRequestItem::where(fn ($q) => PurchaseOrderSourceService::orderedScope($q))->pluck('id')->sort()->values()->all();
        $this->assertSame([$a->id, $b->id], $orderedIds);
    }

    /** @test */
    public function released_sources_and_inactive_pos_do_not_count_as_ordered(): void
    {
        $pr = $this->makeRequest([], 2);
        [$a, $b] = $pr->items->all();

        $po = $this->makePo($pr);
        $this->consolidatedLine($po, $pr, [$a]);
        PurchaseOrderItemSource::where('purchase_request_item_id', $a->id)->update(['active_flag' => null, 'released_at' => now()]);
        $this->assertFalse($a->fresh()->isOrdered(), 'released source');

        $cancelled = $this->makePo($pr, 'CANCELLED');
        $this->consolidatedLine($cancelled, $pr, [$b]);
        $this->assertFalse($b->fresh()->isOrdered(), 'active source on a cancelled PO');

        $cancelled->update(['status' => 'ISSUED']);
        $this->assertTrue($b->fresh()->isOrdered());

        $cancelled->delete(); // soft delete
        $this->assertFalse($b->fresh()->isOrdered(), 'soft-deleted PO');
    }

    /** @test */
    public function historical_direct_and_steel_lines_still_count_as_ordered(): void
    {
        $pr = $this->makeRequest([], 3);
        [$direct, $steel, $free] = $pr->items->all();
        $po = $this->makePo($pr);
        $po->update(['consolidation_policy' => null]);

        $po->items()->create([
            'pr_item_id' => $direct->id, 'item_description' => $direct->item_description,
            'quantity' => 10, 'uom' => 'PCS', 'unit_price' => 5, 'line_total' => 50,
        ]);
        $steelLine = $po->items()->create([
            'item_description' => 'حديد', 'quantity' => 2, 'uom' => 'TON', 'unit_price' => 40000,
            'line_total' => 80000, 'is_consolidated_steel' => true,
        ]);
        SteelItemComponent::create([
            'purchase_order_item_id' => $steelLine->id, 'purchase_request_item_id' => $steel->id,
            'item_description' => 'حديد 12 مم', 'size_or_diameter' => '12', 'quantity' => 2, 'uom' => 'TON',
            'quantity_in_tons' => 2, 'unit_price' => 40000, 'line_amount' => 80000,
        ]);

        $this->assertTrue($direct->isOrdered());
        $this->assertTrue($steel->isOrdered());
        $this->assertFalse($free->isOrdered());
        $this->assertFalse($po->fresh()->isDepartmentConsolidated());
    }

    /** @test */
    public function pending_procurement_list_hides_requests_fully_held_by_consolidated_sources(): void
    {
        $held = $this->makeRequest([], 2);
        $this->consolidatedLine($this->makePo($held), $held, $held->items->all());

        $partial = $this->makeRequest([], 2);
        $this->consolidatedLine($this->makePo($partial), $partial, [$partial->items->first()]);

        $fresh = $this->makeRequest([], 1);

        $ids = collect(app(ProcurementPurchaseRequestService::class)->getApprovedByProcurementRequests(100)->items())
            ->pluck('id')->all();

        $this->assertNotContains($held->id, $ids);
        $this->assertContains($partial->id, $ids);
        $this->assertContains($fresh->id, $ids);
    }

    /** @test */
    public function creating_a_po_for_a_line_held_by_a_consolidated_po_is_refused(): void
    {
        $pr = $this->makeRequest([], 2);
        [$a, $b] = $pr->items->all();
        $held = $this->makePo($pr);
        $this->consolidatedLine($held, $pr, [$a]);

        try {
            app(PurchaseOrderService::class)->createPoFromPr($this->procurementManager, $pr->id, $this->supplier->id, [
                'items' => [['pr_item_id' => $a->id, 'quantity' => 10, 'unit_price' => 5]],
            ]);
            $this->fail('A line already held by a consolidated PO must not be ordered again.');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('أمر شراء مجمع', $e->getMessage());
            $this->assertStringContainsString($held->po_number, $e->getMessage());
        }

        // The other line is still free and can be ordered normally.
        $po = app(PurchaseOrderService::class)->createPoFromPr($this->procurementManager, $pr->id, $this->supplier->id, [
            'items' => [['pr_item_id' => $b->id, 'quantity' => 20, 'unit_price' => 5]],
        ]);
        $this->assertSame([$b->id], $po->items->pluck('pr_item_id')->map(fn ($v) => (int) $v)->all());
        $this->assertNull($po->consolidation_policy, 'Phase 1 does not consolidate anything yet');
    }

    // ── Department identification (code only) ───────────────────────────────

    /** @test */
    public function mandatory_consolidation_is_off_while_the_flag_is_disabled(): void
    {
        config(['procurement.consolidated_po.enabled' => false]);

        $this->assertFalse(PurchaseOrderSourceService::isMandatoryForRequest($this->makeRequest()));
    }

    /** @test */
    public function mandatory_consolidation_applies_to_exactly_the_four_department_codes(): void
    {
        config(['procurement.consolidated_po.enabled' => true]);

        $expected = [
            'FINISHING' => true, 'OFFICE' => true, 'LICENSES' => true, 'DEVELOPMENT' => true,
            'EXECUTION' => false, 'BUILDINGS' => false, 'BUFFET' => false, 'MARKETING' => false, 'SALES' => false,
        ];

        foreach ($expected as $code => $mandatory) {
            $dept = Department::firstOrCreate(['code' => $code], ['name' => "قسم {$code}", 'is_active' => true]);
            $pr = $this->makeRequest(['department_id' => $dept->id, 'target_department_id' => $dept->id], 1);

            $this->assertSame($mandatory, PurchaseOrderSourceService::isMandatoryForRequest($pr), $code);
        }
    }

    /** @test */
    public function an_office_supplies_request_from_another_department_is_not_mandatory(): void
    {
        config(['procurement.consolidated_po.enabled' => true]);
        $execution = Department::create(['name' => 'التنفيذ', 'code' => 'EXECUTION', 'is_active' => true]);

        $pr = $this->makeRequest([
            'request_type' => 'OFFICE_SUPPLIES',
            'department_id' => $execution->id,
            'target_department_id' => $execution->id,
        ], 1);

        $this->assertFalse(PurchaseOrderSourceService::isMandatoryForRequest($pr));
    }

    /** @test */
    public function identification_uses_the_code_never_the_display_name(): void
    {
        config(['procurement.consolidated_po.enabled' => true]);

        $this->dept->update(['name' => 'قسم اسمه اتغير']);
        $this->assertTrue(PurchaseOrderSourceService::isMandatoryForRequest($this->makeRequest([], 1)), 'renamed FINISHING');

        $lookalike = Department::create(['name' => 'التشطيبات', 'code' => 'FIN-2', 'is_active' => true]);
        $pr = $this->makeRequest(['department_id' => $lookalike->id, 'target_department_id' => $lookalike->id], 1);
        $this->assertFalse(PurchaseOrderSourceService::isMandatoryForRequest($pr), 'Arabic name match with another code');
    }

    /** @test */
    public function the_handling_department_wins_over_the_requester_department(): void
    {
        config(['procurement.consolidated_po.enabled' => true]);
        $execution = Department::create(['name' => 'التنفيذ', 'code' => 'EXECUTION', 'is_active' => true]);

        $toFinishing = $this->makeRequest(['department_id' => $execution->id, 'target_department_id' => $this->dept->id], 1);
        $this->assertTrue(PurchaseOrderSourceService::isMandatoryForRequest($toFinishing));

        $toExecution = $this->makeRequest(['department_id' => $this->dept->id, 'target_department_id' => $execution->id], 1);
        $this->assertFalse(PurchaseOrderSourceService::isMandatoryForRequest($toExecution));

        $legacy = $this->makeRequest(['department_id' => $this->dept->id, 'target_department_id' => null], 1);
        $this->assertTrue(PurchaseOrderSourceService::isMandatoryForRequest($legacy), 'falls back to department_id');
    }

    // ── Purge ───────────────────────────────────────────────────────────────

    /** @test */
    public function operational_purge_clears_sources_before_po_lines(): void
    {
        $tables = SystemPurgeService::OPERATIONAL_TABLES;

        $this->assertContains('purchase_order_item_sources', $tables);
        $this->assertLessThan(
            array_search('purchase_order_items', $tables, true),
            array_search('purchase_order_item_sources', $tables, true)
        );
    }
}
