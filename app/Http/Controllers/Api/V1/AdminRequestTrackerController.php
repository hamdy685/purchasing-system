<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\ApprovalHistory;
use App\Models\PurchaseOrder;
use App\Models\PurchaseRequest;
use App\Models\SystemEvent;
use App\Models\User;
use App\Services\SystemEventService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Carbon\Carbon;

class AdminRequestTrackerController extends Controller
{
    /**
     * Map a purchase-request status to the role/user currently responsible.
     */
    private function resolveCurrentResponsible(PurchaseRequest $pr): ?array
    {
        return match ($pr->status) {
            'DRAFT' => $pr->requester ? [
                'id'   => $pr->requester->id,
                'name' => $pr->requester->name,
                'role' => 'مقدم الطلب',
            ] : null,

            'SUBMITTED', 'UNDER_REVIEW' => $pr->assignedReviewer ? [
                'id'   => $pr->assignedReviewer->id,
                'name' => $pr->assignedReviewer->name,
                'role' => 'المراجع',
            ] : null,

            'PENDING_EXECUTIVE_APPROVAL', 'PENDING_EXECUTIVE_QUOTE_DECISION' => (
                $pr->requester?->manager && $pr->requester->manager->hasRole('execution_manager')
                    ? [
                        'id'   => $pr->requester->manager->id,
                        'name' => $pr->requester->manager->name,
                        'role' => 'مدير مشروعات التنفيذ',
                    ]
                    : $this->firstUserWithRole('general_manager')
            ),

            'PENDING_PROCUREMENT_APPROVAL', 'APPROVED_BY_ACCOUNTING',
            'APPROVED_BY_PROCUREMENT', 'PENDING_QUOTE_RECOMMENDATIONS' => $this->firstUserWithRole('procurement_manager'),

            'PENDING_ACCOUNTING_APPROVAL' => $this->firstUserWithRole('accountant'),

            'ISSUED' => $pr->siteEngineer ? [
                'id'   => $pr->siteEngineer->id,
                'name' => $pr->siteEngineer->name,
                'role' => 'مهندس الموقع / أمين المخزن',
            ] : null,

            default => null,
        };
    }

    private function firstUserWithRole(string $roleSlug): ?array
    {
        static $cache = [];
        if (isset($cache[$roleSlug])) {
            return $cache[$roleSlug];
        }

        $user = User::whereHas('roles', fn ($q) => $q->where('slug', $roleSlug))
            ->select('id', 'name')
            ->first();

        $roleLabelMap = [
            'general_manager'     => 'المدير التنفيذي',
            'procurement_manager' => 'مدير المشتريات',
            'accountant'          => 'المدير المالي',
        ];

        $result = $user ? [
            'id'   => $user->id,
            'name' => $user->name,
            'role' => $roleLabelMap[$roleSlug] ?? $roleSlug,
        ] : null;

        $cache[$roleSlug] = $result;
        return $result;
    }

    /**
     * Classify a status into a workflow "stage" for grouping.
     */
    private function statusStage(string $status): string
    {
        return match ($status) {
            'DRAFT'                            => 'creation',
            'SUBMITTED', 'UNDER_REVIEW'        => 'review',
            'PENDING_EXECUTIVE_APPROVAL'       => 'executive',
            'PENDING_PROCUREMENT_APPROVAL',
            'APPROVED_BY_PROCUREMENT'          => 'procurement',
            'PENDING_QUOTE_RECOMMENDATIONS',
            'PENDING_EXECUTIVE_QUOTE_DECISION' => 'quotes',
            'PENDING_ACCOUNTING_APPROVAL',
            'APPROVED_BY_ACCOUNTING'           => 'accounting',
            'ISSUED'                           => 'issued',
            'REJECTED'                         => 'rejected',
            'CANCELLED'                        => 'cancelled',
            default                            => 'unknown',
        };
    }

    /**
     * Calculate how many days the PR has been in the current stage.
     */
    private function daysInCurrentStage(PurchaseRequest $pr): int
    {
        return (int) Carbon::parse($pr->updated_at)->diffInDays(now());
    }

