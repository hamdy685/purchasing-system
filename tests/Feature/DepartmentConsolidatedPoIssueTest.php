<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\Department;
use App\Models\Item;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseOrderItemSource;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use App\Models\WeighingGroup;
use App\Services\PurchaseOrderService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * المرحلة 2: إصدار أوامر الشراء المجمعة إلزامياً للأقسام الأربعة (أمر لكل مورد ونطاق متوافق).
 * كل الاختبارات عبر الـ API الحقيقي: POST /api/v1/procurement/purchase-orders.
 */
class DepartmentConsolidatedPoIssueTest extends TestCase
{
    use RefreshDatabase;

    private Department $finishing;
    private Department $execution;
    private User $procurementManager;
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

        $this->procurementManager = $this->makeUser('pm@cons-issue.test', 'procurement_manager');

        $this->supplierA = Supplier::create(['code' => 'SUP-A', 'company_name' => 'المورد أ', 'contact_name' => 'أ', 'is_active' => true, 'opening_balance' => 0]);
        $this->supplierB = Supplier::create(['code' => 'SUP-B', 'company_name' => 'المورد ب', 'contact_name' => 'ب', 'is_active' => true, 'opening_balance' => 0]);
        $this->category = Category::create(['name' => 'خامات', 'code' => 'MAT', 'is_active' => true]);
    }

    private function makeUser(string $email, ?string $role): User
    {
        $user = User::create([
            'name' => $email,
            'email' => $email,
            'password' => bcrypt('Password123!'),
            'department_id' => $this->finishing->id,
            'is_active' => true,
        ]);
        if ($role) {
            $user->roles()->attach(Role::where('slug', $role)->firstOrFail());
        }

        return $user;
    }

    private function catalogItem(string $name, string $uom = 'PCS'): Item
    {
        $this->seq++;

        return Item::create(['category_id' => $this->category->id, 'sku' => "SKU-{$this->seq}", 'name' => $name, 'uom' => $uom, 'is_active' => true]);
    }

    /**
     * @param array<int, array> $lines each: description, qty, uom, price, supplier (Supplier), item (Item|null), parcel, supplementary
     */
    private function approvedRequest(array $lines, ?Department $dept = null, array $attributes = []): PurchaseRequest
    {
        $this->seq++;
        $dept ??= $this->finishing;
        $pr = PurchaseRequest::create(array_merge([
            'request_number' => "PR-ISSUE-{$this->seq}",
            'request_type' => 'PROJECT',
            'department_id' => $dept->id,
            'target_department_id' => $dept->id,
            'user_id' => $this->procurementManager->id,
            'status' => 'APPROVED_BY_PROCUREMENT',
        ], $attributes));

        foreach ($lines as $line) {
            $pr->items()->create([
                'item_id' => ($line['item'] ?? null)?->id,
                'supplier_id' => ($line['supplier'] ?? null)?->id,
                'item_description' => $line['description'],
                'item_reference' => $line['parcel'] ?? 'PARCEL-1',
                'region' => $line['region'] ?? 'المنطقة الأولى',
                'quantity' => $line['qty'],
                'uom' => $line['uom'] ?? 'PCS',
                'estimated_unit_price' => $line['price'],
                'estimated_line_total' => $line['qty'] * $line['price'],
                'is_supplementary' => $line['supplementary'] ?? false,
            ]);
        }

        return $pr->fresh('items');
    }

    /** Payload the UI sends in its default "one PO per item" mode. */
    private function perItemGroups(PurchaseRequest $pr, array $prices = [], array $types = []): array
    {
        return $pr->items->values()->map(function (PurchaseRequestItem $item, int $i) use ($prices, $types) {
            return [
                'group_name' => "بند مستقل: {$item->item_description}",
                'group_type' => $types[$i] ?? 'NONE',
                'supplier_id' => $item->supplier_id,
                'items' => [[
                    'pr_item_id' => $item->id,
                    'item_id' => $item->item_id,
                    'item_description' => $item->item_description,
                    'item_reference' => $item->item_reference,
                    'region' => $item->region,
                    'quantity' => (float) $item->quantity,
                    'uom' => $item->uom,
                    'unit_price' => $prices[$i] ?? (float) $item->estimated_unit_price,
                    'supplier_id' => $item->supplier_id,
                ]],
            ];
        })->all();
    }

    private function issue(PurchaseRequest $pr, array $payload = [], ?User $as = null)
    {
        return $this->actingAs($as ?? $this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', array_merge(['purchase_request_id' => $pr->id], $payload));
    }

    /** Ten lines: supplier A has 2 identical (same catalog item and price) + 3 different, supplier B has 5 different. */
    private function tenLineRequest(?Department $dept = null): PurchaseRequest
    {
        $tile = $this->catalogItem('سيراميك أرضيات');
        $lines = [
            ['description' => 'سيراميك أرضيات', 'qty' => 100, 'price' => 250, 'supplier' => $this->supplierA, 'item' => $tile],
            ['description' => 'سيراميك أرضيات', 'qty' => 40, 'price' => 250, 'supplier' => $this->supplierA, 'item' => $tile],
            ['description' => 'لاصق سيراميك', 'qty' => 30, 'price' => 90, 'supplier' => $this->supplierA, 'item' => $this->catalogItem('لاصق')],
            ['description' => 'ترويبة', 'qty' => 20, 'price' => 45, 'supplier' => $this->supplierA, 'item' => $this->catalogItem('ترويبة')],
            ['description' => 'زوايا ألومنيوم', 'qty' => 60, 'price' => 35.5, 'supplier' => $this->supplierA, 'item' => $this->catalogItem('زوايا')],
        ];
        foreach (['دهان بلاستيك', 'معجون', 'سيلر', 'ورق صنفرة', 'رولة دهان'] as $i => $name) {
            $lines[] = ['description' => $name, 'qty' => 10 + $i, 'price' => 100 + $i * 10, 'supplier' => $this->supplierB, 'item' => $this->catalogItem($name)];
        }

        return $this->approvedRequest($lines, $dept);
    }

    public static function consolidatingDepartments(): array
    {
        return [['FINISHING'], ['OFFICE'], ['LICENSES'], ['DEVELOPMENT']];
    }

    // ── The multi-supplier rule ─────────────────────────────────────────────

    #[Test]
    #[DataProvider('consolidatingDepartments')]
    public function ten_lines_on_two_suppliers_become_exactly_two_consolidated_pos(string $code): void
    {
        $dept = Department::firstOrCreate(['code' => $code], ['name' => "قسم {$code}", 'is_active' => true]);
        $pr = $this->tenLineRequest($dept);

        $response = $this->issue($pr, ['groups' => $this->perItemGroups($pr)]);

        $response->assertStatus(201)->assertJsonPath('consolidated', true)->assertJsonCount(2, 'data');
        $orders = PurchaseOrder::where('purchase_request_id', $pr->id)->with('items.sources')->orderBy('id')->get();
        $this->assertCount(2, $orders);

        $poA = $orders->firstWhere('supplier_id', $this->supplierA->id);
        $poB = $orders->firstWhere('supplier_id', $this->supplierB->id);
        $this->assertNotNull($poA);
        $this->assertNotNull($poB);

        // A: the two identical tiles are one line with two sources; the other three stay separate.
        $this->assertCount(4, $poA->items);
        $tiles = $poA->items->firstWhere('item_description', 'سيراميك أرضيات');
        $this->assertEquals(140.0, (float) $tiles->quantity);
        $this->assertEquals(35000.0, (float) $tiles->line_total);
        $this->assertNull($tiles->pr_item_id, 'a merged line points at no single request line');
        $this->assertCount(2, $tiles->sources);
        $this->assertCount(5, $poB->items);

        foreach ($orders as $po) {
            $this->assertSame(PurchaseOrder::CONSOLIDATION_POLICY_DEPARTMENT, $po->consolidation_policy);
            $this->assertSame(64, strlen((string) $po->consolidation_key));
            $this->assertSame('ISSUED', $po->status);

            foreach ($po->items as $line) {
                $this->assertSame((int) $po->supplier_id, (int) $line->supplier_id, 'line supplier = PO supplier');
                $this->assertNotEmpty($line->sources);
                $this->assertEqualsWithDelta((float) $line->quantity, $line->sources->sum(fn ($s) => (float) $s->line_quantity), 0.0001);
                $this->assertEqualsWithDelta((float) $line->line_total, $line->sources->sum(fn ($s) => (float) $s->line_amount), 0.001);
                foreach ($line->sources as $source) {
                    $this->assertSame((int) $po->supplier_id, (int) $source->supplier_id);
                    $this->assertSame($dept->id, (int) $source->department_id);
                    $this->assertSame($pr->id, (int) $source->purchase_request_id);
                    $this->assertTrue($source->isActive());
                }
            }
        }

        $this->assertEqualsWithDelta(
            $orders->sum(fn ($po) => (float) $po->grand_total),
            $pr->items->sum(fn ($i) => (float) $i->quantity * (float) $i->estimated_unit_price),
            0.01
        );

        // Every request line is ordered exactly once and the request is fully issued.
        $this->assertSame(10, PurchaseOrderItemSource::active()->where('purchase_request_id', $pr->id)->distinct()->count('purchase_request_item_id'));
        foreach ($pr->items as $item) {
            $this->assertTrue($item->fresh()->isOrdered());
        }
        $this->assertSame('ISSUED', $pr->fresh()->status);
    }

    #[Test]
    public function issuing_without_groups_or_items_takes_all_open_lines_and_still_splits_by_supplier(): void
    {
        $pr = $this->tenLineRequest();

        $this->issue($pr, ['supplier_id' => $this->supplierA->id])->assertStatus(201)->assertJsonCount(2, 'data');

        $this->assertSame(2, PurchaseOrder::where('purchase_request_id', $pr->id)->count());
        $this->assertSame(
            [$this->supplierA->id, $this->supplierB->id],
            PurchaseOrder::where('purchase_request_id', $pr->id)->orderBy('supplier_id')->pluck('supplier_id')->map(fn ($v) => (int) $v)->all()
        );
    }

    #[Test]
    public function the_same_item_at_a_different_price_stays_a_separate_line_in_the_same_po(): void
    {
        $paint = $this->catalogItem('دهان');
        $pr = $this->approvedRequest([
            ['description' => 'دهان', 'qty' => 10, 'price' => 100, 'supplier' => $this->supplierA, 'item' => $paint],
            ['description' => 'دهان', 'qty' => 5, 'price' => 100, 'supplier' => $this->supplierA, 'item' => $paint],
        ]);

        $this->issue($pr, ['groups' => $this->perItemGroups($pr, [100, 120])])->assertStatus(201)->assertJsonCount(1, 'data');

        $po = PurchaseOrder::where('purchase_request_id', $pr->id)->with('items')->sole();
        $this->assertCount(2, $po->items);
        $this->assertEqualsCanonicalizing([100.0, 120.0], $po->items->map(fn ($l) => (float) $l->unit_price)->all());
    }

    #[Test]
    public function the_same_item_with_different_specifications_or_units_stays_separate(): void
    {
        $pipe = $this->catalogItem('ماسورة صرف');
        $pr = $this->approvedRequest([
            ['description' => 'ماسورة صرف', 'qty' => 10, 'price' => 120, 'supplier' => $this->supplierA, 'item' => $pipe],
            ['description' => 'ماسورة صرف', 'qty' => 6, 'price' => 120, 'supplier' => $this->supplierA, 'item' => $pipe],
            ['description' => 'ماسورة صرف', 'qty' => 4, 'uom' => 'M', 'price' => 120, 'supplier' => $this->supplierA, 'item' => $pipe],
        ]);
        $groups = $this->perItemGroups($pr);
        $groups[0]['items'][0]['specifications'] = 'قطر 4 بوصة';
        $groups[1]['items'][0]['specifications'] = 'قطر 6 بوصة';
        $groups[2]['items'][0]['specifications'] = 'قطر 4 بوصة';

        $this->issue($pr, ['groups' => $groups])->assertStatus(201)->assertJsonCount(1, 'data');

        $po = PurchaseOrder::where('purchase_request_id', $pr->id)->with('items.sources')->sole();
        $this->assertCount(3, $po->items);
        foreach ($po->items as $line) {
            $this->assertCount(1, $line->sources);
            $this->assertSame((int) $line->sources->first()->purchase_request_item_id, (int) $line->pr_item_id);
        }
    }

    #[Test]
    public function different_plots_or_regions_of_the_same_supplier_are_separate_pos(): void
    {
        $pr = $this->approvedRequest([
            ['description' => 'بلاط', 'qty' => 10, 'price' => 80, 'supplier' => $this->supplierA, 'parcel' => 'PARCEL-1'],
            ['description' => 'رخام', 'qty' => 4, 'price' => 900, 'supplier' => $this->supplierA, 'parcel' => 'PARCEL-2'],
            ['description' => 'جبس', 'qty' => 7, 'price' => 60, 'supplier' => $this->supplierA, 'parcel' => 'PARCEL-1', 'region' => 'المنطقة الثانية'],
        ]);

        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(201)->assertJsonCount(3, 'data');

        foreach (PurchaseOrder::where('purchase_request_id', $pr->id)->with('items')->get() as $po) {
            $this->assertSame(1, $po->items->pluck('item_reference')->unique()->count());
            $this->assertSame(1, $po->items->pluck('region')->unique()->count());
        }
    }

    #[Test]
    public function a_line_without_a_supplier_is_refused_and_nothing_is_issued(): void
    {
        $pr = $this->approvedRequest([
            ['description' => 'دهان', 'qty' => 10, 'price' => 100, 'supplier' => $this->supplierA],
            ['description' => 'معجون', 'qty' => 5, 'price' => 40],
        ]);
        $groups = $this->perItemGroups($pr);
        $groups[1]['supplier_id'] = $this->supplierA->id; // the form needs a group supplier; the line itself has none
        $groups[1]['items'][0]['supplier_id'] = null;
        $pr->items[1]->update(['supplier_id' => null]);

        // With a group supplier the line resolves to it (same precedence as today) → one PO.
        $this->issue($pr, ['groups' => $groups])->assertStatus(201)->assertJsonCount(1, 'data');

        $orphan = $this->approvedRequest([['description' => 'سيلر', 'qty' => 1, 'price' => 10]]);
        $response = $this->issue($orphan, ['items' => [[
            'pr_item_id' => $orphan->items[0]->id, 'item_reference' => 'PARCEL-1', 'region' => 'المنطقة الأولى', 'quantity' => 1, 'unit_price' => 10,
        ]], 'one_time_supplier_name' => '   ']);

        $response->assertStatus(422);
        $this->assertSame(0, PurchaseOrder::where('purchase_request_id', $orphan->id)->count());
        $this->assertSame(0, PurchaseOrderItemSource::where('purchase_request_id', $orphan->id)->count());
    }

    #[Test]
    public function a_failure_in_one_supplier_po_rolls_back_every_po_of_the_issue(): void
    {
        $pr = $this->tenLineRequest();
        $this->supplierB->update(['is_active' => false]);

        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(422);

        $this->assertSame(0, PurchaseOrder::withTrashed()->where('purchase_request_id', $pr->id)->count());
        $this->assertSame(0, PurchaseOrderItem::count());
        $this->assertSame(0, PurchaseOrderItemSource::count());
        $this->assertSame('APPROVED_BY_PROCUREMENT', $pr->fresh()->status);
    }

    // ── Duplicates and idempotency ──────────────────────────────────────────

    #[Test]
    public function issuing_the_same_request_again_is_refused(): void
    {
        $pr = $this->tenLineRequest();
        $groups = $this->perItemGroups($pr);
        $this->issue($pr, ['groups' => $groups])->assertStatus(201);

        $this->issue($pr, ['groups' => $groups])->assertStatus(409);
        $this->issue($pr, ['supplier_id' => $this->supplierA->id])->assertStatus(409);

        $this->assertSame(2, PurchaseOrder::where('purchase_request_id', $pr->id)->count());
        $this->assertSame(10, PurchaseOrderItemSource::count());
    }

    #[Test]
    public function a_retry_with_the_same_idempotency_key_returns_the_orders_already_issued(): void
    {
        $pr = $this->tenLineRequest();
        $payload = ['groups' => $this->perItemGroups($pr), 'idempotency_key' => '6f1c2a9e-0b7d-4c55-9a43-1e2f3a4b5c6d'];

        $first = $this->issue($pr, $payload)->assertStatus(201);
        $second = $this->issue($pr, $payload)->assertStatus(200)->assertJsonPath('replayed', true);

        $this->assertSame(
            collect($first->json('data'))->pluck('id')->sort()->values()->all(),
            collect($second->json('data'))->pluck('id')->sort()->values()->all()
        );
        $this->assertSame(2, PurchaseOrder::count());

        $other = $this->approvedRequest([['description' => 'سيلر', 'qty' => 1, 'price' => 10, 'supplier' => $this->supplierA]]);
        $this->issue($other, ['groups' => $this->perItemGroups($other), 'idempotency_key' => $payload['idempotency_key']])->assertStatus(409);
    }

    #[Test]
    public function a_malformed_idempotency_key_is_rejected(): void
    {
        $pr = $this->tenLineRequest();

        $this->issue($pr, ['groups' => $this->perItemGroups($pr), 'idempotency_key' => 'abc%_'])->assertStatus(422);
        $this->assertSame(0, PurchaseOrder::count());
    }

    // ── Cancel / release ────────────────────────────────────────────────────

    #[Test]
    public function cancelling_a_consolidated_po_releases_its_lines_without_deleting_history(): void
    {
        $pr = $this->tenLineRequest();
        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(201);
        $poA = PurchaseOrder::where('supplier_id', $this->supplierA->id)->sole();
        $aItemIds = $pr->items->where('supplier_id', $this->supplierA->id)->pluck('id')->all();

        $poA->update(['status' => 'CANCELLED']);

        $this->assertSame(5, PurchaseOrderItemSource::whereIn('purchase_request_item_id', $aItemIds)->count(), 'history kept');
        $this->assertSame(0, PurchaseOrderItemSource::active()->whereIn('purchase_request_item_id', $aItemIds)->count());
        $this->assertNotNull(PurchaseOrderItemSource::whereIn('purchase_request_item_id', $aItemIds)->first()->released_at);
        foreach ($aItemIds as $id) {
            $this->assertFalse(PurchaseRequestItem::find($id)->isOrdered());
        }

        // The released lines can be issued again into a new supplier-A order.
        $this->assertSame('ISSUED', $pr->fresh()->status);
        $pr->fresh()->update(['status' => 'APPROVED_BY_PROCUREMENT']);
        $this->issue($pr, ['supplier_id' => $this->supplierA->id])->assertStatus(201)->assertJsonCount(1, 'data');
        $this->assertSame(5, PurchaseOrderItemSource::active()->whereIn('purchase_request_item_id', $aItemIds)->count());
    }

    // ── Editing a consolidated PO ───────────────────────────────────────────

    #[Test]
    public function a_consolidated_line_cannot_be_deleted_and_added_lines_keep_the_po_supplier(): void
    {
        $pr = $this->tenLineRequest();
        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(201);
        $poA = PurchaseOrder::where('supplier_id', $this->supplierA->id)->with('items')->sole();
        $line = $poA->items->first();

        $this->actingAs($this->procurementManager, 'sanctum')
            ->deleteJson("/api/v1/procurement/purchase-orders/{$poA->id}/items/{$line->id}")
            ->assertStatus(422);
        $this->assertDatabaseHas('purchase_order_items', ['id' => $line->id]);

        $updated = app(PurchaseOrderService::class)->addItem($this->procurementManager, $poA, [
            'item_description' => 'بند إضافي', 'item_reference' => 'PARCEL-1', 'region' => 'المنطقة الأولى', 'quantity' => 1, 'unit_price' => 10,
        ]);
        $this->assertSame($this->supplierA->id, (int) $updated->items->firstWhere('item_description', 'بند إضافي')->supplier_id);

        $this->expectException(ValidationException::class);
        app(PurchaseOrderService::class)->addItem($this->procurementManager, $poA, [
            'item_description' => 'بند لمورد آخر', 'item_reference' => 'PARCEL-1', 'region' => 'المنطقة الأولى',
            'quantity' => 1, 'unit_price' => 10, 'supplier_id' => $this->supplierB->id,
        ]);
    }

    // ── Steel weighing and shared shipment inside the consolidated PO ───────

    #[Test]
    public function a_steel_weighing_group_becomes_one_steel_line_inside_the_suppliers_po(): void
    {
        $pr = $this->approvedRequest([
            ['description' => 'حديد تسليح 12 مم', 'qty' => 10, 'uom' => 'TON', 'price' => 38000, 'supplier' => $this->supplierA],
            ['description' => 'حديد تسليح 16 مم', 'qty' => 5, 'uom' => 'TON', 'price' => 37500, 'supplier' => $this->supplierA],
            ['description' => 'سلك رباط', 'qty' => 20, 'price' => 60, 'supplier' => $this->supplierA],
        ]);
        $groups = $this->perItemGroups($pr);
        $steel = [
            'group_name' => 'حديد', 'group_type' => 'STEEL_WEIGHING', 'supplier_id' => $this->supplierA->id,
            'items' => array_merge($groups[0]['items'], $groups[1]['items']),
        ];

        $this->issue($pr, ['groups' => [$steel, $groups[2]]])->assertStatus(201)->assertJsonCount(1, 'data');

        $po = PurchaseOrder::where('purchase_request_id', $pr->id)->with('items.sources')->sole();
        $this->assertCount(2, $po->items);
        $steelLine = $po->items->firstWhere('is_consolidated_steel', true);
        $this->assertNotNull($steelLine);
        $this->assertEquals(15.0, (float) $steelLine->quantity);
        $this->assertCount(2, $steelLine->sources, 'the diameters\' provenance moved onto the steel line');
        $this->assertEqualsWithDelta(380000 + 187500, $steelLine->sources->sum(fn ($s) => (float) $s->line_amount), 0.01);
        $this->assertSame(1, WeighingGroup::where('purchase_order_id', $po->id)->count());
        $this->assertSame(3, PurchaseOrderItemSource::active()->count());
    }

    #[Test]
    public function a_shared_shipment_spanning_two_suppliers_is_refused(): void
    {
        $pr = $this->approvedRequest([
            ['description' => 'رمل', 'qty' => 10, 'price' => 200, 'supplier' => $this->supplierA],
            ['description' => 'أسمنت', 'qty' => 50, 'price' => 90, 'supplier' => $this->supplierB],
        ]);
        $groups = $this->perItemGroups($pr);
        $shipment = [
            'group_name' => 'شحنة', 'group_type' => 'SHARED_SHIPMENT', 'supplier_id' => $this->supplierA->id,
            'items' => array_merge($groups[0]['items'], $groups[1]['items']),
        ];

        $this->issue($pr, ['groups' => [$shipment]])->assertStatus(422);
        $this->assertSame(0, PurchaseOrder::count());
    }

    // ── Preview and the request flag (used by the PO screen) ────────────────

    #[Test]
    public function the_preview_shows_the_orders_issue_would_create_and_saves_nothing(): void
    {
        $pr = $this->tenLineRequest();
        $groups = $this->perItemGroups($pr);
        $groups[9]['supplier_id'] = null;
        $groups[9]['items'][0]['supplier_id'] = null;
        $groups[9]['one_time_supplier_name'] = 'مورد لمرة واحدة';
        $pr->items[9]->update(['supplier_id' => null]);
        $suppliersBefore = Supplier::count();

        $response = $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders/consolidation-preview', ['purchase_request_id' => $pr->id, 'groups' => $groups])
            ->assertStatus(200)
            ->assertJsonPath('consolidated', true)
            ->assertJsonCount(3, 'data');

        $orderA = collect($response->json('data'))->firstWhere('supplier_id', $this->supplierA->id);
        $this->assertCount(4, $orderA['lines']);
        $tiles = collect($orderA['lines'])->firstWhere('item_description', 'سيراميك أرضيات');
        $this->assertEquals(140, $tiles['quantity']);
        $this->assertCount(2, $tiles['source_pr_item_ids']);
        $this->assertEquals(140 * 250 + 30 * 90 + 20 * 45 + 60 * 35.5, $orderA['subtotal']);

        $this->assertSame(0, PurchaseOrder::count());
        $this->assertSame(0, PurchaseOrderItemSource::count());
        $this->assertSame($suppliersBefore, Supplier::count(), 'the one-time supplier is not created by a preview');
    }

    #[Test]
    public function the_preview_reports_the_same_refusals_as_issuing(): void
    {
        $pr = $this->approvedRequest([
            ['description' => 'رمل', 'qty' => 10, 'price' => 200, 'supplier' => $this->supplierA],
            ['description' => 'أسمنت', 'qty' => 50, 'price' => 90, 'supplier' => $this->supplierB],
        ]);
        $groups = $this->perItemGroups($pr);
        $shipment = ['group_type' => 'SHARED_SHIPMENT', 'supplier_id' => $this->supplierA->id, 'items' => array_merge($groups[0]['items'], $groups[1]['items'])];

        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders/consolidation-preview', ['purchase_request_id' => $pr->id, 'groups' => [$shipment]])
            ->assertStatus(422);

        $other = $this->approvedRequest([['description' => 'رمل', 'qty' => 10, 'price' => 200, 'supplier' => $this->supplierA]], $this->execution);
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders/consolidation-preview', ['purchase_request_id' => $other->id, 'groups' => $this->perItemGroups($other)])
            ->assertStatus(200)->assertJsonPath('consolidated', false)->assertJsonCount(0, 'data');
    }

    #[Test]
    public function the_request_tells_the_screen_whether_consolidation_is_mandatory(): void
    {
        $finishing = $this->tenLineRequest();
        $execution = $this->approvedRequest([['description' => 'رمل', 'qty' => 10, 'price' => 200, 'supplier' => $this->supplierA]], $this->execution);

        $this->actingAs($this->procurementManager, 'sanctum')->getJson("/api/v1/procurement/purchase-requests/{$finishing->id}")
            ->assertStatus(200)->assertJsonPath('data.consolidated_po_required', true);
        $this->actingAs($this->procurementManager, 'sanctum')->getJson("/api/v1/procurement/purchase-requests/{$execution->id}")
            ->assertStatus(200)->assertJsonPath('data.consolidated_po_required', false);

        config(['procurement.consolidated_po.enabled' => false]);
        $this->actingAs($this->procurementManager, 'sanctum')->getJson("/api/v1/procurement/purchase-requests/{$finishing->id}")
            ->assertStatus(200)->assertJsonPath('data.consolidated_po_required', false);
    }

    // ── Regression: everything else behaves as before ───────────────────────

    #[Test]
    public function other_departments_keep_one_po_per_item(): void
    {
        $pr = $this->approvedRequest([
            ['description' => 'رمل', 'qty' => 10, 'price' => 200, 'supplier' => $this->supplierA],
            ['description' => 'زلط', 'qty' => 12, 'price' => 210, 'supplier' => $this->supplierA],
            ['description' => 'أسمنت', 'qty' => 50, 'price' => 90, 'supplier' => $this->supplierB],
        ], $this->execution);

        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(201)->assertJsonMissingPath('consolidated');

        $orders = PurchaseOrder::where('purchase_request_id', $pr->id)->get();
        $this->assertCount(3, $orders);
        $this->assertTrue($orders->every(fn ($po) => $po->consolidation_policy === null));
        $this->assertSame(0, PurchaseOrderItemSource::count());
    }

    #[Test]
    public function an_office_supplies_request_from_another_department_is_not_consolidated(): void
    {
        $pr = $this->approvedRequest([
            ['description' => 'ورق تصوير', 'qty' => 10, 'price' => 150, 'supplier' => $this->supplierA],
            ['description' => 'أقلام', 'qty' => 50, 'price' => 5, 'supplier' => $this->supplierA],
        ], $this->execution, ['request_type' => 'OFFICE_SUPPLIES']);

        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(201);

        $this->assertSame(2, PurchaseOrder::where('purchase_request_id', $pr->id)->count());
        $this->assertSame(0, PurchaseOrderItemSource::count());
    }

    #[Test]
    public function with_the_flag_off_a_finishing_request_keeps_todays_behavior(): void
    {
        config(['procurement.consolidated_po.enabled' => false]);
        $pr = $this->tenLineRequest();

        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(201);

        $this->assertSame(10, PurchaseOrder::where('purchase_request_id', $pr->id)->count());
        $this->assertSame(0, PurchaseOrderItemSource::count());
    }

    #[Test]
    public function a_user_without_po_permission_cannot_issue(): void
    {
        $pr = $this->tenLineRequest();
        $stranger = $this->makeUser('nobody@cons-issue.test', null);

        $this->issue($pr, ['groups' => $this->perItemGroups($pr)], $stranger)->assertStatus(403);
        $this->assertSame(0, PurchaseOrder::count());
    }

    #[Test]
    public function an_unapproved_request_cannot_be_issued(): void
    {
        $pr = $this->tenLineRequest();
        $pr->update(['status' => 'PENDING_REVIEW']);

        $this->issue($pr, ['groups' => $this->perItemGroups($pr)])->assertStatus(409);
        $this->assertSame(0, PurchaseOrder::count());
    }
}
