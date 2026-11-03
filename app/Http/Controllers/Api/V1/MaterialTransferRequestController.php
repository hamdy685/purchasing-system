<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Resources\MaterialTransferRequestResource;
use App\Models\MaterialTransferRequest;
use App\Services\MaterialTransferRequestService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Throwable;

class MaterialTransferRequestController extends Controller
{
    public function __construct(
        protected MaterialTransferRequestService $service
    ) {}

    /**
     * Display a listing of user's own transfer requests.
     */
    public function index(Request $request): JsonResponse
    {
        $paginated = $this->service->getOwnRequests($request->user(), $request->all());

        return response()->json([
            'data' => MaterialTransferRequestResource::collection($paginated->items()),
            'meta' => [
                'current_page' => $paginated->currentPage(),
                'last_page' => $paginated->lastPage(),
                'per_page' => $paginated->perPage(),
                'total' => $paginated->total(),
            ],
        ]);
    }

    /**
     * Store a newly created material transfer request.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'transfer_date' => 'required|date',
            'from_project' => 'required|string|max:255',
            'to_project' => 'required|string|max:255',
            'driver_name' => 'nullable|string|max:255',
            'vehicle_plate_number' => 'nullable|string|max:100',
            'general_notes' => 'nullable|string',
            'reviewer_id' => 'nullable|integer',
            'is_draft' => 'boolean',
            'items' => 'required|array|min:1',
            'items.*.item_description' => 'required|string|max:255',
            'items.*.uom' => 'required|string|max:50',
            'items.*.quantity' => 'required|numeric|min:0.01',
            'items.*.notes' => 'nullable|string|max:500',
        ]);

        $isSubmit = ! ($request->boolean('is_draft', false));

        try {
            $created = $this->service->createRequest($request->user(), $validated, $isSubmit);

            return response()->json([
                'message' => $isSubmit ? 'تم إنشاء وإرسال طلب نقل الخامات بنجاح.' : 'تم حفظ مسودة طلب نقل الخامات بنجاح.',
                'data' => new MaterialTransferRequestResource($created),
            ], 201);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /**
     * Display the specified transfer request.
     */
    public function show(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::with(['user', 'reviewer', 'accountant', 'items'])->findOrFail($id);

        $user = $request->user();
        $isOwner = (int) $item->user_id === (int) $user->id;
        $isAuthorizedRole = $user->hasAnyRole(['reviewer', 'accountant', 'site_accountant', 'general_accountant', 'admin', 'general_manager', 'execution_manager']);

        if (! $isOwner && ! $isAuthorizedRole) {
            return response()->json(['message' => 'غير مصرح لك باستعراض هذا الطلب.'], 403);
        }

        return response()->json([
            'data' => new MaterialTransferRequestResource($item),
        ]);
    }

