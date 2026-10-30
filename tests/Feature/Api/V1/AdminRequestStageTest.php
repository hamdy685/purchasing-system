<?php

namespace Tests\Feature\Api\V1;

use App\Models\AdminAuditLog;
use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\SupplierInvoice;
use App\Models\SystemEvent;
use App\Models\User;
use App\Models\WeighingGroup;
use App\Services\PurchaseReceiptService;
use App\Services\ReviewerPurchaseRequestService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class AdminRequestStageTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $requester;
    private User $reviewer;
    private User $engineer;
    private User $keeper;
    private Supplier $supplier;
    private Department $dept;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $this->dept = Department::create(['name' => 'التنفيذ', 'code' => 'EXEC']);
        $this->admin = $this->makeUser('admin', 'admin-stage@test.com');
        $this->requester = $this->makeUser('site_engineer', 'requester-stage@test.com');
        $this->reviewer = $this->makeUser('reviewer', 'reviewer-stage@test.com');
        $this->engineer = $this->makeUser('site_engineer', 'engineer-stage@test.com');
        $this->keeper = $this->makeUser('warehouse_keeper', 'keeper-stage@test.com');
        $this->supplier = Supplier::create(['company_name' => 'حسان', 'name' => 'حسان', 'is_active' => true]);
    }

    private function makeUser(string $role, string $email): User
    {
        $user = User::create([
            'name' => $role . ' user',
            'email' => $email,
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
            'department_id' => $this->dept->id,
        ]);
        $user->roles()->attach(Role::where('slug', $role)->firstOrFail()->id);

        return $user;
    }

    /**
     * A request that went all the way to "waiting for the actual PO":
     * weighed steel, an approved site receipt and a draft invoice.
     */
    private function deliveredRequest(string $poStatus = 'PENDING_ACTUAL_PO'): array
    {
        $pr = PurchaseRequest::create([
            'request_number' => 'PR-STAGE-' . uniqid(),
            'department_id' => $this->dept->id,
            'user_id' => $this->requester->id,
            'reviewer_user_id' => $this->reviewer->id,
            'site_engineer_user_id' => $this->engineer->id,
            'requires_warehouse_receipt' => true,
            'request_type' => 'PROJECT',
            'procurement_route' => 'DIRECT',
            'direct_supplier_id' => $this->supplier->id,
            'status' => 'ISSUED',
            'total_estimated_cost' => 1000,
        ]);
        $po = PurchaseOrder::create([
            'po_number' => 'PO-STAGE-' . uniqid(),
            'purchase_request_id' => $pr->id,
            'supplier_id' => $this->supplier->id,
            'created_by_user_id' => $this->admin->id,
            'status' => $poStatus,
            'delivery_status' => 'DELIVERED',
            'subtotal' => 1000,
            'grand_total' => 1000,
        ]);
        PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'item_description' => 'حديد',
            'quantity' => 1,
            'uom' => 'TON',
            'unit_price' => 1000,
            'line_total' => 1000,
        ]);
        $group = WeighingGroup::create([
            'group_number' => 'WG-' . uniqid(),
            'purchase_order_id' => $po->id,
            'supplier_id' => $this->supplier->id,
            'status' => 'RECEIVED',
            'total_received_weight' => 1,
            'received_at' => now(),
            'received_by_user_id' => $this->keeper->id,
        ]);
        $receipt = PurchaseReceipt::create([
            'purchase_order_id' => $po->id,
            'purchase_request_id' => $pr->id,
            'supplier_id' => $this->supplier->id,
            'weighing_group_id' => $group->id,
            'warehouse_keeper_user_id' => $this->keeper->id,
            'site_engineer_user_id' => $this->engineer->id,
            'receipt_number' => 'REC-' . uniqid(),
            'status' => 'APPROVED',
            'received_at' => now(),
            'site_engineer_approved_at' => now(),
        ]);

        return compact('pr', 'po', 'group', 'receipt');
    }

    private function invoice(PurchaseOrder $po, PurchaseReceipt $receipt, string $status): SupplierInvoice
    {
        return SupplierInvoice::create([
            'supplier_id' => $this->supplier->id,
            'purchase_order_id' => $po->id,
            'purchase_receipt_id' => $receipt->id,
            'created_by_user_id' => $this->admin->id,
            'invoice_number' => 'INV-' . uniqid(),
            'amount' => 1000,
            'invoice_date' => now()->toDateString(),
            'status' => $status,
        ]);
    }

    private function move(PurchaseRequest $pr, string $stage)
    {
        return $this->actingAs($this->admin, 'sanctum')->postJson("/api/v1/admin/requests/{$pr->id}/move-stage", [
            'request_stage' => $stage,
            'admin_reason' => 'تصحيح مسار الطلب',
        ]);
    }

    public function test_stage_endpoint_reports_current_stage_and_options(): void
    {
        ['pr' => $pr] = $this->deliveredRequest();

        $res = $this->actingAs($this->admin, 'sanctum')->getJson("/api/v1/admin/requests/{$pr->id}/stage");

        $res->assertOk()->assertJsonPath('data.current_stage.value', 'ACTUAL_PO');
        $options = collect($res->json('data.stage_options'))->keyBy('value');
        $this->assertFalse($options['ACTUAL_PO']['available']);
        $this->assertTrue($options['REVIEWER']['available']);
        $this->assertTrue($options['WAREHOUSE_RECEIPT']['available']);
        $this->assertFalse($options['EXECUTIVE']['current']);
    }

    public function test_back_to_reviewer_cancels_downstream_and_lands_in_reviewer_queue(): void
    {
        ['pr' => $pr, 'po' => $po, 'group' => $group, 'receipt' => $receipt] = $this->deliveredRequest();
        $draft = $this->invoice($po, $receipt, 'DRAFT');

        $this->move($pr, 'REVIEWER')->assertOk();

        $pr->refresh();
        $this->assertSame('SUBMITTED', $pr->status);
        $this->assertSame('UNDECIDED', $pr->procurement_route);
        $this->assertSame('CANCELLED', $po->fresh()->status);
        $this->assertSame('CANCELLED', $receipt->fresh()->status);
        $this->assertSame('CANCELLED', $group->fresh()->status);
        $this->assertSame('VOIDED', $draft->fresh()->status);

        $queue = app(ReviewerPurchaseRequestService::class)->getReviewableRequests($this->reviewer);
        $this->assertTrue(collect($queue->items())->contains('id', $pr->id));

        $this->assertDatabaseHas('admin_audit_logs', ['action' => 'ADMIN_REQUEST_STAGE_MOVE', 'entity_id' => $pr->id, 'to_status' => 'SUBMITTED']);
        $this->assertTrue(SystemEvent::where('entity_type', PurchaseRequest::class)->where('entity_id', $pr->id)->where('action', 'ADMIN_REQUEST_STAGE_MOVE')->exists());
    }

    public function test_back_to_requester_returns_request_with_reason(): void
    {
        ['pr' => $pr] = $this->deliveredRequest();

        $this->move($pr, 'REQUESTER')->assertOk();

        $pr->refresh();
        $this->assertSame('RETURNED', $pr->status);
        $this->assertSame('تصحيح مسار الطلب', $pr->return_reason);
        $this->assertTrue($pr->isEditableByRequester());
    }

    public function test_back_to_warehouse_reopens_weighing_and_shows_in_warehouse_queue(): void
    {
        ['pr' => $pr, 'po' => $po, 'group' => $group, 'receipt' => $receipt] = $this->deliveredRequest();
        $po->update(['status' => 'ISSUED', 'finalized_at' => now(), 'finalized_by_user_id' => $this->admin->id]);

        $this->move($pr, 'WAREHOUSE_RECEIPT')->assertOk();

        $po->refresh();
        $this->assertSame('ISSUED', $po->status);
        $this->assertNull($po->finalized_at);
        $this->assertSame('PENDING', $po->delivery_status);
        $this->assertSame('CANCELLED', $receipt->fresh()->status);
        $this->assertSame('PENDING_RECEIPT', $group->fresh()->status);
        $this->assertNull($group->fresh()->received_at);

        // A different keeper must see it too: the old, cancelled receipt no longer pins the order.
        $otherKeeper = $this->makeUser('warehouse_keeper', 'keeper2-stage@test.com');
        foreach ([$this->keeper, $otherKeeper] as $keeper) {
            $queue = app(PurchaseReceiptService::class)->warehouseQueue($keeper);
            $this->assertTrue(collect($queue->items())->contains('id', $po->id));
        }
    }

    public function test_back_to_site_engineer_reopens_the_receipt(): void
    {
        ['pr' => $pr, 'po' => $po, 'receipt' => $receipt] = $this->deliveredRequest();

        $this->move($pr, 'SITE_ENGINEER')->assertOk();

        $receipt->refresh();
        $this->assertSame('PENDING_SITE_ENGINEER', $receipt->status);
        $this->assertNull($receipt->site_engineer_approved_at);
        $this->assertSame('ISSUED', $po->fresh()->status);
        $this->assertSame('ISSUED', $pr->fresh()->status);
    }

    public function test_registered_invoice_blocks_the_move_and_changes_nothing(): void
    {
        ['pr' => $pr, 'po' => $po, 'receipt' => $receipt] = $this->deliveredRequest();
        $invoice = $this->invoice($po, $receipt, 'OPEN');

        $res = $this->move($pr, 'REVIEWER');

        $res->assertStatus(422);
        $this->assertStringContainsString($invoice->invoice_number, (string) $res->json('message'));
        $this->assertSame('ISSUED', $pr->fresh()->status);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);
        $this->assertSame('APPROVED', $receipt->fresh()->status);
    }

    public function test_cancelled_request_can_be_restored_to_any_stage(): void
    {
        ['pr' => $pr, 'po' => $po] = $this->deliveredRequest();

        $this->move($pr, 'CANCELLED')->assertOk();
        $this->assertSame('CANCELLED', $pr->fresh()->status);
        $this->assertSame('CANCELLED', $po->fresh()->status);

        $this->move($pr, 'ACTUAL_PO')->assertOk();
        $this->assertSame('ISSUED', $pr->fresh()->status);
        $this->assertSame('PENDING_ACTUAL_PO', $po->fresh()->status);

        $this->move($pr, 'CANCELLED')->assertOk();
        $this->move($pr, 'EXECUTIVE')->assertOk();
        $this->assertSame('PENDING_EXECUTIVE_APPROVAL', $pr->fresh()->status);
    }

    public function test_unavailable_stage_is_refused_with_reason(): void
    {
        ['pr' => $pr] = $this->deliveredRequest();
        $pr->update(['reviewer_user_id' => null]);

        $res = $this->move($pr, 'REVIEWER');

        $res->assertStatus(422);
        $this->assertStringContainsString('مراجع', (string) $res->json('message'));
    }

    public function test_force_update_can_edit_items_and_move_stage_together(): void
    {
        ['pr' => $pr, 'po' => $po] = $this->deliveredRequest();
        $item = $po->items()->first();

        $this->actingAs($this->admin, 'sanctum')
            ->putJson("/api/v1/admin/orders/{$po->id}/force-update", [
                'admin_reason' => 'تعديل الكمية وإرجاع للموقع',
                'request_stage' => 'SITE_ENGINEER',
                'items' => [
                    ['id' => $item->id, 'item_description' => 'حديد', 'quantity' => 2, 'uom' => 'TON', 'unit_price' => 1000],
                ],
            ])
            ->assertOk();

        $this->assertEquals(2.0, (float) $item->fresh()->quantity);
        $this->assertSame('PENDING_SITE_ENGINEER', PurchaseReceipt::where('purchase_order_id', $po->id)->value('status'));
    }

    public function test_refused_stage_move_discards_item_edits(): void
    {
        ['pr' => $pr, 'po' => $po, 'receipt' => $receipt] = $this->deliveredRequest();
        $this->invoice($po, $receipt, 'POSTED');
        $item = $po->items()->first();

        $this->actingAs($this->admin, 'sanctum')
            ->putJson("/api/v1/admin/orders/{$po->id}/force-update", [
                'admin_reason' => 'محاولة',
                'request_stage' => 'REVIEWER',
                'items' => [
                    ['id' => $item->id, 'item_description' => 'حديد', 'quantity' => 5, 'uom' => 'TON', 'unit_price' => 1000],
                ],
            ])
            ->assertStatus(422);

        $this->assertEquals(1.0, (float) $item->fresh()->quantity);
        $this->assertFalse(AdminAuditLog::where('action', 'ADMIN_REQUEST_STAGE_MOVE')->exists());
    }
}