    // ─────────────────────────────────────────────────────────
    // INDEX — paginated list of all purchase requests
    // ─────────────────────────────────────────────────────────
    public function index(Request $request): JsonResponse
    {
        $query = PurchaseRequest::with([
            'requester:id,name',
            'department:id,name,code',
            'assignedReviewer:id,name',
            'siteEngineer:id,name',
            'landParcel:id,parcel_reference,region',
        ]);

        // ── Filters ──
        if ($status = $request->query('status')) {
            $query->where('status', $status);
        }

        if ($stage = $request->query('stage')) {
            $statusesForStage = $this->statusesForStage($stage);
            if ($statusesForStage) {
                $query->whereIn('status', $statusesForStage);
            }
        }

        if ($departmentId = $request->query('department_id')) {
            $query->where('department_id', $departmentId);
        }

        if ($requestType = $request->query('request_type')) {
            $query->where('request_type', $requestType);
        }

        if ($priority = $request->query('priority')) {
            $query->where('priority', $priority);
        }

        if ($search = $request->query('search')) {
            $query->where(function ($q) use ($search) {
                $q->where('request_number', 'LIKE', "%{$search}%")
                  ->orWhere('notes', 'LIKE', "%{$search}%")
                  ->orWhereHas('requester', fn ($q2) => $q2->where('name', 'LIKE', "%{$search}%"));
            });
        }

        // Stalled filter: PRs that haven't been updated for N days
        if ($stalledDays = $request->query('stalled_days')) {
            $threshold = now()->subDays((int) $stalledDays);
            $query->where('updated_at', '<', $threshold)
                  ->whereNotIn('status', ['ISSUED', 'REJECTED', 'CANCELLED']);
        }

        // Include archived (soft-deleted)
        if ($request->boolean('include_archived')) {
            $query->withTrashed();
        }

        // Sort
        $sortField = $request->query('sort', 'updated_at');
        $sortDir   = $request->query('dir', 'desc');
        $allowedSort = ['created_at', 'updated_at', 'request_number', 'status', 'priority', 'total_estimated_cost'];
        if (in_array($sortField, $allowedSort, true)) {
            $query->orderBy($sortField, $sortDir === 'asc' ? 'asc' : 'desc');
        } else {
            $query->latest('updated_at');
        }

        $perPage = min((int) ($request->query('per_page', 20)), 100);
        $paginated = $query->paginate($perPage);

        $items = $paginated->getCollection()->map(fn (PurchaseRequest $pr) => $this->formatPrSummary($pr));

        return response()->json([
            'data' => $items,
            'meta' => [
                'current_page' => $paginated->currentPage(),
                'last_page'    => $paginated->lastPage(),
                'per_page'     => $paginated->perPage(),
                'from'         => $paginated->firstItem(),
                'to'           => $paginated->lastItem(),
                'total'        => $paginated->total(),
            ],
        ]);
    }

    // ─────────────────────────────────────────────────────────
    // STATS — quick summary counts
    // ─────────────────────────────────────────────────────────
    public function stats(): JsonResponse
    {
        $byStatus = PurchaseRequest::selectRaw('status, COUNT(*) as count')
            ->groupBy('status')
            ->pluck('count', 'status');

        $total       = $byStatus->sum();
        $activeStatuses = ['SUBMITTED', 'UNDER_REVIEW', 'PENDING_EXECUTIVE_APPROVAL', 'PENDING_PROCUREMENT_APPROVAL', 'PENDING_ACCOUNTING_APPROVAL', 'APPROVED_BY_ACCOUNTING', 'PENDING_QUOTE_RECOMMENDATIONS', 'PENDING_EXECUTIVE_QUOTE_DECISION', 'APPROVED_BY_PROCUREMENT'];
        $active      = $byStatus->only($activeStatuses)->sum();
        $completed   = ($byStatus->get('ISSUED', 0));
        $rejected    = ($byStatus->get('REJECTED', 0));
        $drafts      = ($byStatus->get('DRAFT', 0));

        // Count stalled (>3 days without update, excluding terminal statuses)
        $stalled = PurchaseRequest::whereIn('status', $activeStatuses)
            ->where('updated_at', '<', now()->subDays(3))
            ->count();

        return response()->json([
            'data' => [
                'total'     => $total,
                'active'    => $active,
                'completed' => $completed,
                'rejected'  => $rejected,
                'drafts'    => $drafts,
                'stalled'   => $stalled,
                'by_status' => $byStatus,
            ],
        ]);
    }

