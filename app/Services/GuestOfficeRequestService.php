<?php

namespace App\Services;

use App\Models\AppSetting;
use App\Models\Department;
use App\Models\PurchaseRequest;
use App\Models\Role;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Office-supplies requests sent from the public link (no account).
 *
 * Every such request belongs to one internal account that cannot sign in; the
 * name the person typed is kept on the request and shown everywhere instead.
 * The request then follows the normal office-supplies cycle, starting with the
 * chosen department's reviewer, who also confirms receipt.
 */
class GuestOfficeRequestService
{
    public const SYSTEM_USER_EMAIL = 'guest-office-requests@ishbilia.internal';

    private const TOKEN_KEY = 'guest_office_request_token';

    public function __construct(private readonly PurchaseRequestService $requests)
    {
    }

    public static function isSystemUser(User|int|null $user): bool
    {
        if ($user === null) {
            return false;
        }

        if ($user instanceof User) {
            return $user->email === self::SYSTEM_USER_EMAIL;
        }

        return User::query()->whereKey($user)->where('email', self::SYSTEM_USER_EMAIL)->exists();
    }

    /**
     * The shared requester account. Inactive with a random password, so it can never sign in.
     */
    public function systemUser(): User
    {
        $user = User::query()->where('email', self::SYSTEM_USER_EMAIL)->first();

        if (! $user) {
            $user = User::create([
                'name' => 'مقدم طلب مؤقت',
                'email' => self::SYSTEM_USER_EMAIL,
                'password' => Str::random(64),
                'is_active' => false,
            ]);

            $employeeRole = Role::query()->where('slug', 'employee')->first();
            if ($employeeRole) {
                $user->roles()->syncWithoutDetaching([$employeeRole->id]);
            }
        }

        return $user;
    }

    public function token(): string
    {
        $token = AppSetting::getValue(self::TOKEN_KEY);

        if (! $token) {
            $token = $this->rotateToken();
        }

        return $token;
    }

    public function rotateToken(): string
    {
        $token = Str::random(40);
        AppSetting::setValue(self::TOKEN_KEY, $token);

        return $token;
    }

    public function tokenMatches(?string $token): bool
    {
        $current = AppSetting::getValue(self::TOKEN_KEY);

        return is_string($token) && $current !== null && $current !== '' && hash_equals($current, $token);
    }

    /**
     * @return array<int, array{id:int, name:string}>
     */
    public function departmentOptions(): array
    {
        return Department::query()
            ->where('is_active', true)
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (Department $department) => ['id' => $department->id, 'name' => $department->name])
            ->all();
    }

    /**
     * @param array{name:string, phone?:?string, target_department_id:int, notes:string, items:array<int, array>} $data
     */
    public function submit(array $data): PurchaseRequest
    {
        $user = $this->systemUser();

        $created = DB::transaction(function () use ($user, $data) {
            $request = $this->requests->createRequest($user, [
                'request_type' => 'OFFICE_SUPPLIES',
                'target_department_id' => (int) $data['target_department_id'],
                'notes' => $data['notes'],
                'items' => array_map(fn (array $item) => [
                    'item_description' => $item['item_description'],
                    'quantity' => $item['quantity'],
                    'uom' => $item['uom'] ?? 'قطعة',
                    'specifications' => $item['specifications'] ?? null,
                ], $data['items']),
            ]);

            $request->forceFill([
                'guest_requester_name' => trim($data['name']),
                'guest_requester_phone' => filled($data['phone'] ?? null) ? trim((string) $data['phone']) : null,
            ])->save();

            return $request;
        });

        // Submitting runs the normal cycle and its notifications (to the department reviewer).
        return $this->requests->submitRequest($user, $created->fresh());
    }
}
