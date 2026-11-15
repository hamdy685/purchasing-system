<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Small key/value store for settings an admin changes from the app.
 */
class AppSetting extends Model
{
    protected $table = 'app_settings';

    protected $primaryKey = 'key';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['key', 'value'];

    public static function getValue(string $key): ?string
    {
        return static::query()->whereKey($key)->value('value');
    }

    public static function setValue(string $key, ?string $value): void
    {
        static::query()->updateOrCreate(['key' => $key], ['value' => $value]);
    }
}
