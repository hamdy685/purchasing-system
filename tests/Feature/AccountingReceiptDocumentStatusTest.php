<?php

namespace Tests\Feature;

use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\Supplier;
use App\Models\SupplierInvoice;
use App\Models\User;
use App\Models\WeighingGroup;
use Database\Seeders\RolePermissionSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * «إذن الاستلام» / «الفاتورة» document status on the department accountant dashboard cards.
 */
class AccountingReceiptDocumentStatusTest extends TestCase
{
    use RefreshDatabase;

    private User $siteAccountant;
    private User $procurementManager;
    private Supplier $supplier;
    private Department $dept;
    private int $seq = 0;

    protected function setUp(): void
    {
        parent::setUp();
        config(['filesystems.default' => 'public', 'google_drive.enabled' => false]);
        Storage::fake('public');
        $this->seed(RolePermissionSeeder::class);

        $this->dept = Department::firstOrCreate(['code' => 'EXECUTION'], ['name' => 'إدارة التنفيذ', 'is_active' => true]);
        $this->siteAccountant = $this->makeUser('doc.acc@example.com', 'محاسب الموقع', 'site_accountant');
        $this->procurementManager = $this->makeUser('doc.proc@example.com', 'مدير المشتريات', 'procurement_manager');
        $this->supplier = Supplier::create([
            'name' => 'مورد المستندات',
            'company_name' => 'مورد المستندات',
            'contact_person' => 'أحمد',
            'phone' => '01000000000',
            'is_active' => true,
        ]);
    }

    private function makeUser(string $email, string $name, string $roleSlug): User
    {
        $user = User::create([
            'department_id' => $this->dept->id,
            'name' => $name,
            'email' => $email,
            'password' => Hash::make('Secret123!'),
            'is_active' => true,
        ]);
        $user->roles()->sync([Role::where('slug', $roleSlug)->firstOrFail()->id]);

        return $user;
    }

    private function makeReceipt(array $poAttributes = [], array $receiptAttributes = []): PurchaseReceipt
    {
        $n = ++$this->seq;
        $pr = PurchaseRequest::create([
            'request_number' => "PR-DOC-{$n}",
            'request_type' => 'PROJECT_MATERIALS',
            'department_id' => $this->dept->id,
            'user_id' => $this->procurementManager->id,
            'status' => 'APPROVED_BY_GENERAL_MANAGER',
            'notes' => 'اختبار حالة المستندات',
        ]);
        $po = PurchaseOrder::create(array_merge([
            'po_number' => "PO-DOC-{$n}",
            'purchase_request_id' => $pr->id,
            'supplier_id' => $this->supplier->id,
            'created_by_user_id' => $this->procurementManager->id,
            'status' => 'APPROVED_BY_ACCOUNTING',
            'subtotal' => 1000,
            'grand_total' => 1000,
            'currency' => 'EGP',
            'finalized_at' => now(),
        ], $poAttributes));

        return PurchaseReceipt::create(array_merge([
            'purchase_order_id' => $po->id,
            'purchase_request_id' => $pr->id,
            'supplier_id' => $this->supplier->id,
            'receipt_number' => "REC-DOC-{$n}",
            'receipt_type' => 'SITE_DIRECT',
            'status' => 'APPROVED',
            'received_at' => now()->toDateString(),
            'site_engineer_approved_at' => now(),
        ], $receiptAttributes));
    }

    private function makeInvoice(PurchaseReceipt $receipt, string $number, string $status = 'OPEN'): SupplierInvoice
    {
        return SupplierInvoice::create([
            'supplier_id' => $this->supplier->id,
            'purchase_order_id' => $receipt->purchase_order_id,
            'purchase_receipt_id' => $receipt->id,
            'created_by_user_id' => $this->siteAccountant->id,
            'invoice_number' => $number,
            'amount' => 1000,
            'invoice_date' => now()->toDateString(),
            'status' => $status,
            'matching_status' => 'PENDING',
            'paid_amount' => 0,
            'outstanding_amount' => 1000,
        ]);
    }

    private function statusesFor(array $query): array
    {
        $response = $this->actingAs($this->siteAccountant, 'sanctum')
            ->getJson('/api/v1/accounting/receipts/approved?' . http_build_query($query));
        $response->assertOk();

        return collect($response->json('data'))->keyBy('receipt_number')->map(fn ($r) => $r['document_status'] ?? null)->all();
    }

