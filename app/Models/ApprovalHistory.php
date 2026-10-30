<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\MorphTo;

class ApprovalHistory extends Model
{
    use HasFactory;

    protected $table = 'approval_history';

    public const UPDATED_AT = null;

    protected $fillable = [
        'target_type',
        'target_id',
        'actor_user_id',
        'action',
        'from_state',
        'to_state',
        'comments',
        'user_note',
    ];

    /**
     * What the person actually typed for this action, or null when they wrote nothing.
     * `comments` keeps the full audit sentence (often a system default); `user_note`
     * is what the notes card shows.
     */
    public static function typedNote(mixed $value): ?string
    {
        if (! is_string($value)) {
            return null;
        }

        $value = trim($value);

        return $value === '' || in_array($value, self::CANNED_CLIENT_COMMENTS, true) ? null : $value;
    }

    /** Fixed texts some screens send as the comment when the user typed nothing. */
    public const CANNED_CLIENT_COMMENTS = [
        'تم الاعتماد المباشر من المدير التنفيذي.',
        'تم الرفض بواسطة مدير المشتريات',
        'تمت الموافقة المالية على الطلب من الإدارة المالية.',
    ];

    public function target(): MorphTo
    {
        return $this->morphTo();
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }
}
