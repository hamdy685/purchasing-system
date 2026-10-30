<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\AuditLog;
use Carbon\Carbon;
use App\Models\Department;
use App\Models\LandParcel;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\User;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

class PurchaseRequestService
{
    /**
     * Generate sequential unique Purchase Request number (PR-1, PR-2, ...).
     * Simple, clean, ascending starting from 1 with no leading zeros.
     */
    public function generateUniqueRequestNumber(string $prefix = 'PR-'): string
    {
        $latestRequest = DB::table('purchase_requests')
            ->where('request_number', 'like', "{$prefix}%")
            ->orderBy('id', 'desc')
            ->lockForUpdate()
            ->first();

        $maxSeq = 0;
        if ($latestRequest) {
            $parts = explode('-', $latestRequest->request_number);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $maxSeq = (int) $lastPart;
            }
        }

        $existing = DB::table('purchase_requests')
            ->where('request_number', 'like', "{$prefix}%")
            ->pluck('request_number');

        foreach ($existing as $num) {
            $parts = explode('-', (string) $num);
            $lastPart = end($parts);
            if (is_numeric($lastPart)) {
                $seq = (int) $lastPart;
                if ($seq > $maxSeq) {
                    $maxSeq = $seq;
                }
            }
        }

        $nextNumber = max(1, $maxSeq + 1);

        while (DB::table('purchase_requests')->where('request_number', "{$prefix}{$nextNumber}")->exists()) {
            $nextNumber++;
        }