    // ─────────────────────────────────────────────────────────
    // SHOW — full details for a single purchase request
    // ─────────────────────────────────────────────────────────
    public function show(int $id): JsonResponse
    {
        $pr = PurchaseRequest::withTrashed()
            ->with([
                'requester:id,name,email',
                'department:id,name,code',
                'targetDepartment:id,name,code',
                'assignedReviewer:id,name,email',
                'siteEngineer:id,name,email',
                'landParcel:id,parcel_reference,region',
                'items.item:id,name,sku',
                'purchaseOrders:id,po_number,status,grand_total,supplier_id,created_at',
                'purchaseOrders.supplier:id,company_name',
                'purchaseOrders.receipts:id,purchase_order_id,receipt_number,status',
                'approvalHistory.actor:id,name',
                'directSupplier:id,company_name',
            ])
            ->findOrFail($id);

        // Get system events for this PR
        $events = SystemEvent::where('entity_type', PurchaseRequest::class)
            ->where('entity_id', $id)
            ->with('actor:id,name')
            ->orderBy('occurred_at', 'desc')
            ->limit(50)
            ->get()
            ->map(fn (SystemEvent $e) => [
                'id'           => $e->id,
                'event_type'   => $e->event_type,
                'action'       => $e->action,
                'from_state'   => $e->from_state,
                'to_state'     => $e->to_state,
                'description'  => $e->description,
                'actor'        => $e->actor ? ['id' => $e->actor->id, 'name' => $e->actor->name] : null,
                'occurred_at'  => $e->occurred_at?->toIso8601String(),
            ]);

        $data = [
            'id'                    => $pr->id,
            'request_number'        => $pr->request_number,
            'request_type'          => $pr->request_type,
            'procurement_route'     => $pr->procurement_route,
            'status'                => $pr->status,
            'stage'                 => $this->statusStage($pr->status),
            'priority'              => $pr->priority,
            'parcel_reference'      => $pr->parcel_reference,
            'region'                => $pr->region,
            'total_estimated_cost'  => $pr->total_estimated_cost,
            'date_needed'           => $pr->date_needed?->toDateString(),
            'notes'                 => $pr->notes,
            'rejection_reason'      => $pr->rejection_reason,
            'return_reason'         => $pr->return_reason,
            'is_archived'           => $pr->trashed(),
            'days_in_stage'         => $this->daysInCurrentStage($pr),
            'current_responsible'   => $this->resolveCurrentResponsible($pr),
            'requester'             => $pr->requester ? ['id' => $pr->requester->id, 'name' => $pr->requester->name, 'email' => $pr->requester->email] : null,
            'department'            => $pr->department ? ['id' => $pr->department->id, 'name' => $pr->department->name, 'code' => $pr->department->code] : null,
            'target_department'     => $pr->targetDepartment ? ['id' => $pr->targetDepartment->id, 'name' => $pr->targetDepartment->name] : null,
            'assigned_reviewer'     => $pr->assignedReviewer ? ['id' => $pr->assignedReviewer->id, 'name' => $pr->assignedReviewer->name] : null,
            'site_engineer'         => $pr->siteEngineer ? ['id' => $pr->siteEngineer->id, 'name' => $pr->siteEngineer->name] : null,
            'land_parcel'           => $pr->landParcel ? ['id' => $pr->landParcel->id, 'name' => $pr->landParcel->parcel_reference . ($pr->landParcel->region ? " ({$pr->landParcel->region})" : '')] : null,
            'direct_supplier'       => $pr->directSupplier ? ['id' => $pr->directSupplier->id, 'name' => $pr->directSupplier->company_name] : null,
            'items'                 => $pr->items->map(fn ($item) => [
                'id'               => $item->id,
                'item_description' => $item->item_description ?? $item->item?->name ?? '-',
                'quantity'         => $item->quantity,
                'uom'              => $item->uom,
                'estimated_price'  => $item->estimated_price,
                'specifications'   => $item->specifications,
            ]),
            'purchase_orders'       => $pr->purchaseOrders->map(fn (PurchaseOrder $po) => [
                'id'           => $po->id,
                'po_number'    => $po->po_number,
                'status'       => $po->status,
                'grand_total'  => $po->grand_total,
                'supplier'     => $po->supplier?->company_name,
                'created_at'   => $po->created_at?->toIso8601String(),
                'has_receipts' => $po->receipts->isNotEmpty(),
            ]),
            'approval_history'      => $pr->approvalHistory->map(fn (ApprovalHistory $ah) => [
                'action'     => $ah->action,
                'from_state' => $ah->from_state,
                'to_state'   => $ah->to_state,
                'comments'   => $ah->comments,
                'actor'      => $ah->actor ? ['id' => $ah->actor->id, 'name' => $ah->actor->name] : null,
                'created_at' => $ah->created_at?->toIso8601String(),
            ]),
            'system_events'         => $events,
            'created_at'            => $pr->created_at?->toIso8601String(),
            'updated_at'            => $pr->updated_at?->toIso8601String(),
            'submitted_at'          => $pr->submitted_at?->toIso8601String(),
            'deleted_at'            => $pr->deleted_at?->toIso8601String(),
        ];

        // Admin action constraints
        $hasIssuedPo   = $pr->purchaseOrders->where('status', 'ISSUED')->isNotEmpty();
        $hasReceipts   = $pr->purchaseOrders->flatMap->receipts->isNotEmpty();

        $data['admin_actions'] = [
            'can_cancel'  => ! in_array($pr->status, ['CANCELLED']) && ! $pr->trashed(),
            'can_archive' => $pr->status === 'DRAFT' && ! $pr->trashed(),
            'can_restore' => $pr->trashed(),
            'can_reopen'  => in_array($pr->status, ['REJECTED', 'CANCELLED']),
            'has_linked_po'       => $pr->purchaseOrders->isNotEmpty(),
            'has_issued_po'       => $hasIssuedPo,
            'has_linked_receipts' => $hasReceipts,
            'cancel_warning'      => $hasIssuedPo ? 'هذا الطلب مرتبط بأمر شراء صادر — الإلغاء سيكون مرئياً فقط ولن يؤثر على أمر الشراء.' : null,
        ];

        return response()->json(['data' => $data]);
    }

