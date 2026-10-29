<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * An Actual PO whose grand total exceeds config procurement.actual_po_high_value_threshold can only be
     * issued with a written reason; the reason, the threshold in force and who acknowledged it are kept here.
     * Additive only: existing rows are untouched.
     */
    public function up(): void
    {
        Schema::table('purchase_orders', function (Blueprint $table) {
            if (! Schema::hasColumn('purchase_orders', 'high_value_reason')) {
                $table->text('high_value_reason')->nullable();
            }
            if (! Schema::hasColumn('purchase_orders', 'high_value_threshold')) {
                $table->decimal('high_value_threshold', 15, 2)->nullable();
            }
            if (! Schema::hasColumn('purchase_orders', 'high_value_acknowledged_by_user_id')) {
                $table->foreignId('high_value_acknowledged_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            }
            if (! Schema::hasColumn('purchase_orders', 'high_value_acknowledged_at')) {
                $table->timestamp('high_value_acknowledged_at')->nullable();
            }
        });
    }

    public function down(): void
    {
        Schema::table('purchase_orders', function (Blueprint $table) {
            if (Schema::hasColumn('purchase_orders', 'high_value_acknowledged_by_user_id')) {
                $table->dropConstrainedForeignId('high_value_acknowledged_by_user_id');
            }
            foreach (['high_value_acknowledged_at', 'high_value_threshold', 'high_value_reason'] as $column) {
                if (Schema::hasColumn('purchase_orders', $column)) {
                    $table->dropColumn($column);
                }
            }
        });
    }
};
