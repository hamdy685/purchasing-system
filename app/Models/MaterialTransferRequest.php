<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class MaterialTransferRequest extends Model
{
    use HasFactory, SoftDeletes;

    protected $table = 'material_transfer_requests';

    public const STATUS_DRAFT = 'DRAFT';
    public const STATUS_PENDING_REVIEWER = 'PENDING_REVIEWER';
    public const STATUS_PENDING_ACCOUNTING = 'PENDING_ACCOUNTING';
    public const STATUS_ARCHIVED = 'ARCHIVED';
    public const STATUS_REJECTED = 'REJECTED';
    public const STATUS_RETURNED = 'RETURNED';

    protected $fillable = [
        'request_number',
        'transfer_date',
        'from_project',
        'to_project',
        'driver_name',
        'vehicle_plate_number',
        'status',
        'user_id',
        'reviewer_id',
        'reviewed_at',
        'review_notes',
        'accountant_id',
        'accounted_at',
        'accounting_notes',
        'rejection_reason',
        'return_reason',
        'general_notes',
    ];

    protected static function booted(): void
    {
        static::creating(function (MaterialTransferRequest $model) {
            if (empty($model->request_number)) {
                $monthPrefix = 'MTR-' . now()->format('Ym') . '-';
                $latest = static::withTrashed()
                    ->where('request_number', 'like', $monthPrefix . '%')
                    ->orderByDesc('id')
                    ->first();

                $seq = 1;
                if ($latest && preg_match('/-(\d+)$/', $latest->request_number, $matches)) {
                    $seq = ((int) $matches[1]) + 1;
                }
                $model->request_number = $monthPrefix . str_pad((string) $seq, 4, '0', STR_PAD_LEFT);
            }
        });
    }

    protected function casts(): array
    {
        return [
            'transfer_date' => 'date',
            'reviewed_at' => 'datetime',
            'accounted_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    public function reviewer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'reviewer_id');
    }

    public function accountant(): BelongsTo
    {
        return $this->belongsTo(User::class, 'accountant_id');
    }

    public function items(): HasMany
    {
        return $this->hasMany(MaterialTransferRequestItem::class, 'material_transfer_request_id')->orderBy('item_order');
    }

    public function isDraft(): bool
    {
        return $this->status === self::STATUS_DRAFT;
    }

    public function isPendingReviewer(): bool
    {
        return $this->status === self::STATUS_PENDING_REVIEWER;
    }

    public function isPendingAccounting(): bool
    {
        return $this->status === self::STATUS_PENDING_ACCOUNTING;
    }

    public function isArchived(): bool
    {
        return $this->status === self::STATUS_ARCHIVED;
    }

    public function isRejected(): bool
    {
        return $this->status === self::STATUS_REJECTED;
    }

    public function isReturned(): bool
    {
        return $this->status === self::STATUS_RETURNED;
    }

    public function canBeEditedBy(User $user): bool
    {
        if ($user->hasRole('admin')) {
            return true;
        }

        return in_array($this->status, [self::STATUS_DRAFT, self::STATUS_RETURNED], true)
            && (int) $this->user_id === (int) $user->id;
    }

    public function canBeReviewedBy(User $user): bool
    {
        if (! $this->isPendingReviewer()) {
            return false;
        }

        // Assigned to a specific reviewer: only that reviewer can act on it
        if ($this->reviewer_id) {
            return (int) $this->reviewer_id === (int) $user->id;
        }

        return $user->hasAnyRole(['reviewer', 'admin', 'general_manager', 'execution_manager']);
    }

    /**
     * Pending requests this user may review: assigned to them, or legacy unassigned ones.
     */
    public function scopeAssignedToReviewer(Builder $query, User $user): Builder
    {
        return $query->where(function (Builder $q) use ($user) {
            $q->where('reviewer_id', $user->id);
            if ($user->hasAnyRole(['reviewer', 'admin', 'general_manager', 'execution_manager'])) {
                $q->orWhereNull('reviewer_id');
            }
        });
    }

    public function canBeAccountedBy(User $user): bool
    {
        if (! $this->isPendingAccounting()) {
            return false;
        }

        return $user->hasAnyRole(['accountant', 'site_accountant', 'general_accountant', 'admin']);
    }
}
