<?php

namespace Tests\Feature\Api\V1;

use App\Models\Department;
use App\Models\Notification;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use App\Services\PurchaseReceiptService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class PurchaseReceiptWorkflowTest extends TestCase
{
    use RefreshDatabase;

    private User $warehouse;
    private User $siteEngineer;
    private User $accountant;
    private User $siteAccountant;
    private User $procurementManager;
    private PurchaseOrder $purchaseOrder;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);
        $department = Department::create(['name' => 'التنفيذ', 'code' => 'EXECUTION', 'is_active' => true]);
        $this->warehouse = $this->makeUser('warehouse@test', 'أمين المخزن', 'warehouse_keeper', $department->id);
        $this->siteEngineer = $this->makeUser('site@test', 'مهندس الموقع', 'site_engineer', $department->id);
        $this->accountant = $this->makeUser('accounting@test', 'الحسابات', 'accountant', $department->id);
        $this->siteAccountant = $this->makeUser('site-acct@test', 'حسابات التنفيذ', 'site_accountant', $department->id);
        $this->procurementManager = $this->makeUser('procurement@test', 'مسؤول المشتريات', 'procurement_manager', $department->id);
        $employee = $this->makeUser('employee-receipt@test', 'الموظف', 'employee', $department->id);
        $supplier = Supplier::create(['code' => 'RECEIPT-SUP', 'company_name' => 'مورد الاستلام', 'is_active' => true]);

        $purchaseRequest = PurchaseRequest::create([
            'request_number' => 'PR-RECEIPT-001',
            'user_id' => $employee->id,
            'department_id' => $department->id,
            'site_engineer_user_id' => $this->siteEngineer->id,
            'priority' => 'NORMAL',
            'status' => 'APPROVED_BY_PROCUREMENT',
            'total_estimated_cost' => 1000,
            'date_needed' => now()->toDateString(),
        ]);

        $this->purchaseOrder = PurchaseOrder::create([
            'po_number' => 'PO-RECEIPT-001',
            'purchase_request_id' => $purchaseRequest->id,
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $employee->id,
            'status' => 'ISSUED',
            'subtotal' => 1000,
            'grand_total' => 1000,
            'delivery_status' => 'NOT_STARTED',
        ]);
        $this->purchaseOrder->items()->create([
            'item_description' => 'أسمنت',
            'item_reference' => 'RECEIPT-PART-001',
            'region' => 'المنطقة السابعة والعشرون',
            'quantity' => 10,
            'uom' => 'PCS',
            'unit_price' => 100,
            'line_total' => 1000,
        ]);
    }

    public function test_warehouse_submits_then_site_engineer_approves_receipt(): void
    {
        $orderItem = $this->purchaseOrder->items()->first();
        $receipt = app(PurchaseReceiptService::class)->createByWarehouse(
            $this->warehouse,
            $this->purchaseOrder,
            [['purchase_order_item_id' => $orderItem->id, 'received_quantity' => 8, 'notes' => 'تم استلام 8 وحدات']],
        );

        $this->assertSame('PENDING_SITE_ENGINEER', $receipt->status);
        $this->assertSame('IN_RECEIPT', $this->purchaseOrder->fresh()->delivery_status);
        $this->assertDatabaseHas('purchase_receipt_items', ['received_quantity' => 8]);
        $this->assertDatabaseHas('notifications', [
            'user_id' => $this->siteEngineer->id,
            'type' => 'purchase_receipt_pending_site_engineer',
        ]);

        $approved = app(PurchaseReceiptService::class)->approveBySiteEngineer($this->siteEngineer, $receipt, 'تمت مطابقة الاستلام بالموقع.');
        $this->assertSame('APPROVED', $approved->status);
        $this->assertSame('DELIVERED', $this->purchaseOrder->fresh()->delivery_status);
        $this->assertSame('PENDING_ACTUAL_PO', $this->purchaseOrder->fresh()->status);
        // Procurement manager should receive notification to issue actual PO
        $this->assertDatabaseHas('notifications', [
            'user_id' => $this->procurementManager->id,
            'type' => 'grn_approved_pending_actual_po',
        ]);
    }

    public function test_repeated_site_engineer_approval_is_recorded_once(): void
    {
        $orderItem = $this->purchaseOrder->items()->first();
        $receipt = app(PurchaseReceiptService::class)->createByWarehouse(
            $this->warehouse,
            $this->purchaseOrder,
            [['purchase_order_item_id' => $orderItem->id, 'received_quantity' => 8]],
        );

        // Two requests for the same receipt (double tap / retried request) each loaded it while still pending.
        $firstRequest = PurchaseReceipt::findOrFail($receipt->id);
        $secondRequest = PurchaseReceipt::findOrFail($receipt->id);

        app(PurchaseReceiptService::class)->approveBySiteEngineer($this->siteEngineer, $firstRequest);
        $again = app(PurchaseReceiptService::class)->approveBySiteEngineer($this->siteEngineer, $secondRequest);

        $this->assertSame('APPROVED', $again->status);
        $this->assertSame(1, \App\Models\ApprovalHistory::where('target_type', PurchaseReceipt::class)
            ->where('target_id', $receipt->id)
            ->where('to_state', 'APPROVED')
            ->count());
        $this->assertSame(1, Notification::where('user_id', $this->procurementManager->id)
            ->where('type', 'grn_approved_pending_actual_po')
            ->count());
    }

    public function test_site_engineer_cannot_edit_quantities_once_receipt_is_approved(): void
    {
        $orderItem = $this->purchaseOrder->items()->first();
        $receipt = app(PurchaseReceiptService::class)->createByWarehouse(
            $this->warehouse,
            $this->purchaseOrder,
            [['purchase_order_item_id' => $orderItem->id, 'received_quantity' => 8]],
        );
        $staleEdit = PurchaseReceipt::with('items')->findOrFail($receipt->id);
        $receiptItemId = $staleEdit->items->first()->id;

        app(PurchaseReceiptService::class)->approveBySiteEngineer($this->siteEngineer, PurchaseReceipt::findOrFail($receipt->id));

        try {
            app(PurchaseReceiptService::class)->updateBySiteEngineer($this->siteEngineer, $staleEdit, [
                ['id' => $receiptItemId, 'received_quantity' => 3],
            ]);
            $this->fail('Editing an approved receipt must be rejected.');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('بعد اعتماده', $e->getMessage());
        }

        $this->assertDatabaseHas('purchase_receipt_items', ['id' => $receiptItemId, 'received_quantity' => 8]);
    }

    public function test_other_site_engineer_cannot_approve_assigned_receipt(): void
    {
        $otherEngineer = $this->makeUser('other-site@test', 'مهندس آخر', 'site_engineer', $this->siteEngineer->department_id);
        $orderItem = $this->purchaseOrder->items()->first();
        $receipt = app(PurchaseReceiptService::class)->createByWarehouse(
            $this->warehouse,
            $this->purchaseOrder,
            [['purchase_order_item_id' => $orderItem->id, 'received_quantity' => 10]],
        );

        $this->expectException(\Throwable::class);
        app(PurchaseReceiptService::class)->approveBySiteEngineer($otherEngineer, $receipt);
    }

    public function test_buildings_orders_bypass_warehouse_and_route_directly_to_site_engineer(): void
    {
        $buildingsDept = Department::create(['name' => 'المباني', 'code' => 'BUILDINGS', 'is_active' => true]);
        $buildingsReviewer = $this->makeUser('hatem@test', 'م. حاتم', 'reviewer', $buildingsDept->id);
        $buildingsEngineer = $this->makeUser('buildings-engineer@test', 'مهندس موقع المباني', 'site_engineer', $buildingsDept->id);

        $buildingsPr = PurchaseRequest::create([
            'request_number' => 'PR-BLD-001',
            'user_id' => $this->siteEngineer->id,
            'department_id' => $buildingsDept->id,
            'reviewer_user_id' => $buildingsReviewer->id,
            'site_engineer_user_id' => $buildingsEngineer->id,
            'priority' => 'NORMAL',
            'status' => 'APPROVED_BY_PROCUREMENT',
            'total_estimated_cost' => 5000,
            'date_needed' => now()->toDateString(),
            'requires_warehouse_receipt' => false,
        ]);

        $buildingsPo = PurchaseOrder::create([
            'po_number' => 'PO-BLD-001',
            'purchase_request_id' => $buildingsPr->id,
            'supplier_id' => $this->purchaseOrder->supplier_id,
            'created_by_user_id' => $this->warehouse->id,
            'status' => 'ISSUED',
            'subtotal' => 5000,
            'grand_total' => 5000,
            'delivery_status' => 'NOT_STARTED',
        ]);
        $buildingsPo->items()->create([
            'item_description' => 'حديد تسليح',
            'item_reference' => 'BLD-ITEM-001',
            'region' => 'منطقة المباني',
            'quantity' => 20,
            'uom' => 'TON',
            'unit_price' => 250,
            'line_total' => 5000,
        ]);

        $this->assertTrue($buildingsPo->isBuildingsDirectDelivery());

        // 1. Warehouse queue MUST NOT contain Buildings orders
        $warehouseQueue = app(PurchaseReceiptService::class)->warehouseQueue();
        $this->assertFalse(
            $warehouseQueue->getCollection()->contains('id', $buildingsPo->id),
            'Buildings PO must not appear in warehouse queue.'
        );

        // 2. Warehouse keeper cannot create a receipt for Buildings order
        try {
            app(PurchaseReceiptService::class)->createByWarehouse(
                $this->warehouse,
                $buildingsPo,
                [['purchase_order_item_id' => $buildingsPo->items()->first()->id, 'received_quantity' => 20]]
            );
            $this->fail('Warehouse receipt creation should have been rejected for Buildings order.');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('لا يمكن لأمين المخزن استلام هذا الطلب', $e->getMessage());
        }

        // 3. Auto-sync generates SITE_DIRECT receipt for site engineer
        app(PurchaseReceiptService::class)->syncPendingBuildingsReceiptsForEngineer($buildingsEngineer);

        $directReceipt = PurchaseReceipt::where('purchase_order_id', $buildingsPo->id)->first();
        $this->assertNotNull($directReceipt);
        $this->assertSame('SITE_DIRECT', $directReceipt->receipt_type);
        $this->assertSame('PENDING_SITE_ENGINEER', $directReceipt->status);
        $this->assertNull($directReceipt->warehouse_keeper_user_id);
        $this->assertSame($buildingsEngineer->id, $directReceipt->site_engineer_user_id);
        $this->assertSame('IN_RECEIPT', $buildingsPo->fresh()->delivery_status);

        // 4. Site Engineer approves receipt -> advances PO to DELIVERED and notifies accounting
        $approvedReceipt = app(PurchaseReceiptService::class)->approveBySiteEngineer(
            $buildingsEngineer,
            $directReceipt,
            'تم استلام ومطابقة حديد التسليح بالموقع بنجاح.'
        );

        $this->assertSame('APPROVED', $approvedReceipt->status);
        $this->assertSame('DELIVERED', $buildingsPo->fresh()->delivery_status);
        $this->assertSame('PENDING_ACTUAL_PO', $buildingsPo->fresh()->status);
        $this->assertDatabaseHas('notifications', [
            'type' => 'grn_approved_pending_actual_po',
        ]);
    }

    public function test_po_issued_for_buildings_automatically_creates_direct_site_receipt(): void
    {
        $buildingsDept = Department::create(['name' => 'المباني', 'code' => 'BUILDINGS', 'is_active' => true]);
        $procurementUser = $this->makeUser('procurement-bld@test', 'مدير المشتريات المباني', 'procurement_manager', $buildingsDept->id);
        $buildingsEngineer = $this->makeUser('engineer-bld2@test', 'مهندس موقع المباني 2', 'site_engineer', $buildingsDept->id);

        $buildingsPr = PurchaseRequest::create([
            'request_number' => 'PR-BLD-002',
            'user_id' => $this->siteEngineer->id,
            'department_id' => $buildingsDept->id,
            'site_engineer_user_id' => $buildingsEngineer->id,
            'priority' => 'NORMAL',
            'status' => 'APPROVED_BY_PROCUREMENT',
            'total_estimated_cost' => 3000,
            'date_needed' => now()->toDateString(),
            'requires_warehouse_receipt' => false,
        ]);

        $draftPo = PurchaseOrder::create([
            'po_number' => 'PO-BLD-002',
            'purchase_request_id' => $buildingsPr->id,
            'supplier_id' => $this->purchaseOrder->supplier_id,
            'created_by_user_id' => $procurementUser->id,
            'status' => 'PO_DRAFT',
            'subtotal' => 3000,
            'grand_total' => 3000,
            'delivery_status' => 'NOT_STARTED',
        ]);
        $draftPo->items()->create([
            'item_description' => 'طوب أحمر',
            'item_reference' => 'BLD-BRICK-001',
            'region' => 'منطقة المباني',
            'quantity' => 5000,
            'uom' => 'PCS',
            'unit_price' => 0.6,
            'line_total' => 3000,
        ]);

        // Submit to Accounting (which issues the PO)
        $issuedPo = app(\App\Services\PurchaseOrderService::class)->submitToAccounting($procurementUser, $draftPo);

        $this->assertSame('ISSUED', $issuedPo->status);

        // A direct site receipt MUST have been created automatically!
        $directReceipt = PurchaseReceipt::where('purchase_order_id', $issuedPo->id)->first();
        $this->assertNotNull($directReceipt, 'Direct site receipt should be created automatically upon PO issue.');
        $this->assertSame('SITE_DIRECT', $directReceipt->receipt_type);
        $this->assertSame('PENDING_SITE_ENGINEER', $directReceipt->status);
        $this->assertSame($buildingsEngineer->id, $directReceipt->site_engineer_user_id);
        $this->assertNull($directReceipt->warehouse_keeper_user_id);
    }

    public function test_warehouse_approval_and_site_engineer_approval_separation_and_auto_bypass(): void
    {
        $licensesDept = Department::create(['name' => 'التراخيص', 'code' => 'LICENSES', 'is_active' => true]);
        $licensesEngineer = $this->makeUser('licenses-eng@test', 'مهندس التراخيص', 'site_engineer', $licensesDept->id);
        $procurementUser = $this->makeUser('procurement-lic@test', 'مشتريات التراخيص', 'procurement_manager', $licensesDept->id);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-LIC-001',
            'user_id' => $licensesEngineer->id,
            'department_id' => $licensesDept->id,
            'site_engineer_user_id' => $licensesEngineer->id,
            'priority' => 'NORMAL',
            'status' => 'APPROVED_BY_ACCOUNTING',
            'total_estimated_cost' => 1200,
            'date_needed' => now()->toDateString(),
            'requires_warehouse_receipt' => false,
        ]);

        $po = PurchaseOrder::create([
            'po_number' => 'PO-LIC-001',
            'purchase_request_id' => $pr->id,
            'supplier_id' => $this->purchaseOrder->supplier_id,
            'created_by_user_id' => $procurementUser->id,
            'status' => 'PO_DRAFT',
            'subtotal' => 1200,
            'grand_total' => 1200,
            'delivery_status' => 'NOT_STARTED',
        ]);
        $po->items()->create([
            'item_description' => 'كابلات',
            'quantity' => 10,
            'uom' => 'METER',
            'unit_price' => 120,
            'line_total' => 1200,
        ]);

        $issuedPo = app(\App\Services\PurchaseOrderService::class)->submitToAccounting($procurementUser, $po);

        $this->assertTrue($issuedPo->warehouse_approval['is_bypassed']);
        $this->assertSame('AUTO_APPROVED', $issuedPo->warehouse_approval['status']);
        $this->assertTrue($issuedPo->warehouse_approval['approved']);
        $this->assertSame('PENDING', $issuedPo->site_engineer_approval['status']);
        $this->assertFalse($issuedPo->site_engineer_approval['approved']);

        $receipt = PurchaseReceipt::where('purchase_order_id', $issuedPo->id)->firstOrFail();
        $this->assertTrue($receipt->warehouse_approval['is_bypassed']);
        $this->assertSame('AUTO_APPROVED', $receipt->warehouse_approval['status']);
        $this->assertSame('PENDING', $receipt->site_engineer_approval['status']);

        // When site engineer approves
        $approvedReceipt = app(PurchaseReceiptService::class)->approveBySiteEngineer($licensesEngineer, $receipt, 'تم الفحص الهندسي بنجاح');
        $this->assertSame('APPROVED', $approvedReceipt->site_engineer_approval['status']);
        $this->assertTrue($approvedReceipt->site_engineer_approval['approved']);
        $this->assertSame('APPROVED', $approvedReceipt->status);
    }

    public function test_warehouse_queue_returns_pending_orders_across_departments_for_warehouse_keeper(): void
    {
        $licensesDept = Department::create(['name' => 'التراخيص', 'code' => 'LICENSES_Q', 'is_active' => true]);
        $licensesEmployee = $this->makeUser('licenses-emp-q@test', 'موظف التراخيص', 'employee', $licensesDept->id);

        // 1. Pending PO in another department requiring warehouse receipt
        $prPending = PurchaseRequest::create([
            'request_number' => 'PR-LIC-Q-001',
            'user_id' => $licensesEmployee->id,
            'department_id' => $licensesDept->id,
            'priority' => 'NORMAL',
            'status' => 'APPROVED_BY_ACCOUNTING',
            'total_estimated_cost' => 5000,
            'date_needed' => now()->toDateString(),
            'requires_warehouse_receipt' => true,
            'request_type' => 'PROJECT',
        ]);
        $poPending = PurchaseOrder::create([
            'po_number' => 'PO-LIC-Q-001',
            'purchase_request_id' => $prPending->id,
            'supplier_id' => $this->purchaseOrder->supplier_id,
            'created_by_user_id' => $licensesEmployee->id,
            'status' => 'ISSUED',
            'subtotal' => 5000,
            'grand_total' => 5000,
            'delivery_status' => 'NOT_STARTED',
        ]);
        $poPending->items()->create([
            'item_description' => 'بند رخصة',
            'quantity' => 1,
            'uom' => 'PCS',
            'unit_price' => 5000,
            'line_total' => 5000,
        ]);

        // 2. Completed PO (delivered) - should NOT appear in queue
        $poDelivered = PurchaseOrder::create([
            'po_number' => 'PO-LIC-Q-DELIVERED',
            'purchase_request_id' => $prPending->id,
            'supplier_id' => $this->purchaseOrder->supplier_id,
            'created_by_user_id' => $licensesEmployee->id,
            'status' => 'ISSUED',
            'subtotal' => 1000,
            'grand_total' => 1000,
            'delivery_status' => 'DELIVERED',
        ]);

        // 3. PO that does not require warehouse receipt - should NOT appear in queue
        $prNoWarehouse = PurchaseRequest::create([
            'request_number' => 'PR-LIC-Q-NOWH',
            'user_id' => $licensesEmployee->id,
            'department_id' => $licensesDept->id,
            'priority' => 'NORMAL',
            'status' => 'APPROVED_BY_ACCOUNTING',
            'total_estimated_cost' => 1000,
            'date_needed' => now()->toDateString(),
            'requires_warehouse_receipt' => false,
            'request_type' => 'PROJECT',
        ]);
        $poNoWarehouse = PurchaseOrder::create([
            'po_number' => 'PO-LIC-Q-NOWH',
            'purchase_request_id' => $prNoWarehouse->id,
            'supplier_id' => $this->purchaseOrder->supplier_id,
            'created_by_user_id' => $licensesEmployee->id,
            'status' => 'ISSUED',
            'subtotal' => 1000,
            'grand_total' => 1000,
            'delivery_status' => 'NOT_STARTED',
        ]);

        // Call warehouse-queue endpoint as Warehouse Keeper (who is in EXECUTION department)
        $response = $this->actingAs($this->warehouse, 'sanctum')
            ->getJson('/api/v1/purchase-receipts/warehouse-queue');

        $response->assertOk();
        $poNumbers = collect($response->json('data'))->pluck('po_number')->all();

        $this->assertContains('PO-LIC-Q-001', $poNumbers, 'Pending PO from Licenses must be visible to warehouse keeper.');
        $this->assertNotContains('PO-LIC-Q-DELIVERED', $poNumbers, 'Delivered PO must not be in pending warehouse queue.');
        $this->assertNotContains('PO-LIC-Q-NOWH', $poNumbers, 'PO without warehouse receipt requirement must not be in warehouse queue.');

        // Verify alias endpoint works identically
        $aliasResponse = $this->actingAs($this->warehouse, 'sanctum')
            ->getJson('/api/v1/purchase-receipts/pending-warehouse-tasks');
        $aliasResponse->assertOk();
        $aliasPoNumbers = collect($aliasResponse->json('data'))->pluck('po_number')->all();
        $this->assertContains('PO-LIC-Q-001', $aliasPoNumbers);
    }

    public function test_department_reviewer_can_view_and_approve_assigned_receipt(): void
    {
        $licDept = Department::create(['name' => 'التراخيص', 'code' => 'LICENSES', 'is_active' => true]);
        $reviewer = $this->makeUser('reviewer-lic@test', 'م. مصطفى التراخيص', 'reviewer', $licDept->id);
        $emp = $this->makeUser('emp-lic@test', 'موظف التراخيص', 'employee', $licDept->id);
        $supplier = Supplier::create(['code' => 'SUP-LIC', 'company_name' => 'مورد التراخيص', 'is_active' => true]);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-LIC-REV-001',
            'user_id' => $emp->id,
            'department_id' => $licDept->id,
            'reviewer_user_id' => $reviewer->id,
            'site_engineer_user_id' => $reviewer->id, // Reviewer designated himself as receiver
            'priority' => 'NORMAL',
            'status' => 'APPROVED_BY_PROCUREMENT',
            'total_estimated_cost' => 500,
            'date_needed' => now()->toDateString(),
        ]);

        $po = PurchaseOrder::create([
            'po_number' => 'PO-LIC-REV-001',
            'purchase_request_id' => $pr->id,
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $emp->id,
            'status' => 'ISSUED',
            'subtotal' => 500,
            'total_amount' => 500,
        ]);
        $poItem = $po->items()->create([
            'item_description' => 'كشافات طوارئ',
            'quantity' => 10,
            'unit_price' => 50,
            'total_price' => 500,
        ]);

        // Warehouse keeper creates receipt
        $receipt = app(PurchaseReceiptService::class)->createByWarehouse(
            $this->warehouse,
            $po,
            [['purchase_order_item_id' => $poItem->id, 'received_quantity' => 10]],
            now()->toDateString(),
            'ملاحظات المخزن'
        );

        // 1. Reviewer can view the receipt in /assigned
        $assignedRes = $this->actingAs($reviewer, 'sanctum')
            ->getJson('/api/v1/purchase-receipts/assigned');
        $assignedRes->assertOk();
        $assignedIds = collect($assignedRes->json('data'))->pluck('id')->all();
        $this->assertContains($receipt->id, $assignedIds, 'Assigned receipts must be visible to the department reviewer.');

        // 2. Reviewer can inspect and approve the receipt in /approve
        $approveRes = $this->actingAs($reviewer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve", [
                'site_engineer_notes' => 'تم فحص ومطابقة كشافات الطوارئ بمعرفة رئيس قسم التراخيص.',
                'items' => [
                    ['id' => $receipt->items->first()->id, 'received_quantity' => 10],
                ],
            ]);
        $approveRes->assertOk();
        $this->assertEquals('APPROVED', $receipt->fresh()->status);
        $this->assertEquals('PENDING_ACTUAL_PO', $po->fresh()->status);

        // 3. Reviewer can view the approved receipt in /archive
        $archiveRes = $this->actingAs($reviewer, 'sanctum')
            ->getJson('/api/v1/purchase-receipts/archive');
        $archiveRes->assertOk();
        $archiveIds = collect($archiveRes->json('data'))->pluck('id')->all();
        $this->assertContains($receipt->id, $archiveIds, 'Archived receipts must be visible to the department reviewer.');
    }

    private function makeUser(string $email, string $name, string $roleSlug, int $departmentId): User
    {
        $user = User::create([
            'department_id' => $departmentId,
            'name' => $name,
            'email' => $email,
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $user->roles()->attach(Role::where('slug', $roleSlug)->firstOrFail()->id);
        return $user;
    }
}
