<?php

namespace Tests\Feature\Api\V1;

use App\Models\Department;
use App\Models\Notification as AppNotification;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use App\Services\GuestOfficeRequestService;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;
use Tests\TestCase;

class GuestOfficeRequestTest extends TestCase
{
    use RefreshDatabase;

    private Department $department;
    private User $reviewer;
    private User $admin;
    private string $token;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);
        Notification::fake();

        $this->department = Department::create(['name' => 'الموارد البشرية', 'code' => 'HR', 'is_active' => true]);
        $this->reviewer = $this->createUser('reviewer@test', 'مراجع الموارد البشرية', 'reviewer', $this->department->id);
        $this->admin = $this->createUser('admin@test', 'الأدمن', 'admin');
        $this->token = app(GuestOfficeRequestService::class)->token();
    }

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'name' => 'أحمد محمد',
            'phone' => '01000000000',
            'target_department_id' => $this->department->id,
            'notes' => 'ورق تصوير للمكتب',
            'items' => [
                ['item_description' => 'ورق A4', 'quantity' => 5, 'uom' => 'رزمة'],
            ],
        ], $overrides);
    }

    public function test_link_request_goes_to_department_reviewer_with_typed_name(): void
    {
        $response = $this->postJson("/api/v1/public/office-requests/{$this->token}", $this->payload());

        $response->assertStatus(201);
        $pr = PurchaseRequest::query()->withoutGlobalScopes()->where('request_number', $response->json('data.request_number'))->firstOrFail();

        $this->assertSame('OFFICE_SUPPLIES', $pr->request_type);
        $this->assertSame('أحمد محمد', $pr->guest_requester_name);
        $this->assertSame($this->reviewer->id, (int) $pr->reviewer_user_id);
        $this->assertNotSame('DRAFT', $pr->status);
        $this->assertTrue(GuestOfficeRequestService::isSystemUser((int) $pr->user_id));

        // The typed name replaces the shared account's name wherever the requester is loaded.
        $loaded = PurchaseRequest::query()->withoutGlobalScopes()->with('requester')->findOrFail($pr->id);
        $this->assertSame('أحمد محمد (مقدم مؤقت)', $loaded->requester->name);
        $this->assertSame('مقدم طلب مؤقت', User::findOrFail($pr->user_id)->name);

        // The reviewer is told; the shared account never gets anything.
        $this->assertTrue(AppNotification::where('user_id', $this->reviewer->id)->exists());
        $this->assertFalse(AppNotification::where('user_id', $pr->user_id)->exists());
    }

    public function test_shared_account_cannot_sign_in(): void
    {
        app(GuestOfficeRequestService::class)->systemUser();

        $this->postJson('/api/v1/auth/login', [
            'email' => GuestOfficeRequestService::SYSTEM_USER_EMAIL,
            'password' => '123456',
        ])->assertStatus(401);
    }

    public function test_wrong_or_rotated_token_is_refused(): void
    {
        $this->postJson('/api/v1/public/office-requests/wrong-token', $this->payload())->assertNotFound();

        $this->actingAs($this->admin, 'sanctum')
            ->postJson('/api/v1/admin/guest-office-link/rotate')
            ->assertOk();

        $this->postJson("/api/v1/public/office-requests/{$this->token}", $this->payload())->assertNotFound();
        $this->assertSame(0, PurchaseRequest::query()->withoutGlobalScopes()->count());
    }

    public function test_link_always_makes_office_supplies_and_validates_input(): void
    {
        $this->postJson("/api/v1/public/office-requests/{$this->token}", $this->payload(['request_type' => 'PROJECT']))
            ->assertStatus(201);
        $this->assertSame('OFFICE_SUPPLIES', PurchaseRequest::query()->withoutGlobalScopes()->firstOrFail()->request_type);

        $this->postJson("/api/v1/public/office-requests/{$this->token}", $this->payload(['name' => '', 'items' => []]))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['name', 'items']);
    }

    public function test_only_admin_sees_the_link(): void
    {
        $this->actingAs($this->reviewer, 'sanctum')->getJson('/api/v1/admin/guest-office-link')->assertForbidden();
        $this->actingAs($this->admin, 'sanctum')->getJson('/api/v1/admin/guest-office-link')
            ->assertOk()
            ->assertJsonPath('data.token', $this->token);
    }

    public function test_department_reviewer_confirms_receipt_of_a_link_request(): void
    {
        $response = $this->postJson("/api/v1/public/office-requests/{$this->token}", $this->payload());
        $pr = PurchaseRequest::query()->withoutGlobalScopes()->where('request_number', $response->json('data.request_number'))->firstOrFail();

        $supplier = Supplier::create(['code' => 'SUP-1', 'company_name' => 'مورد', 'is_active' => true, 'opening_balance' => 0]);
        $po = PurchaseOrder::create([
            'po_number' => 'PO-GUEST-1',
            'purchase_request_id' => $pr->id,
            'department_id' => $this->department->id,
            'supplier_id' => $supplier->id,
            'created_by_user_id' => $this->admin->id,
            'status' => 'ISSUED',
            'delivery_status' => 'PENDING',
            'subtotal' => 100,
            'grand_total' => 100,
        ]);
        $poItem = PurchaseOrderItem::create([
            'purchase_order_id' => $po->id,
            'pr_item_id' => $pr->items()->first()->id,
            'item_description' => 'ورق A4',
            'quantity' => 5,
            'unit_price' => 20,
            'line_total' => 100,
            'uom' => 'رزمة',
            'item_reference' => 'مقر الشركة',
            'region' => 'إداري / المقر الرئيسي',
        ]);

        $this->actingAs($this->reviewer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}/confirm-office", [
                'items' => [['purchase_order_item_id' => $poItem->id, 'received_quantity' => 5]],
            ])
            ->assertStatus(201);
    }

    private function createUser(string $email, string $name, string $roleSlug, ?int $departmentId = null): User
    {
        $user = User::create([
            'email' => $email,
            'name' => $name,
            'password' => Hash::make('password'),
            'department_id' => $departmentId,
            'is_active' => true,
        ]);

        $role = Role::where('slug', $roleSlug)->first();
        if ($role) {
            $user->roles()->syncWithoutDetaching([$role->id]);
        }

        return $user;
    }
}
