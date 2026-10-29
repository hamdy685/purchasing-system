<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Provenance of department-consolidated PO lines.
     *
     * Each row records one purchase request line's contribution (quantity and value)
     * to one PO line, with snapshots of department, cost allocation and supplier at
     * issue time. Rows are reference data only and never part of any financial total.
     * They are never deleted: when their PO is rejected/cancelled they are released
     * (active_flag = NULL), which also lets the request line be ordered again.
     * UNIQUE(purchase_request_item_id, active_flag) keeps a request line active in at
     * most one PO line (multiple NULLs are allowed by MySQL and SQLite).
     *
     * Additive only: existing rows are untouched.
     */
    public function up(): void
    {
        if (! Schema::hasTable('purchase_order_item_sources')) {
            Schema::create('purchase_order_item_sources', function (Blueprint $table) {
                $table->id();
                $table->foreignId('purchase_order_item_id')->constrained('purchase_order_items')->restrictOnDelete();
                $table->foreignId('purchase_request_id')->constrained('purchase_requests')->restrictOnDelete();
                $table->foreignId('purchase_request_item_id')->constrained('purchase_request_items')->restrictOnDelete();
                $table->foreignId('department_id')->nullable()->constrained('departments')->nullOnDelete();
                $table->foreignId('land_parcel_id')->nullable()->constrained('land_parcels')->nullOnDelete();
                $table->string('item_reference', 100)->nullable();
                $table->string('region', 150)->nullable();
                $table->foreignId('supplier_id')->nullable()->constrained('suppliers')->nullOnDelete();
                $table->decimal('source_quantity', 15, 4);
                $table->string('source_uom', 30);
                $table->decimal('line_quantity', 15, 4);
                $table->decimal('unit_price', 15, 4)->default(0);
                $table->decimal('line_amount', 15, 2)->default(0);
                $table->unsignedTinyInteger('active_flag')->nullable()->default(1);
                $table->timestamp('released_at')->nullable();
                $table->string('released_reason', 255)->nullable();
                $table->uuid('consolidation_run_id')->nullable();
                $table->foreignId('created_by_user_id')->nullable()->constrained('users')->nullOnDelete();
                $table->timestamps();

                $table->unique(['purchase_request_item_id', 'active_flag'], 'po_item_sources_pr_item_active_unique');
                $table->index('purchase_order_item_id');
                $table->index('purchase_request_id');
                $table->index('consolidation_run_id');
            });
        }

        if (Schema::hasTable('purchase_orders')) {
            Schema::table('purchase_orders', function (Blueprint $table) {
                if (! Schema::hasColumn('purchase_orders', 'consolidation_policy')) {
                    $table->string('consolidation_policy', 30)->nullable();
                }
                if (! Schema::hasColumn('purchase_orders', 'consolidation_key')) {
                    $table->string('consolidation_key', 64)->nullable()->index();
                }
                if (! Schema::hasColumn('purchase_orders', 'idempotency_key')) {
                    $table->string('idempotency_key', 64)->nullable()->unique();
                }
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('purchase_order_item_sources');

        if (Schema::hasTable('purchase_orders')) {
            Schema::table('purchase_orders', function (Blueprint $table) {
                if (Schema::hasColumn('purchase_orders', 'idempotency_key')) {
                    $table->dropUnique(['idempotency_key']);
                    $table->dropColumn('idempotency_key');
                }
                if (Schema::hasColumn('purchase_orders', 'consolidation_key')) {
                    $table->dropIndex(['consolidation_key']);
                    $table->dropColumn('consolidation_key');
                }
                if (Schema::hasColumn('purchase_orders', 'consolidation_policy')) {
                    $table->dropColumn('consolidation_policy');
                }
            });
        }
    }
};
