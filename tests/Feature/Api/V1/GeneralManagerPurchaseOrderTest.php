<?php

namespace Tests\Feature\Api\V1;

use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class GeneralManagerPurchaseOrderTest extends TestCase
{
    use RefreshDatabase;

    private Department $dept;
    private User $gmUser;
    private User $accountant;
    private User $procurementManager;
    private User $employee;
    private Supplier $supplier;
    private PurchaseRequest $approvedPr;
    private PurchaseOrder $accountingApprovedPo;
    private PurchaseOrder $draftPo;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $this->dept = Department::create([
            'name' => 'Executive Office',
            'code' => 'DEPT-EXEC',
        ]);

        $gmRole = Role::where('slug', 'general_manager')->first();
        $accountantRole = Role::where('slug', 'accountant')->first();
        $procRole = Role::where('slug', 'procurement_manager')->first();
        $empRole = Role::where('slug', 'employee')->first();

        // GM User
        $this->gmUser = User::create([
            'department_id' => $this->dept->id,
            'name' => 'Dr. Sultan General Manager',
            'email' => 'sultan@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->gmUser->roles()->attach($gmRole->id);

        // Accountant User
        $this->accountant = User::create([
            'department_id' => $this->dept->id,
            'name' => 'Fahad Accountant',
            'email' => 'fahad@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->accountant->roles()->attach($accountantRole->id);

        // Procurement Manager User
        $this->procurementManager = User::create([
            'department_id' => $this->dept->id,
            'name' => 'Tariq Procurement Officer',
            'email' => 'tariq@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->procurementManager->roles()->attach($procRole->id);

        // Employee User
        $this->employee = User::create([
            'department_id' => $this->dept->id,
            'name' => 'Ali Employee',
            'email' => 'ali@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->employee->roles()->attach($empRole->id);

        // Supplier
        $this->supplier = Supplier::create([
            'code' => 'SUP-001',
            'company_name' => 'Al-Falak Technology Corp',
            'email' => 'info@alfalak.com',
            'is_active' => true,
        ]);

        // Approved PR
        $this->approvedPr = PurchaseRequest::create([
            'request_number' => 'PR-2026-00010',
            'user_id' => $this->employee->id,
            'department_id' => $this->dept->id,
            'title' => 'Approved Server Requisition',
            'status' => 'APPROVED_BY_PROCUREMENT',
            'total_estimated_cost' => 10000.00,
        ]);

        // Accounting Approved PO
        $this->accountingApprovedPo = PurchaseOrder::create([
            'po_number' => 'PO-2026-00001',
            'purchase_request_id' => $this->approvedPr->id,
            'supplier_id' => $this->supplier->id,
            'created_by_user_id' => $this->procurementManager->id,
            'status' => 'APPROVED_BY_ACCOUNTING',
            'subtotal' => 10000.00,
            'discount_amount' => 500.00,
            'tax_amount' => 1425.00,
            'grand_total' => 10925.00,
            'reviewed_by_accounting_user_id' => $this->accountant->id,
            'reviewed_at_accounting' => now(),
        ]);

        $this->accountingApprovedPo->items()->create([
            'item_description' => 'Enterprise Server Node',
            'item_reference' => 'GM-PO-001',
            'region' => 'المنطقة السابعة والعشرون',
            'quantity' => 2,
            'uom' => 'UNIT',
            'unit_price' => 5000.00,
            'discount_amount' => 500.00,
            'tax_amount' => 1425.00,
            'line_total' => 10925.00,
        ]);
    }

    public function test_gm_can_list_pos_approved_by_accounting(): void
    {
        $token = $this->gmUser->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/general-manager/purchase-orders');

        $response->assertStatus(200);
        $this->assertCount(1, $response->json('data'));
        $this->assertEquals($this->accountingApprovedPo->id, $response->json('data.0.id'));
    }

    public function test_gm_dashboard_summary_returns_header_fields_only(): void
    {
        $token = $this->gmUser->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/general-manager/purchase-orders?summary=1');

        $response->assertStatus(200);
        $this->assertCount(1, $response->json('data'));
        $response->assertJsonPath('data.0.id', $this->accountingApprovedPo->id);
        $response->assertJsonPath('data.0.status', 'APPROVED_BY_ACCOUNTING');
        $response->assertJsonPath('data.0.grand_total', 10925);
        $response->assertJsonPath('data.0.supplier.id', $this->supplier->id);
        $response->assertJsonPath('data.0.purchase_request.department.id', $this->dept->id);
        $this->assertArrayNotHasKey('items', $response->json('data.0'));
    }

    public function test_gm_can_view_approved_po_details(): void
    {
        $token = $this->gmUser->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/general-manager/purchase-orders/' . $this->accountingApprovedPo->id);

        $response->assertStatus(200)
            ->assertJson([
                'data' => [
                    'id' => $this->accountingApprovedPo->id,
                    'po_number' => 'PO-2026-00001',
                    'status' => 'APPROVED_BY_ACCOUNTING',
                    'grand_total' => '10925.00',
                ],
            ]);
    }

    public function test_gm_cannot_approve_or_reject_po_via_api(): void
    {
        $token = $this->gmUser->createToken('test_token')->plainTextToken;

        // Approve route should return 403 (prohibited mutation)
        $responseApprove = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/general-manager/purchase-orders/' . $this->accountingApprovedPo->id . '/approve', [
                'comment' => 'Approval attempt',
            ]);
        $responseApprove->assertStatus(403);

        // Reject route should return 403 (prohibited mutation)
        $responseReject = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/general-manager/purchase-orders/' . $this->accountingApprovedPo->id . '/reject', [
                'comment' => 'Rejection attempt',
            ]);
        $responseReject->assertStatus(403);
    }

    public function test_procurement_and_accountant_and_employee_cannot_access_gm_endpoints(): void
    {
        $procToken = $this->procurementManager->createToken('proc_token')->plainTextToken;
        $accToken = $this->accountant->createToken('acc_token')->plainTextToken;
        $empToken = $this->employee->createToken('emp_token')->plainTextToken;

        $this->withHeader('Authorization', 'Bearer ' . $procToken)
            ->getJson('/api/v1/general-manager/purchase-orders')
            ->assertStatus(403);

        $this->withHeader('Authorization', 'Bearer ' . $accToken)
            ->getJson('/api/v1/general-manager/purchase-orders')
            ->assertStatus(403);

        $this->withHeader('Authorization', 'Bearer ' . $empToken)
            ->getJson('/api/v1/general-manager/purchase-orders')
            ->assertStatus(403);
    }
}
