<?php

namespace Tests\Feature\Api\V1;

use App\Models\Department;
use App\Models\LandParcel;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\User;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Strict End-to-End Workflow Verification:
 * Validates the 9-Gate Manual Approval Cycle with ZERO Automated State Transitions.
 * Each transition strictly requires an explicit human action by the designated role.
 */
class StrictManualGateWorkflowTest extends TestCase
{
    use RefreshDatabase;

    private Department $deptExecution;
    private User $siteEngineer;
    private User $reviewer;
    private User $generalManager;
    private User $procurementOfficer;
    private User $warehouseKeeper;
    private User $habibaAccountant;
    private User $financialDirector;
    private Supplier $supplier;
    private LandParcel $parcel;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(RolePermissionSeeder::class);

        $this->deptExecution = Department::create([
            'name' => 'إدارة التنفيذ والمشاريع',
            'code' => 'EXECUTION',
            'is_active' => true,
        ]);

        $this->siteEngineer = $this->createUser('site_eng_strict@test', 'م. مهندس الموقع', 'site_engineer', $this->deptExecution->id);
        $this->reviewer = $this->createUser('reviewer_strict@test', 'م. مراجع التنفيذ', 'reviewer', $this->deptExecution->id);
        $this->generalManager = $this->createUser('gm_strict@test', 'المدير التنفيذي', 'general_manager');
        $this->procurementOfficer = $this->createUser('procurement_strict@test', 'م. أحمد مشتريات', 'procurement_manager', $this->deptExecution->id);
        $this->warehouseKeeper = $this->createUser('warehouse_strict@test', 'عم سلامة (أمين المخزن)', 'warehouse_keeper', $this->deptExecution->id);
        
        // Eng. Habiba (General Accountant)
        $this->habibaAccountant = $this->createUser('habiba@ashbiliya.com', 'م. حبيبة (المحاسب العام)', 'general_accountant');
        // Financial Director (Accountant)
        $this->financialDirector = $this->createUser('hasan_finance@test', 'أ. حسن (المدير المالي)', 'accountant');

        // Assign site engineer and reviewer to department defaults
        $this->deptExecution->update([
            'manager_user_id' => $this->reviewer->id,
            'site_engineer_user_id' => $this->siteEngineer->id,
        ]);

        $this->supplier = Supplier::create([
            'code' => 'SUP-STRICT-001',
            'company_name' => 'شركة النيل للحديد والصلب',
            'contact_name' => 'أحمد العشري',
            'phone' => '01011112222',
            'is_active' => true,
            'opening_balance' => 0,
        ]);

