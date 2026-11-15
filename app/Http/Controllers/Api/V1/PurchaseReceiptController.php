<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Services\PurchaseReceiptService;
use Illuminate\Http\Request;

class PurchaseReceiptController extends Controller
{
    public function __construct(
        protected PurchaseReceiptService $service
    ) {}

    public function warehouseQueue(Request $request)
    {
        return response()->json($this->service->warehouseQueue(
            $request->user(),
            min((int) $request->query('per_page', 15), 100)
        ));
    }

    public function pendingWarehouseTasks(Request $request)
    {
        return $this->warehouseQueue($request);
    }

    public function archive(Request $request)
    {
        return response()->json($this->service->receiptArchive($request->user(), min((int) $request->query('per_page', 25), 100)));
    }

    public function store(Request $request, int $purchaseOrderId)
    {
        $validated = $request->validate([
            'received_at' => ['nullable', 'date'],
            'warehouse_notes' => ['nullable', 'string', 'max:3000'],
            'photo' => ['nullable', 'file', 'mimes:jpg,jpeg,png,webp,pdf', 'max:20480'], // max 20MB
            'photo_base64' => ['nullable', 'string'],
            'photo_name' => ['nullable', 'string', 'max:255'],
            'actual_receiver_name' => ['nullable', 'string', 'max:255'],
            'actual_receiver_user_id' => ['nullable', 'integer', 'exists:users,id'],
            'weighing_group_id' => ['nullable', 'integer', 'exists:weighing_groups,id'],
            'scale_ticket_weight' => ['nullable', 'numeric', 'gte:0'],
            'items' => ['required', 'array', 'min:1'],
            'items.*.purchase_order_item_id' => ['required', 'integer', 'exists:purchase_order_items,id'],
            'items.*.received_quantity' => ['required', 'numeric', 'gte:0'],
            'items.*.notes' => ['nullable', 'string', 'max:1000'],
        ]);

        $purchaseOrder = PurchaseOrder::with(['items.item', 'supplier', 'purchaseRequest.landParcel'])->findOrFail($purchaseOrderId);
        $weighingGroup = !empty($validated['weighing_group_id'])
            ? \App\Models\WeighingGroup::with('items')->find($validated['weighing_group_id'])
            : null;

        $photoData = null;
        try {
            if ($request->hasFile('photo')) {
                $ext = $request->file('photo')->getClientOriginalExtension() ?: 'jpg';
                $customName = \App\Services\DocumentNamingService::generateReceiptName(
                    $purchaseOrder,
                    $validated['items'] ?? [],
                    null,
                    $ext,
                    $weighingGroup,
                    1,
                    $validated['received_at'] ?? null
                );
                $photoData = \App\Services\StorageService::storeUploadedFile($request->file('photo'), 'receipts', $customName);
            } elseif ($request->filled('photo_base64')) {
                $customName = \App\Services\DocumentNamingService::generateReceiptName(
                    $purchaseOrder,
                    $validated['items'] ?? [],
                    null,
                    'jpg',
                    $weighingGroup,
                    1,
                    $validated['received_at'] ?? null
                );
                $photoData = \App\Services\StorageService::storeBase64(
                    $request->input('photo_base64'),
                    'receipts',
                    $customName
                );
            }
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
        try {
            $receipt = $this->service->createByWarehouse(
                $request->user(),
                $purchaseOrder,
                $validated['items'],
                $validated['received_at'] ?? null,
                $validated['warehouse_notes'] ?? null,
                $photoData,
                $validated['actual_receiver_name'] ?? null,
                isset($validated['actual_receiver_user_id']) ? (int) $validated['actual_receiver_user_id'] : null,
                isset($validated['weighing_group_id']) ? (int) $validated['weighing_group_id'] : null,
                isset($validated['scale_ticket_weight']) ? (float) $validated['scale_ticket_weight'] : null,
            );
        } catch (\RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 409);
        }

        return response()->json(['message' => 'تم تسجيل الاستلام وإرساله للمستلم/مهندس الموقع للفحص والاعتماد.', 'data' => $receipt], 201);
    }