    // ─────────────────────────────────────────────────────────
    // CANCEL — set status to CANCELLED + record audit
    // ─────────────────────────────────────────────────────────
    public function cancel(Request $request, int $id): JsonResponse
    {
        $request->validate([
            'reason' => 'required|string|min:5|max:500',
        ], [
            'reason.required' => 'سبب الإلغاء مطلوب.',
            'reason.min'      => 'سبب الإلغاء يجب أن لا يقل عن 5 حروف.',
        ]);

        $pr = PurchaseRequest::findOrFail($id);

        if ($pr->status === 'CANCELLED') {
            return response()->json(['message' => 'الطلب ملغي بالفعل.'], 422);
        }

        $previousStatus = $pr->status;
        $admin = Auth::user();

        DB::transaction(function () use ($pr, $request, $previousStatus, $admin) {
            $pr->update([
                'status'           => 'CANCELLED',
                'rejection_reason' => $request->input('reason'),
            ]);

            ApprovalHistory::create([
                'target_type'   => PurchaseRequest::class,
                'target_id'     => $pr->id,
                'actor_user_id' => $admin->id,
                'action'        => 'ADMIN_CANCELLED',
                'from_state'    => $previousStatus,
                'to_state'      => 'CANCELLED',
                'user_note'      => ApprovalHistory::typedNote($request->input('reason')),
                'comments'      => $request->input('reason'),
            ]);

            app(SystemEventService::class)->recordAction($pr, 'ADMIN_CANCELLED', 'تم إلغاء الطلب إدارياً بواسطة ' . $admin->name, [
                'from_state' => $previousStatus,
                'to_state'   => 'CANCELLED',
                'metadata'   => ['reason' => $request->input('reason'), 'admin_id' => $admin->id],
            ]);
        });

        return response()->json(['message' => 'تم إلغاء الطلب بنجاح.']);
    }