    public function test_receipt_present_and_invoice_absent_give_independent_states(): void
    {
        $this->makeReceipt();

        $status = $this->statusesFor(['status' => 'pending'])['REC-DOC-1'];

        $this->assertTrue($status['receipt']['exists']);
        $this->assertFalse($status['receipt']['has_file']);
        $this->assertFalse($status['invoice']['exists']);
        $this->assertFalse($status['invoice']['has_file']);
        $this->assertNull($status['invoice']['file_url']);
        $this->assertSame(0, $status['invoice']['count']);
    }

    public function test_stored_po_invoice_file_marks_invoice_present_with_url(): void
    {
        Storage::disk('public')->put('invoices/real_invoice.pdf', 'pdf-bytes');
        Storage::disk('public')->put('receipts/receipt_scan.jpg', 'jpg-bytes');
        $receipt = $this->makeReceipt(
            ['invoice_photo_path' => 'invoices/real_invoice.pdf', 'invoice_photo_name' => 'real_invoice.pdf'],
            ['photo_path' => 'receipts/receipt_scan.jpg'],
        );

        $status = $this->statusesFor(['status' => 'pending'])['REC-DOC-1'];

        $this->assertTrue($status['receipt']['exists']);
        $this->assertTrue($status['receipt']['has_file']);
        $this->assertTrue($status['invoice']['exists']);
        $this->assertTrue($status['invoice']['has_file']);
        $this->assertSame("/api/v1/purchase-orders/{$receipt->purchase_order_id}/invoice-photo", $status['invoice']['file_url']);
    }

    public function test_drive_receipt_photo_activates_receipt_with_drive_link(): void
    {
        $this->makeReceipt([], [
            'photo_path' => 'https://drive.google.com/file/d/RcPt987/view',
            'photo_drive_id' => 'RcPt987',
        ]);

        $receipt = $this->statusesFor(['status' => 'pending'])['REC-DOC-1']['receipt'];

        $this->assertTrue($receipt['has_file']);
        $this->assertSame('receipt_photo', $receipt['file_source']);
        $this->assertSame('https://drive.google.com/file/d/RcPt987/view', $receipt['file_url']);
    }

    public function test_receipt_without_uploaded_photo_is_inactive_even_though_record_exists(): void
    {
        $this->makeReceipt([], ['photo_path' => 'receipts/deleted_after_redeploy.jpg']);

        $receipt = $this->statusesFor(['status' => 'pending'])['REC-DOC-1']['receipt'];

        $this->assertTrue($receipt['exists']);
        $this->assertFalse($receipt['has_file']);
        $this->assertNull($receipt['file_url']);
        $this->assertNull($receipt['file_source']);
    }

    public function test_steel_scale_ticket_photo_is_used_when_receipt_has_no_photo(): void
    {
        $receipt = $this->makeReceipt();
        $group = WeighingGroup::create([
            'group_number' => 'WG-DOC-1',
            'purchase_order_id' => $receipt->purchase_order_id,
            'supplier_id' => $this->supplier->id,
            'status' => 'RECEIVED',
            'scale_ticket_photo' => 'https://drive.google.com/file/d/ScAlE55/view',
        ]);
        $receipt->update(['weighing_group_id' => $group->id]);

        $photo = $this->statusesFor(['status' => 'pending'])['REC-DOC-1']['receipt'];

        $this->assertTrue($photo['has_file']);
        $this->assertSame('scale_ticket', $photo['file_source']);
        $this->assertSame('https://drive.google.com/file/d/ScAlE55/view', $photo['file_url']);
    }

    public function test_invoices_list_carries_linked_receipt_photo_status(): void
    {
        $withPhoto = $this->makeReceipt([], ['photo_path' => 'https://drive.google.com/file/d/InvRc1/view', 'photo_drive_id' => 'InvRc1']);
        $this->makeInvoice($withPhoto, 'INV-PHOTO');
        $withoutPhoto = $this->makeReceipt();
        $this->makeInvoice($withoutPhoto, 'INV-NOPHOTO');

        $rows = collect($this->actingAs($this->siteAccountant, 'sanctum')
            ->getJson('/api/v1/accounting/invoices')
            ->assertOk()
            ->json('data'))->keyBy('invoice_number');

        $this->assertTrue($rows['INV-PHOTO']['receipt_photo_status']['has_file']);
        $this->assertSame('https://drive.google.com/file/d/InvRc1/view', $rows['INV-PHOTO']['receipt_photo_status']['file_url']);
        $this->assertFalse($rows['INV-NOPHOTO']['receipt_photo_status']['has_file']);
    }

