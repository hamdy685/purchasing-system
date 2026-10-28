<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Consolidated steel (حديد) in direct purchase orders.
     *
     * Several rebar diameters are carried as ONE financial line flagged with
     * is_consolidated_steel. The original diameter lines are kept, for reference
     * only, in steel_item_components and are never summed financially.
     * Additive only: existing rows are untouched.
     */
    public function up(): void
    {
        foreach (['purchase_request_items', 'purchase_order_items'] as $tableName) {
            if (Schema::hasTable($tableName) && ! Schema::hasColumn($tableName, 'is_consolidated_steel')) {
                Schema::table($tableName, function (Blueprint $table) {
                    $table->boolean('is_consolidated_steel')->default(false);
                });
            }
        }

        if (! Schema::hasTable('steel_item_components')) {
            Schema::create('steel_item_components', function (Blueprint $table) {
                $table->id();
                $table->foreignId('purchase_request_item_id')->nullable()->constrained('purchase_request_items')->cascadeOnDelete();
                $table->foreignId('purchase_order_item_id')->nullable()->constrained('purchase_order_items')->cascadeOnDelete();
                $table->foreignId('item_id')->nullable()->constrained('items')->nullOnDelete();
                $table->string('item_description', 255);
                $table->string('size_or_diameter', 50)->nullable();
                $table->decimal('quantity', 15, 4);
                $table->string('uom', 30);
                $table->decimal('quantity_in_tons', 15, 4);
                $table->decimal('unit_price', 15, 4)->default(0);
                $table->decimal('line_amount', 15, 2)->default(0);
                $table->text('specifications')->nullable();
                $table->unsignedInteger('sort_order')->default(0);
                $table->timestamps();

                $table->index('purchase_request_item_id');
                $table->index('purchase_order_item_id');
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('steel_item_components');

        foreach (['purchase_request_items', 'purchase_order_items'] as $tableName) {
            if (Schema::hasTable($tableName) && Schema::hasColumn($tableName, 'is_consolidated_steel')) {
                Schema::table($tableName, function (Blueprint $table) {
                    $table->dropColumn('is_consolidated_steel');
                });
            }
        }
    }
};
