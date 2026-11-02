<?php

namespace Tests\Feature\Api\V1;

use App\Models\ApprovalHistory;
use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use App\Services\PurchaseOrderService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * "Send to accounting directly": a just-issued order is recorded as fully received and its
 * Actual PO issued at once, with optional invoices, skipping the warehouse and site inspection.
 */
class SendDirectToAccountingTest extends TestCase
{
    use RefreshDatabase;

    private User $procurementManager;
    private User $siteEngineer;
    private Supplier $supplier;
    private Department $dept;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $this->dept = Department::create(['name' => 'التشطيبات', 'code' => 'FIN-TEST']);
        $this->procurementManager = $this->user('procurement_manager', 'مدير المشتريات');
        $this->siteEngineer = $this->user('site_engineer', 'م. مصطفى');
        $this->supplier = Supplier::create(['company_name' => 'هيثم عرب نرجس 6', 'is_active' => true]);
    }

    private function user(string $role, string $name): User
    {
        $user = User::create([
            'name' => $name,
            'email' => uniqid('t_') . '@ashbiliya.com',
            'password' => Hash::make('secret'),
            'department_id' => $this->dept->id,
            'is_active' => true,
        ]);
        $user->roles()->attach(Role::where('slug', $role)->value('id'));

        return $user->fresh('roles');
    }

    private function issuedPo(string $status = 'ISSUED', bool $requiresWarehouse = true): PurchaseOrder
    {
        $pr = PurchaseRequest::create([
            'request_number' => 'PR-' . uniqid(),
            'user_id' => $this->siteEngineer->id,
            'department_id' => $this->dept->id,
            'target_department_id' => $this->dept->id,
            'site_engineer_user_id' => $this->siteEngineer->id,
            'requires_warehouse_receipt' => $requiresWarehouse,
            'status' => 'ISSUED',
            'request_type' => 'PROJECT',
            'parcel_reference' => '814',
            'region' => '21',
        ]);

        $po = PurchaseOrder::create([
            'po_number' => 'PO-' . uniqid(),
            'purchase_request_id' => $pr->id,
            'supplier_id' => $this->supplier->id,
            'created_by_user_id' => $this->procurementManager->id,
            'status' => $status,
            'discount_type' => 'NONE',
            'discount_percentage' => 0,
        ]);
        $po->items()->create([
            'item_description' => 'اكريليك بوابات ابيض',
            'quantity' => 10,
            'unit_price' => 450,
            'line_total' => 4500,
            'uom' => 'M2',
            'item_reference' => '814',
            'region' => '21',
            'supplier_id' => $this->supplier->id,
        ]);
        app(PurchaseOrderService::class)->recalculateTotals($po);

        return $po->fresh(['items']);
    }

    public function test_issued_order_is_received_in_full_and_actual_po_issued_with_invoice(): void
    {
        Storage::fake('local');
        Storage::fake('public');
        $po = $this->issuedPo();

        $response = $this->actingAs($this->procurementManager, 'sanctum')
            ->post("/api/v1/procurement/purchase-orders/{$po->id}/send-direct-to-accounting", [
                'attachments' => [UploadedFile::fake()->create('invoice.pdf', 50, 'application/pdf')],
            ], ['Accept' => 'application/json']);

        $response->assertOk();
        $po->refresh();
        $this->assertSame('ISSUED', $po->status);
        $this->assertNotNull($po->finalized_at);
        $this->assertEquals(4500, (float) $po->grand_total);

        $receipt = PurchaseReceipt::where('purchase_order_id', $po->id)->sole();
        $this->assertSame('APPROVED', $receipt->status);
        $this->assertSame($this->siteEngineer->id, (int) $receipt->site_engineer_user_id);
        $this->assertNull($receipt->warehouse_keeper_user_id);
        $this->assertEquals(10, (float) $receipt->items()->sole()->received_quantity);
        $this->assertTrue(ApprovalHistory::where('target_id', $receipt->id)
            ->where('action', 'PROCUREMENT_RECORDED_FULL_RECEIPT')
            ->where('actor_user_id', $this->procurementManager->id)->exists());
        $this->assertSame(1, $po->attachments()->count());
    }

    public function test_invoice_is_optional_and_waiting_direct_site_receipt_is_reused(): void
    {
        $po = $this->issuedPo('ISSUED', false);
        $waiting = app(\App\Services\PurchaseReceiptService::class)->createDirectSiteReceipt($po);

        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/send-direct-to-accounting")
            ->assertOk();

        $this->assertSame(1, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
        $this->assertSame('APPROVED', $waiting->fresh()->status);
        $this->assertNotNull($po->fresh()->finalized_at);
    }

    public function test_order_whose_receiving_started_is_refused_and_left_unchanged(): void
    {
        $po = $this->issuedPo();
        PurchaseReceipt::create([
            'purchase_order_id' => $po->id,
            'purchase_request_id' => $po->purchase_request_id,
            'supplier_id' => $this->supplier->id,
            'warehouse_keeper_user_id' => $this->procurementManager->id,
            'receipt_number' => 'REC-' . uniqid(),
            'status' => 'PENDING_SITE_ENGINEER',
            'received_at' => now()->toDateString(),
        ]);

        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/send-direct-to-accounting")
            ->assertStatus(409);

        $this->assertSame('ISSUED', $po->fresh()->status);
        $this->assertNull($po->fresh()->finalized_at);
    }

    public function test_draft_order_is_refused(): void
    {
        $po = $this->issuedPo('PO_DRAFT');

        $this->actingAs($this->procurementManager, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/send-direct-to-accounting")
            ->assertStatus(409);

        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());
    }

    public function test_site_engineer_cannot_send_directly(): void
    {
        $po = $this->issuedPo();

        $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/send-direct-to-accounting")
            ->assertForbidden();
    }
}