    public function indexAssigned(Request $request)
    {
        $this->service->syncPendingDirectSiteReceiptsForEngineer($request->user());
        $this->service->syncPendingOfficeReceiptsForRequester($request->user());
        $user = $request->user();

        $query = PurchaseReceipt::with([
            'supplier',
            'purchaseOrder.supplier',
            'purchaseOrder.purchaseRequest.department',
            'purchaseOrder.purchaseRequest.requester',
            'purchaseOrder.purchaseRequest.siteEngineer',
            'purchaseOrder.items.item',
            'purchaseOrder.items.prItem',
            'purchaseOrder.items.shipmentGroup',
            'purchaseOrder.shipmentGroups.items',
            'purchaseRequest.department',
            'purchaseRequest.requester',
            'purchaseRequest.siteEngineer',
            'warehouseKeeper',
            'siteEngineer',
            'receiver',
            'actualReceiver',
            'items.purchaseOrderItem.item',
            'items.purchaseOrderItem.prItem',
            'items.purchaseOrderItem.shipmentGroup',
            'weighingGroup.items',
        ]);

        if (! $user->hasRole('admin')) {
            $query->where(function ($q) use ($user) {
                // Strict Action Ownership:
                // 1) Office supplies receipts: confirmed by requester / actual receiver
                $q->where(function ($officeQ) use ($user) {
                    $officeQ->where('receipt_type', 'REQUESTER_OFFICE')
                        ->where(function ($sub) use ($user) {
                            $sub->where('receiver_user_id', $user->id)
                                ->orWhere('actual_receiver_user_id', $user->id)
                                ->orWhereHas('purchaseRequest', fn ($prQ) => $prQ->where('user_id', $user->id))
                                ->orWhereHas('purchaseOrder.purchaseRequest', fn ($prQ) => $prQ->where('user_id', $user->id));
                        });
                })
                // 2) Field/site receipts: strictly the assigned site engineer or receiver
                ->orWhere(function ($siteQ) use ($user) {
                    $siteQ->where('receipt_type', '!=', 'REQUESTER_OFFICE')
                        ->where(function ($sub) use ($user) {
                            $sub->where('site_engineer_user_id', $user->id)
                                ->orWhere('receiver_user_id', $user->id);
                        });
                });
            });
        }

        $receipts = $query->whereIn('status', ['PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED'])
            ->orderByDesc('created_at')
            ->paginate(min((int) $request->query('per_page', 15), 100));

        return response()->json($receipts);
    }

    public function show(string|int $id)
    {
        $receipt = PurchaseReceipt::with([
            'supplier',
            'purchaseOrder.supplier',
            'purchaseOrder.createdBy',
            'purchaseOrder.accountingReviewer',
            'purchaseOrder.purchaseRequest.department',
            'purchaseOrder.purchaseRequest.requester',
            'purchaseOrder.purchaseRequest.assignedReviewer',
            'purchaseOrder.purchaseRequest.siteEngineer',
            'purchaseOrder.purchaseRequest.approvalHistory.actor',
            'purchaseOrder.items.item',
            'purchaseOrder.items.prItem',
            'purchaseOrder.approvalHistory.actor',
            'purchaseRequest.department',
            'purchaseRequest.requester',
            'purchaseRequest.assignedReviewer',
            'purchaseRequest.siteEngineer',
            'warehouseKeeper',
            'siteEngineer',
            'receiver',
            'actualReceiver',
            'items.purchaseOrderItem.item',
            'items.purchaseOrderItem.prItem',
        ])->findOrFail((int) $id);

        return response()->json(['data' => $receipt]);
    }

    public function update(Request $request, string|int $id)
    {
        $user = $request->user();
        $receipt = PurchaseReceipt::findOrFail((int) $id);
        if (! $this->canActOnFieldReceipt($user, $receipt, 'purchase_receipt.edit')) {
            return response()->json(['message' => 'غير مصرح للمحاسب العام أو المستخدم الحالي بتعديل أذونات الاستلام الميدانية.'], 403);
        }

        $validated = $request->validate([
            'site_engineer_notes' => ['nullable', 'string', 'max:3000'],
            'items' => ['required', 'array', 'min:1'],
            'items.*.id' => ['required', 'integer', 'exists:purchase_receipt_items,id'],
            'items.*.received_quantity' => ['required', 'numeric', 'gte:0'],
            'items.*.notes' => ['nullable', 'string', 'max:1000'],
        ]);

        try {
            $updated = $this->service->updateBySiteEngineer(
                $request->user(),
                $receipt,
                $validated['items'],
                $validated['site_engineer_notes'] ?? null,
            );
        } catch (\Illuminate\Auth\Access\AuthorizationException $exception) {
            return response()->json(['message' => $exception->getMessage()], 403);
        } catch (\RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 409);
        }

