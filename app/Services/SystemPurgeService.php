<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Log;

class SystemPurgeService
{
    /**
     * الجداول المحمية نهائياً والممنوع مساسها بأي شكل.
     * Strict list of protected tables that must NEVER be truncated or cleared.
     */
    public const PROTECTED_TABLES = [
        'users',
        'roles',
        'permissions',
        'role_user',
        'permission_role',
        'departments',
        'items',
        'categories',
        'suppliers',
        'accounts',
        'cost_centers',
        'land_parcels',
        'personal_access_tokens',
        'migrations',
    ];

    /**
     * جداول الحركات التشغيلية لدورة المشتريات المراد تفريغها (بالترتيب العكسي للاعتمادية).
     * Operational tables to purge in cascading order.
     */
    public const OPERATIONAL_TABLES = [
        // 1. الدفعات وتوزيعاتها والتسويات المالية
        'supplier_payment_allocations',
        'supplier_payments',
        'supplier_invoice_land_allocations',
        'supplier_invoices',
        'land_parcel_transactions',
        'accounting_contractor_invoices',
        'accounting_petty_cash_settlements',
        'journal_entry_lines',
        'journal_entries',

        // 2. أذون الاستلام وبنودها
        'purchase_receipt_items',
        'purchase_receipts',

        // 3. أوامر الشراء وبنودها
        'purchase_order_item_sources',
        'purchase_order_items',
        'purchase_orders',

        // 4. ترشيحات وعروض الأسعار
        'purchase_request_quote_recommendations',
        'purchase_quote_recommendations',
        'purchase_request_quotes',
        'purchase_quote_items',
        'purchase_quotes',

        // 5. مكملات وملحقات طلبات الشراء (Supplements)
        'purchase_request_supplements',

        // 6. طلبات الشراء وبنودها
        'purchase_request_items',
        'purchase_requests',

        // 7. سجلات الاعتماد والتدقيق والأحداث والإشعارات والمرفقات التشغيلية
        'approval_history',
        'audit_logs',
        'system_events',
        'notifications',
        'attachments',
    ];

    /**
     * تصفير وتفريغ جميع طلبات الشراء والحركات التشغيلية بأمان مع التحقق الصارم من الحفاظ على البيانات الأساسية.
     *
     * @return array{
     *     purged_counts: array<string, int>,
     *     preserved_counts: array<string, int>,
     *     supplier_balances_reset: int,
     *     driver: string
     * }
     */
    public function purgeOperationalPurchasingData(): array
    {
        // 1. التحقق الاستباقي: ضمان عدم وجود أي جدول محمي في قائمة الحذف
        foreach (self::OPERATIONAL_TABLES as $table) {
            if (in_array($table, self::PROTECTED_TABLES, true)) {
                throw new \RuntimeException("خطأ فادح: الجدول المحمي [{$table}] موجود ضمن قائمة التصفير!");
            }
        }

        // إحصائيات الجداول المحمية قبل الحذف للتأكد من بقائها مطابقة
        $preservedCountsBefore = $this->getPreservedCounts();

        $purgedCounts = [];
        $supplierBalancesReset = 0;
        $driver = DB::getDriverName();

        // 2. تعطيل فحص المفاتيح الأجنبية (Foreign Key Constraints) بشكل صارم عبر مختلف محركات قواعد البيانات
        $this->disableForeignKeyConstraints($driver);

        try {
            DB::transaction(function () use (&$purgedCounts, &$supplierBalancesReset) {
                // تفريغ جداول الحركات التشغيلية
                foreach (self::OPERATIONAL_TABLES as $table) {
                    if (Schema::hasTable($table)) {
                        $count = DB::table($table)->count();
                        DB::table($table)->delete();
                        $purgedCounts[$table] = $count;
                    }
                }

                // تصفير ملخص أرصدة الموردين مع الحفاظ التام على الموردين وأرصدتهم الافتتاحية
                if (Schema::hasTable('supplier_balances')) {
                    $supplierBalancesReset = DB::table('supplier_balances')->update([
                        'total_invoiced' => 0,
                        'total_paid' => 0,
                        'balance' => DB::raw('COALESCE(opening_balance, 0)'),
                        'last_activity_at' => null,
                        'updated_at' => now(),
                    ]);
                }
            });

            // إعادة ضبط Auto Increment / Sequence بعد إتمام الـ Transaction لتجنب Implicit Commit في MySQL
            foreach (self::OPERATIONAL_TABLES as $table) {
                if (Schema::hasTable($table)) {
                    $this->resetAutoIncrement($table, $driver);
                }
            }
        } finally {
            // 3. إعادة تفعيل فحص المفاتيح الأجنبية فوراً في كتلة finally لضمان التنفيذ مهما حدث
            $this->enableForeignKeyConstraints($driver);
        }

        // 4. فحص سلامة البيانات المحمية بعد العملية
        $preservedCountsAfter = $this->getPreservedCounts();
        $this->verifyPreservedDataIntegrity($preservedCountsBefore, $preservedCountsAfter);

        Log::info('SystemPurgeService: تم تصفير بيانات دورة الشراء التشغيلية بنجاح.', [
            'purged' => $purgedCounts,
            'preserved' => $preservedCountsAfter,
        ]);

        return [
            'purged_counts' => $purgedCounts,
            'preserved_counts' => $preservedCountsAfter,
            'supplier_balances_reset' => $supplierBalancesReset,
            'driver' => $driver,
        ];
    }

