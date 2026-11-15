<?php

namespace Tests\Feature\Api\V1;

use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseReceiptItem;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * An accountant who requested an order and is set as its receiver must be able to
 * see and approve the receipt; other general accountants still cannot.
 */
class AccountantReceivesOwnOrderTest extends TestCase
{
    use RefreshDatabase;

    private User $accountant;
    private User $otherAccountant;
    private PurchaseReceipt $receipt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $dept = Department::create(['name' => 'المكتبيات', 'code' => 'OFFICE_X', 'is_active' => true]);
        $this->accountant = $this->makeUser('acc@test.local', 'general_accountant', $dept->id);
        $this->otherAccountant = $this->makeUser('acc2@test.local', 'general_accountant', $dept->id);

        $supplier = Supplier::create([
            'code' => 'SUP-ACC-1', 'company_name' => 'مورد', 'contact_name' => 'x',
            'phone' => '0100', 'is_active' => true, 'opening_balance' => 0,
        ]);
        $pr = PurchaseRequest::create([
            'department_id' => $dept->id,
            'target_department_id' => $dept->id,
            'user_id' => $this->accountant->id,
            'site_engineer_user_id' => $this->accountant->id,
            'request_number' => 'PR-ACC-1',
            'status' => 'APPROVED_BY_PROCUREMENT',
            'date_needed' => now()->addDay()->toDateString(),
        ]);
        $po = PurchaseOrder::create([
            'purchase_request_id' => $pr->id, 'supplier_id' => $supplier->id,
            'po_number' => 'PO-ACC-1', 'status' => 'ISSUED', 'created_by_user_id' => $this->otherAccountant->id,
            'subtotal' => 100, 'grand_total' => 100, 'delivery_status' => 'IN_RECEIPT',
        ]);
        $poItem = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id, 'item_description' => 'ورق', 'quantity' => 2,
            'uom' => 'PCS', 'unit_price' => 50, 'line_total' => 100,
        ]);
        $this->receipt = PurchaseReceipt::create([
            'purchase_order_id' => $po->id, 'purchase_request_id' => $pr->id, 'supplier_id' => $supplier->id,
            'site_engineer_user_id' => $this->accountant->id, 'receipt_number' => 'REC-SITE-ACC-1',
            'receipt_type' => 'SITE_DIRECT', 'status' => 'PENDING_SITE_ENGINEER', 'received_at' => now(),
        ]);
        PurchaseReceiptItem::create([
            'purchase_receipt_id' => $this->receipt->id, 'purchase_order_item_id' => $poItem->id,
            'ordered_quantity' => 2, 'received_quantity' => 2,
        ]);
    }

    public function test_assigned_accountant_sees_and_approves_own_receipt(): void
    {
        Sanctum::actingAs($this->accountant);

        $this->getJson('/api/v1/purchase-receipts/assigned')
            ->assertOk()
            ->assertJsonFragment(['receipt_number' => 'REC-SITE-ACC-1']);

        $this->postJson("/api/v1/purchase-receipts/{$this->receipt->id}/approve", [])
            ->assertOk();

        $this->assertSame('APPROVED', $this->receipt->fresh()->status);
    }

    public function test_unassigned_general_accountant_cannot_approve(): void
    {
        Sanctum::actingAs($this->otherAccountant);

        $status = $this->postJson("/api/v1/purchase-receipts/{$this->receipt->id}/approve", [])->status();
        $this->assertContains($status, [403, 404]);

        $this->assertSame('PENDING_SITE_ENGINEER', $this->receipt->fresh()->status);
    }

    private function makeUser(string $email, string $role, int $deptId): User
    {
        $user = User::create([
            'department_id' => $deptId, 'name' => $email, 'email' => $email,
            'password' => Hash::make('Secret123!'), 'is_active' => true,
        ]);
        $user->roles()->attach(Role::where('slug', $role)->firstOrFail()->id);

        return $user;
    }
}
