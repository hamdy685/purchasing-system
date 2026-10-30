<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\ApprovalHistory;
use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseReceiptItem;
use App\Models\PurchaseRequest;
use App\Models\Supplier;
use App\Models\SystemEvent;
use App\Services\AdminRequestStageService;
use App\Services\SystemEventService;
use Carbon\Carbon;
use Carbon\CarbonInterface;
use DateTimeInterface;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;
use Throwable;

class AdminMasterOrdersController extends Controller
{
    /**
     * Format any date value safely without throwing on strings or nulls.
     */
    private static function formatDateSafely(mixed $date): ?string
    {
        if (empty($date)) {
            return null;
        }

        if ($date instanceof CarbonInterface || $date instanceof DateTimeInterface) {
            return $date->toDateString();
        }

        if (is_string($date)) {
            return substr($date, 0, 10);
        }

        try {
            return Carbon::parse($date)->toDateString();
        } catch (Throwable) {
            return (string) $date;
        }
    }

    /**
     * Format any datetime value safely to ISO-8601 string.
     */
    private static function formatDateTimeSafely(mixed $datetime): ?string
    {
        if (empty($datetime)) {
            return null;
        }

        if ($datetime instanceof CarbonInterface || $datetime instanceof DateTimeInterface) {
            return $datetime->toIso8601String();
        }

        try {
            return Carbon::parse($datetime)->toIso8601String();
        } catch (Throwable) {
            return (string) $datetime;
        }
    }

    /**
     * Resolve the normalized procurement cycle stage for an order (or standalone request).
     * Uses in-memory collection inspections when relations are already eager-loaded to avoid N+1 queries.
     */
    public static function resolveCycleStage(?PurchaseOrder $po, ?PurchaseRequest $pr): array
    {
        // 1. Rejected or Cancelled
        if ($po && in_array($po->status, ['REJECTED', 'CANCELLED', 'VOIDED'], true)) {
            return [
                'stage' => 'CANCELLED_OR_REJECTED',
                'label' => 'ملغي / مرفوض',
                'color' => 'rose',
                'description' => 'تم رفض أو إلغاء أمر الشراء',
                'responsible' => 'مدير النظام / إدارة المشتريات',
            ];
        }

        if (! $po && $pr && in_array($pr->status, ['REJECTED', 'CANCELLED'], true)) {
            return [
                'stage' => 'CANCELLED_OR_REJECTED',
                'label' => 'طلب ملغي / مرفوض',
                'color' => 'rose',
                'description' => 'تم رفض أو إلغاء طلب الشراء',
                'responsible' => 'مقدم الطلب / المدير التنفيذي',
            ];
        }

        // 2. Invoiced / Settled in Accounting
        $hasInvoice = false;
        if ($po) {
            if ($po->relationLoaded('supplierInvoices')) {
                $hasInvoice = $po->supplierInvoices->contains(fn ($inv) => ! in_array($inv->status, ['VOIDED', 'CANCELLED'], true));
            } else {
                $hasInvoice = $po->supplierInvoices()->whereNotIn('status', ['VOIDED', 'CANCELLED'])->exists();
            }
        }

        $isAccountingApproved = $po && in_array($po->status, ['APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'], true);
        if ($hasInvoice || $isAccountingApproved) {
            return [
                'stage' => 'INVOICED',
                'label' => 'مسقط ومسجل بالحسابات',
                'color' => 'emerald',
                'description' => 'الفاتورة مسجلة ومطابقة ومحسوبة بالحسابات',
                'responsible' => 'الإدارة المالية والحسابات',
            ];
        }

        // 3. Actual PO Issued & Finalized
        $isActualPo = $po ? $po->isActualPo() : false;

        if ($isActualPo) {
            return [
                'stage' => 'ACTUAL_PO_ISSUED',
                'label' => 'أمر شراء فعلي معتمد',
                'color' => 'cyan',
                'description' => 'تم اعتماد أمر الشراء الفعلي بعد الاستلام - جاهز للتسجيل المالي',
                'responsible' => 'الإدارة المالية والحسابات',
            ];
        }

        // 4. Pending Actual PO (Site Receipt is APPROVED, awaiting Actual PO from procurement)
        $hasApprovedReceipt = false;
        if ($po) {
            if ($po->relationLoaded('purchaseReceipts')) {
                $hasApprovedReceipt = $po->purchaseReceipts->contains(fn ($r) => $r->status === 'APPROVED');
            } else {
                $hasApprovedReceipt = $po->purchaseReceipts()->where('status', 'APPROVED')->exists();
            }
        }

        if ($hasApprovedReceipt || ($po && $po->status === 'PENDING_ACTUAL_PO')) {
            return [
                'stage' => 'PENDING_ACTUAL_PO',
                'label' => 'بالموقع - بانتظار الأمر الفعلي',
                'color' => 'amber',
                'description' => 'تم فحص واستلام المواد بالموقع - بانتظار إصدار وتثبيت أمر الشراء الفعلي',
                'responsible' => 'مدير المشتريات',
            ];
        }

        // 5. GRN Pending (Material arrived, receipt pending warehouse or site engineer approval)
        $hasPendingReceipt = false;
        if ($po) {
            if ($po->relationLoaded('purchaseReceipts')) {
                $hasPendingReceipt = $po->purchaseReceipts->contains(fn ($r) => in_array($r->status, ['PENDING', 'SUBMITTED_BY_WAREHOUSE', 'PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED'], true));
            } else {
                $hasPendingReceipt = $po->purchaseReceipts()->whereIn('status', ['PENDING', 'SUBMITTED_BY_WAREHOUSE', 'PENDING_SITE_ENGINEER', 'WAREHOUSE_RECEIPT_SUBMITTED'])->exists();
            }
        }

        if ($hasPendingReceipt) {
            return [
                'stage' => 'GRN_PENDING',
                'label' => 'بانتظار فحص واعتماد الاستلام',
                'color' => 'purple',
                'description' => 'التوريدات بالموقع/المستودع - بانتظار اعتماد الاستلام من مهندس الموقع',
                'responsible' => 'مهندس الموقع / أمين المستودع',
            ];
        }

        // 6. Preliminary PO Issued (Waiting for delivery / warehouse receipt)
        if ($po && in_array($po->status, ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'PO_DRAFT'], true)) {
            return [
                'stage' => 'PO_ISSUED',
                'label' => 'أمر شراء صادر - قيد التوريد',
                'color' => 'blue',
                'description' => 'أمر الشراء صادر للمورد وقيد تجهيز ونقل التوريدات إلى الموقع',
                'responsible' => 'المورد / أمين المستودع',
            ];
        }