    /**
     * إحصاء عدد السجلات في الجداول الأساسية المحمية.
     *
     * @return array<string, int>
     */
    public function getPreservedCounts(): array
    {
        $counts = [];
        foreach (self::PROTECTED_TABLES as $table) {
            if (Schema::hasTable($table)) {
                $counts[$table] = DB::table($table)->count();
            }
        }
        return $counts;
    }

    /**
     * تعطيل القيود المرجعية لجميع محركات قواعد البيانات.
     */
    protected function disableForeignKeyConstraints(string $driver): void
    {
        if ($driver === 'mysql') {
            DB::statement('SET FOREIGN_KEY_CHECKS=0;');
        } elseif ($driver === 'sqlite') {
            DB::statement('PRAGMA foreign_keys = OFF;');
        }

        try {
            Schema::disableForeignKeyConstraints();
        } catch (\Throwable $e) {
            // تجاهل إن كانت المدعومة مسبقاً عبر statement
        }
    }

    /**
     * إعادة تفعيل القيود المرجعية لجميع محركات قواعد البيانات.
     */
    protected function enableForeignKeyConstraints(string $driver): void
    {
        try {
            Schema::enableForeignKeyConstraints();
        } catch (\Throwable $e) {
            // تجاهل إن كانت المدعومة مسبقاً عبر statement
        }

        if ($driver === 'mysql') {
            DB::statement('SET FOREIGN_KEY_CHECKS=1;');
        } elseif ($driver === 'sqlite') {
            DB::statement('PRAGMA foreign_keys = ON;');
        }
    }

    /**
     * إعادة ترقيم Auto Increment للبدء من 1 في المعاملات الجديدة.
     */
    protected function resetAutoIncrement(string $table, string $driver): void
    {
        try {
            if ($driver === 'mysql') {
                DB::statement("ALTER TABLE `{$table}` AUTO_INCREMENT = 1;");
            } elseif ($driver === 'sqlite') {
                DB::statement("DELETE FROM sqlite_sequence WHERE name = ?", [$table]);
            } elseif ($driver === 'pgsql') {
                DB::statement("ALTER SEQUENCE IF EXISTS {$table}_id_seq RESTART WITH 1;");
            }
        } catch (\Throwable $e) {
            // بعض الجداول قد لا تستخدم Auto increment أو قد تختلف تسمية المتسلسلة
        }
    }

    /**
     * التأكد التام من تطابق أعداد الجداول المحمية وعدم فقدان أي مستخدمين أو موردين أو أصناف أو أقسام.
     *
     * @param array<string, int> $before
     * @param array<string, int> $after
     */
    protected function verifyPreservedDataIntegrity(array $before, array $after): void
    {
        $criticalTables = ['users', 'roles', 'permissions', 'departments', 'items', 'suppliers'];

        foreach ($criticalTables as $table) {
            if (isset($before[$table]) && isset($after[$table])) {
                if ($before[$table] !== $after[$table]) {
                    throw new \RuntimeException("خلل في الأمان: تغير عدد السجلات في الجدول المحمي [{$table}] من {$before[$table]} إلى {$after[$table]}!");
                }
            }
        }
    }
}