        return response()->json(['message' => 'تم حفظ تعديل إذن الاستلام ويمكن اعتماده وإرساله للحسابات.', 'data' => $updated]);
    }

    public function approve(Request $request, string|int $id)
    {
        $user = $request->user();
        $receipt = PurchaseReceipt::findOrFail((int) $id);
        if (! $this->canActOnFieldReceipt($user, $receipt, 'purchase_receipt.approve')) {
            return response()->json(['message' => 'غير مصرح للمحاسب العام أو المستخدم الحالي باعتماد أذونات الاستلام الميدانية.'], 403);
        }

        $validated = $request->validate([
            'site_engineer_notes' => ['nullable', 'string', 'max:3000'],
            'items' => ['nullable', 'array'],
            'items.*.id' => ['required_with:items', 'integer', 'exists:purchase_receipt_items,id'],
            'items.*.received_quantity' => ['required_with:items', 'numeric', 'gte:0'],
            'items.*.notes' => ['nullable', 'string', 'max:1000'],
        ]);

        try {
            if (! empty($validated['items'])) {
                $receipt = $this->service->updateBySiteEngineer(
                    $request->user(),
                    $receipt,
                    $validated['items'],
                    $validated['site_engineer_notes'] ?? null,
                );
            }

            $approved = $this->service->approveBySiteEngineer(
                $request->user(),
                $receipt,
                $validated['site_engineer_notes'] ?? null,
            );
        } catch (\Illuminate\Auth\Access\AuthorizationException $exception) {
            return response()->json(['message' => $exception->getMessage()], 403);
        } catch (\RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 409);
        }

        return response()->json(['message' => 'تم اعتماد إذن الاستلام وإرساله إلى الحسابات.', 'data' => $approved]);
    }

    /**
     * Field receipt edit/approve: role-based access, or the user the receipt is assigned to as
     * site engineer / receiver (e.g. an accountant who requested and receives their own order).
     * General accountants may act only on receipts assigned to them.
     */
    private function canActOnFieldReceipt($user, PurchaseReceipt $receipt, string $permission): bool
    {
        $isAssigned = in_array((int) $user->id, array_map('intval', array_filter([
            $receipt->site_engineer_user_id,
            $receipt->receiver_user_id,
        ])), true);
        if ($isAssigned) {
            // The order may sit outside the user's PO data scope (e.g. an accountant's own order
            // in another department); access is settled here, so load it unscoped for the workflow.
            if ($receipt->purchase_order_id) {
                $receipt->setRelation('purchaseOrder', PurchaseOrder::withoutGlobalScopes()->find($receipt->purchase_order_id));
            }

            return true;
        }
        if ($user->hasRole('general_accountant')) {
            return false;
        }

        return $user->hasRole('admin') || $user->hasRole('general_manager') || $user->hasPermission($permission)
            || ($user->hasRole('reviewer') && $user->hasPermission('purchase_request.review'));
    }

    public function confirmOfficeReceipt(Request $request, int $purchaseOrderId)
    {
        $validated = $request->validate([
            'notes' => ['nullable', 'string', 'max:3000'],
            'items' => ['nullable', 'array'],
            'items.*.purchase_order_item_id' => ['required_with:items', 'integer', 'exists:purchase_order_items,id'],
            'items.*.received_quantity' => ['required_with:items', 'numeric', 'gte:0'],
            'items.*.notes' => ['nullable', 'string', 'max:1000'],
        ]);

        $purchaseOrder = PurchaseOrder::findOrFail($purchaseOrderId);
        try {
            $receipt = $this->service->confirmByRequester(
                $request->user(),
                $purchaseOrder,
                $validated['items'] ?? [],
                $validated['notes'] ?? null,
            );
        } catch (\RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 409);
        }

        return response()->json([
            'message' => 'تم تأكيد استلام المستلزمات المكتبية بنجاح وإحالة الأمر لإدارة المشتريات لإصدار أمر الشراء الفعلي.',
            'data' => $receipt,
        ], 201);
    }

    public function viewPhoto(Request $request, string|int $id)
    {
        $user = $request->user() ?: auth('sanctum')->user();
        if (! $user && $request->filled('token')) {
            $tokenModel = \Laravel\Sanctum\PersonalAccessToken::findToken($request->query('token'));
            if ($tokenModel) {
                $user = $tokenModel->tokenable;
            }
        }

        if (! $user) {
            abort(401, 'انتهت جلسة الدخول. يرجى تسجيل الدخول أولاً.');
        }

        $receipt = PurchaseReceipt::withoutGlobalScopes()->with(['purchaseOrder.purchaseRequest.department', 'purchaseOrder.purchaseRequest.targetDepartment', 'purchaseRequest.department', 'purchaseRequest.targetDepartment'])->findOrFail((int) $id);

        // Departmental and Site Isolation:
        // Central roles have global oversight: admin, general_manager, procurement_manager, accountant, general_accountant, warehouse_keeper
        if (! $user->hasAnyRole(['admin', 'general_manager', 'procurement_manager', 'accountant', 'general_accountant', 'warehouse_keeper']) && ! $user->isGeneralAccountant()) {
            $po = $receipt->purchaseOrder ?: \App\Models\PurchaseOrder::withoutGlobalScopes()->with(['purchaseRequest.department', 'purchaseRequest.targetDepartment'])->find($receipt->purchase_order_id);
            $pr = $po?->purchaseRequest ?: ($receipt->purchaseRequest ?: \App\Models\PurchaseRequest::withoutGlobalScopes()->with(['department', 'targetDepartment'])->find($po?->purchase_request_id ?: $receipt->purchase_request_id));
            if ($pr) {
                if ($user->hasRole('site_accountant')) {
                    $allowedDepts = ['EXECUTION', 'FINISHING', 'BUILDINGS'];
                    $deptCode = $pr->department?->code ?: $pr->targetDepartment?->code;
                    if ($deptCode && ! in_array($deptCode, $allowedDepts, true)) {
                        abort(403, 'غير مصرح لك باستعراض صور استلام هذا القسم.');
                    }
                } elseif ($user->hasRole('licenses_accountant')) {
                    $deptCode = $pr->department?->code ?: $pr->targetDepartment?->code;
                    if ($deptCode !== 'LICENSES') {
                        abort(403, 'غير مصرح لك باستعراض صور استلام هذا القسم.');
                    }
                } elseif ($user->hasRole('buffet_accountant')) {
                    $deptCode = $pr->department?->code ?: $pr->targetDepartment?->code;
                    if ($deptCode !== 'BUFFET') {
                        abort(403, 'غير مصرح لك باستعراض صور استلام هذا القسم.');
                    }
                } elseif ($user->hasRole('development_accountant')) {
                    $deptCode = $pr->department?->code ?: $pr->targetDepartment?->code;
                    if (! in_array($deptCode, ['DEVELOPMENT', 'MARKETING', 'SALES'], true)) {
                        abort(403, 'غير مصرح لك باستعراض صور استلام هذا القسم.');
                    }
                } elseif ($user->hasRole('site_engineer')) {
                    if ($receipt->site_engineer_user_id && $receipt->site_engineer_user_id !== $user->id) {
                        abort(403, 'غير مصرح لك باستعراض استلام غير مسند إليك.');
                    }
                } elseif ($user->hasRole('reviewer')) {
                    if ($user->department_id !== $pr->department_id && $user->department_id !== $pr->target_department_id) {
                        abort(403, 'غير مصرح لك باستعراض استلامات أقسام أخرى.');
                    }
                }
            }
        }

        if (! $receipt->photo_path) {
            abort(404, 'لم يتم إرفاق صورة لهذا الإذن.');
        }

        // 1. If stored as Google Drive URL or File ID, stream securely via Drive API
        $driveId = $receipt->photo_drive_id ?: \App\Services\GoogleDriveService::extractFileId($receipt->photo_path);
        if ($driveId && \App\Services\GoogleDriveService::isConfigured()) {
            try {
                return \App\Services\GoogleDriveService::streamFile(
                    $driveId,
                    $receipt->photo_name ?: "receipt_{$receipt->id}.jpg",
                    $receipt->photo_mime_type ?: 'image/jpeg',
                    false
                );
            } catch (\Throwable $e) {
                \Illuminate\Support\Facades\Log::warning("Drive streaming failed for receipt {$receipt->id}: " . $e->getMessage());
                if (filter_var($receipt->photo_path, FILTER_VALIDATE_URL)) {
                    return redirect()->away($receipt->photo_path);
                }
            }
        }

        if (filter_var($receipt->photo_path, FILTER_VALIDATE_URL)) {
            return redirect()->away($receipt->photo_path);
        }

        try {
            return \App\Services\StorageService::streamResponse(
                $receipt->photo_path,
                $receipt->photo_name ?: "receipt_{$receipt->id}.jpg",
                $receipt->photo_mime_type ?: 'image/jpeg',
                false
            );
        } catch (\Throwable) {
            abort(404, 'ملف الصورة مفقود من الخادم القديم (تم حذفه في عملية نشر سابقة قبل ربط التخزين الدائم). يرجى إعادة إرفاق الصورة.');
        }
    }

    public function getAttachment(Request $request, string|int $id)
    {
        $user = $request->user() ?: auth('sanctum')->user();
        if (! $user && $request->filled('token')) {
            $tokenModel = \Laravel\Sanctum\PersonalAccessToken::findToken($request->query('token'));
            if ($tokenModel) {
                $user = $tokenModel->tokenable;
            }
        }

        if (! $user) {
            return response()->json(['success' => false, 'message' => 'انتهت جلسة الدخول. يرجى تسجيل الدخول أولاً.'], 401);
        }

        $receipt = PurchaseReceipt::withoutGlobalScopes()
            ->with([
                'supplier',
                'purchaseOrder.supplier',
                'purchaseOrder.purchaseRequest.department',
                'purchaseOrder.purchaseRequest.targetDepartment',
                'purchaseRequest.department',
                'purchaseRequest.targetDepartment'
            ])
            ->findOrFail((int) $id);

        // Security Authorization Check:
        $isGlobalRole = $user->hasAnyRole(['admin', 'general_manager', 'procurement_manager', 'accountant', 'general_accountant', 'warehouse_keeper']) || $user->isGeneralAccountant();

        $isAuthorized = $isGlobalRole;

        if (! $isAuthorized) {
            $po = $receipt->purchaseOrder;
            $pr = $po?->purchaseRequest ?: $receipt->purchaseRequest;

            if ($user->hasRole('site_engineer')) {
                $isAuthorized = ($receipt->site_engineer_user_id === $user->id || $receipt->receiver_user_id === $user->id);
            } elseif ($user->hasRole('reviewer') && $pr) {
                $isAuthorized = ($user->department_id === $pr->department_id || $user->department_id === $pr->target_department_id);
            } elseif ($pr && $pr->user_id === $user->id) {
                $isAuthorized = true;
            }
        }

        if (! $isAuthorized) {
            return response()->json([
                'success' => false,
                'message' => 'غير مصرح لك بالاطلاع على مرفق هذا الإذن.'
            ], 403);
        }

        if (! $receipt->photo_path) {
            return response()->json([
                'success' => false,
                'has_attachment' => false,
                'message' => 'لا توجد صورة مرفقة بهذا الإذن.'
            ], 404);
        }

        $supplierName = $receipt->supplier?->name ?: ($receipt->purchaseOrder?->supplier?->name ?: '—');
        $poNumber = $receipt->purchaseOrder?->po_number ?: '—';

        return response()->json([
            'success' => true,
            'has_attachment' => true,
            'attachment' => [
                'receipt_id' => $receipt->id,
                'receipt_number' => $receipt->receipt_number,
                'purchase_order_id' => $receipt->purchase_order_id,
                'po_number' => $poNumber,
                'supplier_name' => $supplierName,
                'received_at' => $receipt->received_at ? $receipt->received_at->format('Y-m-d') : null,
                'file_name' => $receipt->photo_name ?: "receipt_{$receipt->id}.jpg",
                'mime_type' => $receipt->photo_mime_type ?: 'image/jpeg',
                'file_size' => $receipt->photo_size,
                'view_url' => $receipt->photo_url,
                'drive_link' => filter_var($receipt->photo_path, FILTER_VALIDATE_URL) ? $receipt->photo_path : null,
                'uploaded_at' => $receipt->warehouse_submitted_at?->toIso8601String() ?: $receipt->created_at?->toIso8601String(),
            ]
        ]);
    }

    public function cancelPending(Request $request, int $receiptId)
    {
        $receipt = PurchaseReceipt::findOrFail($receiptId);
        try {
            $this->service->cancelPendingReceipt($request->user(), $receipt);
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        } catch (\Illuminate\Auth\Access\AuthorizationException $e) {
            return response()->json(['message' => $e->getMessage()], 403);
        }

        return response()->json(['message' => 'تم إلغاء إذن الاستلام بنجاح وإعادة أمر الشراء لطابور التوريد.']);
    }
}
