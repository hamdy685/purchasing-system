<?php

namespace Tests\Feature\Api\V1;

use App\Models\ApprovalHistory;
use App\Models\Department;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\User;
use App\Services\PurchaseRequestService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * Procurement and the financial manager skip the department reviewer, so on submit they must
 * take the reviewer's decision: who receives the materials and whether they pass the warehouse.
 */
class BypassRequesterReceiverSelectionTest extends TestCase
{
    use RefreshDatabase;

    private Department $targetDept;

    private Department $ownDept;

    private User $siteEngineer;

    protected function setUp(): void
    {
        parent::setUp();

        $this->ownDept = Department::create(['name' => 'المشتريات', 'code' => 'PROCUREMENT', 'is_active' => true]);
        $this->targetDept = Department::create(['name' => 'التنفيذ', 'code' => 'EXECUTION', 'is_active' => true]);

        $this->siteEngineer = $this->userWithRole('site_engineer', $this->targetDept);
    }

    private function userWithRole(string $slug, Department $dept): User
    {
        $role = Role::firstOrCreate(['slug' => $slug], ['name' => $slug]);
        $user = User::create([
            'name' => $slug,
            'email' => $slug . '@bypass.test',
            'password' => bcrypt('secret'),
            'department_id' => $dept->id,
            'is_active' => true,
        ]);
        $user->roles()->attach($role->id);

        return $user->fresh('roles');
    }

    private function draftFor(User $user): PurchaseRequest
    {
        $pr = PurchaseRequest::create([
            'request_number' => 'PR-BYPASS-' . $user->id,
            'user_id' => $user->id,
            'department_id' => $user->department_id,
            'target_department_id' => $this->targetDept->id,
            'status' => 'DRAFT',
            'request_type' => 'PROJECT',
            'parcel_reference' => 'قطعة 12',
            'region' => 'النرجس',
        ]);
        $pr->items()->create(['item_description' => 'أسمنت', 'quantity' => 10, 'uom' => 'شيكارة']);

        return $pr;
    }

    public static function bypassRoles(): array
    {
        return [
            'procurement manager' => ['procurement_manager', 'مدير المشتريات'],
            'financial manager' => ['accountant', 'المدير المالي'],
        ];
    }

    /** @dataProvider bypassRoles */
    public function test_submit_without_receiver_is_rejected(string $slug): void
    {
        $requester = $this->userWithRole($slug, $this->ownDept);
        $pr = $this->draftFor($requester);

        try {
            app(PurchaseRequestService::class)->submitRequest($requester, $pr);
            $this->fail('Submitting without a receiver should be rejected.');
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('site_engineer_user_id', $e->errors());
        }

        $this->assertSame('DRAFT', $pr->fresh()->status);
    }

    /** @dataProvider bypassRoles */
    public function test_submit_records_receiver_and_warehouse_route_like_a_reviewer(string $slug, string $actorLabel): void
    {
        $requester = $this->userWithRole($slug, $this->ownDept);
        $pr = $this->draftFor($requester);

        $submitted = app(PurchaseRequestService::class)->submitRequest($requester, $pr, $this->siteEngineer->id, false);

        $this->assertSame('PENDING_EXECUTIVE_APPROVAL', $submitted->status);
        $this->assertSame($this->siteEngineer->id, (int) $submitted->site_engineer_user_id);
        $this->assertFalse((bool) $submitted->requires_warehouse_receipt);

        $history = ApprovalHistory::where('target_id', $pr->id)->where('actor_user_id', $requester->id)->first();
        $this->assertNotNull($history);
        $this->assertSame('APPROVED_BY_REVIEWER', $history->action);
        $this->assertStringContainsString($actorLabel, $history->comments);
    }

    /** @dataProvider bypassRoles */
    public function test_department_default_site_engineer_satisfies_the_receiver(string $slug): void
    {
        $this->targetDept->update(['site_engineer_user_id' => $this->siteEngineer->id]);
        $requester = $this->userWithRole($slug, $this->ownDept);
        $pr = $this->draftFor($requester);

        $submitted = app(PurchaseRequestService::class)->submitRequest($requester, $pr);

        $this->assertSame('PENDING_EXECUTIVE_APPROVAL', $submitted->status);
        $this->assertSame($this->siteEngineer->id, (int) $submitted->site_engineer_user_id);
    }

    public function test_office_supplies_need_no_receiver(): void
    {
        $requester = $this->userWithRole('procurement_manager', $this->ownDept);
        $pr = $this->draftFor($requester);
        $pr->update(['request_type' => 'OFFICE_SUPPLIES', 'parcel_reference' => null, 'region' => null]);

        $submitted = app(PurchaseRequestService::class)->submitRequest($requester, $pr);

        $this->assertSame('PENDING_EXECUTIVE_APPROVAL', $submitted->status);
        $this->assertNull($submitted->site_engineer_user_id);
    }
}
