<?php

namespace Tests\Unit;

use App\Models\ApprovalHistory;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class ApprovalHistoryUserNoteTest extends TestCase
{
    use RefreshDatabase;

    public function test_typed_note_drops_empty_and_canned_client_texts(): void
    {
        $this->assertNull(ApprovalHistory::typedNote(null));
        $this->assertNull(ApprovalHistory::typedNote('   '));
        $this->assertNull(ApprovalHistory::typedNote('تم الاعتماد المباشر من المدير التنفيذي.'));
        $this->assertSame('ورّد الأبواب قبل آخر الشهر', ApprovalHistory::typedNote('  ورّد الأبواب قبل آخر الشهر '));
    }

    public function test_backfill_keeps_typed_notes_and_drops_system_defaults(): void
    {
        $migration = require database_path('migrations/2026_10_30_120000_add_user_note_to_approval_history_table.php');

        Schema::table('approval_history', fn ($table) => $table->dropColumn('user_note'));

        $rows = [
            'اعتمد المراجع الطلب وأرسله إلى المدير التنفيذي للقرار.' => null,
            'أدخل مدير المشتريات البيانات المالية واختار المورد ثم أرسل الطلب إلى المدير التنفيذي المهندس محمد للاعتماد.' => null,
            'تم الاعتماد المباشر من المدير التنفيذي.' => null,
            'تم إرسال 3 عروض أسعار من موردين مختلفين إلى الحسابات ورئيس القسم للترشيح.' => null,
            'تم اعتماد أمر الشراء محاسبياً رقم PO-2026-0001 (السداد بعد التوريد)' => 'السداد بعد التوريد',
            'نقل إداري إلى مرحلة «المشتريات»: خطأ في المورد' => 'خطأ في المورد',
            'الكمية ناقصة طردين — البنود المستلمة: حديد 16 مم' => 'الكمية ناقصة طردين',
            'برجاء التوريد على الموقع الجديد' => 'برجاء التوريد على الموقع الجديد',
        ];

        $actor = User::create([
            'name' => 'Tester',
            'email' => 'tester@test.local',
            'password' => bcrypt('test-only'),
            'is_active' => true,
        ]);

        foreach (array_keys($rows) as $i => $comment) {
            DB::table('approval_history')->insert([
                'target_type' => 'App\\Models\\PurchaseRequest',
                'target_id' => $i + 1,
                'actor_user_id' => $actor->id,
                'action' => 'TEST',
                'to_state' => 'TEST',
                'comments' => $comment,
                'created_at' => now(),
            ]);
        }

        $migration->up();

        foreach ($rows as $comment => $expected) {
            $this->assertSame(
                $expected,
                DB::table('approval_history')->where('comments', $comment)->value('user_note'),
                $comment
            );
        }
    }
}
