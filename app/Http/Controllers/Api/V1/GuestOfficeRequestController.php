<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Services\GuestOfficeRequestService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Public office-supplies link (no sign-in) and the admin card that shows / rotates it.
 */
class GuestOfficeRequestController extends Controller
{
    public function __construct(private readonly GuestOfficeRequestService $service)
    {
    }

    public function form(string $token): JsonResponse
    {
        $this->ensureToken($token);

        return response()->json([
            'data' => [
                'departments' => $this->service->departmentOptions(),
            ],
        ]);
    }

    public function store(Request $request, string $token): JsonResponse
    {
        $this->ensureToken($token);

        // Hidden field: people never fill it, simple bots do.
        if (filled($request->input('website'))) {
            return response()->json(['message' => 'تم استلام طلبك.'], 201);
        }

        $validated = $request->validate([
            'name' => ['required', 'string', 'min:2', 'max:120'],
            'phone' => ['nullable', 'string', 'max:30'],
            'target_department_id' => [
                'required',
                'integer',
                Rule::exists('departments', 'id')->where('is_active', true),
            ],
            'notes' => ['required', 'string', 'max:2000'],
            'items' => ['required', 'array', 'min:1', 'max:30'],
            'items.*.item_description' => ['required', 'string', 'max:500'],
            'items.*.quantity' => ['required', 'numeric', 'gt:0', 'max:1000000'],
            'items.*.uom' => ['nullable', 'string', 'max:30'],
            'items.*.specifications' => ['nullable', 'string', 'max:1000'],
        ], [
            'name.required' => 'اكتب اسمك.',
            'target_department_id.required' => 'اختر القسم التابع له.',
            'target_department_id.exists' => 'اختر قسمًا صحيحًا.',
            'notes.required' => 'اكتب الغرض من الشراء.',
            'items.required' => 'أضف صنفًا واحدًا على الأقل.',
            'items.*.item_description.required' => 'اكتب وصف الصنف.',
            'items.*.quantity.gt' => 'الكمية لازم تكون أكبر من صفر.',
        ]);

        try {
            $purchaseRequest = $this->service->submit($validated);
        } catch (ValidationException $exception) {
            throw $exception;
        } catch (\RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 409);
        }

        return response()->json([
            'message' => 'تم إرسال طلبك لمراجع القسم.',
            'data' => [
                'request_number' => $purchaseRequest->request_number,
            ],
        ], 201);
    }

    public function adminShow(): JsonResponse
    {
        return response()->json(['data' => ['token' => $this->service->token()]]);
    }

    public function adminRotate(): JsonResponse
    {
        return response()->json([
            'message' => 'تم تغيير اللينك. اللينك القديم لم يعد يعمل.',
            'data' => ['token' => $this->service->rotateToken()],
        ]);
    }

    private function ensureToken(string $token): void
    {
        if (! $this->service->tokenMatches($token)) {
            abort(404, 'هذا اللينك غير صالح أو تم تغييره.');
        }
    }
}