        return "{$prefix}{$nextNumber}";
    }

    /**
     * Backward-compatible alias for generateUniqueRequestNumber.
     */
    public function generateRequestNumber(): string
    {
        return $this->generateUniqueRequestNumber();
    }

    /**
     * Normalize request line items without calculating any estimated price.
     * Supplier prices are entered later in the official quote stage.
     */
    public function normalizeItems(array $items, bool $isOffice = false, ?string $defaultParcel = null, ?string $defaultRegion = null): array
    {
        $normalizedItems = [];

        foreach ($items as $index => $item) {
            $itemReference = trim((string) ($item['item_reference'] ?? ''));
            $region = trim((string) ($item['region'] ?? ''));

            if ($itemReference === '' && $defaultParcel !== null && trim($defaultParcel) !== '') {
                $itemReference = trim($defaultParcel);
            }
            if ($region === '' && $defaultRegion !== null && trim($defaultRegion) !== '') {
                $region = trim($defaultRegion);
            }

            if ($isOffice) {
                if ($itemReference === '') {
                    $itemReference = 'مقر الشركة';
                }
                if ($region === '') {
                    $region = 'إداري / المقر الرئيسي';
                }
            } else {
                if ($itemReference === '' || $region === '') {
                    $errors = [];
                    if ($itemReference === '') {
                        $errors["items.{$index}.item_reference"] = ['رقم قطعة الأرض مطلوب ولا يمكن أن يكون فارغًا.'];
                    }
                    if ($region === '') {
                        $errors["items.{$index}.region"] = ['المنطقة مطلوبة ولا يمكن أن تكون فارغة.'];
                    }
                    throw ValidationException::withMessages($errors);
                }
            }

            $quantity = (float) ($item['quantity'] ?? 0);
            if ($quantity <= 0) {
                throw ValidationException::withMessages([
                    "items.{$index}.quantity" => ['الكمية يجب أن تكون أكبر من صفر.'],
                ]);
            }

            $unitPrice = isset($item['estimated_unit_price']) && $item['estimated_unit_price'] !== '' && $item['estimated_unit_price'] !== null
                ? (float) $item['estimated_unit_price']
                : null;
            $lineTotal = ($unitPrice !== null) ? round($quantity * $unitPrice, 2) : null;

            $normalizedItems[] = [
                'item_id' => $item['item_id'] ?? null,
                'item_description' => $item['item_description'] ?? '',
                'item_reference' => $itemReference,
                'region' => $region,
                'quantity' => $quantity,
                'uom' => $item['uom'] ?? 'PCS',
                'specifications' => $item['specifications'] ?? null,
                'notes' => $item['notes'] ?? null,
                'supplier_id' => !empty($item['supplier_id']) ? (int) $item['supplier_id'] : null,
                'estimated_unit_price' => $unitPrice,
                'estimated_line_total' => $lineTotal,
            ];
        }

        return $normalizedItems;
    }

    /**
     * Backward-compatible alias for internal callers; it no longer calculates prices.
     */
    public function calculateFinancials(array $items): array
    {
        return ['items' => $this->normalizeItems($items)];
    }

    /**
     * Create a new draft Purchase Request with line items.
     * Includes automated retry mechanism (up to 5 attempts) to prevent race condition failures.
     */
    public function createRequest(User $user, array $data): PurchaseRequest
    {
        $maxAttempts = 5;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                return DB::transaction(function () use ($user, $data) {
                    $incomingType = $data['request_type'] ?? 'PROJECT';
                    $requestType = in_array($incomingType, ['OFFICE_SUPPLIES', 'COMPLEMENTARY'], true) ? $incomingType : 'PROJECT';
                    $isOffice = $requestType === 'OFFICE_SUPPLIES';
                    $isComplementary = $requestType === 'COMPLEMENTARY';

                    $parcelReference = trim((string) ($data['parcel_reference'] ?? $data['parcel'] ?? $data['parcel_name'] ?? ''));
                    $region = trim((string) ($data['region'] ?? ''));
                    $landParcelId = !empty($data['land_parcel_id']) ? (int) $data['land_parcel_id'] : null;

                    if ($landParcelId && ($parcelReference === '' || $region === '')) {
                        $lp = LandParcel::find($landParcelId);
                        if ($lp) {
                            if ($parcelReference === '') $parcelReference = $lp->parcel_reference;
                            if ($region === '') $region = $lp->region;
                        }
                    }

                    if ($isOffice) {
                        if ($parcelReference === '') {
                            $parcelReference = 'مقر الشركة';
                        }
                        if ($region === '') {
                            $region = 'إداري / المقر الرئيسي';
                        }
                    } elseif ($isComplementary) {
                        if ($parcelReference === '' && !empty($data['items'][0]['item_reference'])) {
                            $parcelReference = trim((string) $data['items'][0]['item_reference']);
                        }
                        if ($region === '' && !empty($data['items'][0]['region'])) {
                            $region = trim((string) $data['items'][0]['region']);
                        }
                        if ($parcelReference === '') {
                            $parcelReference = 'طلب كمالة مستقل';
                        }
                        if ($region === '') {
                            $region = 'موقع العمل / المستودع';
                        }
                    } else {
                        if ($parcelReference === '' && !empty($data['items'][0]['item_reference'])) {
                            $parcelReference = trim((string) $data['items'][0]['item_reference']);
                        }
                        if ($region === '' && !empty($data['items'][0]['region'])) {
                            $region = trim((string) $data['items'][0]['region']);
                        }

                        if (! $landParcelId && $parcelReference !== '' && $region !== '') {
                            $existingLp = LandParcel::where('parcel_reference', $parcelReference)->where('region', $region)->first();
                            if ($existingLp) {
                                $landParcelId = $existingLp->id;
                            }
                        }
                    }

                    $normalizedItems = $this->normalizeItems($data['items'] ?? [], $isOffice, $parcelReference, $region);
                    $requestNumber = $this->generateUniqueRequestNumber();
                    $targetDepartmentId = (int) ($data['target_department_id'] ?? $data['department_id'] ?? $user->department_id);
                    $targetDepartment = Department::with(['manager', 'siteEngineer'])->find($targetDepartmentId);

                    if (!$targetDepartment) {
                        throw ValidationException::withMessages([
                            'target_department_id' => ['اختر قسمًا مستهدفًا صحيحًا للطلب.'],
                        ]);
                    }

                    $isExecutiveRequester = $user->hasAnyRole(['general_manager', 'execution_manager']);
                    $isBypassRole = $user->hasAnyRole(['general_manager', 'execution_manager', 'procurement_manager', 'accountant', 'admin']);
                    $isReviewerSameDept = $user->hasRole('reviewer') && ((int) $targetDepartment->id === (int) $user->department_id);

                    $assignedManager = $targetDepartment->manager;
                    if (!$assignedManager) {
                        $assignedManager = User::where('department_id', $targetDepartment->id)
                            ->where('is_active', true)
                            ->whereHas('roles', fn ($q) => $q->where('slug', 'reviewer'))
                            ->first();
                    }
                    if (!$assignedManager) {
                        $emailMap = (array) config('procurement.default_department_reviewers', []);
                        if (isset($emailMap[$targetDepartment->code])) {
                            $assignedManager = User::where('email', $emailMap[$targetDepartment->code])->first();
                        }
                    }
                    if ($assignedManager && !$targetDepartment->manager_user_id) {
                        $targetDepartment->update(['manager_user_id' => $assignedManager->id]);
                    }

                    // Backward compatibility for old clients/drafts that still send explicit assignments.
                    if (!$assignedManager && !empty($data['reviewer_user_id'])) {
                        $assignedManager = User::query()->whereKey((int) $data['reviewer_user_id'])->where('is_active', true)->first();
                    }
                    $siteEngineer = null;
                    if (!empty($data['site_engineer_user_id'])) {
                        $siteEngineer = User::query()->whereKey((int) $data['site_engineer_user_id'])->where('is_active', true)->first();
                    }
                    if (!$siteEngineer && !$isOffice && $targetDepartment->site_engineer_user_id) {
                        $siteEngineer = $targetDepartment->siteEngineer;
                    }

                    if ($isReviewerSameDept && !$assignedManager) {
                        $assignedManager = $user;
                    }

                    $pr = PurchaseRequest::create([
                        'request_number' => $requestNumber,
                        'request_type' => $requestType,
                        'parcel_reference' => $parcelReference,
                        'region' => $region,
                        'land_parcel_id' => $landParcelId,
                        'user_id' => $user->id,
                        'department_id' => $user->department_id ?? $targetDepartment->id,
                        'target_department_id' => $targetDepartment->id,
                        // Keep legacy reviewer_user_id populated with the department manager.
                        // The general manager is the final business approver for their own request;
                        // never route their request to the target department manager.
                        'reviewer_user_id' => $isExecutiveRequester ? null : $assignedManager?->id,
                        'site_engineer_user_id' => $isOffice ? null : $siteEngineer?->id,
                        'priority' => $data['priority'] ?? 'NORMAL',
                        'status' => 'DRAFT',
                        'procurement_route' => 'UNDECIDED',
                        'total_estimated_cost' => 0,
                        'requires_warehouse_receipt' => array_key_exists('requires_warehouse_receipt', $data)
                            ? (bool) $data['requires_warehouse_receipt']
                            : true,
                        'date_needed' => $this->normalizeNeededDate($data['date_needed'] ?? $data['required_date'] ?? $data['required_delivery_date'] ?? null),
                        'notes' => $data['notes'] ?? null,
                    ]);

                    foreach ($normalizedItems as $itemData) {
                        $pr->items()->create([
                            'item_id' => $itemData['item_id'] ?? null,
                            'item_description' => $itemData['item_description'],
                            'item_reference' => $itemData['item_reference'],
                            'region' => $itemData['region'],
                            'quantity' => $itemData['quantity'],
                            'uom' => $itemData['uom'],
                            'specifications' => $itemData['specifications'] ?? null,
                            'notes' => $itemData['notes'] ?? null,
                            'is_supplementary' => $isComplementary,
                        ]);
                    }

                    AuditLog::create([
                        'user_id' => $user->id,
                        'action' => 'CREATED',
                        'entity_type' => PurchaseRequest::class,
                        'entity_id' => $pr->id,
                        'new_value' => json_encode([
                            'request_number' => $pr->request_number,
                            'request_type' => $pr->request_type,
                            'parcel_reference' => $pr->parcel_reference,
                            'region' => $pr->region,
                            'status' => 'DRAFT',
                        ], JSON_UNESCAPED_UNICODE),
                    ]);

                    return $pr->load(['requester.roles', 'requester:id,name,email,department_id', 'department:id,name,code', 'assignedReviewer:id,name,email,department_id', 'siteEngineer:id,name,email,department_id', 'landParcel', 'items.item', 'items.supplier']);
                });
            } catch (QueryException $e) {
                $isDuplicate = $e->getCode() == 23000
                    || ($e->errorInfo[1] ?? null) == 1062
                    || str_contains($e->getMessage(), '1062')
                    || str_contains($e->getMessage(), 'Duplicate entry')
                    || str_contains($e->getMessage(), 'request_number');

                if ($isDuplicate && $attempt < $maxAttempts) {
                    Log::warning("PurchaseRequestService: Duplicate request_number collision detected on attempt {$attempt}, retrying...", [
                        'user_id' => $user->id,
                        'attempt' => $attempt,
                        'error' => $e->getMessage(),
                    ]);
                    usleep(random_int(20000, 100000));
                    continue;
                }

                throw $e;
            }
        }

        throw new \RuntimeException('تعذر إنشاء طلب الشراء بسبب تداخل أرقام الطلبات. يرجى إعادة المحاولة.');
    }

    /**
     * Update a requester-editable Purchase Request before reviewer approval.
     */
    public function updateRequest(User $user, PurchaseRequest $request, array $data): PurchaseRequest
    {
        if (! $request->isEditableByRequester()) {
            throw new \RuntimeException('لا يمكن تعديل طلب الشراء بعد اعتماد المراجع.');
        }

        return DB::transaction(function () use ($user, $request, $data) {
            $lockedRequest = PurchaseRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
            if (! $lockedRequest->isEditableByRequester()) {
                throw new \RuntimeException('لا يمكن تعديل طلب الشراء بعد اعتماد المراجع.');
            }

            $requestType = $data['request_type'] ?? $lockedRequest->request_type ?? 'PROJECT';
            $isOffice = $requestType === 'OFFICE_SUPPLIES';

            $parcelProvided = array_key_exists('parcel_reference', $data);
            $regionProvided = array_key_exists('region', $data);
            $itemsProvided = array_key_exists('items', $data);

            $parcelReference = $parcelProvided
                ? trim((string) $data['parcel_reference'])
                : (string) ($lockedRequest->parcel_reference ?? $lockedRequest->items()->first()?->item_reference ?? '');

            $region = $regionProvided
                ? trim((string) $data['region'])
                : (string) ($lockedRequest->region ?? $lockedRequest->items()->first()?->region ?? '');

            $landParcelId = array_key_exists('land_parcel_id', $data)
                ? (!empty($data['land_parcel_id']) ? (int) $data['land_parcel_id'] : null)
                : $lockedRequest->land_parcel_id;

            if ($landParcelId && ($parcelReference === '' || $region === '')) {
                $lp = LandParcel::find($landParcelId);
                if ($lp) {
                    if ($parcelReference === '') $parcelReference = $lp->parcel_reference;
                    if ($region === '') $region = $lp->region;
                }
            }

            if ($isOffice) {
                $parcelReference = $parcelReference !== '' ? $parcelReference : 'مقر الشركة';
                $region = $region !== '' ? $region : 'إداري / المقر الرئيسي';
            } else {
                if ($parcelReference === '' && !empty($data['items'][0]['item_reference'])) {
                    $parcelReference = trim((string) $data['items'][0]['item_reference']);
                }
                if ($region === '' && !empty($data['items'][0]['region'])) {
                    $region = trim((string) $data['items'][0]['region']);
                }

                if ($parcelReference !== '' && $region !== '' && ! $landParcelId) {
                    $existingLp = LandParcel::where('parcel_reference', $parcelReference)->where('region', $region)->first();
                    if ($existingLp) {
                        $landParcelId = $existingLp->id;
                    }
                }
            }

            $updateFields = [];
            if ($parcelReference !== '') {
                $updateFields['parcel_reference'] = $parcelReference;
            }
            if ($region !== '') {
                $updateFields['region'] = $region;
            }
            if ($landParcelId !== null) {
                $updateFields['land_parcel_id'] = $landParcelId;
            }

            if (array_key_exists('request_type', $data)) {
                $updateFields['request_type'] = $requestType;
            }
            if (array_key_exists('target_department_id', $data)) {
                $targetDepartment = Department::with(['manager', 'siteEngineer'])->find((int) $data['target_department_id']);
                if (!$targetDepartment) {
                    throw ValidationException::withMessages(['target_department_id' => ['اختر قسمًا مستهدفًا صحيحًا.']]);
                }
                $assignedManager = $targetDepartment->manager;
                if (!$assignedManager) {
                    $assignedManager = User::where('department_id', $targetDepartment->id)
                        ->where('is_active', true)
                        ->whereHas('roles', fn ($q) => $q->where('slug', 'reviewer'))
                        ->first();
                }
                if (!$assignedManager) {
                    $emailMap = (array) config('procurement.default_department_reviewers', []);
                    if (isset($emailMap[$targetDepartment->code])) {
                        $assignedManager = User::where('email', $emailMap[$targetDepartment->code])->first();
                    }
                }
                if ($assignedManager && !$targetDepartment->manager_user_id) {
                    $targetDepartment->update(['manager_user_id' => $assignedManager->id]);
                }
                $isExecutiveRequester = $user->hasAnyRole(['general_manager', 'execution_manager']);
                $updateFields['target_department_id'] = $targetDepartment->id;
                $updateFields['reviewer_user_id'] = $isExecutiveRequester ? null : $assignedManager?->id;
            }
            $simpleFields = ['notes', 'priority'];
            foreach ($simpleFields as $field) {
                if (array_key_exists($field, $data)) {
                    $updateFields[$field] = is_string($data[$field]) ? trim($data[$field]) : $data[$field];
                }
            }
            if (array_key_exists('site_engineer_user_id', $data)) {
                $updateFields['site_engineer_user_id'] = $isOffice ? null : (!empty($data['site_engineer_user_id']) ? (int) $data['site_engineer_user_id'] : null);
            }
            if (array_key_exists('requires_warehouse_receipt', $data)) {
                $updateFields['requires_warehouse_receipt'] = (bool) $data['requires_warehouse_receipt'];
            }
            if (array_key_exists('date_needed', $data)) {
                $updateFields['date_needed'] = $this->normalizeNeededDate($data['date_needed']);
            }

            if (array_key_exists('items', $data)) {
                $existingItems = $request->items->keyBy('id');
                $normalizedItems = $this->normalizeItems($data['items'], $isOffice, $parcelReference, $region);

                $totalCost = 0.0;
                $primarySupplierId = $request->direct_supplier_id;

                // Re-create items
                $request->items()->delete();
                foreach ($normalizedItems as $index => $itemData) {
                    $existingItem = !empty($data['items'][$index]['id'])
                        ? $existingItems->get((int) $data['items'][$index]['id'])
                        : ($request->items[$index] ?? null);

                    $supplierId = $itemData['supplier_id']
                        ?? (!empty($data['items'][$index]['supplier_id']) ? (int) $data['items'][$index]['supplier_id'] : null)
                        ?? $existingItem?->supplier_id;

                    $unitPrice = $itemData['estimated_unit_price']
                        ?? (isset($data['items'][$index]['estimated_unit_price']) ? (float) $data['items'][$index]['estimated_unit_price'] : ($existingItem?->estimated_unit_price !== null ? (float) $existingItem->estimated_unit_price : null));

                    $lineTotal = ($unitPrice !== null) ? round((float) $itemData['quantity'] * $unitPrice, 2) : null;
                    if ($lineTotal !== null) {
                        $totalCost += $lineTotal;
                    }
                    if ($supplierId && !$primarySupplierId) {
                        $primarySupplierId = $supplierId;
                    }

                    $request->items()->create([
                        'item_id' => $itemData['item_id'] ?? null,
                        'item_description' => $itemData['item_description'],
                        'item_reference' => $itemData['item_reference'],
                        'region' => $itemData['region'],
                        'quantity' => $itemData['quantity'],
                        'uom' => $itemData['uom'],
                        'specifications' => $itemData['specifications'] ?? null,
                        'notes' => $itemData['notes'] ?? null,
                        'supplier_id' => $supplierId,
                        'estimated_unit_price' => $unitPrice,
                        'estimated_line_total' => $lineTotal,
                    ]);
                }

                if ($primarySupplierId && !$request->direct_supplier_id) {
                    $updateFields['direct_supplier_id'] = $primarySupplierId;
                }
                if ($totalCost > 0) {
                    $updateFields['total_estimated_cost'] = round($totalCost, 2);
                }
            } else {
                // Keep existing items in sync if parcel/region changed
                $request->items()->update([
                    'item_reference' => $parcelReference,
                    'region' => $region,
                ]);
            }

            $request->update($updateFields);

            return $request->fresh(['requester.roles', 'requester:id,name,email,department_id', 'department:id,name,code', 'targetDepartment.manager:id,name,email,department_id', 'targetDepartment.siteEngineer:id,name,email,department_id', 'assignedReviewer:id,name,email,department_id', 'siteEngineer:id,name,email,department_id', 'landParcel', 'items.item', 'items.supplier']);
        });
    }

    private function normalizeNeededDate(?string $value): string
    {
        $dateValue = trim((string) $value);
        if ($dateValue === '') {
            return Carbon::today()->toDateString();
        }

        try {
            if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $dateValue, $matches)) {
                $date = Carbon::createFromFormat('Y-m-d', $matches[1]);
            } else {
                $date = Carbon::parse($dateValue);
            }
        } catch (\Throwable) {
            return Carbon::today()->toDateString();
        }

        if (! $date) {
            return Carbon::today()->toDateString();
        }

        // Auto-bump past dates (e.g. from saved draft) to today
        if ($date->lt(Carbon::today())) {
            return Carbon::today()->toDateString();
        }

        return $date->toDateString();
    }

    /**
     * Soft delete a draft Purchase Request.
     */
    public function deleteRequest(User $user, PurchaseRequest $request): void
    {
        if ($request->status !== 'DRAFT') {
            throw new \RuntimeException('Only draft purchase requests can be deleted.');
        }

        DB::transaction(function () use ($request) {
            $lockedRequest = PurchaseRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
            if ($lockedRequest->status !== 'DRAFT') {
                throw new \RuntimeException('Only draft purchase requests can be deleted.');
            }

            $lockedRequest->delete();
        });
    }

    /**
     * Submit a draft Purchase Request for review.
     */
    public function submitRequest(
        User $user,
        PurchaseRequest $request,
        ?int $siteEngineerUserId = null,
        ?bool $requiresWarehouseReceipt = null,
        ?string $comment = null
    ): PurchaseRequest {
        if (! in_array($request->status, ['DRAFT', 'REJECTED', 'RETURNED'], true)) {
            throw new \RuntimeException('يمكن فقط إرسال طلبات الشراء التي في حالة مسودة أو معادة/مرفوضة.');
        }

        if ($request->items()->count() === 0) {
            throw ValidationException::withMessages([
                'items' => ['يجب إضافة بند واحد على الأقل لطلب الشراء قبل الإرسال.'],
            ]);
        }

        return DB::transaction(function () use ($user, $request, $siteEngineerUserId, $requiresWarehouseReceipt, $comment) {
            // إعادة تحميل الطلب مع قفل الصف لمنع الإرسال المزدوج أو انتقالين متزامنين من المسودة.
            $request = PurchaseRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
            if (! in_array($request->status, ['DRAFT', 'REJECTED', 'RETURNED'], true)) {
                throw new \RuntimeException('تم إرسال طلب الشراء بالفعل أو لم يعد في حالة مسودة أو مرفوض.');
            }
            $request->loadMissing(['department', 'targetDepartment', 'assignedReviewer', 'siteEngineer']);
            $normalizedNeededDate = $this->normalizeNeededDate($request->date_needed?->toDateString());
            $isExecutiveRequester = $user->hasAnyRole(['general_manager', 'execution_manager']);
            $isDepartmentManagerRequester = $user->hasRole('reviewer');
            // مدير المشتريات والحسابات: يتجاوزان المراجع ويذهبان مباشرةً للمدير التنفيذي.
            $isProcurementOrAccounting = $user->hasAnyRole(['procurement_manager', 'accountant']);
            $isTargetDeptManager = (int) $request->targetDepartment?->manager_user_id === (int) $user->id;
            $sameDepartment = (int) $request->department_id === (int) $request->target_department_id || (int) $user->department_id === (int) $request->target_department_id;
            $canSkipReviewer = $isDepartmentManagerRequester && ($sameDepartment || $isTargetDeptManager || ! $request->department_id);
            // المشتريات والمدير المالي يتخطيان المراجع، فيأخذان قراره: تحديد مسؤول الاستلام ومسار المخزن.
            $actsAsReviewer = ! $isExecutiveRequester && ($canSkipReviewer || $isProcurementOrAccounting);
            $isComplementary = $request->isComplementaryRequest();

            if ($isComplementary) {
                // في طلبات الكمالة:
                // - إذا أنشأه المدير التنفيذي أو مراجع القسم لنفس قسمه أو إدارة المشتريات -> يذهب مباشرة للمشتريات (تجاوز التنفيذي والمالية)
                // - إذا أنشأه مهندس الموقع أو موظف عادي أو مراجع لقسم آخر -> يذهب للمراجع أولاً (SUBMITTED) لتدقيقه
                if ($isExecutiveRequester || $canSkipReviewer || $isProcurementOrAccounting) {
                    $nextStatus = 'PENDING_PROCUREMENT_APPROVAL';
                } else {
                    $nextStatus = 'SUBMITTED';
                }
            } else {
                $nextStatus = $isExecutiveRequester
                    ? 'PENDING_PROCUREMENT_APPROVAL'
                    : ($isProcurementOrAccounting || $canSkipReviewer
                        ? 'PENDING_EXECUTIVE_APPROVAL'
                        : 'SUBMITTED');
            }

            $assignedSiteEngineerId = $request->site_engineer_user_id;
            if ($siteEngineerUserId) {
                $assignedSiteEngineerId = $siteEngineerUserId;
            }

            // إذا كان مقدم الطلب هو المدير التنفيذي أو مراجع القسم لنفس قسمه لطلب مشروعات/موقع، يجب تحديد مسؤول الاستلام
            $requiresReceiverSelection = ($isExecutiveRequester || ($actsAsReviewer && in_array($nextStatus, ['PENDING_EXECUTIVE_APPROVAL', 'PENDING_PROCUREMENT_APPROVAL'], true)))
                && $request->request_type !== 'OFFICE_SUPPLIES';

            if ($requiresReceiverSelection) {
                if (!$assignedSiteEngineerId && $request->targetDepartment?->site_engineer_user_id) {
                    $assignedSiteEngineerId = $request->targetDepartment->site_engineer_user_id;
                }
                if (!$assignedSiteEngineerId) {
                    $msg = $isExecutiveRequester
                        ? 'طالما أن طلب الشراء صادر من المدير التنفيذي ولا يمر على مراجع، يجب تحديد مهندس الموقع أو مسؤول الاستلام قبل إرسال الطلب إلى المشتريات.'
                        : 'يجب تحديد مهندس الموقع أو مسؤول الاستلام (أو اختيار المراجع لنفسه) قبل اعتماد الطلب وإرساله للمشتريات.';
                    throw ValidationException::withMessages([
                        'site_engineer_user_id' => [$msg],
                    ]);
                }
            }

            $assignedReviewerId = null;
            if (! $isExecutiveRequester) {
                if ($canSkipReviewer) {
                    $assignedReviewerId = $user->id;
                } else {
                    $assignedReviewerId = $request->targetDepartment?->manager_user_id;
                    if (! $assignedReviewerId && $request->targetDepartment) {
                        $targetReviewer = User::where('department_id', $request->targetDepartment->id)
                            ->where('is_active', true)
                            ->whereHas('roles', fn ($q) => $q->where('slug', 'reviewer'))
                            ->first();
                        $assignedReviewerId = $targetReviewer?->id;
                    }
                    if (! $assignedReviewerId && $request->reviewer_user_id && (int) $request->reviewer_user_id !== (int) $user->id) {
                        $assignedReviewerId = $request->reviewer_user_id;
                    }
                }
            }

            $updateData = [
                'status' => $nextStatus,
                'date_needed' => $normalizedNeededDate,
                'submitted_at' => now(),
                'reviewer_user_id' => $assignedReviewerId,
                'site_engineer_user_id' => $request->request_type === 'OFFICE_SUPPLIES' ? null : $assignedSiteEngineerId,
            ];

            if ($requiresWarehouseReceipt !== null) {
                $updateData['requires_warehouse_receipt'] = (bool) $requiresWarehouseReceipt;
            }

            $request->update($updateData);

            if ($actsAsReviewer && in_array($nextStatus, ['PENDING_EXECUTIVE_APPROVAL', 'PENDING_PROCUREMENT_APPROVAL'], true)) {
                $actionName = $nextStatus === 'PENDING_PROCUREMENT_APPROVAL' ? 'APPROVED_BY_REVIEWER_FAST_TRACK' : 'APPROVED_BY_REVIEWER';
                $actorLabel = $canSkipReviewer ? 'مراجع القسم' : ($user->hasRole('procurement_manager') ? 'مدير المشتريات' : 'المدير المالي');
                $commentText = $comment ?: ($nextStatus === 'PENDING_PROCUREMENT_APPROVAL'
                    ? "أنشأ واعتمد {$actorLabel} طلب الكمالة المستقل وأرسله مباشرةً إلى إدارة المشتريات (مسار سريع دون تنفيذي أو مالية)."
                    : "أنشأ واعتمد {$actorLabel} الطلب وحدد مسؤول الاستلام ومسار المخزن وأرسله إلى المدير التنفيذي.");

                ApprovalHistory::create([
                    'target_type' => PurchaseRequest::class,
                    'target_id' => $request->id,
                    'actor_user_id' => $user->id,
                    'action' => $actionName,
                    'from_state' => 'DRAFT',
                    'to_state' => $nextStatus,
                    'user_note' => ApprovalHistory::typedNote($comment),
                    'comments' => $commentText,
                ]);
            }

            AuditLog::create([
                'user_id' => $user->id,
                'action' => 'SUBMITTED',
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $request->id,
                'old_value' => json_encode(['status' => 'DRAFT'], JSON_UNESCAPED_UNICODE),
                'new_value' => json_encode(['status' => $nextStatus, 'target_department_id' => $request->target_department_id], JSON_UNESCAPED_UNICODE),
            ]);

            try {
                $eventMessage = match (true) {
                    $nextStatus === 'PENDING_PROCUREMENT_APPROVAL' && $isComplementary => 'أنشأ واعتمد مراجع القسم/المدير طلب كمالة مستقل وأرسله مباشرة إلى إدارة المشتريات (مسار سريع دون تنفيذي أو مالية).',
                    $nextStatus === 'PENDING_PROCUREMENT_APPROVAL' => 'أنشأ المدير التنفيذي طلب شراء وأرسله مباشرة إلى مدير المشتريات.',
                    $nextStatus === 'PENDING_EXECUTIVE_APPROVAL' && $isProcurementOrAccounting => 'أنشأ مدير المشتريات / الحسابات طلب شراء وأرسله مباشرةً للمدير التنفيذي متجاوزاً مرحلة المراجع.',
                    $nextStatus === 'PENDING_EXECUTIVE_APPROVAL' && $canSkipReviewer => 'أنشأ واعتمد مراجع القسم الطلب وحدد مسؤول الاستلام ومسار المخزن وأرسله مباشرةً إلى المدير التنفيذي.',
                    $nextStatus === 'PENDING_EXECUTIVE_APPROVAL' => 'أرسل مراجع القسم الطلب إلى المدير التنفيذي مباشرة لأن القسم المستهدف هو نفس قسمه.',
                    default => ($isComplementary ? 'أرسل طلب الكمالة إلى رئيس القسم للمراجعة والتدقيق.' : 'أرسل الطلب إلى مدير القسم المستهدف للمراجعة.'),
                };
                app(SystemEventService::class)->recordAction(
                    $request,
                    'PR_SUBMITTED',
                    $eventMessage,
                    ['event_type' => 'purchase_request.submitted', 'from_state' => 'DRAFT', 'to_state' => $nextStatus, 'actor_user_id' => $user->id, 'metadata' => ['is_complementary' => $isComplementary]]
                );

                $notificationService = app(NotificationService::class);
                if ($nextStatus === 'SUBMITTED') {
                    $request->load('assignedReviewer');
                    $reviewers = $request->assignedReviewer
                        ? collect([$request->assignedReviewer])
                        : $notificationService->resolveUsersWithPermission('purchase_request.review', $request->target_department_id);
                    $notifTitle = $isComplementary ? 'طلب كمالة جديد بانتظار المراجعة' : 'طلب شراء جديد للمراجعة';
                    $notifBody = $isComplementary
                        ? "طلب الكمالة {$request->request_number} تابع لقسمك ويحتاج مراجعة واعتماد رئيس القسم وتحديد جهة الاستلام."
                        : "طلب الشراء {$request->request_number} تابع لقسمك ويحتاج اعتماد مدير القسم.";
                    $notificationService->queueUsers(
                        $reviewers,
                        'purchase_request_submitted',
                        $notifTitle,
                        $notifBody,
                        $request
                    );
                } elseif ($nextStatus === 'PENDING_EXECUTIVE_APPROVAL') {
                    $requester = $request->requester;
                    $directManager = ($requester && $requester->manager_id)
                        ? User::where('id', $requester->manager_id)->where('is_active', true)->first()
                        : null;

                    if ($directManager) {
                        $notificationService->queueNotification(
                            $directManager->id,
                            'purchase_request_pending_executive_approval',
                            'طلب شراء بانتظار اعتماد المدير',
                            "طلب الشراء {$request->request_number} لموظفك ({$requester->name}) جاهز لقرارك.",
                            $request
                        );
                    } else {
                        $gmUsers = User::whereHas('roles', fn ($q) => $q->where('slug', 'general_manager'))->where('is_active', true)->get();
                        $notificationService->queueUsers(
                            $gmUsers,
                            'purchase_request_pending_executive_approval',
                            'طلب شراء بانتظار اعتماد المدير التنفيذي',
                            "طلب الشراء {$request->request_number} جاهز لقرار المدير التنفيذي.",
                            $request
                        );
                    }
                } else {
                    // PENDING_PROCUREMENT_APPROVAL: Notify procurement directly!
                    $procurementUsers = User::whereHas('roles', fn ($q) => $q->where('slug', 'procurement_manager'))->where('is_active', true)->get();
                    if ($procurementUsers->isEmpty()) {
                        $procurementUsers = $notificationService->resolveUsersWithPermission('purchase_request.view_approved');
                    }
                    $notifTitle = $isComplementary ? 'طلب كمالة معتمد جاهز للمشتريات' : 'طلب شراء من المدير التنفيذي';
                    $notifBody = $isComplementary
                        ? "طلب الكمالة المستقل {$request->request_number} معتمد وجاهز لدى إدارة المشتريات لإصدار أمر الشراء فوراً دون تنفيذي أو مالية."
                        : "طلب الشراء {$request->request_number} وصل مباشرة للمشتريات لبدء مساره.";
                    $notificationService->queueUsers(
                        $procurementUsers,
                        'purchase_request_pending_procurement',
                        $notifTitle,
                        $notifBody,
                        $request
                    );
                }
            } catch (\Throwable $notifEx) {
                \Illuminate\Support\Facades\Log::warning('PR Submit notification warning: ' . $notifEx->getMessage());
            }

            return $request->fresh(['requester.roles', 'requester:id,name,email,department_id', 'department:id,name,code', 'targetDepartment.manager:id,name,email,department_id', 'targetDepartment.siteEngineer:id,name,email,department_id', 'assignedReviewer:id,name,email,department_id', 'siteEngineer:id,name,email,department_id', 'items.item', 'items.supplier']);
        });
    }

    /**
     * Get paginated own purchase requests for an employee.
     */
    public function getOwnRequests(User $user, int $perPage = 15)
    {
        $query = PurchaseRequest::query();

        // Procurement Manager and Admin see all purchase requests across the organization
        if (! $user->hasAnyRole(['procurement_manager', 'admin'])) {
            $query->where('user_id', $user->id);
        }

        return $query
            ->with([
                'requester.roles',
                'requester:id,name,email,department_id',
                'department:id,name,code',
                'targetDepartment.manager:id,name,email,department_id',
                'targetDepartment.siteEngineer:id,name,email,department_id',
                'assignedReviewer:id,name,email,department_id',
                'siteEngineer:id,name,email,department_id',
                'items.item',
                'items.supplier',
                'approvalHistory.actor',
                'purchaseOrders' => function ($q) {
                    $q->select('id', 'po_number', 'purchase_request_id', 'status', 'grand_total', 'finalized_at', 'supplier_id', 'created_at', 'updated_at')
                      ->with([
                          'supplier:id,company_name',
                          'receipts:id,purchase_order_id,status,receipt_number',
                      ]);
                },
                'supplements',
            ])
            ->withCount(['purchaseOrders as issued_purchase_orders_count' => function ($q) {
                $q->whereNotIn('status', ['REJECTED', 'CANCELLED', 'VOIDED']);
            }])
            ->orderBy('created_at', 'desc')
            ->paginate($perPage);
    }

    /**
     * Cancel a rejected, returned, or draft purchase request by the requester or admin.
     */
    public function cancelRequest(User $user, PurchaseRequest $pr, ?string $reason = null): PurchaseRequest
    {
        // 1. Authorization: Only the requester who owns the request, or Admin/GM
        if ($pr->user_id !== $user->id && ! $user->hasAnyRole(['admin', 'general_manager'])) {
            throw new \DomainException('ليس لديك صلاحية لإلغاء هذا الطلب.');
        }

        // 2. Prevent duplicate cancellation
        if ($pr->status === 'CANCELLED') {
            throw new \DomainException('طلب الشراء ملغي بالفعل ولا يمكن إلغاؤه مرة أخرى.');
        }

        // 3. Status checks: Can only cancel if REJECTED, RETURNED, or DRAFT
        $cancellableStatuses = ['REJECTED', 'RETURNED', 'DRAFT'];
        if (! in_array($pr->status, $cancellableStatuses, true)) {
            throw new \DomainException("لا يمكن إلغاء الطلب في حالته الحالية ({$pr->status}). يسمح بالإلغاء فقط للطلبات المرفوضة أو المعادة أو المسودات.");
        }

        // 4. Must not have any active (non-cancelled) POs
        $hasActivePos = $pr->purchaseOrders()->whereNotIn('status', ['REJECTED', 'CANCELLED', 'VOIDED'])->exists();
        if ($hasActivePos) {
            throw new \DomainException('لا يمكن إلغاء طلب شراء صدرت له أوامر شراء نشطة.');
        }

        return DB::transaction(function () use ($user, $pr, $reason) {
            $fromState = $pr->status;

            // Update status to CANCELLED
            $pr->update([
                'status' => 'CANCELLED',
            ]);

            $commentText = $reason ?: ($fromState === 'REJECTED'
                ? 'تم إلغاء طلب الشراء المرفوض نهائياً من قبل مقدم الطلب والاستغناء عن إعادة إرساله.'
                : 'تم إلغاء طلب الشراء من قبل مقدم الطلب.');

            // Record in ApprovalHistory to preserve rejection history and audit trail
            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $user->id,
                'action' => 'CANCELLED',
                'from_state' => $fromState,
                'to_state' => 'CANCELLED',
                'user_note' => ApprovalHistory::typedNote($reason),
                'comments' => $commentText,
            ]);

            AuditLog::create([
                'user_id' => $user->id,
                'action' => 'CANCELLED',
                'entity_type' => PurchaseRequest::class,
                'entity_id' => $pr->id,
                'old_value' => json_encode(['status' => $fromState], JSON_UNESCAPED_UNICODE),
                'new_value' => json_encode(['status' => 'CANCELLED'], JSON_UNESCAPED_UNICODE),
            ]);

            try {
                app(SystemEventService::class)->recordAction(
                    $pr,
                    'PR_CANCELLED_BY_REQUESTER',
                    "قام {$user->name} بإلغاء طلب الشراء ({$pr->request_number}) بعد أن كان في حالة ({$fromState}).",
                    [
                        'event_type' => 'purchase_request.cancelled',
                        'from_state' => $fromState,
                        'to_state' => 'CANCELLED',
                        'actor_user_id' => $user->id,
                        'metadata' => [
                            'reason' => $reason,
                        ],
                    ]
                );
            } catch (\Throwable $e) {
                Log::warning('Failed to log system event for PR cancellation: ' . $e->getMessage());
            }

            return $pr->fresh([
                'requester',
                'department',
                'items.item',
                'approvalHistory.actor',
            ]);
        });
    }
}

