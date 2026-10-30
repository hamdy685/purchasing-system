<?php

use App\Models\ApprovalHistory;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Adds `user_note`: only what a person typed for an approval action.
 * `comments` stays as the audit sentence, which is often a system default.
 *
 * Existing rows are backfilled from `comments`, dropping the default texts the
 * services write when nobody typed anything, and keeping the typed part where a
 * default wraps a typed note. Only additive: `comments` is never changed.
 */
return new class extends Migration
{
    /** Default sentences written when no note was typed. */
    private const DEFAULT_TEXTS = [
        'Financial review approved by accounting.',
        'Purchase order created by procurement manager.',
        'Purchase order issued by procurement manager.',
        'وافقت الإدارة المالية على الطلب وأعادته إلى مدير المشتريات لإنشاء أمر الشراء.',
        'بدأ مدير المشتريات تجهيز عروض أسعار من موردين مختلفين.',
        'تم التراجع عن مسار عروض الأسعار وإعادة الطلب إلى قسم اختيار المسار وتحديد الأسعار المباشرة.',
        'أصدر مدير المشتريات أمر الشراء الفعلي بعد اعتماد إذن الاستلام وأرسله للحسابات.',
        'أنشأ مدير المشتريات طلب شراء مباشرًا وأرسله إلى المدير التنفيذي المهندس محمد للاعتماد.',
        'قام مدير المشتريات بتسعير الطلب مباشرة واختيار المورد وتخطي مرحلة الاعتماد المبدئي وأرسل الطلب إلى المدير التنفيذي للاعتماد النهائي.',
        'أدخل مدير المشتريات البيانات المالية واختار المورد ثم أرسل الطلب إلى المدير التنفيذي المهندس محمد للاعتماد.',
        'عدّل مهندس الموقع كميات إذن الاستلام قبل إرساله للحسابات.',
        'تم التخطي التلقائي للاستلام المخزني (Auto-Bypass) لعدم اشتراط المخزن لهذا الطلب، وتوجيه الإذن مباشرة إلى مهندس الموقع للفحص والاعتماد.',
        'تم إنشاء إذن استلام المستلزمات المكتبية وتوجيهه لمقدم الطلب للفحص وتعديل الكميات المستلمة واعتمادها.',
        'سجل أمين المخزن الكميات المستلمة وأرسل إذن الاستلام للمستلم/مهندس الموقع للفحص والاعتماد.',
        'أكد مقدم الطلب استلام المستلزمات المكتبية بالكامل، وأُحيل الملف لإدارة المشتريات لإصدار أمر الشراء الفعلي.',
        'بدأ المراجع مراجعة الطلب مباشرة.',
        'اعتمد المراجع الطلب وأرسله إلى المدير التنفيذي للقرار.',
        'اعتمد رئيس القسم طلب الكمالة المستقل وأرسله مباشرة إلى إدارة المشتريات (تخطي المسار التنفيذي والمالي).',
        'أنشأ واعتمد مراجع القسم طلب الكمالة المستقل وأرسله مباشرةً إلى إدارة المشتريات (مسار سريع دون تنفيذي أو مالية).',
        'أنشأ واعتمد مراجع القسم الطلب وحدد مسؤول الاستلام ومسار المخزن وأرسله إلى المدير التنفيذي.',
        'تم إلغاء طلب الشراء المرفوض نهائياً من قبل مقدم الطلب والاستغناء عن إعادة إرساله.',
        'تم إلغاء طلب الشراء من قبل مقدم الطلب.',
        'تم اعتماد وتعديل الطلب من المدير التنفيذي وإحالته للإدارة المالية.',
        'تم تعديل الطلب من المدير التنفيذي وإرساله للمشتريات.',
        'اختار المدير التنفيذي العرض وأعاده إلى مدير المشتريات لإنشاء أمر الشراء.',
        'رفض المدير التنفيذي عروض الأسعار والطلب.',
    ];

    /** Defaults with a variable part and no typed text. */
    private const DEFAULT_PATTERNS = [
        '/^تم إصدار وتثبيت أمر الشراء الفعلي رقم /u',
        '/^تم إصدار أوامر الشراء لجميع بنود طلب الشراء بالكامل \(/u',
        '/^تم إرسال \d+ عروض أسعار /u',
        '/^تم اعتماد طلب الكمالة \(دفعة /u',
        '/^تم اعتماد بنود الكمالة وربطها بأمر الشراء /u',
        '/^اعتمد .+ طلب الشراء بعد التسعير وحوله إلى الإدارة المالية للموافقة\.$/u',
        '/^تم الاعتماد المبدئي للطلب من .+ وإرساله للمشتريات للبدء في التسعير\.$/u',
        '/^اعتمد .+ (فحص واستلام البنود|استلام وفحص المستلزمات المكتبية|استلام المواد)/u',
    ];

    /** Defaults that wrap a typed note: the first capture group is the typed part. */
    private const WRAPPED_PATTERNS = [
        '/^تعديل سيادي من مدير النظام:\s*(.+)$/us',
        '/^نقل إداري إلى مرحلة «[^»]*»:\s*(.+)$/us',
        '/^تم رفض طلب الكمالة \(دفعة [^)]*\) من قِبل مراجع القسم:\s*(.+)$/us',
        '/^تم إنشاء (?:واعتماد )?طلب كمالة \(دفعة [^)]*\)[^:]*:\s*(.+)$/us',
        '/^تم إنشاء (?:واعتماد )?طلب كمالة \(دفعة [^)]*\)[^:]*()$/us',
        '/^تم اعتماد أمر الشراء محاسبياً رقم \S+ \((.+)\)$/us',
        '/^تم اعتماد أمر الشراء محاسبياً رقم \S+()$/us',
        '/^(.+?) — (?:البنود المستلمة|استلام المستلزمات المكتبية بمقر الشركة|استلام وتفريغ)/us',
    ];

    public function up(): void
    {
        Schema::table('approval_history', function (Blueprint $table) {
            $table->text('user_note')->nullable()->after('comments');
        });

        DB::table('approval_history')
            ->whereNotNull('comments')
            ->orderBy('id')
            ->select(['id', 'comments'])
            ->chunkById(500, function ($rows) {
                foreach ($rows as $row) {
                    $note = $this->typedPart((string) $row->comments);
                    if ($note !== null) {
                        DB::table('approval_history')->where('id', $row->id)->update(['user_note' => $note]);
                    }
                }
            });
    }

    public function down(): void
    {
        Schema::table('approval_history', function (Blueprint $table) {
            $table->dropColumn('user_note');
        });
    }

    private function typedPart(string $comments): ?string
    {
        $text = trim($comments);

        if ($text === '' || in_array($text, self::DEFAULT_TEXTS, true)) {
            return null;
        }

        foreach (self::WRAPPED_PATTERNS as $pattern) {
            if (preg_match($pattern, $text, $m)) {
                return ApprovalHistory::typedNote($m[1] ?? '');
            }
        }

        foreach (self::DEFAULT_PATTERNS as $pattern) {
            if (preg_match($pattern, $text)) {
                return null;
            }
        }

        return ApprovalHistory::typedNote($text);
    }
};