    public function test_drive_invoice_reference_counts_as_stored_file(): void
    {
        $this->makeReceipt([
            'invoice_photo_path' => 'https://drive.google.com/file/d/AbC123xyz/view',
            'invoice_photo_drive_id' => 'AbC123xyz',
        ]);

        $status = $this->statusesFor(['status' => 'pending'])['REC-DOC-1'];

        $this->assertTrue($status['invoice']['exists']);
        $this->assertSame('https://drive.google.com/file/d/AbC123xyz/view', $status['invoice']['file_url']);
    }

    public function test_invoice_filename_without_stored_file_is_not_treated_as_present(): void
    {
        $this->makeReceipt(['invoice_photo_path' => 'invoices/missing_after_redeploy.pdf', 'invoice_photo_name' => 'missing.pdf']);

        $status = $this->statusesFor(['status' => 'pending'])['REC-DOC-1'];

        $this->assertTrue($status['receipt']['exists']);
        $this->assertFalse($status['invoice']['exists']);
        $this->assertFalse($status['invoice']['has_file']);
        $this->assertNull($status['invoice']['file_url']);
    }

    public function test_registered_invoices_are_listed_and_voided_ones_ignored(): void
    {
        $withOne = $this->makeReceipt([], ['accountant_recorded_at' => now()]);
        $this->makeInvoice($withOne, 'INV-ONE');
        $this->makeInvoice($withOne, 'INV-VOID', 'VOIDED');

        $withTwo = $this->makeReceipt([], ['accountant_recorded_at' => now()]);
        $this->makeInvoice($withTwo, 'INV-A');
        $this->makeInvoice($withTwo, 'INV-B');

        $onlyVoided = $this->makeReceipt([], ['accountant_recorded_at' => now()]);
        $this->makeInvoice($onlyVoided, 'INV-X', 'CANCELLED');

        $statuses = $this->statusesFor(['recorded' => 1]);

        $one = $statuses[$withOne->receipt_number]['invoice'];
        $this->assertTrue($one['exists']);
        $this->assertFalse($one['has_file']);
        $this->assertSame(1, $one['count']);
        $this->assertSame('INV-ONE', $one['invoices'][0]['invoice_number']);

        $two = $statuses[$withTwo->receipt_number]['invoice'];
        $this->assertTrue($two['exists']);
        $this->assertSame(2, $two['count']);
        $this->assertSame($withTwo->purchaseOrder->po_number, $two['po_number']);

        $this->assertFalse($statuses[$onlyVoided->receipt_number]['invoice']['exists']);
        $this->assertTrue($statuses[$onlyVoided->receipt_number]['receipt']['exists']);
    }

    public function test_invoices_are_eager_loaded_in_a_single_query(): void
    {
        foreach (range(1, 4) as $i) {
            $receipt = $this->makeReceipt([], ['accountant_recorded_at' => now()]);
            $this->makeInvoice($receipt, "INV-EAGER-{$i}");
        }

        DB::flushQueryLog();
        DB::enableQueryLog();
        $statuses = $this->statusesFor(['recorded' => 1]);
        $invoiceQueries = collect(DB::getQueryLog())
            ->pluck('query')
            ->filter(fn ($sql) => preg_match('/^select [^()]* from ["`]?supplier_invoices["`]? /i', $sql));
        DB::disableQueryLog();

        $this->assertCount(4, $statuses);
        $this->assertCount(1, $invoiceQueries, 'supplier invoices must be loaded once for all receipts (no N+1)');
    }

    public function test_listing_permission_is_unchanged(): void
    {
        $this->makeReceipt();
        $employee = $this->makeUser('doc.emp@example.com', 'موظف', 'employee');

        $this->actingAs($employee, 'sanctum')
            ->getJson('/api/v1/accounting/receipts/approved')
            ->assertForbidden();
    }
}
