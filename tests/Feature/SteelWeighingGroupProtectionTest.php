<?php

namespace Tests\Feature;

use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use App\Models\WeighingGroup;
use App\Services\SteelWeighingGroupService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

class SteelWeighingGroupProtectionTest extends TestCase
{
    use RefreshDatabase;

    private User $procurementManager;
    private Supplier $supplier;
    private PurchaseOrder $purchaseOrder;
    private Department $dept;

    protected function setUp(): void
    {
        parent::setUp();

        $role = Role::firstOrCreate(['slug' => 'procurement_manager'], [
            'name' => 'Procurement Manager',
            'department_id' => null,
            'is_active' => true,
        ]);

        $this->dept = Department::create(['name' => 'إدارة التنفيذ', 'code' => 'EXEC-01']);

        $this->procurementManager = User::create([
            'name' => 'مدير المشتريات التجريبي',
            'email' => 'pm_test@alashbiliya.com',
            'password' => Hash::make('password123'),
            'department_id' => $this->dept->id,
            'is_active' => true,
        ]);
        $this->procurementManager->roles()->attach($role->id);

        $this->supplier = Supplier::create([
            'company_name' => 'شركة عز للصلب',
            'contact_person' => 'م. مبيعات',
            'is_active' => true,
        ]);

        $pr = PurchaseRequest::create([
            'request_number' => 'PR-' . uniqid(),
            'user_id' => $this->procurementManager->id,
            'requester_user_id' => $this->procurementManager->id,
            'department_id' => $this->dept->id,
            'status' => 'APPROVED',
            'date_needed' => now()->toDateString(),
        ]);

        $this->purchaseOrder = PurchaseOrder::create([
            'po_number' => 'PO-2026-9999',
            'purchase_request_id' => $pr->id,
            'department_id' => $this->dept->id,
            'supplier_id' => $this->supplier->id,
            'created_by_user_id' => $this->procurementManager->id,
            'status' => 'ISSUED', // receivable PO state (weighing receive now enforces the delivery gate)
            'total_amount' => 500000,
            'grand_total' => 500000,
            'is_actual' => true,
        ]);
    }

    public function test_strictly_rejects_grouping_when_unit_prices_differ(): void
    {
        $service = app(SteelWeighingGroupService::class);

        // Item 1: 38,000 EGP / ton
        $item1 = PurchaseOrderItem::create([
            'purchase_order_id' => $this->purchaseOrder->id,
            'item_description' => 'حديد تسليح 12 مم',
            'quantity' => 2.0,
            'uom' => 'TON',
            'unit_price' => 38000,
            'line_total' => 76000,
            'supplier_id' => $this->supplier->id,
        ]);

        // Item 2: 39,500 EGP / ton (Different price!)
        $item2 = PurchaseOrderItem::create([
            'purchase_order_id' => $this->purchaseOrder->id,
            'item_description' => 'حديد تسليح 16 مم',
            'quantity' => 3.0,
            'uom' => 'TON',
            'unit_price' => 39500,
            'line_total' => 118500,
            'supplier_id' => $this->supplier->id,
        ]);

        $this->expectException(ValidationException::class);

        try {
            $service->createWeighingGroup(
                $this->procurementManager,
                $this->purchaseOrder->id,
                [$item1->id, $item2->id],
                'تجربة تجميع بأسعار مختلفة'
            );
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('items', $e->errors());
            $this->assertEquals(
                'لا يمكن تجميع البنود لأن سعر الطن مختلف بين البنود.',
                $e->errors()['items'][0]
            );
            throw $e;
        }
    }

    public function test_creates_group_with_uniform_price_and_calculates_total_financials(): void
    {
        $service = app(SteelWeighingGroupService::class);

        // Example from final specification:
        // حديد 3 مم: 2 طن
        // حديد 5 مم: 1.5 طن
        // كانات: 0.8 طن
        // حديد 8 مم: 0.7 طن
        // إجمالي المطلوب = 5 طن
        // سعر الطن = 41,500 جنيه
        $tonPrice = 41500;

        $item1 = PurchaseOrderItem::create([
            'purchase_order_id' => $this->purchaseOrder->id,
            'item_description' => 'حديد 3 مم',
            'quantity' => 2.0,
            'uom' => 'TON',
            'unit_price' => $tonPrice,
            'line_total' => 2.0 * $tonPrice,
            'supplier_id' => $this->supplier->id,
        ]);

        $item2 = PurchaseOrderItem::create([
            'purchase_order_id' => $this->purchaseOrder->id,
            'item_description' => 'حديد 5 مم',
            'quantity' => 1.5,
            'uom' => 'TON',
            'unit_price' => $tonPrice,
            'line_total' => 1.5 * $tonPrice,
            'supplier_id' => $this->supplier->id,
        ]);

        $item3 = PurchaseOrderItem::create([
            'purchase_order_id' => $this->purchaseOrder->id,
            'item_description' => 'كانات حديد',
            'quantity' => 0.8,
            'uom' => 'TON',
            'unit_price' => $tonPrice,
            'line_total' => 0.8 * $tonPrice,
            'supplier_id' => $this->supplier->id,
        ]);

        $item4 = PurchaseOrderItem::create([
            'purchase_order_id' => $this->purchaseOrder->id,
            'item_description' => 'حديد 8 مم',
            'quantity' => 0.7,
            'uom' => 'TON',
            'unit_price' => $tonPrice,
            'line_total' => 0.7 * $tonPrice,
            'supplier_id' => $this->supplier->id,
        ]);

        $group = $service->createWeighingGroup(
            $this->procurementManager,
            $this->purchaseOrder->id,
            [$item1->id, $item2->id, $item3->id, $item4->id],
            'وزنة حديد مجمعة للشحنة'
        );

        $this->assertInstanceOf(WeighingGroup::class, $group);
        $this->assertEquals(5.0, (float) $group->total_ordered_weight);
        $this->assertEquals(41500.0, (float) $group->unit_price);
        $this->assertEquals(207500.0, (float) $group->total_amount); // 5.0 * 41,500

        // Receiving: Actual scale ticket = 5.8 tons
        // Rule: 5.8 * 41,500 = 240,700 EGP
        $receipt = $service->recordReceiving(
            $this->procurementManager,
            $group->id,
            5.8,
            'https://drive.google.com/file/d/test-scale-photo/view',
            [],
            'ملاحظات الاستلام بالموقع'
        );

        $group->refresh();
        $this->assertEquals('RECEIVED', $group->status);
        $this->assertEquals(5.8, (float) $group->total_received_weight);
        $this->assertEquals(240700.0, (float) $group->total_amount); // 5.8 * 41,500 = 240,700 EGP
        $this->assertEquals(0.8, (float) $group->weight_difference);
        $this->assertNotNull($receipt->id);
    }
}