    // ─────────────────────────────────────────────────────────
    // ARCHIVE — soft-delete a DRAFT PR
    // ─────────────────────────────────────────────────────────
    public function archive(Request $request, int $id): JsonResponse
    {
        $pr = PurchaseRequest::findOrFail($id);

        if ($pr->status !== 'DRAFT') {
            return response()->json(['message' => 'الأرشفة متاحة فقط للطلبات المسودة.'], 422);
        }

        $admin = Auth::user();

        DB::transaction(function () use ($pr, $admin, $request) {
            $pr->delete(); // SoftDeletes → sets deleted_at

            app(SystemEventService::class)->recordAction($pr, 'ADMIN_ARCHIVED', 'تم أرشفة الطلب إدارياً بواسطة ' . $admin->name, [
                'metadata' => ['reason' => $request->input('reason'), 'admin_id' => $admin->id],
            ]);
        });

        return response()->json(['message' => 'تم أرشفة الطلب بنجاح.']);
    }

    // ─────────────────────────────────────────────────────────
    // RESTORE — un-soft-delete a PR
    // ─────────────────────────────────────────────────────────
    public function restore(int $id): JsonResponse
    {
        $pr = PurchaseRequest::withTrashed()->findOrFail($id);

        if (! $pr->trashed()) {
            return response()->json(['message' => 'الطلب غير مؤرشف.'], 422);
        }

        $admin = Auth::user();

        DB::transaction(function () use ($pr, $admin) {
            $pr->restore();

            app(SystemEventService::class)->recordAction($pr, 'ADMIN_RESTORED', 'تم استعادة الطلب إدارياً بواسطة ' . $admin->name, [
                'metadata' => ['admin_id' => $admin->id],
            ]);
        });

        return response()->json(['message' => 'تم استعادة الطلب بنجاح.']);
    }

    // ─────────────────────────────────────────────────────────
    // REOPEN — unreject/reopen a REJECTED or CANCELLED PR
    // ─────────────────────────────────────────────────────────
    public function reopen(Request $request, int $id): JsonResponse
    {
        $pr = PurchaseRequest::withTrashed()->findOrFail($id);

        if (! in_array($pr->status, ['REJECTED', 'CANCELLED'], true)) {
            return response()->json(['message' => 'إعادة الفتح متاحة فقط للطلبات المرفوضة أو الملغاة.'], 422);
        }

        $targetStatus = (string) $request->input('target_status', 'PENDING_PROCUREMENT_APPROVAL');
        $validStatuses = [
            'DRAFT',
            'SUBMITTED',
            'PENDING_EXECUTIVE_APPROVAL',
            'PENDING_PROCUREMENT_APPROVAL',
            'APPROVED_BY_PROCUREMENT',
            'PENDING_ACCOUNTING_APPROVAL',
        ];

        if (! in_array($targetStatus, $validStatuses, true)) {
            $targetStatus = 'PENDING_PROCUREMENT_APPROVAL';
        }

        $admin = Auth::user();
        $reason = $request->input('reason', 'تم إلغاء الرفض وإعادة فتح الطلب واستئناف الدورة إدارياً');

        DB::transaction(function () use ($pr, $admin, $targetStatus, $reason) {
            $fromStatus = $pr->status;
            $pr->status = $targetStatus;
            $pr->rejection_reason = null;
            if ($targetStatus === 'PENDING_PROCUREMENT_APPROVAL') {
                $pr->procurement_route = 'UNDECIDED';
            }
            if ($pr->trashed()) {
                $pr->restore();
            }
            $pr->save();

            ApprovalHistory::create([
                'target_type'   => PurchaseRequest::class,
                'target_id'     => $pr->id,
                'actor_user_id' => $admin->id,
                'action'        => 'ADMIN_REOPENED',
                'from_state'    => $fromStatus,
                'to_state'      => $targetStatus,
                'user_note'      => ApprovalHistory::typedNote($reason),
                'comments'      => $reason,
            ]);

            app(SystemEventService::class)->recordAction($pr, 'ADMIN_REOPENED', $reason . ' بواسطة ' . $admin->name, [
                'event_type' => 'purchase_request.reopened',
                'from_state' => $fromStatus,
                'to_state'   => $targetStatus,
                'metadata'   => ['admin_id' => $admin->id, 'reason' => $reason],
            ]);
        });

        return response()->json([
            'message' => 'تم إلغاء الرفض وإعادة الطلب بنجاح إلى مرحلة: ' . $targetStatus,
            'status'  => $targetStatus,
        ]);
    }