    /**
     * Update the specified transfer request (DRAFT or RETURNED).
     */
    public function update(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::findOrFail($id);

        $validated = $request->validate([
            'transfer_date' => 'sometimes|required|date',
            'from_project' => 'sometimes|required|string|max:255',
            'to_project' => 'sometimes|required|string|max:255',
            'driver_name' => 'nullable|string|max:255',
            'vehicle_plate_number' => 'nullable|string|max:100',
            'general_notes' => 'nullable|string',
            'reviewer_id' => 'nullable|integer',
            'is_draft' => 'boolean',
            'items' => 'sometimes|required|array|min:1',
            'items.*.item_description' => 'required|string|max:255',
            'items.*.uom' => 'required|string|max:50',
            'items.*.quantity' => 'required|numeric|min:0.01',
            'items.*.notes' => 'nullable|string|max:500',
        ]);

        $isSubmit = ! ($request->boolean('is_draft', true));

        try {
            $updated = $this->service->updateRequest($item, $request->user(), $validated, $isSubmit);

            return response()->json([
                'message' => 'تم تحديث بيانات طلب نقل الخامات بنجاح.',
                'data' => new MaterialTransferRequestResource($updated),
            ]);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /**
     * Submit a draft or returned request.
     */
    public function submit(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::findOrFail($id);

        try {
            $submitted = $this->service->submitRequest($item, $request->user());

            return response()->json([
                'message' => 'تم إرسال طلب نقل الخامات بنجاح.',
                'data' => new MaterialTransferRequestResource($submitted),
            ]);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /**
     * Remove the specified draft request.
     */
    public function destroy(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::findOrFail($id);
        $user = $request->user();

        if (! $item->canBeEditedBy($user) && ! $user->hasRole('admin')) {
            return response()->json(['message' => 'لا يمكنك حذف هذا الطلب.'], 403);
        }

        if (! in_array($item->status, [MaterialTransferRequest::STATUS_DRAFT, MaterialTransferRequest::STATUS_RETURNED], true) && ! $user->hasRole('admin')) {
            return response()->json(['message' => 'لا يمكن حذف طلب تم إرساله.'], 422);
        }

        $item->delete();

        return response()->json(['message' => 'تم حذف الطلب بنجاح.']);
    }

    /**
     * Reviewer Queue: Get requests pending review.
     */
    public function reviewerIndex(Request $request): JsonResponse
    {
        $user = $request->user();
        if (! $user->hasAnyRole(['reviewer', 'admin', 'general_manager', 'execution_manager'])) {
            return response()->json(['message' => 'غير مصرح.'], 403);
        }

        $paginated = $this->service->getPendingReviewerRequests($user, $request->all());

        return response()->json([
            'data' => MaterialTransferRequestResource::collection($paginated->items()),
            'meta' => [
                'current_page' => $paginated->currentPage(),
                'last_page' => $paginated->lastPage(),
                'per_page' => $paginated->perPage(),
                'total' => $paginated->total(),
            ],
        ]);
    }

    /**
     * Reviewer approves the request.
     */
    public function reviewerApprove(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::findOrFail($id);
        $validated = $request->validate([
            'notes' => 'nullable|string|max:1000',
        ]);

        try {
            $approved = $this->service->approveByReviewer($item, $request->user(), $validated['notes'] ?? null);

            return response()->json([
                'message' => 'تم اعتماد طلب نقل الخامات وإحالته مباشرة إلى الحسابات بنجاح.',
                'data' => new MaterialTransferRequestResource($approved),
            ]);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /**
     * Reviewer rejects the request.
     */
    public function reviewerReject(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::findOrFail($id);
        $validated = $request->validate([
            'rejection_reason' => 'required|string|max:1000',
        ]);

        try {
            $rejected = $this->service->rejectByReviewer($item, $request->user(), $validated['rejection_reason']);

            return response()->json([
                'message' => 'تم رفض طلب نقل الخامات.',
                'data' => new MaterialTransferRequestResource($rejected),
            ]);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /**
     * Reviewer returns the request for modification.
     */
    public function reviewerReturn(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::findOrFail($id);
        $validated = $request->validate([
            'return_reason' => 'required|string|max:1000',
        ]);

        try {
            $returned = $this->service->returnByReviewer($item, $request->user(), $validated['return_reason']);

            return response()->json([
                'message' => 'تمت إعادة طلب نقل الخامات للمهندس مقدم الطلب للتعديل.',
                'data' => new MaterialTransferRequestResource($returned),
            ]);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /**
     * Accounting Queue: Get requests pending accounting action.
     */
    public function accountingIndex(Request $request): JsonResponse
    {
        $user = $request->user();
        if (! $user->hasAnyRole(['accountant', 'site_accountant', 'general_accountant', 'admin'])) {
            return response()->json(['message' => 'غير مصرح.'], 403);
        }

        $paginated = $this->service->getPendingAccountingRequests($user, $request->all());

        return response()->json([
            'data' => MaterialTransferRequestResource::collection($paginated->items()),
            'meta' => [
                'current_page' => $paginated->currentPage(),
                'last_page' => $paginated->lastPage(),
                'per_page' => $paginated->perPage(),
                'total' => $paginated->total(),
            ],
        ]);
    }

    /**
     * Accounting: Process and archive the transfer request.
     */
    public function accountingProcessAndArchive(Request $request, int $id): JsonResponse
    {
        $item = MaterialTransferRequest::findOrFail($id);
        $validated = $request->validate([
            'accounting_notes' => 'nullable|string|max:1000',
        ]);

        try {
            $archived = $this->service->processAndArchiveByAccountant(
                $item,
                $request->user(),
                $validated['accounting_notes'] ?? null
            );

            return response()->json([
                'message' => 'تمت المعالجة المحاسبية وأرشفة طلب نقل الخامات بنجاح إلى أرشيف المنقولات.',
                'data' => new MaterialTransferRequestResource($archived),
            ]);
        } catch (Throwable $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }

    /**
     * Transfer Archive: List all archived transfer requests.
     */
    public function archiveIndex(Request $request): JsonResponse
    {
        $paginated = $this->service->getArchivedRequests($request->all());

        return response()->json([
            'data' => MaterialTransferRequestResource::collection($paginated->items()),
            'meta' => [
                'current_page' => $paginated->currentPage(),
                'last_page' => $paginated->lastPage(),
                'per_page' => $paginated->perPage(),
                'total' => $paginated->total(),
            ],
        ]);
    }
}