        $this->parcel = LandParcel::create([
            'parcel_reference' => 'PARCEL-STRICT-001',
            'region' => 'منطقة بيت الوطن',
            'opening_balance' => 100000,
            'funded_total' => 0,
            'expense_total' => 0,
            'balance' => 100000,
            'is_active' => true,
        ]);
    }

    /**
     * Test the full 9-Gate lifecycle with strict manual stop assertions at every gate.
     */
    public function test_strict_nine_gate_lifecycle_with_no_automated_transitions(): void
    {
        // ─────────────────────────────────────────────────────────────
        // GATE 1: SITE ENGINEER CREATES PR (Initial state is DRAFT)
        // ─────────────────────────────────────────────────────────────
        $createPrPayload = [
            'department_id' => $this->deptExecution->id,
            'assigned_reviewer_id' => $this->reviewer->id,
            'site_engineer_user_id' => $this->siteEngineer->id,
            'parcel_reference' => 'PARCEL-STRICT-001',
            'region' => 'منطقة بيت الوطن',
            'date_needed' => now()->addDays(5)->toDateString(),
            'priority' => 'HIGH',
            'justification' => 'احتياج حديد تسليح لبشة الأساسات',
            'items' => [
                [
                    'item_description' => 'حديد تسليح قطاع 16 مم',
                    'item_reference' => 'PARCEL-STRICT-001',
                    'region' => 'منطقة بيت الوطن',
                    'quantity' => 15,
                    'uom' => 'TON',
                    'specifications' => 'حديد عز عالي المقاومة',
                ],
            ],
        ];

        $createPrResponse = $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson('/api/v1/purchase-requests', $createPrPayload);

        $createPrResponse->assertStatus(201);
        $prId = $createPrResponse->json('data.id');
        $this->assertNotNull($prId);

        $pr = PurchaseRequest::with('items')->findOrFail($prId);

        // Verification: Newly created PR is in DRAFT (it does NOT auto-submit)
        $this->assertSame('DRAFT', $pr->status);

        // Site Engineer explicitly submits PR to the reviewer
        $submitPrResponse = $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-requests/{$pr->id}/submit", [
                'site_engineer_user_id' => $this->siteEngineer->id,
            ]);

        $submitPrResponse->assertStatus(200);
        $pr->refresh();

        // Verification: Status is now SUBMITTED
        $this->assertSame('SUBMITTED', $pr->status);

        // NEGATIVE ASSERTION GATE 1:
        // System must HALT. PR is NOT approved, and Procurement CANNOT issue PO for unapproved PR.
        $prematurePoAttempt = $this->actingAs($this->procurementOfficer, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
                'status' => 'ISSUED',
                'items' => [
                    [
                        'pr_item_id' => $pr->items->first()->id,
                        'item_description' => 'حديد تسليح قطاع 16 مم',
                        'quantity' => 15,
                        'unit_price' => 40000,
                        'uom' => 'TON',
                    ],
                ],
            ]);
        // Procurement PO controller rejects PR that is not APPROVED_BY_PROCUREMENT
        $this->assertTrue(in_array($prematurePoAttempt->status(), [409, 422], true));
        $this->assertDatabaseMissing('purchase_orders', ['purchase_request_id' => $pr->id]);

        // ─────────────────────────────────────────────────────────────
        // GATE 2: REVIEWER EXPLICIT APPROVAL (Manual Action by Reviewer)
        // ─────────────────────────────────────────────────────────────
        $reviewerApproveResponse = $this->actingAs($this->reviewer, 'sanctum')
            ->postJson("/api/v1/reviewer/purchase-requests/{$pr->id}/approve", [
                'comment' => 'تم فحص المخططات الإنشائية والكميات مطابقة للوحة',
                'site_engineer_user_id' => $this->siteEngineer->id,
            ]);

        $reviewerApproveResponse->assertStatus(200);

        $pr->refresh();
        // Gate 2 Check: State moved to PENDING_EXECUTIVE_APPROVAL
        $this->assertSame('PENDING_EXECUTIVE_APPROVAL', $pr->status);

        // NEGATIVE ASSERTION GATE 2:
        // System must HALT. PR has NO supplier chosen, NO quotes, and NO purchase order.
        $this->assertNull($pr->supplier_id);
        $this->assertNull($pr->direct_supplier_id);
        $this->assertDatabaseMissing('purchase_orders', ['purchase_request_id' => $pr->id]);

        // ─────────────────────────────────────────────────────────────
        // GATE 3: GENERAL MANAGER / EXECUTIVE APPROVAL (Manual Action by GM)
        // ─────────────────────────────────────────────────────────────
        $gmApproveResponse = $this->actingAs($this->generalManager, 'sanctum')
            ->postJson("/api/v1/general-manager/purchase-requests/{$pr->id}/approve", [
                'comment' => 'معتمد من الإدارة التنفيذية، يُحال للمشتريات للتسعير والإصدار',
            ]);

        $gmApproveResponse->assertStatus(200);

        $pr->refresh();
        // Gate 3 Check: PR moved to PENDING_PROCUREMENT_APPROVAL
        $this->assertSame('PENDING_PROCUREMENT_APPROVAL', $pr->status);

        // ─────────────────────────────────────────────────────────────
        // GATE 4: PROCUREMENT SETS ROUTE & PRICING (Manual Action by Procurement)
        // ─────────────────────────────────────────────────────────────
        $procurementApproveResponse = $this->actingAs($this->procurementOfficer, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-requests/{$pr->id}/approve", [
                'use_quotes' => false,
                'comment' => 'توريد مباشر من مصنع حديد عز بسعر الطن 42,000 ج.م',
                'financial_data' => [
                    'supplier_id' => $this->supplier->id,
                    'items' => [
                        [
                            'pr_item_id' => $pr->items->first()->id,
                            'supplier_id' => $this->supplier->id,
                            'quantity' => 15,
                            'unit_price' => 42000,
                            'uom' => 'TON',
                        ],
                    ],
                ],
            ]);

        $procurementApproveResponse->assertStatus(200);

        $pr->refresh();
        // Gate 4 Check: PR route is DIRECT and moved to PENDING_EXECUTIVE_APPROVAL for pricing confirmation
        $this->assertSame('DIRECT', $pr->procurement_route);
        $this->assertSame('PENDING_EXECUTIVE_APPROVAL', $pr->status);

        // NEGATIVE ASSERTION GATE 4:
        // System must HALT. Procurement CANNOT issue PO yet before GM and Accounting approval of direct pricing.
        $prematurePoBeforeGm = $this->actingAs($this->procurementOfficer, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
                'items' => [
                    [
                        'pr_item_id' => $pr->items->first()->id,
                        'item_description' => 'حديد تسليح قطاع 16 مم',
                        'item_reference' => 'PARCEL-STRICT-001',
                        'region' => 'منطقة بيت الوطن',
                        'quantity' => 15,
                        'unit_price' => 42000,
                    ],
                ],
            ]);
        $this->assertTrue(in_array($prematurePoBeforeGm->status(), [409, 422], true));
        $this->assertDatabaseMissing('purchase_orders', ['purchase_request_id' => $pr->id]);

        // ─────────────────────────────────────────────────────────────
        // GATE 4b: GENERAL MANAGER CONFIRMS DIRECT ROUTE PRICING (Manual Action by GM)
        // ─────────────────────────────────────────────────────────────
        $gmDirectApproveResponse = $this->actingAs($this->generalManager, 'sanctum')
            ->postJson("/api/v1/general-manager/purchase-requests/{$pr->id}/approve", [
                'comment' => 'معتمد من الإدارة التنفيذية بالسعر المذكور ويحال للمالية.',
            ]);

        $gmDirectApproveResponse->assertStatus(200);
        $pr->refresh();
        // Gate 4b Check: PR moved to PENDING_ACCOUNTING_APPROVAL
        $this->assertSame('PENDING_ACCOUNTING_APPROVAL', $pr->status);

        // NEGATIVE ASSERTION GATE 4b:
        // System must HALT. Still CANNOT issue PO before Accounting approves budget.
        $prematurePoBeforeAccounting = $this->actingAs($this->procurementOfficer, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
                'items' => [
                    [
                        'pr_item_id' => $pr->items->first()->id,
                        'item_description' => 'حديد تسليح قطاع 16 مم',
                        'item_reference' => 'PARCEL-STRICT-001',
                        'region' => 'منطقة بيت الوطن',
                        'quantity' => 15,
                        'unit_price' => 42000,
                    ],
                ],
            ]);
        $this->assertTrue(in_array($prematurePoBeforeAccounting->status(), [409, 422], true));
        $this->assertDatabaseMissing('purchase_orders', ['purchase_request_id' => $pr->id]);

        // ─────────────────────────────────────────────────────────────
        // GATE 4c: FINANCIAL DIRECTOR APPROVES BUDGET (Financial Director has exclusive authority)
        // ─────────────────────────────────────────────────────────────
        // Eng. Habiba (General Accountant) attempts to approve -> 403 Forbidden
        $habibaDirectApproveResponse = $this->actingAs($this->habibaAccountant, 'sanctum')
            ->postJson("/api/v1/accounting/purchase-requests/{$pr->id}/direct-approve", [
                'comment' => 'محاولة اعتماد مالي غير مصرح بها من المحاسب العام',
            ]);
        $habibaDirectApproveResponse->assertStatus(403);

        // Financial Director (Hasan) executes manual budget approval -> 200 OK
        $financialDirectorApproveResponse = $this->actingAs($this->financialDirector, 'sanctum')
            ->postJson("/api/v1/accounting/purchase-requests/{$pr->id}/direct-approve", [
                'comment' => 'تمت الموافقة المالية وتوفر الميزانية المخصصة لبند حديد التسليح.',
            ]);
        $financialDirectorApproveResponse->assertStatus(200);
        $pr->refresh();
        // Gate 4c Check: PR is now APPROVED_BY_ACCOUNTING
        $this->assertSame('APPROVED_BY_ACCOUNTING', $pr->status);

        // NEGATIVE ASSERTION GATE 4c:
        // System must HALT. Accounting approval DOES NOT auto-generate a Purchase Order.
        // It merely readies the request for manual PO issuance by Procurement.
        $this->assertDatabaseMissing('purchase_orders', ['purchase_request_id' => $pr->id]);
        $this->assertSame(0, PurchaseOrder::where('purchase_request_id', $pr->id)->count());

        // ─────────────────────────────────────────────────────────────
        // GATE 5: PROCUREMENT CREATES & ISSUES PRELIMINARY PO (Manual Action by Procurement)
        // ─────────────────────────────────────────────────────────────
        $createPoResponse = $this->actingAs($this->procurementOfficer, 'sanctum')
            ->postJson('/api/v1/procurement/purchase-orders', [
                'purchase_request_id' => $pr->id,
                'supplier_id' => $this->supplier->id,
                'status' => 'ISSUED',
                'notes' => 'أمر شراء توريد حديد لبشة الأساسات',
                'items' => [
                    [
                        'pr_item_id' => $pr->items->first()->id,
                        'item_description' => 'حديد تسليح قطاع 16 مم',
                        'item_reference' => 'PARCEL-STRICT-001',
                        'region' => 'منطقة بيت الوطن',
                        'quantity' => 15,
                        'unit_price' => 42000,
                        'uom' => 'TON',
                    ],
                ],
            ]);

        $createPoResponse->assertStatus(201);
        $poId = $createPoResponse->json('data.id');
        $this->assertNotNull($poId);

        $po = PurchaseOrder::with('items')->findOrFail($poId);
        // Gate 5 Check: PO status is ISSUED
        $this->assertSame('ISSUED', $po->status);
        $this->assertNull($po->finalized_at); // Preliminary, not actual
        $this->assertEquals(630000.0, (float) $po->grand_total); // 15 * 42,000 = 630,000

        // NEGATIVE ASSERTION GATE 5:
        // No warehouse receipt exists yet, and no accountant recording exists yet.
        $this->assertDatabaseMissing('purchase_receipts', ['purchase_order_id' => $po->id]);
        $this->assertSame(0, PurchaseReceipt::where('purchase_order_id', $po->id)->count());

        // ─────────────────────────────────────────────────────────────
        // GATE 6: WAREHOUSE RECORDS BLIND RECEIPT (Manual Action by Warehouse Keeper)
        // ─────────────────────────────────────────────────────────────
        $poItem = $po->items->first();
        $warehouseReceiptPayload = [
            'received_at' => now()->toDateString(),
            'warehouse_notes' => 'تم استلام وتفريغ الحديد في الموقع بموجب بون ميزان البسكول رقم 99812',
            'items' => [
                [
                    'purchase_order_item_id' => $poItem->id,
                    'received_quantity' => 14.5, // Actual measured weight is 14.5 tons
                    'notes' => 'الوزن الفعلي لبون الميزان 14.5 طن',
                ],
            ],
        ];

        $warehouseResponse = $this->actingAs($this->warehouseKeeper, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/purchase-orders/{$po->id}", $warehouseReceiptPayload);

        $warehouseResponse->assertStatus(201);
        $receiptId = $warehouseResponse->json('data.id');
        $this->assertNotNull($receiptId);

        $receipt = PurchaseReceipt::findOrFail($receiptId);

        // Gate 6 Check: Receipt status MUST be PENDING_SITE_ENGINEER
        $this->assertSame('PENDING_SITE_ENGINEER', $receipt->status);

        // NEGATIVE ASSERTION GATE 6:
        // Receipt is NOT APPROVED, NOT RECORDED by accountant, and PO is NOT PENDING_ACTUAL_PO yet.
        $this->assertNull($receipt->accountant_recorded_at);
        $this->assertNull($receipt->accountant_recorded_by_user_id);
        $this->assertNotSame('APPROVED', $receipt->status);
        $this->assertNotSame('PENDING_ACTUAL_PO', $po->fresh()->status);

        // Accounting approved receipts queue MUST NOT include this unapproved receipt
        $accountingPendingQueue = $this->actingAs($this->habibaAccountant, 'sanctum')
            ->getJson('/api/v1/accounting/receipts/approved');
        $accountingPendingQueue->assertStatus(200);
        $queueIds = collect($accountingPendingQueue->json('data'))->pluck('id')->all();
        $this->assertNotContains($receipt->id, $queueIds);

        // ─────────────────────────────────────────────────────────────
        // GATE 7: SITE ENGINEER INSPECTS & APPROVES GRN (Manual Action by Site Eng)
        // ─────────────────────────────────────────────────────────────
        $siteEngApproveResponse = $this->actingAs($this->siteEngineer, 'sanctum')
            ->postJson("/api/v1/purchase-receipts/{$receipt->id}/approve", [
                'notes' => 'تمت مراجعة بون الميزان ومطابقة قطاع 16 مم مع أختام مصنع عز، الاستلام معتمد هندسياً.',
            ]);

        $siteEngApproveResponse->assertStatus(200);

        $receipt->refresh();
        $po->refresh();

        // Gate 7 Check: Receipt status is APPROVED and PO moved to PENDING_ACTUAL_PO
        $this->assertSame('APPROVED', $receipt->status);
        $this->assertSame('PENDING_ACTUAL_PO', $po->status);

        // NEGATIVE ASSERTION GATE 7:
        // PO is NOT finalized automatically (`finalized_at` MUST be null).
        // Receipt is NOT recorded by accountant automatically (`accountant_recorded_at` MUST be null).
        $this->assertNull($po->finalized_at);
        $this->assertNull($receipt->accountant_recorded_at);
        $this->assertNull($receipt->accountant_recorded_by_user_id);

        // ─────────────────────────────────────────────────────────────
        // GATE 8: PROCUREMENT FINALIZES ACTUAL PO (Manual Action by Procurement)
        // ─────────────────────────────────────────────────────────────
        $actualPoFinalizePayload = [
            // Above the Actual PO high-value threshold a written reason is required.
            'high_value_reason' => 'أمر شراء فعلي لتوريد المرحلة كاملة',
            'items' => [
                [
                    'id' => $poItem->id,
                    'pr_item_id' => $pr->items->first()->id,
                    'item_description' => 'حديد تسليح قطاع 16 مم (كمية فعلية)',
                    'item_reference' => 'PARCEL-STRICT-001',
                    'region' => 'منطقة بيت الوطن',
                    'quantity' => 14.5, // Adjusted to actual receipt quantity
                    'unit_price' => 42000,
                    'uom' => 'TON',
                    'specifications' => 'حديد عز معتمد',
                    'supplier_id' => $this->supplier->id,
                ],
            ],
            'notes' => 'إصدار أمر الشراء الفعلي بعد مطابقة الكمية الفعلية 14.5 طن المستلمة بالموقع.',
        ];

        $finalizeResponse = $this->actingAs($this->procurementOfficer, 'sanctum')
            ->postJson("/api/v1/procurement/purchase-orders/{$po->id}/finalize", $actualPoFinalizePayload);

        $finalizeResponse->assertStatus(200);

        $po->refresh();
        // Gate 8 Check: PO finalized_at and finalized_by are set, grand total updated to 14.5 * 42000 = 609,000
        $this->assertNotNull($po->finalized_at);
        $this->assertSame($this->procurementOfficer->id, $po->finalized_by_user_id);
        $this->assertEquals(609000.0, (float) $po->grand_total);

        // NEGATIVE ASSERTION GATE 8:
        // Receipt is STILL NOT recorded automatically. The system MUST HALT waiting for the accountant.
        $receipt->refresh();
        $this->assertNull($receipt->accountant_recorded_at);
        $this->assertNull($receipt->accountant_recorded_by_user_id);

        // ─────────────────────────────────────────────────────────────
        // GATE 9: GENERAL ACCOUNTANT (ENG. HABIBA) MANUALLY RECORDS RECEIPT
        // ─────────────────────────────────────────────────────────────
        // Step 9a: Receipt appears in Habiba's pending accounting queue
        $habibaQueueResponse = $this->actingAs($this->habibaAccountant, 'sanctum')
            ->getJson('/api/v1/accounting/receipts/approved');

        $habibaQueueResponse->assertStatus(200);
        $habibaQueueIds = collect($habibaQueueResponse->json('data'))->pluck('id')->all();
        $this->assertContains($receipt->id, $habibaQueueIds);

        // Step 9b: Eng. Habiba explicitly calls the recording endpoint
        $recordPayload = [
            'notes' => 'تمت مراجعة أمر الشراء الفعلي رقم ' . $po->po_number . ' وإذن الاستلام، وتم ترحيل القيد في شيت الإكسيل الخارجي.',
        ];

        $recordResponse = $this->actingAs($this->habibaAccountant, 'sanctum')
            ->postJson("/api/v1/accounting/receipts/{$receipt->id}/mark-recorded", $recordPayload);

        $recordResponse->assertStatus(200);
        $recordResponse->assertJsonPath('data.is_accountant_recorded', true);

        // Gate 9 Check: Receipt is now recorded with timestamp and Habiba's user ID
        $receipt->refresh();
        $this->assertNotNull($receipt->accountant_recorded_at);
        $this->assertSame($this->habibaAccountant->id, $receipt->accountant_recorded_by_user_id);
        $this->assertSame($recordPayload['notes'], $receipt->accountant_recording_notes);

        // Verify System Event Audit Trail
        $this->assertDatabaseHas('system_events', [
            'action' => 'ACCOUNTANT_RECORDED',
            'actor_user_id' => $this->habibaAccountant->id,
        ]);

        // Step 9c: Receipt is no longer in pending queue
        $habibaPendingQueueAfter = $this->actingAs($this->habibaAccountant, 'sanctum')
            ->getJson('/api/v1/accounting/receipts/approved?status=pending');
        $afterIds = collect($habibaPendingQueueAfter->json('data'))->pluck('id')->all();
        $this->assertNotContains($receipt->id, $afterIds);
    }

    private function createUser(string $email, string $name, string $roleSlug, ?int $departmentId = null): User
    {
        $user = User::create([
            'department_id' => $departmentId,
            'name' => $name,
            'email' => $email,
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);

        $role = Role::where('slug', $roleSlug)->firstOrFail();
        $user->roles()->attach($role->id);

        return $user;
    }
}
