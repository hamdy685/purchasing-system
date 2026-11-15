<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Public office-supplies link: a request sent from the link keeps the name the
 * person typed (and an optional phone), because its owner in `user_id` is one
 * shared internal account that cannot sign in.
 *
 * `app_settings` holds the link's secret token so an admin can rotate it.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('purchase_requests', 'guest_requester_name')) {
            Schema::table('purchase_requests', function (Blueprint $table) {
                $table->string('guest_requester_name', 120)->nullable()->after('user_id');
                $table->string('guest_requester_phone', 30)->nullable()->after('guest_requester_name');
            });
        }

        if (! Schema::hasTable('app_settings')) {
            Schema::create('app_settings', function (Blueprint $table) {
                $table->string('key', 100)->primary();
                $table->text('value')->nullable();
                $table->timestamps();
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('app_settings');

        if (Schema::hasColumn('purchase_requests', 'guest_requester_name')) {
            Schema::table('purchase_requests', function (Blueprint $table) {
                $table->dropColumn(['guest_requester_name', 'guest_requester_phone']);
            });
        }
    }
};