        // 7. Standalone PR: Approved, awaiting PO creation
        if ($pr && in_array($pr->status, ['PENDING_PROCUREMENT_APPROVAL', 'APPROVED_BY_PROCUREMENT', 'APPROVED_BY_ACCOUNTING'], true)) {
            return [
                'stage' => 'PENDING_PO',
                'label' => 'طلب معتمد - بانتظار أمر الشراء',
                'color' => 'indigo',
                'description' => 'تم اعتماد الطلب - بانتظار قيام المشتريات بإصدار أمر الشراء والتعاقد',
                'responsible' => 'مدير المشتريات',
            ];
        }

        // 8. Standalone PR: Under Review / GM Approval
        return [
            'stage' => 'UNDER_REVIEW',
            'label' => 'طلب قيد المراجعة والاعتماد',
            'color' => 'sky',
            'description' => 'الطلب في مرحلة التدقيق والموافقات الإدارية المبدئية',
            'responsible' => 'المراجع / المدير التنفيذي',
        ];
    }

    /**
     * GET /api/v1/admin/all-orders-master
     * Master endpoint returning all orders and standalone requests across the entire procurement lifecycle.
     */
    public function index(Request $request): JsonResponse
    {
        try {
            $search = trim((string) $request->query('search', ''));
            $stageFilter = (string) $request->query('stage', 'all');
            $departmentId = $request->query('department_id');
            $supplierId = $request->query('supplier_id');
            $dateFrom = $request->query('date_from');
            $dateTo = $request->query('date_to');

            // 1. Fetch Purchase Orders with relations safely
            $poQuery = PurchaseOrder::query()
                ->with([
                    'purchaseRequest.department',
                    'purchaseRequest.requester',
                    'purchaseRequest.landParcel',
                    'supplier',
                    'items.supplier',
                    'purchaseReceipts.items',
                    'supplierInvoices',
                    'createdBy',
                ]);

            if ($departmentId) {
                $poQuery->whereHas('purchaseRequest', fn ($q) => $q->where('department_id', $departmentId));
            }

            if ($supplierId) {
                $poQuery->where(function ($sq) use ($supplierId) {
                    $sq->where('supplier_id', $supplierId)
                        ->orWhereHas('items', fn ($iq) => $iq->where('supplier_id', $supplierId));
                });
            }

            if ($dateFrom) {
                $poQuery->whereDate('created_at', '>=', $dateFrom);
            }
            if ($dateTo) {
                $poQuery->whereDate('created_at', '<=', $dateTo);
            }

            if ($search !== '') {
                $poQuery->where(function ($q) use ($search) {
                    $q->where('po_number', 'like', "%{$search}%")
                        ->orWhereHas('supplier', function ($sq) use ($search) {
                            $sq->where('company_name', 'like', "%{$search}%")
                                ->orWhere('contact_name', 'like', "%{$search}%");
                        })
                        ->orWhereHas('items.supplier', function ($isq) use ($search) {
                            $isq->where('company_name', 'like', "%{$search}%")
                                ->orWhere('contact_name', 'like', "%{$search}%");
                        })
                        ->orWhereHas('purchaseRequest', function ($pq) use ($search) {
                            $pq->where('request_number', 'like', "%{$search}%")
                                ->orWhere('notes', 'like', "%{$search}%")
                                ->orWhereHas('requester', fn ($rq) => $rq->where('name', 'like', "%{$search}%"));
                        })
                        ->orWhereHas('items', function ($iq) use ($search) {
                            $iq->where('item_description', 'like', "%{$search}%")
                                ->orWhere('item_reference', 'like', "%{$search}%");
                        });
                });
            }

            $allPos = $poQuery->orderByDesc('id')->get();

            // 2. Fetch Standalone Purchase Requests (without active POs) if viewing all or PR-related stages
            $standalonePrs = collect();
            if (in_array($stageFilter, ['all', 'pending_po', 'under_review', 'cancelled_or_rejected'], true)) {
                $prQuery = PurchaseRequest::query()
                    ->whereDoesntHave('purchaseOrders', function ($q) {
                        $q->whereNotIn('status', ['REJECTED', 'CANCELLED']);
                    })
                    ->with(['department', 'requester', 'landParcel', 'items']);

                if ($departmentId) {
                    $prQuery->where('department_id', $departmentId);
                }
                if ($dateFrom) {
                    $prQuery->whereDate('created_at', '>=', $dateFrom);
                }
                if ($dateTo) {
                    $prQuery->whereDate('created_at', '<=', $dateTo);
                }
                if ($search !== '') {
                    $prQuery->where(function ($q) use ($search) {
                        $q->where('request_number', 'like', "%{$search}%")
                            ->orWhere('notes', 'like', "%{$search}%")
                            ->orWhereHas('requester', fn ($rq) => $rq->where('name', 'like', "%{$search}%"))
                            ->orWhereHas('items', function ($iq) use ($search) {
                                $iq->where('item_description', 'like', "%{$search}%")
                                    ->orWhere('item_reference', 'like', "%{$search}%");
                            });
                    });
                }
                $standalonePrs = $prQuery->orderByDesc('id')->get();
            }

            // 3. Map orders and requests into unified Master Order representations
            $masterList = collect();

            foreach ($allPos as $po) {
                $pr = $po->purchaseRequest;
                $stageInfo = self::resolveCycleStage($po, $pr);

                // Latest receipt
                $latestReceipt = $po->purchaseReceipts->sortByDesc('id')->first();
                // Primary invoice
                $primaryInvoice = $po->supplierInvoices->first();

                $parcelRef = $po->items->pluck('item_reference')->filter()->first()
                    ?: ($pr?->landParcel?->parcel_reference ?: '—');
                $region = $po->items->pluck('region')->filter()->first()
                    ?: ($pr?->landParcel?->region ?: ($pr?->department?->name ?? '—'));

                $isActual = $po->finalized_at !== null || $stageInfo['stage'] === 'ACTUAL_PO_ISSUED' || $stageInfo['stage'] === 'INVOICED';

                $masterList->push([
                    'unique_key' => "PO-{$po->id}",
                    'order_id' => $po->id,
                    'request_id' => $pr?->id,
                    'po_number' => $po->po_number,
                    'pr_number' => $pr?->request_number ?? '—',
                    'department' => [
                        'id' => $pr?->department?->id,
                        'name' => $pr?->department?->name ?? 'غير محدد',
                        'code' => $pr?->department?->code ?? '—',
                    ],
                    'requester' => [
                        'id' => $pr?->requester?->id,
                        'name' => $pr?->requester?->name ?? ($po->createdBy?->name ?? '—'),
                    ],
                    'supplier' => [
                        'id' => $po->supplier?->id,
                        'name' => $po->supplier?->company_name ?? $po->supplier?->contact_name ?? 'غير محدد',
                        'code' => $po->supplier?->tax_number ?? '—',
                    ],
                    'project_site' => [
                        'parcel_reference' => $parcelRef,
                        'region' => $region,
                    ],
                    'po_status' => $po->status,
                    'pr_status' => $pr?->status ?? '—',
                    'cycle_stage' => $stageInfo['stage'],
                    'cycle_stage_label' => $stageInfo['label'],
                    'cycle_stage_color' => $stageInfo['color'],
                    'cycle_stage_desc' => $stageInfo['description'],
                    'responsible_party' => $stageInfo['responsible'],
                    'is_actual_po' => $isActual,
                    'finalized_at' => self::formatDateTimeSafely($po->finalized_at),
                    'grand_total' => (float) ($po->grand_total ?? 0),
                    'subtotal' => (float) ($po->subtotal ?? 0),
                    'items_count' => $po->items->count(),
                    'items' => $po->items->map(function (PurchaseOrderItem $item) use ($latestReceipt) {
                        $matchingReceiptItem = $latestReceipt?->items->firstWhere('purchase_order_item_id', $item->id);
                        $poQty = (float) ($item->quantity ?? 0);
                        $unitPrice = (float) ($item->unit_price ?? 0);
                        $lineTotal = (float) ($item->line_total !== null && (float) $item->line_total > 0
                            ? $item->line_total
                            : round($poQty * $unitPrice, 2));
                        return [
                            'id' => $item->id,
                            'item_description' => $item->item_description,
                            'item_reference' => $item->item_reference,
                            'region' => $item->region,
                            'quantity' => $poQty,
                            'original_po_quantity' => $poQty,
                            'actual_quantity' => $poQty,
                            'uom' => $item->uom,
                            'unit_price' => $unitPrice,
                            'line_total' => $lineTotal,
                            'received_quantity' => $matchingReceiptItem ? (float) $matchingReceiptItem->received_quantity : null,
                            'specifications' => $item->specifications,
                        ];
                    })->values(),
                    'receipt' => $latestReceipt ? [
                        'id' => $latestReceipt->id,
                        'receipt_number' => $latestReceipt->receipt_number,
                        'status' => $latestReceipt->status,
                        'received_at' => self::formatDateSafely($latestReceipt->received_at),
                        'photo_url' => $latestReceipt->photo_url,
                    ] : null,
                    'invoice' => $primaryInvoice ? [
                        'id' => $primaryInvoice->id,
                        'invoice_number' => $primaryInvoice->invoice_number,
                        'status' => $primaryInvoice->status,
                        'matching_status' => $primaryInvoice->matching_status,
                        'amount' => (float) $primaryInvoice->amount,
                    ] : null,
                    'delivery_date' => self::formatDateSafely($po->delivery_date),
                    'actual_delivery_date' => self::formatDateSafely($po->actual_delivery_date),
                    'notes' => $po->notes,
                    'financial_notes' => $po->financial_notes,
                    'created_at' => self::formatDateTimeSafely($po->created_at),
                    'updated_at' => self::formatDateTimeSafely($po->updated_at),
                ]);
            }

            foreach ($standalonePrs as $pr) {
                $stageInfo = self::resolveCycleStage(null, $pr);

                $parcelRef = $pr->landParcel?->parcel_reference
                    ?: ($pr->items->pluck('item_reference')->filter()->first() ?: '—');
                $region = $pr->landParcel?->region
                    ?: ($pr->items->pluck('region')->filter()->first() ?: ($pr->department?->name ?? '—'));

                $masterList->push([
                    'unique_key' => "PR-{$pr->id}",
                    'order_id' => null,
                    'request_id' => $pr->id,
                    'po_number' => '— (قيد الاعتماد)',
                    'pr_number' => $pr->request_number,
                    'department' => [
                        'id' => $pr->department?->id,
                        'name' => $pr->department?->name ?? 'غير محدد',
                        'code' => $pr->department?->code ?? '—',
                    ],
                    'requester' => [
                        'id' => $pr->requester?->id,
                        'name' => $pr->requester?->name ?? '—',
                    ],
                    'supplier' => [
                        'id' => null,
                        'name' => 'لم يُحدد بعد',
                        'code' => '—',
                    ],
                    'project_site' => [
                        'parcel_reference' => $parcelRef,
                        'region' => $region,
                    ],
                    'po_status' => null,
                    'pr_status' => $pr->status,
                    'cycle_stage' => $stageInfo['stage'],
                    'cycle_stage_label' => $stageInfo['label'],
                    'cycle_stage_color' => $stageInfo['color'],
                    'cycle_stage_desc' => $stageInfo['description'],
                    'responsible_party' => $stageInfo['responsible'],
                    'is_actual_po' => false,
                    'finalized_at' => null,
                    'grand_total' => (float) ($pr->total_estimated_cost ?? 0),
                    'subtotal' => (float) ($pr->total_estimated_cost ?? 0),
                    'items_count' => $pr->items->count(),
                    'items' => $pr->items->map(fn ($item) => [
                        'id' => $item->id,
                        'item_description' => $item->item_description,
                        'item_reference' => $item->item_reference,
                        'region' => $item->region,
                        'quantity' => (float) $item->quantity,
                        'uom' => $item->uom,
                        'unit_price' => (float) $item->estimated_unit_price,
                        'line_total' => (float) ($item->estimated_line_total > 0 ? $item->estimated_line_total : round((float)$item->quantity * (float)$item->estimated_unit_price, 2)),
                        'received_quantity' => null,
                        'specifications' => $item->specifications,
                    ])->values(),
                    'receipt' => null,
                    'invoice' => null,
                    'delivery_date' => null,
                    'actual_delivery_date' => null,
                    'notes' => $pr->notes,
                    'financial_notes' => null,
                    'created_at' => self::formatDateTimeSafely($pr->created_at),
                    'updated_at' => self::formatDateTimeSafely($pr->updated_at),
                ]);
            }

            // 4. Calculate Stage Statistics on the FULL collection
            $stats = [
                'total_count' => $masterList->count(),
                'invoiced_count' => $masterList->where('cycle_stage', 'INVOICED')->count(),
                'actual_po_count' => $masterList->where('cycle_stage', 'ACTUAL_PO_ISSUED')->count(),
                'pending_actual_po_count' => $masterList->where('cycle_stage', 'PENDING_ACTUAL_PO')->count(),
                'grn_pending_count' => $masterList->where('cycle_stage', 'GRN_PENDING')->count(),
                'po_issued_count' => $masterList->where('cycle_stage', 'PO_ISSUED')->count(),
                'pending_po_count' => $masterList->where('cycle_stage', 'PENDING_PO')->count(),
                'under_review_count' => $masterList->where('cycle_stage', 'UNDER_REVIEW')->count(),
                'rejected_count' => $masterList->where('cycle_stage', 'CANCELLED_OR_REJECTED')->count(),
                'total_financial_value' => round((float) $masterList->where('is_actual_po', true)->sum('grand_total'), 2),
                'total_estimated_value' => round((float) $masterList->whereNotIn('cycle_stage', ['CANCELLED_OR_REJECTED'])->sum('grand_total'), 2),
            ];

            // 5. Filter by Stage if requested
            if ($stageFilter !== 'all' && $stageFilter !== '') {
                $normalizedFilter = strtoupper(str_replace('-', '_', $stageFilter));
                $masterList = $masterList->filter(fn ($row) => $row['cycle_stage'] === $normalizedFilter)->values();
            }

            // Sort: newest created first
            $sortedList = $masterList->sortByDesc('created_at')->values();

            // 6. Pagination
            $perPageParam = $request->query('per_page', 50);
            $isAll = $perPageParam === 'ALL' || $perPageParam === 'all' || (is_numeric($perPageParam) && (int) $perPageParam <= 0);
            $perPage = $isAll ? max(1, $sortedList->count()) : (int) $perPageParam;
            $page = max(1, (int) $request->query('page', 1));
            $totalRows = $sortedList->count();
            $lastPage = $isAll ? 1 : max(1, (int) ceil($totalRows / $perPage));
            $sliced = $isAll ? $sortedList : $sortedList->slice(($page - 1) * $perPage, $perPage)->values();

            // Lookups for filters (safe column selections)
            $departments = Department::orderBy('name')->get(['id', 'name', 'code']);
            $suppliers = Supplier::where('is_active', true)
                ->orderBy('company_name')
                ->get(['id', 'company_name', 'contact_name'])
                ->map(fn ($s) => [
                    'id' => $s->id,
                    'company_name' => $s->company_name,
                    'name' => $s->company_name ?: $s->contact_name,
                    'code' => $s->tax_number ?? '—',
                ])
                ->values();

            return response()->json([
                'success' => true,
                'data' => $sliced,
                'meta' => [
                    'current_page' => $page,
                    'per_page' => $perPage,
                    'total' => $totalRows,
                    'last_page' => $lastPage,
                    'from' => $totalRows > 0 ? (($page - 1) * $perPage + 1) : 0,
                    'to' => min($page * $perPage, $totalRows),
                ],
                'stats' => $stats,
                'lookups' => [
                    'departments' => $departments,
                    'suppliers' => $suppliers,
                ],
            ]);
        } catch (Throwable $e) {
            Log::error('AdminMasterOrdersController@index exception: ' . $e->getMessage(), [
                'file' => $e->getFile(),
                'line' => $e->getLine(),
                'trace' => substr($e->getTraceAsString(), 0, 1000),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'حدث خطأ أثناء جلب بيانات التحكم الشامل: ' . $e->getMessage(),
                'error' => $e->getMessage(),
                'data' => [],
                'stats' => [
                    'total_count' => 0,
                    'invoiced_count' => 0,
                    'actual_po_count' => 0,
                    'pending_actual_po_count' => 0,
                    'grn_pending_count' => 0,
                    'po_issued_count' => 0,
                    'pending_po_count' => 0,
                    'under_review_count' => 0,
                    'rejected_count' => 0,
                    'total_financial_value' => 0,
                ],
                'lookups' => [
                    'departments' => [],
                    'suppliers' => [],
                ],
            ], 500);
        }
    }

    /**
     * GET /api/v1/admin/orders/{id}/details
     * Detailed inspect payload for an order, including receipts, items, linked PR, and audit logs.
     */
    public function showOrder(int $id): JsonResponse
    {
        try {
            $po = PurchaseOrder::with([
                'purchaseRequest.department',
                'purchaseRequest.requester',
                'purchaseRequest.landParcel',
                'supplier',
                'items.item',
                'items.supplier',
                'purchaseReceipts.items',
                'supplierInvoices',
                'approvalHistory.actor',
                'createdBy',
            ])->findOrFail($id);

            $pr = $po->purchaseRequest;
            $stageInfo = self::resolveCycleStage($po, $pr);

            $auditLogs = $this->auditLogsFor($po, $pr);

            $availableSuppliers = Supplier::where('is_active', true)
                ->orderBy('company_name')
                ->get(['id', 'company_name', 'contact_name'])
                ->map(fn ($s) => [
                    'id' => $s->id,
                    'company_name' => $s->company_name,
                    'name' => $s->company_name ?: $s->contact_name,
                    'code' => $s->tax_number ?? '—',
                ])
                ->values();

            return response()->json([
                'success' => true,
                'data' => [
                    'order' => $po,
                    'request' => $pr,
                    'cycle_stage' => $stageInfo,
                    'audit_logs' => $auditLogs,
                    'available_suppliers' => $availableSuppliers,
                    ...$this->stagePayload($pr, app(AdminRequestStageService::class)),
                ],
            ]);
        } catch (Throwable $e) {
            Log::error('AdminMasterOrdersController@showOrder exception: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'تعذر جلب تفاصيل أمر الشراء: ' . $e->getMessage(),
            ], 500);
        }
    }

    /**
     * PUT /api/v1/admin/orders/{id}/force-update
     * Sovereign override (RBAC Bypass) allowing the Super Admin to update ANY field,
     * status, items, prices, or quantities at ANY stage with full audit trail.
     */
    public function forceUpdateOrder(Request $request, int $id): JsonResponse
    {
        $admin = Auth::user();

        $validator = Validator::make($request->all(), [
            'status' => 'nullable|string',
            'supplier_id' => 'nullable|exists:suppliers,id',
            'delivery_date' => 'nullable|date',
            'actual_delivery_date' => 'nullable|date',
            'delivery_notes' => 'nullable|string',
            'notes' => 'nullable|string',
            'financial_notes' => 'nullable|string',
            'rejection_reason' => 'nullable|string',
            'is_actual_po' => 'nullable|boolean',
            'finalized_at' => 'nullable|date',
            'receipt_status' => 'nullable|string',
            'delivery_status' => 'nullable|string',
            'admin_reason' => 'required|string|min:3|max:500',
            'sync_receipt' => 'nullable|boolean',
            'sync_pr' => 'nullable|boolean',
            'request_stage' => 'nullable|string|in:' . implode(',', array_keys(AdminRequestStageService::STAGES)),
            'items' => 'nullable|array',
            'items.*.id' => 'nullable|integer',
            'items.*.delete' => 'nullable|boolean',
            // Lines marked for removal only need their id.
            'items.*.supplier_id' => 'exclude_if:items.*.delete,true|nullable|exists:suppliers,id',
            'items.*.item_description' => 'exclude_if:items.*.delete,true|required|string|max:255',
            'items.*.item_reference' => 'exclude_if:items.*.delete,true|nullable|string|max:100',
            'items.*.region' => 'exclude_if:items.*.delete,true|nullable|string|max:100',
            // Existing lines may legitimately sit at 0 (steel diameters folded into a weighed "حديد" line).
            'items.*.quantity' => 'exclude_if:items.*.delete,true|required|numeric|min:0',
            'items.*.uom' => 'exclude_if:items.*.delete,true|required|string|max:50',
            'items.*.unit_price' => 'exclude_if:items.*.delete,true|required|numeric|min:0',
            'items.*.specifications' => 'exclude_if:items.*.delete,true|nullable|string',
        ], self::FORCE_UPDATE_MESSAGES, $this->forceUpdateAttributeNames($request));

        $validator->after(function ($v) use ($request) {
            foreach ((array) $request->input('items', []) as $index => $item) {
                if (empty($item['id']) && empty($item['delete']) && is_numeric($item['quantity'] ?? null) && (float) $item['quantity'] <= 0) {
                    $v->errors()->add("items.{$index}.quantity", $this->itemLabel($index, $item) . ' — الكمية يجب أن تكون أكبر من صفر للبند الجديد.');
                }
            }
        });

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => $validator->errors()->first(),
                'errors' => $validator->errors(),
            ], 422);
        }

        $validated = $validator->validated();

        $po = PurchaseOrder::with(['items', 'purchaseReceipts.items', 'purchaseRequest'])->findOrFail($id);

        $oldSnapshot = [
            'status' => $po->status,
            'supplier_id' => $po->supplier_id,
            'subtotal' => (float) $po->subtotal,
            'grand_total' => (float) $po->grand_total,
            'delivery_date' => self::formatDateSafely($po->delivery_date),
            'actual_delivery_date' => self::formatDateSafely($po->actual_delivery_date),
            'finalized_at' => self::formatDateTimeSafely($po->finalized_at),
            'items' => $po->items->map(fn ($it) => [
                'id' => $it->id,
                'supplier_id' => $it->supplier_id,
                'description' => $it->item_description,
                'reference' => $it->item_reference,
                'qty' => (float) $it->quantity,
                'uom' => $it->uom,
                'unit_price' => (float) $it->unit_price,
                'line_total' => (float) $it->line_total,
            ])->toArray(),
        ];

        $adminReason = trim($validated['admin_reason']);
        $syncReceipt = $request->boolean('sync_receipt', true);
        $syncPr = $request->boolean('sync_pr', true);

        try {
            DB::transaction(function () use ($po, $validated, $adminReason, $admin, $syncReceipt, $syncPr, $oldSnapshot) {
                $fromStatus = $po->status;

                // 1. Update direct PO attributes
                if (! empty($validated['status'])) {
                    $po->status = $validated['status'];
                }

                if (array_key_exists('supplier_id', $validated)) {
                    $po->supplier_id = $validated['supplier_id'];
                }
                if (array_key_exists('delivery_date', $validated)) {
                    $po->delivery_date = $validated['delivery_date'] ? Carbon::parse($validated['delivery_date']) : null;
                }
                if (array_key_exists('actual_delivery_date', $validated)) {
                    $po->actual_delivery_date = $validated['actual_delivery_date'] ? Carbon::parse($validated['actual_delivery_date']) : null;
                }
                if (array_key_exists('delivery_notes', $validated)) {
                    $po->delivery_notes = $validated['delivery_notes'];
                }
                if (array_key_exists('notes', $validated)) {
                    $po->notes = $validated['notes'];
                }
                if (array_key_exists('financial_notes', $validated)) {
                    $po->financial_notes = $validated['financial_notes'];
                }
                if (array_key_exists('rejection_reason', $validated)) {
                    $po->rejection_reason = $validated['rejection_reason'];
                }

                if (array_key_exists('delivery_status', $validated)) {
                    $po->delivery_status = $validated['delivery_status'];
                }

                // Handle Actual PO flag / finalization timestamp
                if (array_key_exists('is_actual_po', $validated)) {
                    if ($validated['is_actual_po']) {
                        if (! $po->finalized_at) {
                            $po->finalized_at = now();
                            $po->finalized_by_user_id = $admin->id;
                        }
                    } else {
                        $po->finalized_at = null;
                        $po->finalized_by_user_id = null;
                        // Reset delivery status if rolling back to ISSUED so it's not permanently stuck as DELIVERED
                        if (! array_key_exists('delivery_status', $validated) && in_array($po->status, ['ISSUED', 'PO_ISSUED'], true)) {
                            $po->delivery_status = 'IN_RECEIPT';
                        }
                    }
                } elseif (! empty($validated['finalized_at'])) {
                    $po->finalized_at = Carbon::parse($validated['finalized_at']);
                    $po->finalized_by_user_id = $admin->id;
                }

                // 2. Process Items Override
                if (! empty($validated['items']) && is_array($validated['items'])) {
                    foreach ($validated['items'] as $itemData) {
                        $itemId = $itemData['id'] ?? null;
                        $isDelete = ! empty($itemData['delete']);

                        if ($itemId) {
                            $existingItem = PurchaseOrderItem::where('purchase_order_id', $po->id)->find($itemId);
                            if ($existingItem) {
                                if ($isDelete) {
                                    // Delete receipt items referencing this
                                    DB::table('purchase_receipt_items')->where('purchase_order_item_id', $existingItem->id)->delete();
                                    $existingItem->delete();
                                    continue;
                                }

                                $qty = (float) $itemData['quantity'];
                                $price = (float) $itemData['unit_price'];
                                $lineTotal = round($qty * $price, 2);

                                $itemSupplierId = ! empty($itemData['supplier_id'])
                                    ? (int) $itemData['supplier_id']
                                    : ($po->supplier_id ?: null);

                                $existingItem->update([
                                    'item_description' => $itemData['item_description'],
                                    'supplier_id' => $itemSupplierId,
                                    'item_reference' => $itemData['item_reference'] ?? $existingItem->item_reference,
                                    'region' => $itemData['region'] ?? $existingItem->region,
                                    'quantity' => $qty,
                                    'uom' => $itemData['uom'],
                                    'unit_price' => $price,
                                    'line_total' => $lineTotal,
                                    'specifications' => $itemData['specifications'] ?? $existingItem->specifications,
                                ]);
                            }
                        } elseif (! $isDelete) {
                            // Create brand new item
                            $qty = (float) $itemData['quantity'];
                            $price = (float) $itemData['unit_price'];
                            $lineTotal = round($qty * $price, 2);

                            $itemSupplierId = ! empty($itemData['supplier_id'])
                                ? (int) $itemData['supplier_id']
                                : ($po->supplier_id ?: null);

                            PurchaseOrderItem::create([
                                'purchase_order_id' => $po->id,
                                'supplier_id' => $itemSupplierId,
                                'item_description' => $itemData['item_description'],
                                'item_reference' => $itemData['item_reference'] ?? null,
                                'region' => $itemData['region'] ?? null,
                                'quantity' => $qty,
                                'uom' => $itemData['uom'],
                                'unit_price' => $price,
                                'line_total' => $lineTotal,
                                'specifications' => $itemData['specifications'] ?? null,
                            ]);
                        }
                    }
                }

                // Recalculate totals
                $freshItems = PurchaseOrderItem::where('purchase_order_id', $po->id)->get();
                $subtotal = round($freshItems->sum('line_total'), 2);
                $grandTotal = $subtotal;

                $po->subtotal = $subtotal;
                $po->grand_total = $grandTotal;
                if (Schema::hasColumn('purchase_orders', 'total_amount')) {
                    $po->total_amount = $grandTotal;
                }

                // If all items share a single supplier and header was not explicitly set to something else, sync header supplier
                $activeSupplierIds = $freshItems->pluck('supplier_id')->filter()->unique();
                if ($activeSupplierIds->count() === 1) {
                    $po->supplier_id = $activeSupplierIds->first();
                } elseif (empty($po->supplier_id) && $activeSupplierIds->isNotEmpty()) {
                    $po->supplier_id = $activeSupplierIds->first();
                }

                $po->save();

                // 3. Receipt synchronization (if requested and receipts exist)
                if ($syncReceipt) {
                    foreach ($po->purchaseReceipts as $receipt) {
                        if ($po->supplier_id) {
                            $receipt->supplier_id = $po->supplier_id;
                        }

                        if (! empty($validated['receipt_status'])) {
                            $receipt->status = $validated['receipt_status'];
                        } elseif (array_key_exists('is_actual_po', $validated) && ! $validated['is_actual_po'] && in_array($po->status, ['ISSUED', 'PO_ISSUED'], true)) {
                            // If reverting back to ISSUED and unmarking Actual PO, reset receipt to pending site engineer
                            if ($receipt->status === 'APPROVED') {
                                $receipt->status = 'PENDING_SITE_ENGINEER';
                            }
                        }

                        $receipt->save();
                        foreach ($freshItems as $pItem) {
                            $rcptItem = PurchaseReceiptItem::where('purchase_receipt_id', $receipt->id)
                                ->where('purchase_order_item_id', $pItem->id)
                                ->first();

                            if ($rcptItem) {
                                $rcptItem->update([
                                    'ordered_quantity' => $pItem->quantity,
                                    'received_quantity' => $pItem->quantity,
                                ]);
                            } else {
                                PurchaseReceiptItem::create([
                                    'purchase_receipt_id' => $receipt->id,
                                    'purchase_order_item_id' => $pItem->id,
                                    'ordered_quantity' => $pItem->quantity,
                                    'received_quantity' => $pItem->quantity,
                                    'uom' => $pItem->uom,
                                ]);
                            }
                        }
                    }
                }

                // 4. PR Synchronization (if requested and linked)
                if ($syncPr && $po->purchase_request_id) {
                    DB::table('purchase_requests')
                        ->where('id', $po->purchase_request_id)
                        ->update([
                            'total_estimated_cost' => $grandTotal,
                            'updated_at' => now(),
                        ]);
                }

                // 5. Accounting invoice synchronization
                if ($po->supplier_id) {
                    DB::table('supplier_invoices')
                        ->where('purchase_order_id', $po->id)
                        ->whereIn('status', ['OPEN', 'PENDING'])
                        ->where(function ($q) use ($po) {
                            $q->whereNull('supplier_id')->orWhere('supplier_id', '!=', $po->supplier_id);
                        })
                        ->update([
                            'supplier_id' => $po->supplier_id,
                            'updated_at' => now(),
                        ]);
                }

                // 6. System Audit Trail Logging
                $newSnapshot = [
                    'status' => $po->status,
                    'supplier_id' => $po->supplier_id,
                    'subtotal' => (float) $po->subtotal,
                    'grand_total' => (float) $po->grand_total,
                    'delivery_date' => self::formatDateSafely($po->delivery_date),
                    'actual_delivery_date' => self::formatDateSafely($po->actual_delivery_date),
                    'finalized_at' => self::formatDateTimeSafely($po->finalized_at),
                    'items' => $freshItems->map(fn ($it) => [
                        'id' => $it->id,
                        'supplier_id' => $it->supplier_id,
                        'description' => $it->item_description,
                        'reference' => $it->item_reference,
                        'qty' => (float) $it->quantity,
                        'uom' => $it->uom,
                        'unit_price' => (float) $it->unit_price,
                        'line_total' => (float) $it->line_total,
                    ])->toArray(),
                ];

                // Record in SystemEvent
                app(SystemEventService::class)->record([
                    'actor_user_id' => $admin->id,
                    'event_type' => 'admin.force_override',
                    'action' => 'ADMIN_FORCE_UPDATE',
                    'entity_type' => PurchaseOrder::class,
                    'entity_id' => $po->id,
                    'entity_label' => "أمر شراء {$po->po_number} (تعديل سيادي من مدير النظام)",
                    'from_state' => $fromStatus,
                    'to_state' => $po->status,
                    'description' => "قام مدير النظام ({$admin->name}) بتعديل سيادي شامل على أمر الشراء رقم {$po->po_number}. سبب التدخل: {$adminReason}",
                    'old_values' => $oldSnapshot,
                    'new_values' => $newSnapshot,
                    'metadata' => [
                        'admin_id' => $admin->id,
                        'admin_name' => $admin->name,
                        'reason' => $adminReason,
                        'ip' => request()->ip(),
                        'sync_receipt' => $syncReceipt,
                        'sync_pr' => $syncPr,
                    ],
                ]);

                // Record in ApprovalHistory
                ApprovalHistory::create([
                    'target_type' => PurchaseOrder::class,
                    'target_id' => $po->id,
                    'actor_user_id' => $admin->id,
                    'action' => 'ADMIN_FORCE_OVERRIDE',
                    'from_state' => $fromStatus,
                    'to_state' => $po->status,
                    'user_note' => ApprovalHistory::typedNote($adminReason),
                    'comments' => "تعديل سيادي من مدير النظام: {$adminReason}",
                ]);

                // Stage move runs in the same transaction so a refused move also discards the edits.
                if (! empty($validated['request_stage']) && $po->purchaseRequest) {
                    app(AdminRequestStageService::class)->moveToStage($po->purchaseRequest, $validated['request_stage'], $adminReason, $admin);
                }
            });
        } catch (ValidationException $e) {
            return $this->validationFailure($e);
        }

        $refreshedPo = PurchaseOrder::with(['items', 'purchaseReceipts.items', 'supplierInvoices', 'supplier'])->find($id);

        return response()->json([
            'success' => true,
            'message' => "تم حفظ التعديلات على أمر الشراء {$refreshedPo->po_number}.",
            'data' => $refreshedPo,
        ]);
    }

    /**
     * GET /api/v1/admin/requests/{id}/stage
     * Current stage of a purchase request plus the stages the admin may move it to.
     */
    public function showRequestStage(int $id, AdminRequestStageService $stages): JsonResponse
    {
        $pr = PurchaseRequest::with(['requester:id,name', 'department:id,name'])->findOrFail($id);

        return response()->json([
            'success' => true,
            'data' => [
                'request' => $pr,
                ...$this->stagePayload($pr, $stages),
                'audit_logs' => $this->auditLogsFor(null, $pr),
            ],
        ]);
    }

    /**
     * POST /api/v1/admin/requests/{id}/move-stage
     */
    public function moveRequestStage(Request $request, int $id, AdminRequestStageService $stages): JsonResponse
    {
        $validator = Validator::make($request->all(), [
            'request_stage' => 'required|string|in:' . implode(',', array_keys(AdminRequestStageService::STAGES)),
            'admin_reason' => 'required|string|min:3|max:500',
        ], self::FORCE_UPDATE_MESSAGES, [
            'request_stage' => 'المرحلة',
            'admin_reason' => 'سبب التعديل',
        ]);

        if ($validator->fails()) {
            return response()->json([
                'success' => false,
                'message' => $validator->errors()->first(),
                'errors' => $validator->errors(),
            ], 422);
        }

        $pr = PurchaseRequest::findOrFail($id);
        try {
            $result = $stages->moveToStage($pr, $request->input('request_stage'), (string) $request->input('admin_reason'), Auth::user());
        } catch (ValidationException $e) {
            return $this->validationFailure($e);
        }

        return response()->json([
            'success' => true,
            'message' => $result['message'],
            'data' => $result['document'] ?? null,
        ]);
    }

    private const FORCE_UPDATE_MESSAGES = [
        'required' => ':attribute مطلوب.',
        'string' => ':attribute غير صالح.',
        'numeric' => ':attribute يجب أن يكون رقمًا.',
        'integer' => ':attribute يجب أن يكون رقمًا صحيحًا.',
        'boolean' => ':attribute غير صالح.',
        'array' => ':attribute غير صالح.',
        'date' => ':attribute ليس تاريخًا صحيحًا.',
        'exists' => ':attribute غير موجود.',
        'in' => ':attribute غير معروفة.',
        'min.numeric' => ':attribute لا يمكن أن يكون أقل من :min.',
        'min.string' => ':attribute يجب ألا يقل عن :min أحرف.',
        'max.string' => ':attribute يجب ألا يزيد عن :max حرف.',
    ];

    private function validationFailure(ValidationException $e): JsonResponse
    {
        return response()->json([
            'success' => false,
            'message' => collect($e->errors())->flatten()->first() ?: 'تعذر حفظ التعديل.',
            'errors' => $e->errors(),
        ], 422);
    }

    private function forceUpdateAttributeNames(Request $request): array
    {
        $names = [
            'supplier_id' => 'المورد',
            'delivery_date' => 'تاريخ التوريد',
            'actual_delivery_date' => 'تاريخ الاستلام الفعلي',
            'notes' => 'الملاحظات',
            'financial_notes' => 'الملاحظات المالية',
            'admin_reason' => 'سبب التعديل',
            'request_stage' => 'المرحلة',
        ];
        $fields = [
            'supplier_id' => 'المورد',
            'item_description' => 'اسم الصنف',
            'item_reference' => 'رقم القطعة',
            'region' => 'المنطقة',
            'quantity' => 'الكمية',
            'uom' => 'الوحدة',
            'unit_price' => 'سعر الوحدة',
            'specifications' => 'المواصفات',
        ];

        foreach ((array) $request->input('items', []) as $index => $item) {
            $label = $this->itemLabel($index, is_array($item) ? $item : []);
            foreach ($fields as $field => $fieldLabel) {
                $names["items.{$index}.{$field}"] = "{$label} — {$fieldLabel}";
            }
        }

        return $names;
    }

    private function itemLabel(int|string $index, array $item): string
    {
        $number = (int) $index + 1;
        $description = trim((string) ($item['item_description'] ?? ''));

        return $description !== '' ? "البند {$number} ({$description})" : "البند {$number}";
    }

    private function stagePayload(?PurchaseRequest $pr, AdminRequestStageService $stages): array
    {
        if (! $pr) {
            return ['current_stage' => null, 'stage_options' => []];
        }

        $current = $stages->currentStage($pr);

        return [
            'current_stage' => ['value' => $current, 'label' => $stages->stageLabel($current)],
            'stage_options' => $stages->stageOptions($pr),
        ];
    }

    private function auditLogsFor(?PurchaseOrder $po, ?PurchaseRequest $pr): Collection
    {
        return SystemEvent::query()
            ->where(function ($q) use ($po, $pr) {
                if ($po) {
                    $q->orWhere(fn ($sub) => $sub->where('entity_type', PurchaseOrder::class)->where('entity_id', $po->id));
                }
                if ($pr) {
                    $q->orWhere(fn ($sub) => $sub->where('entity_type', PurchaseRequest::class)->where('entity_id', $pr->id));
                }
            })
            ->with('actor:id,name,email')
            ->orderByDesc('occurred_at')
            ->limit(30)
            ->get();
    }

    /**
     * DELETE /api/v1/admin/orders/{id}/force-delete
     * Sovereign Hard Delete: Completely purges an order and/or purchase request along with its
     * entire document cycle (items, receipts, invoices, attachments, approvals) with strict audit trail.
     */
    public function forceDeleteOrder(Request $request, int $id): JsonResponse
    {
        $admin = Auth::user();
        $reason = trim((string) $request->input('reason', ''));
        if (empty($reason)) {
            $reason = 'إلغاء إداري سيادي من لوحة التحكم مع الاحتفاظ بالسجل التاريخي';
        }

        $entityType = strtolower((string) $request->input('entity_type', 'auto'));

        try {
            // Auto detection of entity if 'auto'
            if ($entityType === 'auto') {
                $po = PurchaseOrder::withTrashed()->find($id);
                if ($po) {
                    $entityType = 'order';
                } else {
                    $pr = PurchaseRequest::withTrashed()->find($id);
                    if ($pr) {
                        $entityType = 'request';
                    } else {
                        return response()->json([
                            'success' => false,
                            'message' => "المعاملة رقم #{$id} غير موجودة في النظام.",
                        ], 404);
                    }
                }
            }

            /** @var \App\Services\AdminWorkflowControlService $controlService */
            $controlService = app(\App\Services\AdminWorkflowControlService::class);

            $result = $controlService->cancelSafely(
                $entityType === 'order' ? 'PURCHASE_ORDER' : 'PURCHASE_REQUEST',
                $id,
                $reason,
                $admin,
                $request->ip(),
                $request->userAgent()
            );

            return response()->json([
                'success' => true,
                'message' => "تم حظر الحذف الفيزيائي نهائياً لحماية الحسابات والبيانات التاريخية، وتم تحويل المعاملة بنجاح إلى حالة ملغاة (CANCELLED / VOIDED) مع توثيق العملية بالكامل في سجل التدقيق الإداري غير القابل للتعديل.",
                'data' => $result,
            ]);
        } catch (\Illuminate\Validation\ValidationException $ve) {
            return response()->json([
                'success' => false,
                'message' => collect($ve->errors())->flatten()->first() ?: 'خطأ في التحقق من صحة البيانات.',
                'errors' => $ve->errors(),
            ], 422);
        } catch (Throwable $e) {
            Log::error('AdminMasterOrdersController@forceDeleteOrder exception: ' . $e->getMessage(), [
                'id' => $id,
                'error' => $e->getMessage(),
                'trace' => substr($e->getTraceAsString(), 0, 1000),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'تعذر إتمام العملية بأمان: ' . $e->getMessage(),
                'error' => $e->getMessage(),
            ], 500);
        }
    }
}
