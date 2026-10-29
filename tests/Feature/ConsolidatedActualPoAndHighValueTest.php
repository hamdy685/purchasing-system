<?php

namespace Tests\Feature;

use App\Models\AuditLog;
use App\Models\Attachment;
use App\Models\Category;
use App\Models\Department;
use App\Models\Item;
use App\Models\Notification;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseOrderItemSource;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseReceiptItem;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Config;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * المرحلة 3: الاستلام وأمر الشراء الفعلي لأوامر الشراء المجمعة، وصلاحيات مدير المشتريات الكاملة
 * قبل الإصدار، والمرفقات المتعددة، وتحذير الـ 500 ألف (لكل الأقسام).
 */
class ConsolidatedActualPoAndHighValueTest extends TestCase
{
    use RefreshDatabase;

    private Department $finishing;
    private Department $execution;
    private User $procurementManager;
    private User $generalManager;
    private User $accountant;
    private User $warehouseKeeper;
    private User $siteEngineer;
    private Supplier $supplierA;
    private Supplier $supplierB;
    private Supplier $supplierC;
    private Category $category;
    private int $seq = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);
        config(['procurement.consolidated_po.enabled' => true]);
        Config::set('google_drive.enabled', false);
        Storage::fake('public');

        $this->finishing = Department::create(['name' => 'التشطيبات', 'code' => 'FINISHING', 'is_active' => true]);
        $this->execution = Department::create(['name' => 'التنفيذ', 'code' => 'EXECUTION', 'is_active' => true]);

        $this->procurementManager = $this->makeUser('pm@actual.test', 'procurement_manager');
        $this->generalManager = $this->makeUser('gm@actual.test', 'general_manager');
        $this->accountant = $this->makeUser('acct@actual.test', 'accountant');
        $this->warehouseKeeper = $this->makeUser('wh@actual.test', 'warehouse_keeper');
        $this->siteEngineer = $this->makeUser('se@actual.test', 'site_engineer');

        $this->supplierA = $this->supplier('A');
        $this->supplierB = $this->supplier('B');
        $this->supplierC = $this->supplier('C');
        $this->category = Category::create(['name' => 'خامات', 'code' => 'MAT', 'is_active' => true]);
    }

    private function makeUser(string $email, string $role): User
    {
        $user = User::create([
            'name' => $email, 'email' => $email, 'password' => bcrypt('Password123!'),
            'department_id' => $this->finishing->id, 'is_active' => true,
        ]);
        $user->roles()->attach(Role::where('slug', $role)->firstOrFail());

        return $user;
    }

    private function supplier(string $code): Supplier
    {
        return Supplier::create(['code' => "SUP-{$code}", 'company_name' => "المورد {$code}", 'contact_name' => $code, 'is_active' => true, 'opening_balance' => 0]);
    }

    private function catalogItem(string $name): Item
    {
        $this->seq++;

        return Item::create(['category_id' => $this->category->id, 'sku' => "SKU-AP-{$this->seq}", 'name' => $name, 'uom' => 'PCS', 'is_active' => true]);
    }

    private function approvedRequest(array $lines, ?Department $dept = null): PurchaseRequest
    {
        $this->seq++;
        $dept ??= $this->finishing;
        $pr = PurchaseRequest::create([
            'request_number' => "PR-AP-{$this->seq}",
            'request_type' => 'PROJECT',
            'department_id' => $dept->id,
            'target_department_id' => $dept->id,
            'user_id' => $this->procurementManager->id,
            'site_engineer_user_id' => $this->siteEngineer->id,
            'requires_warehouse_receipt' => true,
            'status' => 'APPROVED_BY_PROCUREMENT',
        ]);
        foreach ($lines as $line) {
            $pr->items()->create([
                'item_id' => ($line['item'] ?? null)?->id,
                'supplier_id' => $line['supplier']->id,
                'item_description' => $line['description'],
                'item_reference' => 'PARCEL-7',
                'region' => 'المنطقة السابعة',
                'quantity' => $line['qty'],
                'uom' => 'PCS',
                'estimated_unit_price' => $line['price'],
                'estimated_line_total' => $line['qty'] * $line['price'],
            ]);
        }

        return $pr->fresh('items');
    }

    /** Issue through the real API with the UI's default one-group-per-item payload. */
    private function issue(PurchaseRequest $pr): array
    {
        $groups = $pr->items->map(fn ($item) => [
            'group_name' => $item->item_description, 'group_type' => 'NONE', 'supplier_id' => $item->supplier_id,
            'items' => [[
                'pr_item_id' => $item->id, 'item_id' => $item->item_id, 'item_description' => $item->item_description,
                'item_reference' => $item->item_reference, 'region' => $item->region, 'quantity' => (float) $item->quantity,
                'uom' => $item->uom, 'unit_price' => (float) $item->estimated_unit_price, 'supplier_id' => $item->supplier_id,
            ]],
        ])->values()->all();

        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', ['purchase_request_id' => $pr->id, 'groups' => $groups])
            ->assertStatus(201);

        return PurchaseOrder::where('purchase_request_id', $pr->id)->with('items.sources')->orderBy('id')->get()
            ->keyBy('supplier_id')->all();
    }

    /** Warehouse receives (optionally different quantities) and the site engineer approves. */
    private function receiveAndApprove(PurchaseOrder $po, array $receivedByLineId = []): PurchaseReceipt
    {
        $items = $po->items()->get()->map(fn ($line) => [
            'purchase_order_item_id' => $line->id,
            'received_quantity' => $receivedByLineId[$line->id] ?? (float) $line->quantity,
        ])->all();

        $response = $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", ['items' => $items]);
        $response->assertStatus(201);
        $receipt = PurchaseReceipt::findOrFail($response->json('data.id'));

        $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve")
            ->assertStatus(200);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);

        return $receipt->fresh('items');
    }

    private function finalizePayload(PurchaseOrder $po, array $overrides = []): array
    {
        return $po->items()->orderBy('id')->get()->map(fn ($line) => array_merge([
            'id' => $line->id,
            'item_description' => $line->item_description,
            'item_reference' => $line->item_reference,
            'region' => $line->region,
            'quantity' => (float) $line->quantity,
            'uom' => $line->uom,
            'unit_price' => (float) $line->unit_price,
        ], $overrides[$line->id] ?? []))->all();
    }

    private function finalize(PurchaseOrder $po, array $payload)
    {
        return $this->actingAs($this->procurementManager, 'sanctum')
            ->post("/api/v1/procurement/purchase-orders/{$po->id}/finalize", $payload, ['Accept' => 'application/json']);
    }

    /** A PO for any department waiting for its Actual PO, with one line. */
    private function pendingActualPo(Department $dept, float $unitPrice): PurchaseOrder
    {
        $pr = $this->approvedRequest([['description' => 'معدة', 'qty' => 1, 'price' => $unitPrice, 'supplier' => $this->supplierA]], $dept);
        $this->seq++;
        $po = PurchaseOrder::create([
            'po_number' => "PO-HV-{$this->seq}", 'purchase_request_id' => $pr->id, 'supplier_id' => $this->supplierA->id,
            'created_by_user_id' => $this->procurementManager->id, 'status' => 'PENDING_ACTUAL_PO',
        ]);
        $po->items()->create([
            'pr_item_id' => $pr->items[0]->id, 'item_description' => 'معدة', 'item_reference' => 'PARCEL-7', 'region' => 'المنطقة السابعة',
            'quantity' => 1, 'uom' => 'PCS', 'unit_price' => 1, 'line_total' => 1, 'supplier_id' => $this->supplierA->id,
        ]);

        return $po->fresh('items');
    }

    // ── Receiving ───────────────────────────────────────────────────────────

    #[Test]
    public function each_supplier_po_is_received_separately_with_its_own_supplier_and_lines(): void
    {
        $tile = $this->catalogItem('سيراميك');
        $orders = $this->issue($this->approvedRequest([
            ['description' => 'سيراميك', 'qty' => 100, 'price' => 250, 'supplier' => $this->supplierA, 'item' => $tile],
            ['description' => 'سيراميك', 'qty' => 40, 'price' => 250, 'supplier' => $this->supplierA, 'item' => $tile],
            ['description' => 'دهان', 'qty' => 10, 'price' => 300, 'supplier' => $this->supplierB],
        ]));
        $poA = $orders[$this->supplierA->id];
        $poB = $orders[$this->supplierB->id];

        // A line of B's order cannot be received on A's receipt.
        $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$poA->id}", ['items' => [
                ['purchase_order_item_id' => $poA->items[0]->id, 'received_quantity' => 140],
                ['purchase_order_item_id' => $poB->items[0]->id, 'received_quantity' => 10],
            ]])
            ->assertStatus(422);
        $this->assertSame(0, PurchaseReceipt::count());

        $merged = $poA->items->sole();
        $receiptA = $this->receiveAndApprove($poA, [$merged->id => 138]);
        $receiptB = $this->receiveAndApprove($poB);

        $this->assertSame($this->supplierA->id, (int) $receiptA->supplier_id);
        $this->assertSame($this->supplierB->id, (int) $receiptB->supplier_id);
        $this->assertSame([$merged->id], $receiptA->items->pluck('purchase_order_item_id')->map(fn ($v) => (int) $v)->all());
        $this->assertEquals(140.0, (float) $receiptA->items->sole()->ordered_quantity);
        $this->assertEquals(138.0, (float) $receiptA->items->sole()->received_quantity, 'received once on the merged line');
    }

    // ── Actual PO on a consolidated order ───────────────────────────────────

    #[Test]
    public function the_actual_po_stays_consolidated_and_never_touches_received_quantities_or_sources(): void
    {
        $tile = $this->catalogItem('سيراميك');
        $poA = $this->issue($this->approvedRequest([
            ['description' => 'سيراميك', 'qty' => 100, 'price' => 250, 'supplier' => $this->supplierA, 'item' => $tile],
            ['description' => 'سيراميك', 'qty' => 40, 'price' => 250, 'supplier' => $this->supplierA, 'item' => $tile],
            ['description' => 'لاصق', 'qty' => 30, 'price' => 90, 'supplier' => $this->supplierA],
        ]))[$this->supplierA->id];
        $merged = $poA->items->firstWhere('item_description', 'سيراميك');
        $sourcesBefore = $merged->sources->map->only(['id', 'purchase_request_item_id', 'line_quantity', 'line_amount'])->all();
        $receipt = $this->receiveAndApprove($poA, [$merged->id => 138]);

        $this->finalize($poA, ['items' => $this->finalizePayload($poA, [$merged->id => ['quantity' => 138, 'unit_price' => 245]])])
            ->assertStatus(200);

        $final = PurchaseOrder::with('items.sources')->findOrFail($poA->id);
        $this->assertSame('ISSUED', $final->status);
        $this->assertCount(2, $final->items, 'no per-source lines rebuilt');
        $line = $final->items->firstWhere('id', $merged->id);
        $this->assertEquals(138.0, (float) $line->quantity);
        $this->assertEquals(138 * 245, (float) $line->line_total);
        $this->assertEquals($sourcesBefore, $line->sources->map->only(['id', 'purchase_request_item_id', 'line_quantity', 'line_amount'])->all(), 'contractual provenance unchanged');
        $this->assertEquals(138.0, (float) PurchaseReceiptItem::where('purchase_receipt_id', $receipt->id)->where('purchase_order_item_id', $merged->id)->value('received_quantity'));
        $this->assertEquals(138 * 245 + 30 * 90, (float) $final->grand_total);
    }

    #[Test]
    public function lines_of_a_consolidated_actual_po_are_matched_by_id_only(): void
    {
        $poA = $this->issue($this->approvedRequest([
            ['description' => 'باب', 'qty' => 2, 'price' => 3000, 'supplier' => $this->supplierA, 'item' => $this->catalogItem('باب')],
            ['description' => 'باب', 'qty' => 1, 'price' => 4500, 'supplier' => $this->supplierA, 'item' => $this->catalogItem('باب مصفح')],
        ]))[$this->supplierA->id];
        [$first, $second] = $poA->items->sortBy('id')->values()->all();
        $this->receiveAndApprove($poA);

        // Same description on both lines, sent in reverse order: each line must keep its own values.
        $payload = array_reverse($this->finalizePayload($poA, [
            $first->id => ['unit_price' => 2900],
            $second->id => ['unit_price' => 4400],
        ]));
        $this->finalize($poA, ['items' => $payload])->assertStatus(200);

        $this->assertEquals(2900.0, (float) PurchaseOrderItem::find($first->id)->unit_price);
        $this->assertEquals(4400.0, (float) PurchaseOrderItem::find($second->id)->unit_price);
        $this->assertSame(2, PurchaseOrderItem::where('purchase_order_id', $poA->id)->count());
    }

    #[Test]
    public function the_whole_consolidated_order_may_move_to_another_supplier_but_never_split(): void
    {
        $poA = $this->issue($this->approvedRequest([
            ['description' => 'رمل', 'qty' => 10, 'price' => 200, 'supplier' => $this->supplierA],
            ['description' => 'زلط', 'qty' => 12, 'price' => 210, 'supplier' => $this->supplierA],
        ]))[$this->supplierA->id];
        $receipt = $this->receiveAndApprove($poA);
        [$sand, $gravel] = $poA->items->sortBy('id')->values()->all();

        // One line to supplier B → refused, nothing changes.
        $this->finalize($poA, ['items' => $this->finalizePayload($poA, [$gravel->id => ['supplier_id' => $this->supplierB->id]])])
            ->assertStatus(422);
        $this->assertSame('PENDING_ACTUAL_PO', $poA->fresh()->status);
        $this->assertSame($this->supplierA->id, (int) PurchaseOrderItem::find($gravel->id)->supplier_id);

        // Header B with one line still A → refused.
        $this->finalize($poA, ['supplier_id' => $this->supplierB->id, 'items' => $this->finalizePayload($poA, [$sand->id => ['supplier_id' => $this->supplierA->id]])])
            ->assertStatus(422);

        // The whole order to supplier C → accepted, every line and the receipt follow.
        $this->finalize($poA, ['supplier_id' => $this->supplierC->id, 'items' => $this->finalizePayload($poA)])->assertStatus(200);
        $final = PurchaseOrder::with('items')->findOrFail($poA->id);
        $this->assertSame($this->supplierC->id, (int) $final->supplier_id);
        $this->assertTrue($final->items->every(fn ($l) => (int) $l->supplier_id === $this->supplierC->id));
        $this->assertSame($this->supplierC->id, (int) $receipt->fresh()->supplier_id);
    }

    #[Test]
    public function procurement_can_edit_everything_before_issue_and_nothing_after(): void
    {
        $poA = $this->issue($this->approvedRequest([
            ['description' => 'رمل', 'qty' => 10, 'price' => 200, 'supplier' => $this->supplierA],
        ]))[$this->supplierA->id];
        $this->receiveAndApprove($poA);
        $line = $poA->items->sole();

        $payload = $this->finalizePayload($poA, [$line->id => [
            'item_description' => 'رمل مغسول', 'specifications' => 'ناعم', 'uom' => 'M3', 'quantity' => 9.5, 'unit_price' => 210,
        ]]);
        $payload[] = ['item_description' => 'نقل', 'item_reference' => 'PARCEL-7', 'region' => 'المنطقة السابعة', 'quantity' => 1, 'uom' => 'TRIP', 'unit_price' => 500];

        $this->finalize($poA, [
            'items' => $payload, 'notes' => 'تعديلات الفعلي', 'discount_type' => 'TOTAL', 'discount_percentage' => 10,
        ])->assertStatus(200);

        $final = PurchaseOrder::with('items')->findOrFail($poA->id);
        $edited = $final->items->firstWhere('id', $line->id);
        $this->assertSame('رمل مغسول', $edited->item_description);
        $this->assertSame('ناعم', $edited->specifications);
        $this->assertSame('M3', $edited->uom);
        $added = $final->items->firstWhere('item_description', 'نقل');
        $this->assertNotNull($added);
        $this->assertSame($this->supplierA->id, (int) $added->supplier_id, 'added line belongs to the order supplier');
        $this->assertEquals(round((9.5 * 210 + 500) * 0.9, 2), (float) $final->grand_total);
        $this->assertTrue(AuditLog::where('entity_type', PurchaseOrderItem::class)->where('entity_id', $line->id)->where('action', 'PO_ITEM_UPDATED')->exists());
        $this->assertTrue(AuditLog::where('action', 'PO_ITEM_ADDED')->where('entity_id', $added->id)->exists());

        // After issue the Actual PO is locked.
        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$poA->id}/items", ['item_description' => 'x', 'item_reference' => 'PARCEL-7', 'region' => 'المنطقة السابعة', 'quantity' => 1, 'unit_price' => 1])
            ->assertStatus(409);
        $this->actingAs($this->procurementManager, 'sanctum')
            ->putJson("/api/v1/procurement/purchase-orders/{$poA->id}/items/{$line->id}", ['item_reference' => 'PARCEL-7', 'region' => 'المنطقة السابعة', 'quantity' => 1, 'unit_price' => 1])
            ->assertStatus(409);
        $this->actingAs($this->procurementManager, 'sanctum')
            ->deleteJson("/api/v1/procurement/purchase-orders/{$poA->id}/items/{$added->id}")
            ->assertStatus(409);
        $this->finalize($poA->fresh(), ['items' => $this->finalizePayload($poA)])->assertStatus(409);
        $this->assertSame(2, PurchaseOrderItem::where('purchase_order_id', $poA->id)->count());
    }

    // ── 500,000 warning (all departments) ───────────────────────────────────

    #[Test]
    public function up_to_the_threshold_no_reason_is_needed(): void
    {
        foreach ([499999.99, 500000.00] as $price) {
            $po = $this->pendingActualPo($this->execution, $price);
            $this->finalize($po, ['items' => $this->finalizePayload($po, [$po->items[0]->id => ['unit_price' => $price]])])->assertStatus(200);
            $this->assertNull($po->fresh()->high_value_reason);
        }
        $this->assertSame(0, Notification::where('type', 'purchase_order_actual_high_value')->count());
    }

    #[Test]
    public function above_the_threshold_without_a_reason_nothing_is_saved(): void
    {
        $po = $this->pendingActualPo($this->execution, 1);
        $line = $po->items[0];

        foreach ([null, '   ', 'قصير'] as $reason) {
            $payload = ['items' => $this->finalizePayload($po, [$line->id => ['unit_price' => 500000.01]])];
            if ($reason !== null) {
                $payload['high_value_reason'] = $reason;
            }

            $this->finalize($po, $payload)
                ->assertStatus(422)
                ->assertJsonPath('code', 'HIGH_VALUE_REASON_REQUIRED')
                ->assertJsonPath('grand_total', 500000.01)
                ->assertJsonValidationErrors('high_value_reason');
        }

        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);
        $this->assertNull($po->fresh()->finalized_at);
        $this->assertEquals(1.0, (float) $line->fresh()->unit_price, 'line edits rolled back');
    }

    #[Test]
    public function above_the_threshold_with_a_reason_it_is_issued_recorded_and_notified(): void
    {
        $po = $this->pendingActualPo($this->finishing, 1);
        $reason = 'توريد معدات تكييف مركزي للمبنى بالكامل';

        $this->finalize($po, [
            'items' => $this->finalizePayload($po, [$po->items[0]->id => ['unit_price' => 750000]]),
            'high_value_reason' => $reason,
        ])->assertStatus(200)->assertJsonPath('data.high_value_reason', $reason);

        $final = $po->fresh();
        $this->assertSame('ISSUED', $final->status);
        $this->assertSame($reason, $final->high_value_reason);
        $this->assertEquals(500000.0, (float) $final->high_value_threshold);
        $this->assertSame($this->procurementManager->id, (int) $final->high_value_acknowledged_by_user_id);
        $this->assertNotNull($final->high_value_acknowledged_at);
        $this->assertTrue(AuditLog::where('action', 'ACTUAL_PO_HIGH_VALUE_ACKNOWLEDGED')->where('entity_id', $po->id)->exists());

        $notified = Notification::where('type', 'purchase_order_actual_high_value')->pluck('user_id')->map(fn ($v) => (int) $v)->all();
        $this->assertContains($this->generalManager->id, $notified, 'the one informational notice the GM receives');
        $this->assertContains($this->accountant->id, $notified);
        $this->assertNotContains($this->warehouseKeeper->id, $notified);
        $this->assertNotContains($this->executionManager()->id, $notified);

        // The GM sees it in the notification list and the unread count.
        $list = $this->actingAs($this->generalManager, 'sanctum')->getJson('/api/v1/notifications')->assertStatus(200);
        $this->assertContains('purchase_order_actual_high_value', collect($list->json('data'))->pluck('type')->all());
        $this->actingAs($this->generalManager, 'sanctum')->getJson('/api/v1/notifications/unread-count')
            ->assertStatus(200)->assertJsonPath('unread_count', 1);
    }

    #[Test]
    public function the_executive_gate_still_blocks_every_other_informational_notification(): void
    {
        $po = $this->pendingActualPo($this->execution, 1000);
        $service = app(\App\Services\NotificationService::class);

        $this->assertNull($service->createNotification($this->generalManager, 'purchase_order_actual_issued_accounting', 'x', 'y', $po));
        $this->assertNull($service->createNotification($this->executionManager(), 'purchase_order_actual_high_value', 'x', 'y', $po));
        $this->assertNotNull($service->createNotification($this->generalManager, 'purchase_order_actual_high_value', 'x', 'y', $po));

        // An informational notice stored for the GM by some other path is still hidden from the list.
        Notification::create([
            'user_id' => $this->generalManager->id, 'type' => 'purchase_order_actual_issued_accounting', 'title' => 'x', 'message' => 'y',
            'notifiable_type' => PurchaseOrder::class, 'notifiable_id' => $po->id, 'purchase_order_id' => $po->id,
        ]);
        $types = collect($this->actingAs($this->generalManager, 'sanctum')->getJson('/api/v1/notifications')->json('data'))->pluck('type')->all();
        $this->assertSame(['purchase_order_actual_high_value'], $types);
    }

    private function executionManager(): User
    {
        return User::where('email', 'em@actual.test')->first() ?? $this->makeUser('em@actual.test', 'execution_manager');
    }

    #[Test]
    public function the_threshold_applies_after_discount_and_tax(): void
    {
        $po = $this->pendingActualPo($this->execution, 1);

        // 520,000 − 5% = 494,000 → no reason needed.
        $this->finalize($po, [
            'items' => $this->finalizePayload($po, [$po->items[0]->id => ['unit_price' => 520000]]),
            'discount_type' => 'TOTAL', 'discount_percentage' => 5,
        ])->assertStatus(200);
        $this->assertEquals(494000.0, (float) $po->fresh()->grand_total);
        $this->assertNull($po->fresh()->high_value_reason);
    }

    #[Test]
    public function the_threshold_is_per_supplier_order_for_consolidated_requests(): void
    {
        $orders = $this->issue($this->approvedRequest([
            ['description' => 'مصعد', 'qty' => 1, 'price' => 600000, 'supplier' => $this->supplierA],
            ['description' => 'رخام', 'qty' => 1, 'price' => 300000, 'supplier' => $this->supplierB],
        ]));
        $poA = $orders[$this->supplierA->id];
        $poB = $orders[$this->supplierB->id];
        $this->receiveAndApprove($poA);
        $this->receiveAndApprove($poB);

        $this->finalize($poB, ['items' => $this->finalizePayload($poB)])->assertStatus(200);
        $this->finalize($poA, ['items' => $this->finalizePayload($poA)])->assertStatus(422)->assertJsonPath('code', 'HIGH_VALUE_REASON_REQUIRED');
        $this->finalize($poA, ['items' => $this->finalizePayload($poA), 'high_value_reason' => 'مصعد ركاب للمبنى الإداري'])->assertStatus(200);
    }

    // ── Multiple attachments ────────────────────────────────────────────────

    #[Test]
    public function several_files_are_attached_with_the_actual_po_and_the_first_is_the_main_invoice(): void
    {
        $po = $this->pendingActualPo($this->execution, 1000);

        $this->finalize($po, [
            'items' => $this->finalizePayload($po),
            'attachments' => [
                UploadedFile::fake()->create('invoice.pdf', 120, 'application/pdf'),
                UploadedFile::fake()->image('page-2.jpg'),
                UploadedFile::fake()->image('page-3.png'),
            ],
        ])->assertStatus(200)->assertJsonCount(3, 'data.invoice_attachments');

        $attachments = Attachment::where('attachable_type', PurchaseOrder::class)->where('attachable_id', $po->id)->orderBy('id')->get();
        $this->assertCount(3, $attachments);
        $this->assertSame($attachments->first()->file_path, $po->fresh()->invoice_photo_path);
        foreach ($attachments as $attachment) {
            Storage::disk('public')->assertExists($attachment->file_path);
        }
    }

    #[Test]
    public function a_bad_file_or_a_failed_issue_leaves_no_attachment_and_no_stored_file(): void
    {
        $po = $this->pendingActualPo($this->execution, 1000);

        $this->finalize($po, [
            'items' => $this->finalizePayload($po),
            'attachments' => [UploadedFile::fake()->create('virus.exe', 10, 'application/octet-stream')],
        ])->assertStatus(422);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);

        // The issue fails (high value without reason) after the files were stored: they are removed again.
        $this->finalize($po, [
            'items' => $this->finalizePayload($po, [$po->items[0]->id => ['unit_price' => 900000]]),
            'attachments' => [UploadedFile::fake()->create('invoice.pdf', 50, 'application/pdf')],
        ])->assertStatus(422);

        $this->assertSame(0, Attachment::where('attachable_type', PurchaseOrder::class)->count());
        $this->assertSame([], Storage::disk('public')->allFiles());
        $this->assertNull($po->fresh()->invoice_photo_path);
    }

    #[Test]
    public function the_legacy_single_invoice_file_still_works_and_extra_files_can_be_added_later_but_not_removed(): void
    {
        $po = $this->pendingActualPo($this->execution, 1000);

        $this->finalize($po, [
            'items' => $this->finalizePayload($po),
            'invoice_file' => UploadedFile::fake()->create('invoice.pdf', 40, 'application/pdf'),
        ])->assertStatus(200);
        $this->assertSame(1, Attachment::where('attachable_id', $po->id)->count());

        $this->actingAs($this->procurementManager, 'sanctum')
            ->post("/api/v1/procurement/purchase-orders/{$po->id}/upload-invoice", [
                'attachments' => [UploadedFile::fake()->image('extra-1.jpg'), UploadedFile::fake()->image('extra-2.jpg')],
            ], ['Accept' => 'application/json'])
            ->assertStatus(200);
        $this->assertSame(3, Attachment::where('attachable_id', $po->id)->count());

        $deleteRoutes = collect(app('router')->getRoutes()->getRoutes())
            ->filter(fn ($route) => in_array('DELETE', $route->methods(), true) && str_contains($route->uri(), 'purchase-orders') && str_contains($route->uri(), 'invoice'));
        $this->assertCount(0, $deleteRoutes, 'there is no endpoint to delete an Actual PO attachment');
    }
}
