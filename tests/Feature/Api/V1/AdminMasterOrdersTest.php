<?php

namespace Tests\Feature\Api\V1;

use App\Models\AdminAuditLog;
use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseReceiptItem;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\SupplierInvoice;
use App\Models\SystemEvent;
use App\Models\User;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class AdminMasterOrdersTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);
    }

    private function makeUser(string $roleSlug, string $email): User
    {
        $user = User::create([
            'name' => ucfirst($roleSlug) . ' Test User',
            'email' => $email,
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);

        $role = Role::where('slug', $roleSlug)->firstOrFail();
        $user->roles()->attach($role->id);

        return $user;
    }

    public function test_admin_can_access_all_orders_master(): void
    {
        $admin = $this->makeUser('admin', 'admin-master-test@ashbiliya.com');
        $dept = Department::create(['name' => 'إدارة التنفيذ', 'code' => 'EXEC']);
        $supplier = Supplier::create([
            'company_name' => 'شركة الراجحي للحديد',
            'name' => 'سعيد الراجحي',
            'email' => 'rajhi@example.com',
            'is_active' => true,
        ]);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-2026-9001',
            'department_id' => $dept->id,
            'user_id' => $admin->id,
            'status' => 'APPROVED_BY_PROCUREMENT',
            'total_estimated_cost' => 50000,
        ]);

        $po = PurchaseOrder::create([
            'po_number' => 'PO-2026-9001',
            'purchase_request_id' => $pr->id,
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $admin->id,
            'status' => 'ISSUED',
            'subtotal' => 50000,
            'grand_total' => 50000,
        ]);

        PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'item_description' => 'حديد تسليح 16 مم',
            'quantity' => 10,
            'uom' => 'TON',
            'unit_price' => 5000,
            'line_total' => 50000,
        ]);

        $response = $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/all-orders-master');

        $response->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonStructure([
                'success',
                'data',
                'meta',
                'stats' => [
                    'total_count',
                    'invoiced_count',
                    'actual_po_count',
                    'pending_actual_po_count',
                    'po_issued_count',
                    'total_financial_value',
                ],
                'lookups',
            ]);

        $data = $response->json('data');
        $this->assertNotEmpty($data);
        $this->assertEquals('PO-2026-9001', $data[0]['po_number']);
        $this->assertEquals('PO_ISSUED', $data[0]['cycle_stage']);
    }

    public function test_admin_can_perform_force_update_override_on_order(): void
    {
        $admin = $this->makeUser('admin', 'admin-force-test@ashbiliya.com');
        $dept = Department::create(['name' => 'إدارة المشروعات', 'code' => 'PROJ']);
        $supplier = Supplier::create([
            'company_name' => 'مؤسسة البناء الحديث',
            'name' => 'أحمد البناء',
            'email' => 'binaa@example.com',
            'is_active' => true,
        ]);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-2026-9002',
            'department_id' => $dept->id,
            'user_id' => $admin->id,
            'status' => 'APPROVED_BY_ACCOUNTING',
            'total_estimated_cost' => 10000,
        ]);

        $po = PurchaseOrder::create([
            'po_number' => 'PO-2026-9002',
            'purchase_request_id' => $pr->id,
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $admin->id,
            'status' => 'PENDING_ACTUAL_PO',
            'subtotal' => 10000,
            'grand_total' => 10000,
        ]);

        $poItem = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'item_description' => 'إسمنت بورتلاندي',
            'quantity' => 100,
            'uom' => 'BAG',
            'unit_price' => 100,
            'line_total' => 10000,
        ]);

        $receipt = PurchaseReceipt::create([
            'purchase_order_id' => $po->id,
            'receipt_number' => 'GRN-2026-9002',
            'status' => 'APPROVED',
        ]);

        PurchaseReceiptItem::create([
            'purchase_receipt_id' => $receipt->id,
            'purchase_order_item_id' => $poItem->id,
            'ordered_quantity' => 100,
            'received_quantity' => 100,
            'uom' => 'BAG',
        ]);

        // Force update: change price from 100 to 120 and qty from 100 to 120, and force status to ISSUED + is_actual_po
        $payload = [
            'status' => 'ISSUED',
            'is_actual_po' => true,
            'admin_reason' => 'تصحيح مباشر للكميات الفعلية بعد توقيع محاضر الموقع',
            'sync_receipt' => true,
            'sync_pr' => true,
            'items' => [
                [
                    'id' => $poItem->id,
                    'item_description' => 'إسمنت بورتلاندي ممتاز',
                    'quantity' => 120,
                    'uom' => 'BAG',
                    'unit_price' => 120,
                    'specifications' => 'مقاوم للكبريتات',
                ],
            ],
        ];

        $response = $this->actingAs($admin, 'sanctum')
            ->putJson("/api/v1/admin/orders/{$po->id}/force-update", $payload);

        $response->assertOk()
            ->assertJsonPath('success', true);

        // Verify PO was updated
        $po->refresh();
        $this->assertEquals('ISSUED', $po->status);
        $this->assertNotNull($po->finalized_at);
        $this->assertEquals(14400, (float) $po->grand_total);

        // Verify receipt item was synchronized
        $rcptItem = PurchaseReceiptItem::where('purchase_receipt_id', $receipt->id)->first();
        $this->assertEquals(120, (float) $rcptItem->received_quantity);

        // Verify Audit Log was recorded
        $auditEvent = SystemEvent::where('action', 'ADMIN_FORCE_UPDATE')
            ->where('entity_id', $po->id)
            ->first();

        $this->assertNotNull($auditEvent);
        $this->assertEquals($admin->id, $auditEvent->actor_user_id);
        $this->assertStringContainsString('تصحيح مباشر للكميات الفعلية', $auditEvent->description);
    }

    public function test_admin_can_force_update_order_items_suppliers_individually_and_sync_accounting(): void
    {
        $admin = $this->makeUser('admin', 'admin-multisup-test@ashbiliya.com');
        $dept = Department::create(['name' => 'إدارة المباني', 'code' => 'BLD-MULTI']);

        $supplierA = Supplier::create([
            'company_name' => 'شركة التوريدات الأولى (أ)',
            'name' => 'المورد أ',
            'email' => 'supA@example.com',
            'is_active' => true,
        ]);
        $supplierB = Supplier::create([
            'company_name' => 'شركة الطوب الأحمر الحديث (ب)',
            'name' => 'المورد ب',
            'email' => 'supB@example.com',
            'is_active' => true,
        ]);
        $supplierC = Supplier::create([
            'company_name' => 'مؤسسة أسمنت المعلم (ج)',
            'name' => 'المورد ج',
            'email' => 'supC@example.com',
            'is_active' => true,
        ]);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-2026-MULTI-01',
            'department_id' => $dept->id,
            'user_id' => $admin->id,
            'status' => 'APPROVED_BY_PROCUREMENT',
            'total_estimated_cost' => 36137.5,
        ]);

        $po = PurchaseOrder::create([
            'po_number' => 'PO-2026-MULTI-01',
            'purchase_request_id' => $pr->id,
            'supplier_id' => $supplierA->id,
            'created_by_user_id' => $admin->id,
            'status' => 'ISSUED',
            'subtotal' => 36137.5,
            'grand_total' => 36137.5,
        ]);

        $item1 = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'supplier_id' => $supplierA->id,
            'item_description' => 'طوب أحمر مفرغ',
            'quantity' => 12,
            'uom' => 'BRICKS',
            'unit_price' => 2450,
            'line_total' => 29400,
        ]);

        $item2 = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'supplier_id' => $supplierA->id,
            'item_description' => 'اسمنت المعلم',
            'quantity' => 1.75,
            'uom' => 'TON',
            'unit_price' => 3850,
            'line_total' => 6737.5,
        ]);

        $receipt = PurchaseReceipt::create([
            'purchase_order_id' => $po->id,
            'receipt_number' => 'GRN-MULTI-01',
            'status' => 'APPROVED',
            'supplier_id' => $supplierA->id,
        ]);

        // Force update: Assign item1 to supplierB and item2 to supplierC
        $payload = [
            'status' => 'ISSUED',
            'supplier_id' => $supplierB->id,
            'is_actual_po' => true,
            'admin_reason' => 'تخصيص مورد مستقل لكل بند وتثبيت أمر الشراء الفعلي',
            'sync_receipt' => true,
            'sync_pr' => true,
            'items' => [
                [
                    'id' => $item1->id,
                    'supplier_id' => $supplierB->id,
                    'item_description' => 'طوب أحمر مفرغ عالي الجودة',
                    'quantity' => 12,
                    'uom' => 'BRICKS',
                    'unit_price' => 2450,
                ],
                [
                    'id' => $item2->id,
                    'supplier_id' => $supplierC->id,
                    'item_description' => 'اسمنت المعلم بورتلاندي',
                    'quantity' => 1.75,
                    'uom' => 'TON',
                    'unit_price' => 3850,
                ],
            ],
        ];

        $response = $this->actingAs($admin, 'sanctum')
            ->putJson("/api/v1/admin/orders/{$po->id}/force-update", $payload);

        $response->assertOk()
            ->assertJsonPath('success', true);

        // Verify items in DB
        $item1Fresh = $item1->fresh(['supplier']);
        $item2Fresh = $item2->fresh(['supplier']);

        $this->assertEquals($supplierB->id, $item1Fresh->supplier_id);
        $this->assertEquals($supplierC->id, $item2Fresh->supplier_id);

        // Verify show details API returns items with supplier relationship
        $detailsRes = $this->actingAs($admin, 'sanctum')
            ->getJson("/api/v1/admin/orders/{$po->id}/details");
        $detailsRes->assertOk();
        $itemsData = $detailsRes->json('data.order.items');
        $this->assertCount(2, $itemsData);
        $this->assertEquals($supplierB->id, $itemsData[0]['supplier_id']);
        $this->assertEquals($supplierC->id, $itemsData[1]['supplier_id']);

        // Verify Purchases Report reflects each item's actual supplier
        $reportRes = $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/reports/purchases?filter_type=custom&from_date=' . now()->subDays(5)->toDateString() . '&to_date=' . now()->addDays(5)->toDateString() . '&actual_only=0');
        $reportRes->assertOk();
        $reportRows = collect($reportRes->json('rows'));
        $row1 = $reportRows->firstWhere('id', "PO-{$po->id}-ITEM-{$item1->id}");
        $row2 = $reportRows->firstWhere('id', "PO-{$po->id}-ITEM-{$item2->id}");

        $this->assertNotNull($row1);
        $this->assertNotNull($row2);
        $this->assertEquals('شركة الطوب الأحمر الحديث (ب)', $row1['supplier_name']);
        $this->assertEquals('مؤسسة أسمنت المعلم (ج)', $row2['supplier_name']);
    }

    /**
     * Reproduces PO-260: steel lines left at quantity 0 after weighing make the whole
     * save fail with a generic 422, and the message never names the offending item.
     */
    public function test_force_update_with_zero_quantity_lines_reports_the_actual_item(): void
    {
        $admin = $this->makeUser('admin', 'admin-zero-qty@ashbiliya.com');
        $dept = Department::create(['name' => 'التنفيذ', 'code' => 'EXEC0']);
        $supplier = Supplier::create(['company_name' => 'حسان', 'name' => 'مورد حديد', 'is_active' => true]);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-ZERO-1',
            'department_id' => $dept->id,
            'user_id' => $admin->id,
            'status' => 'ISSUED',
            'total_estimated_cost' => 1000,
        ]);
        $po = PurchaseOrder::create([
            'po_number' => 'PO-ZERO-1',
            'purchase_request_id' => $pr->id,
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $admin->id,
            'status' => 'ISSUED',
            'subtotal' => 1000,
            'grand_total' => 1000,
        ]);
        $weighed = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'item_description' => 'حديد',
            'quantity' => 5.18,
            'uom' => 'TON',
            'unit_price' => 43000,
            'line_total' => 222740,
        ]);
        $zero = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'item_description' => 'حديد 4 لنيه',
            'quantity' => 0,
            'uom' => 'TON',
            'unit_price' => 43000,
            'line_total' => 0,
        ]);

        // Exactly what the screen sends: every loaded line, status ISSUED.
        $response = $this->actingAs($admin, 'sanctum')
            ->putJson("/api/v1/admin/orders/{$po->id}/force-update", [
                'status' => 'ISSUED',
                'supplier_id' => $supplier->id,
                'is_actual_po' => false,
                'admin_reason' => 'تصحيح بيانات الوزنة',
                'items' => [
                    ['id' => $weighed->id, 'supplier_id' => $supplier->id, 'item_description' => 'حديد', 'quantity' => 5.18, 'uom' => 'TON', 'unit_price' => 43000, 'delete' => false],
                    ['id' => $zero->id, 'supplier_id' => $supplier->id, 'item_description' => 'حديد 4 لنيه', 'quantity' => 0, 'uom' => 'TON', 'unit_price' => 43000, 'delete' => false],
                ],
            ]);

        $response->assertOk();
        $this->assertEquals(0.0, (float) $zero->fresh()->quantity);
    }

    public function test_force_update_validation_error_names_the_item_in_arabic(): void
    {
        $admin = $this->makeUser('admin', 'admin-bad-item@ashbiliya.com');
        $supplier = Supplier::create(['company_name' => 'مورد', 'name' => 'مورد', 'is_active' => true]);
        $dept = Department::create(['name' => 'المكتب', 'code' => 'OFF0']);
        $pr = PurchaseRequest::create([
            'request_number' => 'PR-BAD-1',
            'department_id' => $dept->id,
            'user_id' => $admin->id,
            'status' => 'ISSUED',
            'total_estimated_cost' => 10,
        ]);
        $po = PurchaseOrder::create([
            'purchase_request_id' => $pr->id,
            'po_number' => 'PO-BAD-1',
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $admin->id,
            'status' => 'ISSUED',
            'subtotal' => 0,
            'grand_total' => 0,
        ]);
        $item = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'item_description' => 'أسمنت',
            'quantity' => 1,
            'uom' => 'TON',
            'unit_price' => 10,
            'line_total' => 10,
        ]);

        $response = $this->actingAs($admin, 'sanctum')
            ->putJson("/api/v1/admin/orders/{$po->id}/force-update", [
                'admin_reason' => 'اختبار',
                'items' => [
                    ['id' => $item->id, 'item_description' => 'أسمنت', 'quantity' => -2, 'uom' => 'TON', 'unit_price' => 10],
                ],
            ]);

        $response->assertStatus(422);
        $message = (string) $response->json('message');
        $this->assertMatchesRegularExpression('/[\x{0600}-\x{06FF}]/u', $message);
        $this->assertStringContainsString('البند 1', $message);
        $this->assertStringContainsString('الكمية', $message);
    }

    public function test_non_admin_cannot_access_or_force_update(): void
    {
        $employee = $this->makeUser('employee', 'emp-test@ashbiliya.com');

        $response = $this->actingAs($employee, 'sanctum')
            ->getJson('/api/v1/admin/all-orders-master');
        $response->assertForbidden();

        $response2 = $this->actingAs($employee, 'sanctum')
            ->putJson('/api/v1/admin/orders/1/force-update', [
                'admin_reason' => 'hacking',
            ]);
        $response2->assertForbidden();

        $response3 = $this->actingAs($employee, 'sanctum')
            ->deleteJson('/api/v1/admin/orders/1/force-delete', [
                'reason' => 'hacking',
            ]);
        $response3->assertForbidden();
    }

    public function test_admin_can_force_delete_order_and_its_entire_document_cycle(): void
    {
        $admin = $this->makeUser('admin', 'admin-delete-test@ashbiliya.com');
        $dept = Department::create(['name' => 'إدارة التنفيذ', 'code' => 'EXEC2']);
        $supplier = Supplier::create([
            'company_name' => 'شركة توريدات الدلتا',
            'name' => 'محمد الدلتا',
            'email' => 'delta@example.com',
            'is_active' => true,
        ]);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-2026-9003',
            'department_id' => $dept->id,
            'user_id' => $admin->id,
            'status' => 'APPROVED_BY_ACCOUNTING',
            'total_estimated_cost' => 30000,
        ]);

        $prItem = PurchaseRequestItem::create([
            'purchase_request_id' => $pr->id,
            'item_description' => 'طوب أحمر مفرغ',
            'quantity' => 1000,
            'uom' => 'PIECE',
            'estimated_unit_price' => 30,
            'estimated_line_total' => 30000,
        ]);

        $po = PurchaseOrder::create([
            'po_number' => 'PO-2026-9003',
            'purchase_request_id' => $pr->id,
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $admin->id,
            'status' => 'ISSUED',
            'subtotal' => 30000,
            'grand_total' => 30000,
        ]);

        $poItem = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'item_description' => 'طوب أحمر مفرغ',
            'quantity' => 1000,
            'uom' => 'PIECE',
            'unit_price' => 30,
            'line_total' => 30000,
        ]);

        $receipt = PurchaseReceipt::create([
            'purchase_order_id' => $po->id,
            'purchase_request_id' => $pr->id,
            'receipt_number' => 'GRN-2026-9003',
            'status' => 'APPROVED',
        ]);

        $receiptItem = PurchaseReceiptItem::create([
            'purchase_receipt_id' => $receipt->id,
            'purchase_order_item_id' => $poItem->id,
            'ordered_quantity' => 1000,
            'received_quantity' => 1000,
            'uom' => 'PIECE',
        ]);

        $invoice = SupplierInvoice::create([
            'supplier_id' => $supplier->id,
            'purchase_order_id' => $po->id,
            'purchase_receipt_id' => $receipt->id,
            'created_by_user_id' => $admin->id,
            'invoice_number' => 'INV-2026-9003',
            'amount' => 30000,
            'status' => 'PENDING',
            'invoice_date' => now()->toDateString(),
        ]);

        $response = $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/orders/{$po->id}/force-delete", [
                'reason' => 'طلب تجريبي تم إلغاؤه نهائياً',
            ]);

        $response->assertOk()
            ->assertJsonPath('success', true);

        // Verify safe cancellation of entire cycle without deleting financial trail
        $this->assertEquals('CANCELLED', $po->fresh()->status);

        // Verify Admin Audit Log was recorded
        $auditLog = AdminAuditLog::where('action', 'ADMIN_CANCEL_ORDER')
            ->where('entity_id', $po->id)
            ->first();
        $this->assertNotNull($auditLog);
        $this->assertEquals($admin->id, $auditLog->actor_user_id);
    }

    public function test_admin_can_force_delete_standalone_purchase_request(): void
    {
        $admin = $this->makeUser('admin', 'admin-pr-del@ashbiliya.com');
        $dept = Department::create(['name' => 'إدارة الخدمات', 'code' => 'SERV']);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-2026-9004',
            'department_id' => $dept->id,
            'user_id' => $admin->id,
            'status' => 'SUBMITTED',
            'total_estimated_cost' => 5000,
        ]);

        $prItem = PurchaseRequestItem::create([
            'purchase_request_id' => $pr->id,
            'item_description' => 'أدوات مكتبية وقرطاسية',
            'quantity' => 10,
            'uom' => 'SET',
            'estimated_unit_price' => 500,
            'estimated_line_total' => 5000,
        ]);

        $response = $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/orders/{$pr->id}/force-delete", [
                'entity_type' => 'request',
                'reason' => 'طلب مكرر بالخطأ',
            ]);

        $response->assertOk()
            ->assertJsonPath('success', true);

        $this->assertEquals('CANCELLED', $pr->fresh()->status);

        $auditLog = AdminAuditLog::where('action', 'ADMIN_CANCEL_REQUEST')
            ->where('entity_id', $pr->id)
            ->first();
        $this->assertNotNull($auditLog);
        $this->assertEquals($admin->id, $auditLog->actor_user_id);
    }
}

