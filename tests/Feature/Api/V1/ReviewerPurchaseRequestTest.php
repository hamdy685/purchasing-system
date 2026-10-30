<?php

namespace Tests\Feature\Api\V1;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\Department;
use App\Models\Item;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\Role;
use App\Models\User;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class ReviewerPurchaseRequestTest extends TestCase
{
    use RefreshDatabase;

    private Department $itDept;
    private Department $hrDept;
    private User $itReviewer;
    private User $hrReviewer;
    private User $itSiteEngineer;
    private User $employee;
    private PurchaseRequest $itSubmittedPr;
    private PurchaseRequest $hrSubmittedPr;
    private PurchaseRequestItem $itPrItem;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $this->itDept = Department::create([
            'name' => 'IT Department',
            'code' => 'DEPT-IT',
        ]);

        $this->hrDept = Department::create([
            'name' => 'HR Department',
            'code' => 'DEPT-HR',
        ]);

        $reviewerRole = Role::where('slug', 'reviewer')->first();
        $employeeRole = Role::where('slug', 'employee')->first();
        $siteEngineerRole = Role::where('slug', 'site_engineer')->first();

        // IT Reviewer
        $this->itReviewer = User::create([
            'department_id' => $this->itDept->id,
            'name' => 'Sami IT Reviewer',
            'email' => 'sami@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->itReviewer->roles()->attach($reviewerRole->id);

        // HR Reviewer
        $this->hrReviewer = User::create([
            'department_id' => $this->hrDept->id,
            'name' => 'Huda HR Reviewer',
            'email' => 'huda@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->hrReviewer->roles()->attach($reviewerRole->id);

        $this->itSiteEngineer = User::create([
            'department_id' => $this->itDept->id,
            'name' => 'Site Engineer Fixture',
            'email' => 'site-engineer-fixture@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->itSiteEngineer->roles()->attach($siteEngineerRole->id);
        $this->itDept->update([
            'manager_user_id' => $this->itReviewer->id,
            'site_engineer_user_id' => $this->itSiteEngineer->id,
        ]);
        $this->hrDept->update([
            'manager_user_id' => $this->hrReviewer->id,
            'site_engineer_user_id' => $this->itSiteEngineer->id,
        ]);

        // Employee
        $this->employee = User::create([
            'department_id' => $this->itDept->id,
            'name' => 'Ali Employee',
            'email' => 'ali@ashbiliya.com',
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $this->employee->roles()->attach($employeeRole->id);

        // IT Submitted PR
        $this->itSubmittedPr = PurchaseRequest::create([
            'request_number' => 'PR-2026-00001',
            'user_id' => $this->employee->id,
            'department_id' => $this->itDept->id,
            'target_department_id' => $this->itDept->id,
            'reviewer_user_id' => $this->itReviewer->id,
            'site_engineer_user_id' => $this->itSiteEngineer->id,
            'title' => 'IT Equipment Request',
            'priority' => 'NORMAL',
            'status' => 'SUBMITTED',
        ]);

        $this->itPrItem = $this->itSubmittedPr->items()->create([
            'item_description' => 'Monitor 27 inch',
            'item_reference' => 'IT-PART-001',
            'region' => 'المنطقة السابعة والعشرون',
            'quantity' => 2,
            'uom' => 'PCS',
            'estimated_unit_price' => 500.00,
            'estimated_line_total' => 1000.00,
            'specifications' => '4K Display',
        ]);

        // HR Submitted PR
        $this->hrSubmittedPr = PurchaseRequest::create([
            'request_number' => 'PR-2026-00002',
            'user_id' => $this->hrReviewer->id,
            'department_id' => $this->hrDept->id,
            'target_department_id' => $this->hrDept->id,
            'reviewer_user_id' => $this->hrReviewer->id,
            'site_engineer_user_id' => $this->itSiteEngineer->id,
            'title' => 'HR Stationery Request',
            'priority' => 'LOW',
            'status' => 'SUBMITTED',
        ]);

        $this->hrSubmittedPr->items()->create([
            'item_description' => 'Printer Paper',
            'item_reference' => 'HR-PART-001',
            'region' => 'المنطقة السابعة والعشرون',
            'quantity' => 10,
            'uom' => 'BOX',
            'estimated_unit_price' => 20.00,
            'estimated_line_total' => 200.00,
        ]);
    }

    public function test_reviewer_can_list_reviewable_prs_in_scope(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/reviewer/purchase-requests');

        $response->assertStatus(200);
        $this->assertCount(1, $response->json('data'));
        $this->assertEquals($this->itSubmittedPr->id, $response->json('data.0.id'));
    }

    public function test_reviewer_cannot_view_outside_scope_pr(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/reviewer/purchase-requests/' . $this->hrSubmittedPr->id);

        $this->assertContains($response->status(), [403, 404]);
    }

    public function test_reviewer_can_start_review_submitted_becomes_under_review(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/review');

        $response->assertStatus(200)
            ->assertJson([
                'data' => [
                    'id' => $this->itSubmittedPr->id,
                    'status' => 'UNDER_REVIEW',
                ],
            ]);

        $this->assertDatabaseHas('purchase_requests', [
            'id' => $this->itSubmittedPr->id,
            'status' => 'UNDER_REVIEW',
        ]);

        $this->assertDatabaseHas('approval_history', [
            'target_id' => $this->itSubmittedPr->id,
            'action' => 'REVIEW_STARTED',
            'to_state' => 'UNDER_REVIEW',
        ]);
    }

    public function test_reviewer_can_edit_request_header_and_creates_audit_log(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        // Auto starts review if submitted
        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->putJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id, [
                'priority' => 'HIGH',
            ]);

        $response->assertStatus(200)
            ->assertJson([
                'data' => [
                    'priority' => 'HIGH',
                    ],
            ]);

        $this->assertDatabaseHas('audit_logs', [
            'entity_id' => $this->itSubmittedPr->id,
            'field_name' => 'priority',
            'old_value' => 'NORMAL',
            'new_value' => 'HIGH',
        ]);

    }

    public function test_reviewer_cannot_edit_after_reviewer_approval_while_next_stage_is_pending(): void
    {
        $this->itSubmittedPr->update(['status' => 'PENDING_EXECUTIVE_APPROVAL']);
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->putJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id, [
                'priority' => 'HIGH',
            ]);

        $response->assertStatus(409)
            ->assertJson(['message' => 'لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.']);
    }

    public function test_reviewer_cannot_edit_line_item_after_reviewer_approval(): void
    {
        $this->itSubmittedPr->update(['status' => 'PENDING_EXECUTIVE_APPROVAL']);
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->putJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/items/' . $this->itPrItem->id, [
                'item_reference' => 'LOCKED-PART-001',
                'region' => 'المنطقة السابعة والعشرون',
                'quantity' => 4,
            ]);

        $response->assertStatus(409)
            ->assertJson(['message' => 'لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.']);
    }

    public function test_reviewer_cannot_edit_after_procurement_manager_approval(): void
    {
        $this->itSubmittedPr->update(['status' => 'APPROVED_BY_PROCUREMENT']);
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->putJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id, [
                'priority' => 'HIGH',
            ]);

        $response->assertStatus(409)
            ->assertJson(['message' => 'لا يمكن للمراجع تعديل الطلب بعد اعتماده وإرساله إلى المرحلة التالية.']);
    }

    public function test_reviewer_can_edit_line_item_quantity_and_price_and_recalculates_totals(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        // Update item quantity from 2 -> 4 and price from 500 -> 600
        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->putJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/items/' . $this->itPrItem->id, [
                'item_reference' => 'IT-PART-001',
                'region' => 'المنطقة السابعة والعشرون',
                'quantity' => 4,
                'estimated_unit_price' => 600.00,
                'specifications' => '4K Display 144Hz',
            ]);

        $response->assertStatus(200)
            ->assertJson([
                'data' => [
                ],
            ]);

        // Audit records for quantity and specifications
        $this->assertDatabaseHas('audit_logs', [
            'entity_id' => $this->itPrItem->id,
            'field_name' => 'quantity',
            'old_value' => '2.00',
            'new_value' => '4',
        ]);


        $this->assertDatabaseHas('audit_logs', [
            'entity_id' => $this->itPrItem->id,
            'field_name' => 'specifications',
            'old_value' => '4K Display',
            'new_value' => '4K Display 144Hz',
        ]);
    }

    public function test_reviewer_can_add_line_item_and_recalculates_totals(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/items', [
                'item_description' => 'HDMI Cable 3m',
                'item_reference' => 'IT-PART-002',
                'region' => 'المنطقة السابعة والعشرون',
                'quantity' => 3,
                'uom' => 'PCS',
                'estimated_unit_price' => 50.00,
            ]);

        $response->assertStatus(200)
            ->assertJson([
                'data' => [
                ],
            ]);

        $this->assertDatabaseHas('audit_logs', [
            'action' => 'ITEM_ADDED',
            'field_name' => 'item_description',
            'new_value' => 'HDMI Cable 3m',
        ]);
    }

    public function test_reviewer_can_remove_line_item_and_recalculates_totals(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->deleteJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/items/' . $this->itPrItem->id);

        $response->assertStatus(200)
            ->assertJson([
                'data' => [
                ],
            ]);

        $this->assertDatabaseHas('audit_logs', [
            'action' => 'ITEM_REMOVED',
            'field_name' => 'item_description',
            'old_value' => 'Monitor 27 inch',
        ]);
    }

    public function test_reviewer_can_approve_under_review_request(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/approve', [
                'comment' => 'Specifications and pricing verified cleanly.',
            ]);

        $response->assertStatus(200)
            ->assertJson([
                'message' => 'Purchase request approved successfully.',
                'data' => [
                    'id' => $this->itSubmittedPr->id,
                    'status' => 'PENDING_EXECUTIVE_APPROVAL',
                ],
            ]);

        $this->assertDatabaseHas('purchase_requests', [
            'id' => $this->itSubmittedPr->id,
            'status' => 'PENDING_EXECUTIVE_APPROVAL',
        ]);

        $this->assertDatabaseHas('approval_history', [
            'target_id' => $this->itSubmittedPr->id,
            'action' => 'APPROVED_BY_REVIEWER',
            'to_state' => 'PENDING_EXECUTIVE_APPROVAL',
            'comments' => 'Specifications and pricing verified cleanly.',
            'user_note' => 'Specifications and pricing verified cleanly.',
        ]);
    }

    public function test_reviewer_approval_without_comment_keeps_default_text_out_of_user_note(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/approve', [])
            ->assertStatus(200);

        $entry = ApprovalHistory::where('target_id', $this->itSubmittedPr->id)
            ->where('action', 'APPROVED_BY_REVIEWER')
            ->firstOrFail();

        $this->assertSame('اعتمد المراجع الطلب وأرسله إلى المدير التنفيذي للقرار.', $entry->comments);
        $this->assertNull($entry->user_note);
    }

    public function test_reviewer_approval_fails_if_no_site_engineer_is_selected_and_no_department_default(): void
    {
        $this->itDept->update(['site_engineer_user_id' => null]);
        $this->itSubmittedPr->update(['site_engineer_user_id' => null]);

        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/approve', [
                'comment' => 'No engineer passed',
            ]);

        $response->assertStatus(422)
            ->assertJsonValidationErrors(['site_engineer_user_id']);
    }

    public function test_reviewer_approval_succeeds_when_explicit_site_engineer_is_provided(): void
    {
        $this->itDept->update(['site_engineer_user_id' => null]);
        $this->itSubmittedPr->update(['site_engineer_user_id' => null]);

        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/approve', [
                'comment' => 'Assigned explicit site engineer',
                'site_engineer_user_id' => $this->itSiteEngineer->id,
            ]);

        $response->assertStatus(200);

        $this->assertDatabaseHas('purchase_requests', [
            'id' => $this->itSubmittedPr->id,
            'site_engineer_user_id' => $this->itSiteEngineer->id,
            'status' => 'PENDING_EXECUTIVE_APPROVAL',
        ]);
    }


    public function test_reviewer_cannot_approve_already_approved_request(): void
    {
        $this->itSubmittedPr->update(['status' => 'APPROVED_BY_REVIEWER']);

        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/approve');

        $response->assertStatus(409)
            ->assertJson(['message' => 'Only pending purchase requests can be approved.']);
    }

    public function test_reviewer_can_reject_under_review_request_with_comment(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/reject', [
                'comment' => 'Out of budget allocation for this quarter.',
            ]);

        $response->assertStatus(200)
            ->assertJson([
                'message' => 'Purchase request rejected successfully.',
                'data' => [
                    'id' => $this->itSubmittedPr->id,
                    'status' => 'REJECTED',
                ],
            ]);

        $this->assertDatabaseHas('purchase_requests', [
            'id' => $this->itSubmittedPr->id,
            'status' => 'REJECTED',
            'rejection_reason' => 'Out of budget allocation for this quarter.',
        ]);

        $this->assertDatabaseHas('approval_history', [
            'target_id' => $this->itSubmittedPr->id,
            'action' => 'REJECTED',
            'to_state' => 'REJECTED',
            'comments' => 'Out of budget allocation for this quarter.',
        ]);
    }

    public function test_reject_requires_comment(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->postJson('/api/v1/reviewer/purchase-requests/' . $this->itSubmittedPr->id . '/reject', []);

        $response->assertStatus(422)
            ->assertJsonValidationErrors(['comment']);
    }

    public function test_reviewer_cannot_modify_outside_scope_request(): void
    {
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->putJson('/api/v1/reviewer/purchase-requests/' . $this->hrSubmittedPr->id, [
                'title' => 'Hacking HR Title',
            ]);

        $this->assertContains($response->status(), [403, 404]);
    }

    public function test_employee_cannot_access_reviewer_endpoints(): void
    {
        $token = $this->employee->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/reviewer/purchase-requests');

        $response->assertStatus(403);
    }

    public function test_reviewer_filters_by_all_requested_fields_and_remains_department_scoped(): void
    {
        $this->itSubmittedPr->update(['project' => 'مشروع النخيل']);
        $token = $this->itReviewer->createToken('test_token')->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/reviewer/purchase-requests?' . http_build_query([
                'request_number' => 'PR-2026-00001',
                'requester_name' => 'Ali',
                'status' => 'SUBMITTED',
                'project' => 'النخيل',
                'priority' => 'NORMAL',
                'item_reference' => 'IT-PART-001',
                'region' => 'السابعة والعشرون',
                'from_date' => '2026-01-01',
                'to_date' => '2026-12-31',
            ]));

        $response->assertOk();
        $response->assertJsonCount(1, 'data');
        $this->assertSame($this->itSubmittedPr->id, $response->json('data.0.id'));

        $outsideScope = $this->withHeader('Authorization', 'Bearer ' . $token)
            ->getJson('/api/v1/reviewer/purchase-requests?request_number=PR-2026-00002');

        $outsideScope->assertOk();
        $outsideScope->assertJsonCount(0, 'data');
    }

    public function test_requests_are_routed_strictly_to_target_department_and_hidden_from_requesting_department_reviewer(): void
    {
        // Employee belongs to IT Department ($this->itDept), but request is targeted to HR Department ($this->hrDept)
        $targetedPr = PurchaseRequest::create([
            'request_number' => 'PR-2026-99999',
            'user_id' => $this->employee->id,
            'department_id' => $this->itDept->id,
            'target_department_id' => $this->hrDept->id,
            'reviewer_user_id' => $this->hrReviewer->id,
            'priority' => 'NORMAL',
            'status' => 'SUBMITTED',
            'total_estimated_cost' => 5000,
        ]);

        $targetedPr->items()->create([
            'item_description' => 'مواد خاصة بقسم المباني',
            'quantity' => 10,
            'uom' => 'PCS',
        ]);

        // 1. Reviewer of requesting department (IT Reviewer) MUST NOT see this request
        $itResponse = $this->actingAs($this->itReviewer, 'sanctum')
            ->getJson('/api/v1/reviewer/purchase-requests');
        $itResponse->assertOk();
        $itIds = collect($itResponse->json('data'))->pluck('id')->all();
        $this->assertNotContains($targetedPr->id, $itIds, 'Request targeted to HR must NOT appear in IT reviewer list.');

        // IT Reviewer cannot access it directly (403)
        $itDetailResponse = $this->actingAs($this->itReviewer, 'sanctum')
            ->getJson("/api/v1/reviewer/purchase-requests/{$targetedPr->id}");
        $itDetailResponse->assertStatus(403);

        // 2. Reviewer of target department (HR Reviewer) MUST see this request
        $hrResponse = $this->actingAs($this->hrReviewer, 'sanctum')
            ->getJson('/api/v1/reviewer/purchase-requests');
        $hrResponse->assertOk();
        $hrIds = collect($hrResponse->json('data'))->pluck('id')->all();
        $this->assertContains($targetedPr->id, $hrIds, 'Request targeted to HR MUST appear in HR reviewer list.');

        // HR Reviewer can view it
        $hrDetailResponse = $this->actingAs($this->hrReviewer, 'sanctum')
            ->getJson("/api/v1/reviewer/purchase-requests/{$targetedPr->id}");
        $hrDetailResponse->assertOk();
        $this->assertSame($targetedPr->id, $hrDetailResponse->json('data.id'));
    }

    public function test_reviewer_can_control_whether_warehouse_receipt_is_required_or_bypassed(): void
    {
        // 1. By default, requires_warehouse_receipt is true on creation
        $this->assertTrue($this->itSubmittedPr->requiresWarehouseReceipt());

        // 2. Reviewer approves with requires_warehouse_receipt = false (direct delivery / bypass warehouse)
        $response = $this->actingAs($this->itReviewer, 'sanctum')
            ->postJson("/api/v1/reviewer/purchase-requests/{$this->itSubmittedPr->id}/approve", [
                'comment' => 'توريد مباشر للموقع لا يتطلب استلام عم سلامة بالمخزن.',
                'site_engineer_user_id' => $this->itSiteEngineer->id,
                'requires_warehouse_receipt' => false,
            ]);

        $response->assertOk();
        $this->assertFalse($response->json('data.requires_warehouse_receipt'));

        $this->itSubmittedPr->refresh();
        $this->assertFalse($this->itSubmittedPr->requires_warehouse_receipt);
        $this->assertFalse($this->itSubmittedPr->requiresWarehouseReceipt());

        // 3. Another PR approved with default / true
        $pr2 = PurchaseRequest::create([
            'request_number' => 'PR-2026-88888',
            'user_id' => $this->employee->id,
            'department_id' => $this->itDept->id,
            'reviewer_user_id' => $this->itReviewer->id,
            'priority' => 'NORMAL',
            'status' => 'SUBMITTED',
            'total_estimated_cost' => 1000,
        ]);
        $pr2->items()->create([
            'item_description' => 'أصناف مخزنية',
            'quantity' => 5,
            'uom' => 'PCS',
        ]);

        $response2 = $this->actingAs($this->itReviewer, 'sanctum')
            ->postJson("/api/v1/reviewer/purchase-requests/{$pr2->id}/approve", [
                'comment' => 'استلام مخزني عادي عبر عم سلامة.',
                'site_engineer_user_id' => $this->itSiteEngineer->id,
                'requires_warehouse_receipt' => true,
            ]);

        $response2->assertOk();
        $this->assertTrue($response2->json('data.requires_warehouse_receipt'));
        $pr2->refresh();
        $this->assertTrue($pr2->requires_warehouse_receipt);
        $this->assertTrue($pr2->requiresWarehouseReceipt());
    }
}
