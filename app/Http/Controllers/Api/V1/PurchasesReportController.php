<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Department;
use App\Models\PurchaseOrder;
use App\Models\SupplierInvoice;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class PurchasesReportController extends Controller
{
    /**
     * Allowed roles for this specific report.
     */
    private const ALLOWED_ROLES = [
        'accountant',
        'site_accountant',
        'licenses_accountant',
        'buffet_accountant',
        'development_accountant',
        'general_accountant',
        'general_manager',
        'execution_manager',
        'procurement_manager',
        'admin',
    ];

    /**
     * Display the purchases report with the 12 accounting-verified columns.
     */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();

        // 1. Authorize role: only Accountant, GM, Procurement Manager, and Admin
        $userRoles = $user->roles->flatMap(fn ($r) => [
            strtolower((string) ($r->name ?? '')),
            strtolower((string) ($r->slug ?? '')),
        ])->filter()->all();
        $isAllowed = ! empty(array_intersect($userRoles, self::ALLOWED_ROLES));

        if (! $isAllowed) {
            return response()->json([
                'message' => 'غير مصرح لك بالوصول لتقرير المشتريات المحاسبي. هذا التقرير مخصص للحسابات والمدير التنفيذي ومدير المشتريات فقط.',
            ], 403);
        }

        // 2. Parse Date / Period Filters
        $filterType = (string) $request->query('filter_type', 'monthly'); // 'daily' | 'monthly' | 'custom'
        $departmentId = $request->filled('department_id') && $request->query('department_id') !== 'ALL'
            ? (int) $request->query('department_id')
            : null;
        $supplierId = $request->filled('supplier_id') && $request->query('supplier_id') !== 'ALL'
            ? (int) $request->query('supplier_id')
            : null;
        $accountingFilter = (string) $request->query('accounting_filter', 'ALL'); // 'VERIFIED_ONLY' | 'ALL' | 'PENDING'
        $actualOnly = $request->boolean('actual_only', true); // أوامر الشراء الفعلية فقط (الافتراضي نعم لحماية التقارير المالية)
        $dateBasis = (string) $request->query('date_basis', 'po_date'); // 'po_date' | 'delivery_date' | 'pr_date'
        if (! in_array($dateBasis, ['po_date', 'delivery_date', 'pr_date'], true)) {
            $dateBasis = 'po_date';
        }

        $startDate = null;
        $endDate = null;
        $dateLabel = '';

        if ($filterType === 'daily') {
            $date = $request->query('date', now()->toDateString());
            try {
                $parsed = Carbon::parse($date);
                $startDate = $parsed->copy()->startOfDay();
                $endDate = $parsed->copy()->endOfDay();
                $dateLabel = 'يوم ' . $parsed->translatedFormat('d F Y');
            } catch (\Throwable) {
                $startDate = now()->startOfDay();
                $endDate = now()->endOfDay();
                $dateLabel = 'اليوم';
            }
        } elseif ($filterType === 'monthly') {
            $month = (string) $request->query('month', now()->format('Y-m'));
            try {
                $parsed = Carbon::createFromFormat('Y-m', $month)->startOfMonth();
                $startDate = $parsed->copy()->startOfMonth();
                $endDate = $parsed->copy()->endOfMonth();
                $dateLabel = 'شهر ' . $parsed->format('m-Y');
            } catch (\Throwable) {
                $startDate = now()->startOfMonth();
                $endDate = now()->endOfMonth();
                $dateLabel = 'الشهر الحالي';
            }
        } elseif ($filterType === 'custom') {
            $fromDate = $request->query('from_date');
            $toDate = $request->query('to_date');
            if ($fromDate && $toDate) {
                try {
                    $startDate = Carbon::parse($fromDate)->startOfDay();
                    $endDate = Carbon::parse($toDate)->endOfDay();
                    $dateLabel = "من {$fromDate} إلى {$toDate}";
                } catch (\Throwable) {
                    $startDate = now()->subDays(30)->startOfDay();
                    $endDate = now()->endOfDay();
                    $dateLabel = 'آخر 30 يوم';
                }
            } else {
                $startDate = now()->subDays(30)->startOfDay();
                $endDate = now()->endOfDay();
                $dateLabel = 'آخر 30 يوم';
            }
        }

        // 3. Query all Purchase Orders in the period with items, receipts and supplier invoices
        $allowedDepartmentCodes = ($user->hasRole('development_accountant') || $user->hasRole('general_accountant') || $user->hasRole('admin'))
            ? null
            : app(\App\Services\SupplierInvoiceService::class)->getAllowedDepartmentCodesForAccountant($user);

        $ordersQuery = PurchaseOrder::query()
            ->with([
                'supplier',
                'items.prItem',
                'items.supplier',
                'purchaseRequest.department',
                'purchaseRequest.targetDepartment',
                'purchaseRequest.landParcel',
                'purchaseReceipts.items.purchaseOrderItem.item',
                'purchaseReceipts.items.purchaseOrderItem.prItem',
                'supplierInvoices.landAllocations.parcel',
                'supplierInvoices.landAllocations.department',
                'supplierInvoices.purchaseReceipt.items.purchaseOrderItem.item',
                'supplierInvoices.purchaseReceipt.items.purchaseOrderItem.prItem',
                'supplierInvoices.createdBy',
                'weighingGroups.items',
                'purchaseReceipts.weighingGroup.items',
            ])
            ->when($actualOnly, function ($q) {
                $q->actualPo();
            }, function ($q) {
                $q->whereNotIn('status', ['PO_DRAFT', 'REJECTED', 'CANCELLED', 'VOIDED']);
            })
            ->when($supplierId !== null, function ($q) use ($supplierId) {
                $q->where(function ($sq) use ($supplierId) {
                    $sq->where('supplier_id', $supplierId)
                        ->orWhereHas('items', fn ($iq) => $iq->where('supplier_id', $supplierId));
                });
            })
            ->when($allowedDepartmentCodes !== null, function ($q) use ($allowedDepartmentCodes) {
                $q->whereHas('purchaseRequest.department', function ($dq) use ($allowedDepartmentCodes) {
                    $dq->whereIn('code', $allowedDepartmentCodes);
                });
            })
            ->when($user->hasRole('execution_manager'), function ($q) use ($user) {
                $q->whereHas('purchaseRequest.requester', function ($rq) use ($user) {
                    $rq->where('manager_id', $user->id);
                });
            });

        // 3.1 فلترة الحالة المحاسبية والتسجيل
        if ($accountingFilter === 'PENDING') {
            // أوامر الشراء بانتظار إتمام التسجيل المحاسبي
            $ordersQuery->where(function ($oq) {
                $oq->whereDoesntHave('purchaseReceipts', function ($rq) {
                    $rq->whereNotNull('accountant_recorded_at');
                })->whereDoesntHave('supplierInvoices', function ($iq) {
                    $iq->whereNotIn('status', ['VOIDED', 'CANCELLED']);
                });
            });
        } elseif ($accountingFilter === 'VERIFIED_ONLY') {
            // الأوامر الفعلية المسجلة محاسبياً أو المعتمدة نهائياً
            $ordersQuery->where(function ($oq) {
                $oq->whereNotNull('finalized_at')
                    ->orWhereIn('status', ['APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'])
                    ->orWhereHas('purchaseReceipts', function ($rq) {
                        $rq->whereNotNull('accountant_recorded_at');
                    })
                    ->orWhereHas('supplierInvoices', function ($iq) {
                        $iq->whereNotIn('status', ['VOIDED', 'CANCELLED']);
                    });
            });
        }

        // 3.2 فلترة التاريخ بناءً على اختيار المستخدم (أمر الشراء / تاريخ التوريد / طلب الشراء)
        if ($startDate !== null && $endDate !== null) {
            $startDateStr = $startDate->toDateString();
            $endDateStr = $endDate->toDateString();

            if ($dateBasis === 'po_date') {
                // تاريخ أمر الشراء (الافتراضي: تاريخ الأمر أو تاريخ التوريد الفعلي أو تاريخ الاستلام أو تاريخ الفاتورة)
                $ordersQuery->where(function ($q) use ($startDateStr, $endDateStr) {
                    $q->whereDate('created_at', '>=', $startDateStr)->whereDate('created_at', '<=', $endDateStr)
                        ->orWhere(function ($dq) use ($startDateStr, $endDateStr) {
                            $dq->whereNotNull('actual_delivery_date')
                                ->whereDate('actual_delivery_date', '>=', $startDateStr)
                                ->whereDate('actual_delivery_date', '<=', $endDateStr);
                        })
                        ->orWhereHas('purchaseReceipts', function ($rq) use ($startDateStr, $endDateStr) {
                            $rq->whereDate('received_at', '>=', $startDateStr)
                                ->whereDate('received_at', '<=', $endDateStr);
                        })
                        ->orWhereHas('supplierInvoices', function ($iq) use ($startDateStr, $endDateStr) {
                            $iq->whereNotIn('status', ['VOIDED', 'CANCELLED'])
                                ->where(function ($dateQ) use ($startDateStr, $endDateStr) {
                                    $dateQ->whereDate('invoice_date', '>=', $startDateStr)
                                        ->whereDate('invoice_date', '<=', $endDateStr)
                                        ->orWhere(function ($cq) use ($startDateStr, $endDateStr) {
                                            $cq->whereDate('created_at', '>=', $startDateStr)
                                                ->whereDate('created_at', '<=', $endDateStr);
                                        });
                                });
                        });
                });
            } elseif ($dateBasis === 'delivery_date') {
                // تاريخ التوريد / الاستلام الفعلي بالموقع
                $ordersQuery->where(function ($dq) use ($startDateStr, $endDateStr) {
                    $dq->whereHas('purchaseReceipts', function ($rq) use ($startDateStr, $endDateStr) {
                        $rq->whereDate('received_at', '>=', $startDateStr)
                            ->whereDate('received_at', '<=', $endDateStr);
                    })->orWhere(function ($oq) use ($startDateStr, $endDateStr) {
                        $oq->whereNotNull('delivery_date')
                            ->whereDate('delivery_date', '>=', $startDateStr)
                            ->whereDate('delivery_date', '<=', $endDateStr);
                    })->orWhere(function ($oq) use ($startDateStr, $endDateStr) {
                        $oq->whereNotNull('actual_delivery_date')
                            ->whereDate('actual_delivery_date', '>=', $startDateStr)
                            ->whereDate('actual_delivery_date', '<=', $endDateStr);
                    });
                });
            } elseif ($dateBasis === 'pr_date') {
                // تاريخ طلب الشراء الأساسي
                $ordersQuery->whereHas('purchaseRequest', function ($pq) use ($startDateStr, $endDateStr) {
                    $pq->whereDate('created_at', '>=', $startDateStr)
                        ->whereDate('created_at', '<=', $endDateStr);
                });
            }
        }

        $orders = $ordersQuery->orderByDesc('created_at')->get();

        // 4. Transform into the exact report columns per item based on Purchase Order
        $reportRows = [];

        foreach ($orders as $order) {
            $requestModel = $order->purchaseRequest;

            // Department resolution
            $defaultDept = $requestModel?->targetDepartment
                ?? $requestModel?->department;

            $deptId = $defaultDept?->id;
            $deptName = $defaultDept?->name ?? 'العام';

            if ($departmentId !== null && $deptId !== $departmentId) {
                continue;
            }

            // Land parcel & region resolution
            $defaultParcelRef = $requestModel?->parcel_reference
                ?? $requestModel?->landParcel?->parcel_reference
                ?? '—';

            $defaultRegion = $requestModel?->region
                ?? $requestModel?->landParcel?->region
                ?? '—';

            $activeInvoices = $order->supplierInvoices->filter(fn ($inv) => ! in_array($inv->status, ['VOIDED', 'CANCELLED'], true));

            if ($accountingFilter === 'VERIFIED_ONLY' && $activeInvoices->isEmpty()) {
                continue;
            }

            if ($accountingFilter === 'PENDING' && $activeInvoices->isNotEmpty()) {
                continue;
            }

            $primaryInvoice = $activeInvoices->first();
            $approvedReceipt = $order->purchaseReceipts->where('status', 'APPROVED')->first();
            $latestReceipt = $order->purchaseReceipts->sortByDesc('id')->first();
            $receiptWithPhoto = $order->purchaseReceipts->filter(fn ($r) => ! empty($r->photo_path))->sortByDesc('id')->first();
            $targetReceipt = $receiptWithPhoto ?: $latestReceipt ?: $approvedReceipt;
            $hasReceiptAttachment = (bool) ($targetReceipt && ! empty($targetReceipt->photo_path));

            // Order dates
            $poDate = $order->created_at?->format('Y-m-d');
            $prDate = $requestModel?->created_at?->format('Y-m-d');
            $deliveryDate = $approvedReceipt?->received_at?->format('Y-m-d')
                ?? $primaryInvoice?->invoice_date?->format('Y-m-d')
                ?? $order->actual_delivery_date?->format('Y-m-d')
                ?? $order->delivery_date?->format('Y-m-d')
                ?? $order->created_at?->format('Y-m-d');

            $primaryDate = match ($dateBasis) {
                'delivery_date' => $deliveryDate,
                'pr_date' => $prDate ?? $poDate,
                default => $poDate,
            };

            // Purchase Order items - authoritative quantities & financial figures
            $poItems = $order->items;
            if ($poItems->isEmpty() && $requestModel && $requestModel->items->isNotEmpty()) {
                $poItems = $requestModel->items;
            }

            // ── Consolidated Steel Weighing Groups (ميزان بسكول - وزنة حديد موحدة) ──
            $activeWgs = ($order->weighingGroups ?? collect())->where('status', '!=', 'CANCELLED');
            $groupedPoItemIds = $activeWgs->flatMap(fn ($wg) => $wg->items->pluck('purchase_order_item_id'))->all();

            foreach ($activeWgs as $wg) {
                $wgUnitPrice = (float) ($wg->unit_price ?: ($wg->items->first()?->unit_price ?? 0));
                $wgOrderedQty = (float) $wg->total_ordered_weight;
                $wgReceivedQty = $wg->total_received_weight !== null ? (float) $wg->total_received_weight : null;

                // Consolidated "حديد": the received quantity is what the receiver entered on the receipt line,
                // independent of the scale net weight (which may be missing, lower or higher).
                $wgPoItemIds = $wg->items->pluck('purchase_order_item_id');
                $wgIsConsolidated = $wgPoItemIds->isNotEmpty() && $order->items
                    ->whereIn('id', $wgPoItemIds)
                    ->every(fn ($poItem) => (bool) $poItem->is_consolidated_steel);
                $wgReceipt = $approvedReceipt ?? $targetReceipt;
                if ($wgIsConsolidated && $wgReceipt) {
                    $wgLines = $wgReceipt->items->whereIn('purchase_order_item_id', $wgPoItemIds);
                    $wgReceivedQty = $wgLines->isNotEmpty() ? (float) $wgLines->sum('received_quantity') : null;
                }
                $effectiveQty = $wgReceivedQty !== null ? $wgReceivedQty : $wgOrderedQty;
                $wgLineTotal = round($effectiveQty * $wgUnitPrice, 2);

                $wgPlots = $wg->items->pluck('land_plot_number')->filter()->unique()->implode(', ');
                $wgRegions = $wg->items->pluck('region')->filter()->unique()->implode(', ');

                $reportRows[] = [
                    'id' => "PO-{$order->id}-WG-{$wg->id}",
                    'invoice_id' => $primaryInvoice?->id,
                    'receipt_id' => $targetReceipt?->id ?? $approvedReceipt?->id,
                    'receipt_number' => $targetReceipt?->receipt_number ?? $approvedReceipt?->receipt_number,
                    'photo_url' => $targetReceipt?->photo_url ?? $approvedReceipt?->photo_url ?? $wg->scale_ticket_photo,
                    'has_receipt_attachment' => $hasReceiptAttachment || ! empty($wg->scale_ticket_photo),
                    'invoice_url' => $order->invoice_photo_url,
                    'has_invoice_attachment' => (bool) $order->has_invoice_attachment,
                    'receipt_view_allowed' => true,
                    'purchase_order_id' => $order->id,
                    'grand_total' => (float) $order->grand_total,
                    // التواريخ
                    'date_basis' => $dateBasis,
                    'primary_date' => $primaryDate,
                    'primary_date_formatted' => $primaryDate ? Carbon::parse($primaryDate)->format('d/m/Y') : '—',
                    'po_date' => $poDate,
                    'po_date_formatted' => $poDate ? Carbon::parse($poDate)->format('d/m/Y') : '—',
                    'pr_date' => $prDate,
                    'pr_date_formatted' => $prDate ? Carbon::parse($prDate)->format('d/m/Y') : '—',
                    'delivery_date' => $deliveryDate,
                    'delivery_date_formatted' => $deliveryDate ? Carbon::parse($deliveryDate)->format('d/m/Y') : '—',
                    // الأرقام المرجعية
                    'po_number' => $order->po_number,
                    'po_number_short' => preg_replace('/^PO-\d{4}-0*/', '', $order->po_number) ?: $order->po_number,
                    'pr_number' => $requestModel?->request_number,
                    // تفاصيل الوزنة الموحدة
                    'item_name' => "وزنة حديد مجمعة ({$wg->group_number})",
                    'uom' => 'طن',
                    'quantity' => $wgOrderedQty,
                    'unit_price' => $wgUnitPrice,
                    'total_price' => $wgLineTotal,
                    'received_quantity' => $wgReceivedQty,
                    'receipt_status' => $targetReceipt?->status ?? $approvedReceipt?->status,
                    'supplier_name' => $order->supplier?->company_name ?? '—',
                    'supplier_id' => $order->supplier_id,
                    'parcel_reference' => $wgPlots ?: $defaultParcelRef,
                    'region' => $wgRegions ?: $defaultRegion,
                    'department_id' => $deptId,
                    'department_name' => $deptName,
                    'department_code' => $defaultDept?->code,
                    'works' => $requestModel?->notes ?: 'وزنة حديد مجمعة (ميزان بسكول)',
                    'invoice_number' => $primaryInvoice?->invoice_number,
                    'accounting_status' => $primaryInvoice ? 'VERIFIED' : 'PENDING',
                    'accounting_status_label' => $primaryInvoice ? 'مسجل ومطابق بالحسابات' : 'بانتظار التسجيل المحاسبي',
                    'matching_status' => $primaryInvoice?->matching_status,
                    'accountant_name' => $primaryInvoice?->createdBy?->name ?? null,
                    'order_status' => $order->status,
                    'created_at' => $order->created_at?->toIso8601String(),
                ];
            }

            if ($poItems->isNotEmpty()) {
                foreach ($poItems as $poItem) {
                    if (in_array($poItem->id, $groupedPoItemIds, true)) {
                        continue; // تم إدراجه أعلاه في سطر الوزنة المجمعة الموحدة
                    }
                    $prItem = $poItem->prItem ?? (property_exists($poItem, 'prItem') ? null : $poItem);

                    // الاستلام الفعلي بالموقع كمعلومة استرشادية للحسابات
                    $matchingReceiptItem = null;
                    if ($approvedReceipt && $approvedReceipt->items->isNotEmpty()) {
                        $matchingReceiptItem = $approvedReceipt->items->first(function ($ri) use ($poItem) {
                            return $ri->purchase_order_item_id == $poItem->id
                                || ($ri->purchaseOrderItem && $ri->purchaseOrderItem->item_description === $poItem->item_description);
                        });
                    }
                    // الاستلام الفعلي بالموقع كمعلومة استرشادية للعرض فقط
                    $rawReceivedQty = $matchingReceiptItem ? (float) $matchingReceiptItem->received_quantity : null;
                    $receivedQty = $rawReceivedQty;

                    // كميات وأسعار أمر الشراء الفعلي هي المصدر الحصري المعتمد للتقارير والتحليلات المالية
                    $poQty = (float) ($poItem->quantity ?? 0);
                    $unitPrice = (float) ($poItem->unit_price ?? $poItem->estimated_unit_price ?? 0);

                    // فحص بند الطوب: إذا كان التسعير بالألف طوبة والكمية مسجلة بعدد الطوب الفردي (مثلاً 9360 طوبة فردية)
                    $uomUpper = strtoupper(trim((string) ($poItem->uom ?? '')));
                    $itemDesc = (string) ($poItem->item_description ?? '');
                    $isThousandBricks = $uomUpper === 'THOUSAND_BRICKS'
                        || str_contains($uomUpper, 'ألف')
                        || str_contains($uomUpper, 'الف')
                        || str_contains($uomUpper, 'طوب')
                        || str_contains($itemDesc, 'طوب');

                    if ($isThousandBricks) {
                        if ($poQty >= 100 && $unitPrice >= 500) {
                            $poQty = round($poQty / 1000, 3);
                        }
                        if ($receivedQty !== null && $receivedQty >= 100) {
                            $receivedQty = round($receivedQty / 1000, 3);
                        }
                    }

                    // حساب إجمالي البند دائماً بناءً على كمية أمر الشراء الفعلي وسعر الوحدة المعتمد
                    $lineTotal = round($poQty * $unitPrice, 2);

                    $effectiveGrandTotal = (float) $order->grand_total;
                    if ($isThousandBricks && $effectiveGrandTotal > 500000 && $lineTotal < 100000) {
                        $effectiveGrandTotal = $lineTotal;
                    }

                    $rowParcelRef = $poItem->item_reference
                        ?: ($prItem?->item_reference ?: $defaultParcelRef);
                    $rowRegion = $poItem->region
                        ?: ($prItem?->region ?: $defaultRegion);

                    $effectiveItemSupplier = $poItem->supplier ?? $order->supplier;
                    $rowSupplierId = $poItem->supplier_id ?: $order->supplier_id;

                    if ($supplierId !== null && (int) $rowSupplierId !== $supplierId) {
                        continue;
                    }

                    $works = $poItem->specifications
                        ?: ($prItem?->specifications ?: ($requestModel?->notes ?: '—'));

                    $reportRows[] = [
                        'id' => "PO-{$order->id}-ITEM-{$poItem->id}",
                        'invoice_id' => $primaryInvoice?->id,
                        'receipt_id' => $targetReceipt?->id ?? $approvedReceipt?->id,
                        'receipt_number' => $targetReceipt?->receipt_number ?? $approvedReceipt?->receipt_number,
                        'photo_url' => $targetReceipt?->photo_url ?? $approvedReceipt?->photo_url,
                        'has_receipt_attachment' => $hasReceiptAttachment,
                        'invoice_url' => $order->invoice_photo_url,
                        'has_invoice_attachment' => (bool) $order->has_invoice_attachment,
                        'receipt_view_allowed' => true,
                        'purchase_order_id' => $order->id,
                        'grand_total' => $effectiveGrandTotal,
                        // التواريخ حسب الفلترة
                        'date_basis' => $dateBasis,
                        'primary_date' => $primaryDate,
                        'primary_date_formatted' => $primaryDate ? Carbon::parse($primaryDate)->format('d/m/Y') : '—',
                        'po_date' => $poDate,
                        'po_date_formatted' => $poDate ? Carbon::parse($poDate)->format('d/m/Y') : '—',
                        'pr_date' => $prDate,
                        'pr_date_formatted' => $prDate ? Carbon::parse($prDate)->format('d/m/Y') : '—',
                        'delivery_date' => $deliveryDate,
                        'delivery_date_formatted' => $deliveryDate ? Carbon::parse($deliveryDate)->format('d/m/Y') : '—',
                        // الأرقام المرجعية
                        'po_number' => $order->po_number,
                        'po_number_short' => preg_replace('/^PO-\d{4}-0*/', '', $order->po_number) ?: $order->po_number,
                        'pr_number' => $requestModel?->request_number,
                        // الصنف والوحدة
                        'item_name' => $poItem->item_description ?? ($poItem->item?->name ?? '—'),
                        'uom' => $poItem->uom ?? '—',
                        // كمية وأسعار أمر الشراء الفعلي (الأساس المالي والمحاسبي الحصري)
                        'quantity' => $poQty,
                        'unit_price' => $unitPrice,
                        'total_price' => $lineTotal,
                        // بيانات الاستلام الفعلي بالموقع (بيان استرشادي للحسابات فقط)
                        'received_quantity' => $receivedQty,
                        'receipt_status' => $approvedReceipt?->status,
                        // المورد والموقع
                        'supplier_name' => $effectiveItemSupplier?->company_name ?? $effectiveItemSupplier?->name ?? '—',
                        'supplier_id' => $rowSupplierId,
                        'parcel_reference' => $rowParcelRef ?: '—',
                        'region' => $rowRegion ?: '—',
                        'department_id' => $deptId,
                        'department_name' => $deptName,
                        'department_code' => $defaultDept?->code,
                        'works' => $works ?: '—',
                        // الحالة المحاسبية
                        'accounting_status' => $primaryInvoice ? 'VERIFIED' : 'PENDING',
                        'accounting_status_label' => $primaryInvoice ? 'مسقط ومسجل بالحسابات' : 'صادر - بانتظار تسجيل الحسابات',
                        'invoice_number' => $primaryInvoice?->invoice_number,
                        'matching_status' => $primaryInvoice?->matching_status,
                        'accountant_name' => $primaryInvoice?->createdBy?->name ?? ($primaryInvoice ? 'الحسابات' : null),
                        'order_status' => $order->status,
                        'created_at' => $order->created_at?->toIso8601String(),
                    ];
                }
            } else {
                // حالة أمر بدون تفصيل بنود
                $reportRows[] = [
                    'id' => "PO-{$order->id}",
                    'invoice_id' => $primaryInvoice?->id,
                    'receipt_id' => $targetReceipt?->id ?? $approvedReceipt?->id,
                    'receipt_number' => $targetReceipt?->receipt_number ?? $approvedReceipt?->receipt_number,
                    'photo_url' => $targetReceipt?->photo_url ?? $approvedReceipt?->photo_url,
                    'has_receipt_attachment' => $hasReceiptAttachment,
                    'receipt_view_allowed' => true,
                    'purchase_order_id' => $order->id,
                    'grand_total' => (float) $order->grand_total,
                    'date_basis' => $dateBasis,
                    'primary_date' => $primaryDate,
                    'primary_date_formatted' => $primaryDate ? Carbon::parse($primaryDate)->format('d/m/Y') : '—',
                    'po_date' => $poDate,
                    'po_date_formatted' => $poDate ? Carbon::parse($poDate)->format('d/m/Y') : '—',
                    'pr_date' => $prDate,
                    'pr_date_formatted' => $prDate ? Carbon::parse($prDate)->format('d/m/Y') : '—',
                    'delivery_date' => $deliveryDate,
                    'delivery_date_formatted' => $deliveryDate ? Carbon::parse($deliveryDate)->format('d/m/Y') : '—',
                    'po_number' => $order->po_number,
                    'po_number_short' => preg_replace('/^PO-\d{4}-0*/', '', $order->po_number) ?: $order->po_number,
                    'pr_number' => $requestModel?->request_number,
                    'item_name' => 'أمر شراء #' . $order->po_number,
                    'uom' => 'إجمالي',
                    'quantity' => 1,
                    'unit_price' => (float) $order->grand_total,
                    'total_price' => (float) $order->grand_total,
                    'received_quantity' => null,
                    'supplier_name' => $order->supplier?->company_name ?? $order->supplier?->name ?? '—',
                    'supplier_id' => $order->supplier_id,
                    'parcel_reference' => $defaultParcelRef,
                    'region' => $defaultRegion,
                    'department_id' => $deptId,
                    'department_name' => $deptName,
                    'department_code' => $defaultDept?->code,
                    'works' => $requestModel?->notes ?: '—',
                    'accounting_status' => $primaryInvoice ? 'VERIFIED' : 'PENDING',
                    'accounting_status_label' => $primaryInvoice ? 'مسقط ومسجل بالحسابات' : 'صادر - بانتظار تسجيل الحسابات',
                    'invoice_number' => $primaryInvoice?->invoice_number,
                    'matching_status' => $primaryInvoice?->matching_status,
                    'accountant_name' => $primaryInvoice?->createdBy?->name ?? null,
                    'order_status' => $order->status,
                    'created_at' => $order->created_at?->toIso8601String(),
                ];
            }
        }

        // 5. Calculate Summary Metrics
        $totalOrders = count(array_unique(array_column($reportRows, 'purchase_order_id')));
        $totalItemsCount = count($reportRows);
        $totalAmount = array_sum(array_column($reportRows, 'total_price'));
        $totalQuantity = array_sum(array_column($reportRows, 'quantity'));
        $uniqueSuppliers = count(array_unique(array_filter(array_column($reportRows, 'supplier_name'), fn ($s) => $s && $s !== '—')));
        $uniqueParcels = count(array_unique(array_filter(array_column($reportRows, 'parcel_reference'), fn ($p) => $p && $p !== '—')));
        $verifiedCount = count(array_filter($reportRows, fn ($r) => ($r['accounting_status'] ?? '') === 'VERIFIED'));

        // 6. Pagination calculation (Default 50 rows per page, supports per_page=ALL for full export)
        $page = max(1, (int) $request->query('page', 1));
        $perPageParam = $request->query('per_page');
        $isAll = $perPageParam === 'ALL' || $perPageParam === 'all' || (is_numeric($perPageParam) && (int) $perPageParam <= 0);
        $perPage = $isAll ? max(1, count($reportRows)) : (is_numeric($perPageParam) ? max(1, (int) $perPageParam) : 50);

        $totalRows = count($reportRows);
        $lastPage = $isAll ? 1 : max(1, (int) ceil($totalRows / $perPage));
        $slicedRows = $isAll ? $reportRows : array_values(array_slice($reportRows, ($page - 1) * $perPage, $perPage));

        // 7. List of available active departments for the filter dropdown
        $allDepartments = Department::query()
            ->orderBy('name')
            ->get(['id', 'name', 'code']);

        return response()->json([
            'filters' => [
                'filter_type' => $filterType,
                'date_basis' => $dateBasis,
                'actual_only' => $actualOnly,
                'date' => $request->query('date'),
                'month' => $request->query('month', now()->format('Y-m')),
                'from_date' => $request->query('from_date'),
                'to_date' => $request->query('to_date'),
                'department_id' => $departmentId,
                'supplier_id' => $supplierId,
                'accounting_filter' => $accountingFilter,
                'date_label' => $dateLabel,
            ],
            'pagination' => [
                'current_page' => $page,
                'per_page' => $perPage,
                'total' => $totalRows,
                'last_page' => $lastPage,
                'from' => $totalRows > 0 ? (($page - 1) * $perPage + 1) : 0,
                'to' => min($page * $perPage, $totalRows),
            ],
            'metrics' => [
                'total_amount' => $totalAmount,
                'total_quantity' => $totalQuantity,
                'total_orders_count' => $totalOrders,
                'total_items_count' => $totalItemsCount,
                'suppliers_count' => $uniqueSuppliers,
                'parcels_count' => $uniqueParcels,
                'verified_items_count' => $verifiedCount,
            ],
            'departments' => $allDepartments,
            'rows' => $slicedRows,
        ]);
    }
}