    // ─────────────────────────────────────────────────────────
    // ADD NOTE — add an admin note as a system event
    // ─────────────────────────────────────────────────────────
    public function addNote(Request $request, int $id): JsonResponse
    {
        $request->validate([
            'note' => 'required|string|min:3|max:1000',
        ], [
            'note.required' => 'الملاحظة مطلوبة.',
        ]);

        $pr = PurchaseRequest::withTrashed()->findOrFail($id);
        $admin = Auth::user();

        app(SystemEventService::class)->recordAction($pr, 'ADMIN_NOTE', $request->input('note'), [
            'event_type' => 'admin.note',
            'metadata'   => ['admin_id' => $admin->id, 'admin_name' => $admin->name],
        ]);

        return response()->json(['message' => 'تم إضافة الملاحظة بنجاح.']);
    }

    // ─────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────
    private function formatPrSummary(PurchaseRequest $pr): array
    {
        return [
            'id'                  => $pr->id,
            'request_number'      => $pr->request_number,
            'request_type'        => $pr->request_type,
            'procurement_route'   => $pr->procurement_route,
            'status'              => $pr->status,
            'stage'               => $this->statusStage($pr->status),
            'priority'            => $pr->priority,
            'parcel_reference'    => $pr->parcel_reference ?? $pr->landParcel?->parcel_reference,
            'region'              => $pr->region ?? $pr->landParcel?->region,
            'total_estimated_cost' => $pr->total_estimated_cost,
            'is_archived'         => $pr->trashed(),
            'days_in_stage'       => $this->daysInCurrentStage($pr),
            'current_responsible' => $this->resolveCurrentResponsible($pr),
            'requester'           => $pr->requester ? ['id' => $pr->requester->id, 'name' => $pr->requester->name] : null,
            'department'          => $pr->department ? ['id' => $pr->department->id, 'name' => $pr->department->name, 'code' => $pr->department->code] : null,
            'assigned_reviewer'   => $pr->assignedReviewer ? ['id' => $pr->assignedReviewer->id, 'name' => $pr->assignedReviewer->name] : null,
            'land_parcel'         => $pr->landParcel ? ['id' => $pr->landParcel->id, 'name' => $pr->landParcel->parcel_reference . ($pr->landParcel->region ? " ({$pr->landParcel->region})" : '')] : null,
            'created_at'          => $pr->created_at?->toIso8601String(),
            'updated_at'          => $pr->updated_at?->toIso8601String(),
        ];
    }

    private function statusesForStage(string $stage): ?array
    {
        return match ($stage) {
            'creation'    => ['DRAFT'],
            'review'      => ['SUBMITTED', 'UNDER_REVIEW'],
            'executive'   => ['PENDING_EXECUTIVE_APPROVAL'],
            'procurement' => ['PENDING_PROCUREMENT_APPROVAL', 'APPROVED_BY_PROCUREMENT'],
            'quotes'      => ['PENDING_QUOTE_RECOMMENDATIONS', 'PENDING_EXECUTIVE_QUOTE_DECISION'],
            'accounting'  => ['PENDING_ACCOUNTING_APPROVAL', 'APPROVED_BY_ACCOUNTING'],
            'issued'      => ['ISSUED'],
            'rejected'    => ['REJECTED'],
            'cancelled'   => ['CANCELLED'],
            default       => null,
        };
    }
}
