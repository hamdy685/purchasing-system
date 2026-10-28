<?php

namespace App\Services;

use App\Models\Accounting\Account;
use App\Models\Accounting\CostCenter;
use App\Models\Accounting\JournalEntry;
use App\Models\Accounting\JournalEntryLine;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseReceipt;
use App\Models\Supplier;
use App\Models\SupplierBalance;
use App\Models\SupplierInvoice;
use App\Models\SupplierPayment;
use App\Models\User;
use App\Services\LandParcelService;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

class SupplierInvoiceService
{
    public const ACCOUNTANT_DEPARTMENT_MAPPINGS = [
        'general_accountant' => ['EXECUTION', 'FINISHING', 'BUILDINGS', 'OFFICE'],
        'site_accountant' => ['EXECUTION', 'FINISHING', 'BUILDINGS', 'SITE'],
        'licenses_accountant' => ['LICENSES'],
        'buffet_accountant' => ['BUFFET'],
        'development_accountant' => ['DEVELOPMENT', 'MARKETING', 'SALES'],
    ];

    public const SITE_ACCOUNTANT_DEPARTMENT_CODES = ['EXECUTION', 'FINISHING', 'BUILDINGS'];

    public function isGeneralAccountant(?User $user): bool
    {
        return $user?->isGeneralAccountant() ?? false;
    }

    public function getDepartmentAccountantRole(?User $user): ?string
    {
        if (! $user) {
            return null;
        }

        foreach (array_keys(self::ACCOUNTANT_DEPARTMENT_MAPPINGS) as $role) {
            if ($user->hasRole($role)) {
                return $role;
            }
        }

        return null;
    }

    public function isRestrictedDepartmentAccountant(?User $user): bool
    {
        if (! $user || $user->hasRole('admin')) {
            return false;
        }

        return $this->getDepartmentAccountantRole($user) !== null;
    }

    public function isRestrictedSiteAccountant(?User $user): bool
    {
        return $this->isRestrictedDepartmentAccountant($user);
    }

    public function getAllowedDepartmentCodesForAccountant(?User $user): ?array
    {
        if (! $user || $user->hasRole('admin')) {
            return null;
        }

        // General Accountant (Eng. Habiba) action scope is strictly the 4 departments:
        // EXECUTION, FINISHING, BUILDINGS, OFFICE
        if ($user->hasRole('general_accountant') || $this->isGeneralAccountant($user)) {
            return ['EXECUTION', 'FINISHING', 'BUILDINGS', 'OFFICE'];
        }

        $role = $this->getDepartmentAccountantRole($user);
        if ($role && isset(self::ACCOUNTANT_DEPARTMENT_MAPPINGS[$role])) {
            return self::ACCOUNTANT_DEPARTMENT_MAPPINGS[$role];
        }

        return null;
    }

    /**
     * Get the active General Accountant user (Eng. Habiba).
     */
    public function getGeneralAccountant(): ?User
    {
        return User::where('is_active', true)
            ->where(function ($q) {
                $q->whereHas('roles', fn ($rq) => $rq->where('slug', 'general_accountant'))
                  ->orWhere('email', 'habiba@gmail.com')
                  ->orWhere('email', 'habiba@ashbiliya.com');
            })
            ->first();
    }

    /**
     * Resolve accountants for a given department.
     * If the department has a dedicated accountant, return them.
     * Otherwise, fallback to the General Accountant (Eng. Habiba) ONLY if within her 4-department scope.
     */
    public function getAccountantsForDepartment(?string $deptCode): \Illuminate\Support\Collection
    {
        $deptAccountants = collect();
        if ($deptCode) {
            foreach (self::ACCOUNTANT_DEPARTMENT_MAPPINGS as $roleSlug => $deptCodes) {
                if (in_array($deptCode, $deptCodes, true)) {
                    $users = User::whereHas('roles', fn ($q) => $q->where('slug', $roleSlug))
                        ->where('is_active', true)
                        ->get();
                    $deptAccountants = $deptAccountants->merge($users);
                }
            }

            // Also resolve any accountants directly assigned to this department
            $department = \App\Models\Department::where('code', $deptCode)->first();
            if ($department) {
                $deptUsers = User::where('department_id', $department->id)
                    ->whereHas('roles', fn ($q) => $q->whereIn('slug', ['accountant', 'site_accountant', 'licenses_accountant', 'buffet_accountant', 'development_accountant', 'general_accountant']))
                    ->where('is_active', true)
                    ->get();
                if ($deptUsers->isNotEmpty()) {
                    $deptAccountants = $deptAccountants->merge($deptUsers);
                }
            }
        }

        // Fallback: If no dedicated accountant mapped, route to General Accountant ONLY if the department is in her 4-department scope
        if ($deptAccountants->isEmpty() && in_array($deptCode, ['EXECUTION', 'FINISHING', 'BUILDINGS', 'OFFICE'], true)) {
            $generalAccountant = $this->getGeneralAccountant();
            if ($generalAccountant) {
                $deptAccountants = collect([$generalAccountant]);
            }
        }

        return $deptAccountants->unique('id')->values();
    }

    public function approvedReceipts(int $limit = 100, ?User $user = null, ?string $statusFilter = 'pending')
    {
        return PurchaseReceipt::with([
            'purchaseOrder.supplier',
            'purchaseOrder.createdBy',
            'purchaseOrder.accountingReviewer',
            'purchaseOrder.purchaseRequest.department',
            'purchaseOrder.purchaseRequest.requester',
            'purchaseOrder.purchaseRequest.assignedReviewer',
            'purchaseOrder.purchaseRequest.siteEngineer',
            'purchaseOrder.purchaseRequest.approvalHistory.actor',
            'purchaseOrder.purchaseRequest.items.item',
            'purchaseOrder.purchaseRequest.items.supplier',
            'purchaseOrder.items.item',
            'purchaseOrder.items.supplier',
            'purchaseOrder.items.prItem.supplier',
            'purchaseOrder.approvalHistory.actor',
            'warehouseKeeper',
            'siteEngineer',
            'accountantRecordedBy',
            'items.purchaseOrderItem.item',
            'items.purchaseOrderItem.supplier',
            'items.purchaseOrderItem.prItem.supplier',
        ])
            ->where('status', 'APPROVED')
            ->where(function ($query) {
                // Internal warehouse receipts and office supplies receipts require a completed Actual PO before appearing in Accounting
                $internalSupplier = \App\Models\Supplier::getOrCreateInternalWarehouseSupplier();
                $query->where(function ($nonWhQuery) use ($internalSupplier) {
                    $nonWhQuery->where('supplier_id', '!=', $internalSupplier->id)
                               ->whereHas('purchaseOrder', function ($poQ) use ($internalSupplier) {
                                   $poQ->where('supplier_id', '!=', $internalSupplier->id)
                                       ->whereDoesntHave('purchaseRequest', function ($prQ) {
                                           $prQ->where('request_type', 'OFFICE_SUPPLIES');
                                       });
                               });
                })->orWhereHas('purchaseOrder', function ($poQuery) {
                    $poQuery->where('status', '!=', 'PENDING_ACTUAL_PO')
                        ->where(function ($q) {
                            $q->whereNotNull('finalized_at')
                              ->orWhereIn('status', ['ISSUED', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED']);
                        });
                });
            })
            ->when($statusFilter === 'recorded', function ($query) {
                $query->whereNotNull('accountant_recorded_at');
            })
            ->when($statusFilter === 'pending' || $statusFilter === null, function ($query) {
                $query->whereNull('accountant_recorded_at')
                      ->whereDoesntHave('supplierInvoices', function ($iq) {
                          $iq->whereNotIn('status', ['VOIDED', 'CANCELLED']);
                      });
            })
            ->when($this->getAllowedDepartmentCodesForAccountant($user), function ($query, $allowedCodes) {
                $query->whereHas('purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            })
            ->orderByDesc('site_engineer_approved_at')
            ->limit($limit)
            ->get();
    }

    public function invoices(?int $supplierId = null, int $limit = 200, ?User $user = null)
    {
        return SupplierInvoice::with([
            'supplier',
            'purchaseOrder.purchaseRequest.department',
            'purchaseReceipt',
            'paymentAllocations.payment',
            'landAllocations.parcel',
            'journalEntry.lines.account',
        ])
            ->when($supplierId, fn ($query) => $query->where('supplier_id', $supplierId))
            ->when($this->getAllowedDepartmentCodesForAccountant($user), function ($query, $allowedCodes) {
                $query->whereHas('purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            })
            ->orderByDesc('invoice_date')
            ->orderByDesc('id')
            ->limit($limit)
            ->get();
    }

    public function createInvoice(
        User $accountant,
        PurchaseOrder $purchaseOrder,
        PurchaseReceipt $receipt,
        float $amount,
        ?string $invoiceNumber = null,
        ?string $invoiceDate = null,
        ?string $dueDate = null,
        array $landAllocations = [],
        ?string $notes = null,
        ?int $supplierId = null
    ): SupplierInvoice {
        $receipt->loadMissing(['purchaseOrder', 'items.purchaseOrderItem']);
        $purchaseOrder->loadMissing(['supplier', 'items']);

        if ($receipt->purchase_order_id !== $purchaseOrder->id) {
            throw new \RuntimeException('إذن الاستلام غير مرتبط بأمر الشراء المحدد.');
        }
        if ($receipt->status !== 'APPROVED') {
            throw new \RuntimeException('لا يمكن تسجيل فاتورة قبل اعتماد إذن الاستلام.');
        }
        $purchaseOrder->loadMissing('purchaseRequest');
        if ($purchaseOrder->status === 'PENDING_ACTUAL_PO' && ($receipt->isInternalWarehouse() || $purchaseOrder->purchaseRequest?->isOfficeRequest())) {
            throw new \RuntimeException('يحظر تسجيل فاتورة أو قيود محاسبية قبل إصدار أمر الشراء الفعلي بالكامل من إدارة المشتريات.');
        }
        if ($receipt->isInternalWarehouse() && ! $purchaseOrder->finalized_at) {
            throw new \RuntimeException('يحظر تسجيل فاتورة أو قيود محاسبية لطلبات المخزن الداخلي قبل إصدار أمر الشراء الفعلي بالكامل.');
        }

        $allowedCodes = $this->getAllowedDepartmentCodesForAccountant($accountant);
        if ($allowedCodes !== null) {
            $purchaseOrder->loadMissing('purchaseRequest.department');
            $deptCode = $purchaseOrder->purchaseRequest?->department?->code;
            if ($deptCode && ! in_array($deptCode, $allowedCodes, true)) {
                throw new \RuntimeException('غير مصرح لك بتسجيل فواتير لهذا القسم.');
            }
        }

        if ($amount <= 0) {
            throw ValidationException::withMessages(['amount' => ['قيمة الفاتورة يجب أن تكون أكبر من صفر.']]);
        }
        if (SupplierInvoice::where('purchase_receipt_id', $receipt->id)->exists()) {
            throw new \RuntimeException('تم تسجيل فاتورة لهذا إذن الاستلام بالفعل.');
        }

        $normalizedInvoiceNumber = trim((string) $invoiceNumber);
        if ($normalizedInvoiceNumber === '') {
            $prefix = 'INV-';
            $maxSeq = 0;
            $existing = SupplierInvoice::where('invoice_number', 'like', "{$prefix}%")->pluck('invoice_number');
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
            $seq = max(1, $maxSeq + 1);
            $normalizedInvoiceNumber = "{$prefix}{$seq}";
            while (SupplierInvoice::where('invoice_number', $normalizedInvoiceNumber)->exists()) {
                $seq++;
                $normalizedInvoiceNumber = "{$prefix}{$seq}";
            }
        } elseif (SupplierInvoice::where('invoice_number', $normalizedInvoiceNumber)->exists()) {
            throw ValidationException::withMessages(['invoice_number' => ['رقم الفاتورة مستخدم من قبل. أدخل رقمًا مختلفًا أو راجع أرشيف فواتير المورد.']]);
        }

        $targetSupplierId = $supplierId ?: $purchaseOrder->supplier_id;
        if (! $targetSupplierId) {
            $firstItemSupplier = $purchaseOrder->items()->pluck('supplier_id')->filter()->first();
            $targetSupplierId = $firstItemSupplier ?: null;
        }

        return DB::transaction(function () use ($accountant, $purchaseOrder, $receipt, $amount, $normalizedInvoiceNumber, $invoiceDate, $dueDate, $landAllocations, $notes, $targetSupplierId): SupplierInvoice {
            $invoice = SupplierInvoice::create([
                'supplier_id' => $targetSupplierId,
                'purchase_order_id' => $purchaseOrder->id,
                'purchase_receipt_id' => $receipt->id,
                'created_by_user_id' => $accountant->id,
                'invoice_number' => $normalizedInvoiceNumber,
                'amount' => round($amount, 2),
                'invoice_date' => $invoiceDate ?: now()->toDateString(),
                'due_date' => $dueDate,
                'status' => 'OPEN',
                'matching_status' => 'PENDING',
                'paid_amount' => 0,
                'outstanding_amount' => round($amount, 2),
                'notes' => $notes,
            ]);

            app(LandParcelService::class)->recordInvoiceAllocations($accountant, $invoice, $landAllocations);
            if ($invoice->supplier_id) {
                $this->refreshSupplierBalance($invoice->supplier_id);
            }

            // Auto-resolve / mark read all notifications related to this PO and Receipt
            app(NotificationService::class)->markOrderAndReceiptNotificationsAsRead($purchaseOrder, $receipt);

            return $invoice->fresh(['supplier', 'purchaseOrder', 'purchaseReceipt', 'landAllocations.parcel']);
        });
    }

    public function matchThreeWay(User $accountant, SupplierInvoice $invoice): SupplierInvoice
    {
        $invoice->loadMissing([
            'purchaseOrder.supplier',
            'purchaseOrder.items',
            'purchaseReceipt.items.purchaseOrderItem',
        ]);

        if ($invoice->matching_status === 'MATCHED') {
            return $invoice;
        }
        if ($invoice->purchaseReceipt->status !== 'APPROVED') {
            throw new \RuntimeException('لا يمكن المطابقة قبل اعتماد إذن الاستلام.');
        }
        if ($invoice->purchaseReceipt->purchase_order_id !== $invoice->purchase_order_id) {
            throw new \RuntimeException('المستندات الثلاثة غير مرتبطة بنفس أمر الشراء.');
        }
        $validSupplierIds = $invoice->purchaseOrder->items->pluck('supplier_id')->filter()->push($invoice->purchaseOrder->supplier_id)->unique()->map(fn ($v) => (int) $v)->all();
        if (!in_array((int) $invoice->supplier_id, $validSupplierIds, true)) {
            throw new \RuntimeException('المورد في الفاتورة لا يطابق المورد في أمر الشراء أو أي من بنوده.');
        }

        $receivedValue = $this->calculateReceiptValue($invoice->purchaseReceipt);
        if (abs((float) $invoice->amount - $receivedValue) > 0.01) {
            throw ValidationException::withMessages([
                'matching' => [sprintf('فشل التحقق: مبلغ الفاتورة %.2f لا يساوي قيمة الاستلام %.2f ج.م.', $invoice->amount, $receivedValue)],
            ]);
        }

        $invoice->update([
            'matching_status' => 'MATCHED',
            'status' => ((float) $invoice->paid_amount > 0 && (float) $invoice->outstanding_amount <= 0) ? 'PAID' : 'OPEN',
            'matched_at' => now(),
            'matched_by_user_id' => $accountant->id,
            'matching_notes' => 'تمت مطابقة أمر الشراء وإذن الاستلام وفاتورة المورد.',
            'outstanding_amount' => max(0, round((float) $invoice->amount - (float) $invoice->paid_amount, 2)),
        ]);

        $this->refreshSupplierBalance($invoice->supplier_id);
        $this->generateSupplierInvoiceJournalEntry($invoice);
        app(NotificationService::class)->markOrderAndReceiptNotificationsAsRead($invoice->purchaseOrder, $invoice->purchaseReceipt);

        return $invoice->fresh([
            'supplier',
            'purchaseOrder',
            'purchaseReceipt',
            'paymentAllocations.payment',
            'landAllocations.parcel',
            'journalEntry.lines.account',
        ]);
    }

    public function recordPayment(
        User $accountant,
        SupplierInvoice $invoice,
        float $amount,
        ?string $paymentDate = null,
        string $paymentMethod = 'BANK_TRANSFER',
        ?string $referenceNumber = null,
        ?string $notes = null,
    ): array {
        return $this->recordSupplierPayment(
            $accountant,
            Supplier::findOrFail($invoice->supplier_id),
            $amount,
            $paymentDate,
            $paymentMethod,
            $referenceNumber,
            $notes,
        );
    }

    /**
     * Record a supplier-level payment and allocate it oldest-first across all open debts.
     * Payments are independent of invoice matching status — they apply to any OPEN or PARTIALLY_PAID invoice.
     */
    public function recordSupplierPayment(
        User $accountant,
        Supplier $supplier,
        float $amount,
        ?string $paymentDate = null,
        string $paymentMethod = 'BANK_TRANSFER',
        ?string $referenceNumber = null,
        ?string $notes = null,
    ): array {
        if ($amount <= 0) {
            throw ValidationException::withMessages(['amount' => ['قيمة الدفعة يجب أن تكون أكبر من صفر.']]);
        }

        return DB::transaction(function () use ($accountant, $supplier, $amount, $paymentDate, $paymentMethod, $referenceNumber, $notes): array {
            $supplierId = $supplier->id;
            $remaining = round($amount, 2);

            $payPrefix = 'PAY-';
            $maxPaySeq = 0;
            $existingPayments = SupplierPayment::where('payment_number', 'like', "{$payPrefix}%")->pluck('payment_number');
            foreach ($existingPayments as $pNum) {
                $parts = explode('-', (string) $pNum);
                $lastPart = end($parts);
                if (is_numeric($lastPart)) {
                    $pSeq = (int) $lastPart;
                    if ($pSeq > $maxPaySeq) {
                        $maxPaySeq = $pSeq;
                    }
                }
            }
            $paySeq = max(1, $maxPaySeq + 1);
            $paymentNumber = "{$payPrefix}{$paySeq}";
            while (SupplierPayment::where('payment_number', $paymentNumber)->exists()) {
                $paySeq++;
                $paymentNumber = "{$payPrefix}{$paySeq}";
            }

            $payment = SupplierPayment::create([
                'supplier_id' => $supplierId,
                'accountant_user_id' => $accountant->id,
                'payment_number' => $paymentNumber,
                'amount' => round($amount, 2),
                'payment_date' => $paymentDate ?: now()->toDateString(),
                'payment_method' => $paymentMethod,
                'reference_number' => $referenceNumber,
                'allocated_amount' => 0,
                'overpayment_amount' => 0,
                'notes' => $notes,
            ]);

            $debts = SupplierInvoice::where('supplier_id', $supplierId)
                ->whereIn('status', ['OPEN', 'PARTIALLY_PAID'])
                ->where('outstanding_amount', '>', 0)
                ->orderBy('invoice_date')
                ->orderBy('id')
                ->lockForUpdate()
                ->get();

            foreach ($debts as $debt) {
                if ($remaining <= 0) {
                    break;
                }
                $allocation = round(min($remaining, (float) $debt->outstanding_amount), 2);
                if ($allocation <= 0) {
                    continue;
                }

                $payment->allocations()->create([
                    'supplier_invoice_id' => $debt->id,
                    'amount' => $allocation,
                ]);

                $paidAmount = round((float) $debt->paid_amount + $allocation, 2);
                $outstanding = max(0, round((float) $debt->amount - $paidAmount, 2));
                $debt->update([
                    'paid_amount' => $paidAmount,
                    'outstanding_amount' => $outstanding,
                    'status' => $outstanding <= 0 ? 'PAID' : 'PARTIALLY_PAID',
                ]);

                $remaining = round($remaining - $allocation, 2);
            }

            $allocated = round($amount - $remaining, 2);
            $payment->update([
                'allocated_amount' => $allocated,
                'overpayment_amount' => max(0, $remaining),
            ]);

            $this->refreshSupplierBalance($supplierId);
            $this->generateSupplierPaymentJournalEntry($payment);

            return [
                'payment' => $payment->fresh(['supplier', 'accountant', 'allocations.invoice.purchaseOrder', 'journalEntry.lines.account']),
                'supplier_balance' => $this->getSupplierBalance($supplierId),
                'overpayment_warning' => $remaining > 0,
                'message' => $remaining > 0
                    ? sprintf('تم تسجيل الدفعة مع تحذير: %.2f ج.م تجاوزت إجمالي المديونية الحالية.', $remaining)
                    : 'تم تسجيل الدفعة على حساب المورد وتوزيعها على أقدم مديونية أولًا.',
            ];
        });
    }

    public function supplierAccounts(int $limit = 200, ?User $user = null): array
    {
        $allowedCodes = $this->getAllowedDepartmentCodesForAccountant($user);

        return Supplier::query()
            ->where('is_active', true)
            ->when($allowedCodes !== null, function ($query) use ($allowedCodes) {
                $query->where(function ($sq) use ($allowedCodes) {
                    $sq->whereHas('purchaseOrders.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                        $dq->whereIn('code', $allowedCodes);
                    })->orWhereHas('invoices.purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                        $dq->whereIn('code', $allowedCodes);
                    });
                });
            })
            ->orderBy('company_name')
            ->limit($limit)
            ->get()
            ->map(fn (Supplier $supplier) => $this->supplierSummary($supplier, $user))
            ->values()
            ->all();
    }

    public function supplierAccount(Supplier $supplier, ?User $user = null, ?string $fromDate = null): array
    {
        $allowedCodes = $this->getAllowedDepartmentCodesForAccountant($user);

        $supplier->load([
            'purchaseOrders' => fn ($query) => $query
                ->when($allowedCodes !== null, function ($q) use ($allowedCodes) {
                    $q->whereHas('purchaseRequest.department', function ($dq) use ($allowedCodes) {
                        $dq->whereIn('code', $allowedCodes);
                    });
                })
                ->orderByDesc('created_at'),
            'invoices' => fn ($query) => $query
                ->when($allowedCodes !== null, function ($q) use ($allowedCodes) {
                    $q->whereHas('purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                        $dq->whereIn('code', $allowedCodes);
                    });
                })
                ->with(['purchaseOrder', 'purchaseReceipt', 'paymentAllocations.payment', 'landAllocations.parcel']),
            'payments' => fn ($query) => $query
                ->when($allowedCodes !== null, function ($q) use ($allowedCodes) {
                    $q->whereHas('allocations.invoice.purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                        $dq->whereIn('code', $allowedCodes);
                    });
                })
                ->orderByDesc('payment_date'),
            'balanceAccount',
        ]);

        return [
            'supplier' => $supplier,
            'summary' => $this->supplierSummary($supplier, $user),
            'invoices' => $supplier->invoices->sortByDesc('invoice_date')->values(),
            'payments' => $supplier->payments->sortByDesc('payment_date')->values(),
            'ledger' => $this->buildSupplierLedger($supplier, $user, $fromDate),
        ];
    }

    public function buildSupplierLedger(Supplier $supplier, ?User $user = null, ?string $fromDate = null): array
    {
        $allowedCodes = $this->getAllowedDepartmentCodesForAccountant($user);
        $rows = [];

        // 1. Opening Balance
        if ((float) $supplier->opening_balance > 0) {
            $obDate = $supplier->created_at ? $supplier->created_at->format('Y-m-d') : '2026-01-01';
            $rows[] = [
                'id' => 'OB-' . $supplier->id,
                'type' => 'OPENING_BALANCE',
                'sort_order' => 1,
                'date' => $obDate,
                'date_formatted' => Carbon::parse($obDate)->format('d/m/Y'),
                'description' => 'رصيد افتتاحي سابق' . ($supplier->opening_balance_notes ? " ({$supplier->opening_balance_notes})" : ''),
                'parcel' => '—',
                'region' => '—',
                'quantity' => null,
                'uom' => '—',
                'unit_price' => null,
                'value' => (float) $supplier->opening_balance,
                'paid' => 0.0,
                'reference' => 'رصيد سابق',
            ];
        }

        // 2. Supplies (Items supplied by this supplier from Purchase Orders & Receipts)
        $poItems = PurchaseOrderItem::where(function ($q) use ($supplier) {
                $q->where('supplier_id', $supplier->id)
                  ->orWhere(function ($sub) use ($supplier) {
                      $sub->whereNull('supplier_id')
                          ->whereHas('purchaseOrder', fn ($po) => $po->where('supplier_id', $supplier->id));
                  });
            })
            ->whereHas('purchaseOrder', function ($q) use ($allowedCodes) {
                $q->where(function ($sub) {
                    $sub->whereNotNull('finalized_at')
                        ->orWhereIn('status', ['APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'])
                        ->orWhereHas('supplierInvoices', fn ($iq) => $iq->whereNotIn('status', ['VOIDED', 'CANCELLED']));
                })
                ->whereNotIn('status', ['PO_DRAFT', 'DRAFT', 'CANCELLED', 'VOIDED', 'REJECTED', 'PENDING_ACTUAL_PO'])
                ->when($allowedCodes !== null, function ($dq) use ($allowedCodes) {
                    $dq->whereHas('purchaseRequest.department', fn ($d) => $d->whereIn('code', $allowedCodes));
                });
            })
            ->with([
                'purchaseOrder.purchaseRequest.department',
                'purchaseOrder.purchaseRequest.landParcel',
                'purchaseOrder.purchaseReceipts.items',
                'purchaseOrder.supplierInvoices.landAllocations.parcel',
                'prItem',
                'item',
            ])
            ->get();

        foreach ($poItems as $poItem) {
            $order = $poItem->purchaseOrder;
            $requestModel = $order?->purchaseRequest;

            $receipt = $order?->purchaseReceipts?->firstWhere('status', 'APPROVED') ?? $order?->purchaseReceipts?->first();
            $invoice = $order?->supplierInvoices?->firstWhere('status', '!=', 'VOIDED');

            $date = $receipt?->received_at?->format('Y-m-d')
                ?? ($invoice?->invoice_date?->format('Y-m-d')
                ?? ($order?->finalized_at?->format('Y-m-d')
                ?? ($order?->actual_delivery_date?->format('Y-m-d')
                ?? ($order?->order_date?->format('Y-m-d')
                ?? ($order?->created_at?->format('Y-m-d') ?? now()->format('Y-m-d'))))));

            $parcel = $poItem->item_reference
                ?: ($poItem->prItem?->item_reference
                ?: ($poItem->prItem?->parcel_reference
                ?: ($invoice?->landAllocations?->first()?->parcel?->parcel_reference
                ?: ($requestModel?->parcel_reference
                ?: ($requestModel?->landParcel?->parcel_reference ?: '—')))));

            $region = $poItem->region
                ?: ($poItem->prItem?->region
                ?: ($invoice?->landAllocations?->first()?->parcel?->region
                ?: ($requestModel?->region
                ?: ($requestModel?->landParcel?->region ?: '—'))));

            $receiptItem = $receipt?->items?->firstWhere('purchase_order_item_id', $poItem->id);
            $receivedQuantity = $receiptItem?->received_quantity !== null ? (float) $receiptItem->received_quantity : null;
            // Once the Actual PO is issued it is what the supplier is owed (and what the invoice carries);
            // the receipt keeps the quantity actually received, which may differ (over/under receipt).
            $quantity = $order?->finalized_at
                ? (float) $poItem->quantity
                : (float) ($receivedQuantity ?? $poItem->quantity);
            $unitPrice = (float) $poItem->unit_price;
            $value = round($quantity * $unitPrice, 2);

            $desc = $poItem->item_description ?: ($poItem->item?->name ?: 'صنف');

            $rows[] = [
                'id' => "SUP-PO{$order?->id}-ITEM{$poItem->id}",
                'type' => 'SUPPLY',
                'sort_order' => 2,
                'date' => $date,
                'date_formatted' => Carbon::parse($date)->format('d/m/Y'),
                'description' => $desc,
                'parcel' => $parcel,
                'region' => $region,
                'quantity' => $quantity,
                'received_quantity' => $receivedQuantity,
                'uom' => $poItem->uom ?? '—',
                'unit_price' => $unitPrice,
                'value' => $value,
                'paid' => 0.0,
                'reference' => $order?->po_number ?? "PO #{$order?->id}",
                'purchase_order_id' => $order?->id,
                'receipt_number' => $receipt?->receipt_number,
                'invoice_number' => $invoice?->invoice_number,
            ];
        }

        // 3. Payments (الواصل)
        $payments = $supplier->payments()
            ->when($allowedCodes !== null, function ($q) use ($allowedCodes) {
                $q->whereHas('allocations.invoice.purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            })
            ->with(['allocations.invoice.landAllocations.parcel'])
            ->orderBy('payment_date')
            ->get();

        foreach ($payments as $payment) {
            $date = $payment->payment_date ? Carbon::parse($payment->payment_date)->format('Y-m-d') : $payment->created_at->format('Y-m-d');
            $methodName = match ($payment->payment_method) {
                'CASH' => 'نقدي',
                'BANK_TRANSFER' => 'تحويل بنكي',
                'CHEQUE' => 'شيك',
                default => $payment->payment_method,
            };

            $desc = "سداد دفعة ({$methodName})"
                . ($payment->payment_number ? " - إيصال #{$payment->payment_number}" : ($payment->reference_number ? " - مرجع #{$payment->reference_number}" : ''))
                . ($payment->notes ? " - {$payment->notes}" : '');

            $parcel = $payment->allocations->map(fn ($a) => $a->invoice?->landAllocations?->first()?->parcel?->parcel_reference)->filter()->first() ?? '—';
            $region = $payment->allocations->map(fn ($a) => $a->invoice?->landAllocations?->first()?->parcel?->region)->filter()->first() ?? '—';

            $rows[] = [
                'id' => "PAY-{$payment->id}",
                'type' => 'PAYMENT',
                'sort_order' => 3,
                'date' => $date,
                'date_formatted' => Carbon::parse($date)->format('d/m/Y'),
                'description' => $desc,
                'parcel' => $parcel,
                'region' => $region,
                'quantity' => null,
                'uom' => '—',
                'unit_price' => null,
                'value' => 0.0,
                'paid' => (float) $payment->amount,
                'reference' => $payment->payment_number ?: ($payment->reference_number ?: "PAY #{$payment->id}"),
                'payment_id' => $payment->id,
            ];
        }

        // 4. Sort chronologically by date ASC, then sort_order
        usort($rows, function ($a, $b) {
            $cmp = strcmp($a['date'], $b['date']);
            if ($cmp !== 0) {
                return $cmp;
            }
            return ($a['sort_order'] ?? 2) <=> ($b['sort_order'] ?? 2);
        });

        // 5. If fromDate is set, calculate Balance Brought Forward (رصيد ما قبل الفترة)
        $cleanFromDate = $fromDate ? trim($fromDate) : null;
        if ($cleanFromDate) {
            $priorRows = [];
            $currentPeriodRows = [];
            foreach ($rows as $r) {
                // An opening balance record is by definition from a prior period
                if ($r['type'] === 'OPENING_BALANCE' || $r['date'] < $cleanFromDate) {
                    $priorRows[] = $r;
                } else {
                    $currentPeriodRows[] = $r;
                }
            }

            $priorBalance = 0.0;
            foreach ($priorRows as $pr) {
                $priorBalance += (float) $pr['value'] - (float) $pr['paid'];
            }
            $priorBalance = round($priorBalance, 2);

            $bfDateFormatted = Carbon::parse($cleanFromDate)->subDay()->format('d/m/Y');
            $bfRow = [
                'id' => 'BF-' . $supplier->id . '-' . $cleanFromDate,
                'type' => 'CARRIED_FORWARD',
                'sort_order' => 0,
                'date' => $cleanFromDate,
                'date_formatted' => $bfDateFormatted,
                'description' => 'رصيد ما قبل الفترة المنقول (Balance B/F)',
                'parcel' => '—',
                'region' => '—',
                'quantity' => null,
                'uom' => '—',
                'unit_price' => null,
                'value' => $priorBalance >= 0 ? $priorBalance : 0.0,
                'paid' => $priorBalance < 0 ? abs($priorBalance) : 0.0,
                'balance' => $priorBalance,
                'reference' => 'رصيد مرحل',
            ];

            $rows = array_merge([$bfRow], $currentPeriodRows);
            $runningBalance = $priorBalance;
            for ($i = 1; $i < count($rows); $i++) {
                $runningBalance += (float) $rows[$i]['value'] - (float) $rows[$i]['paid'];
                $rows[$i]['balance'] = round($runningBalance, 2);
            }

            return $rows;
        }

        // 6. Calculate Running Balance for all records
        $runningBalance = 0;
        foreach ($rows as &$row) {
            $runningBalance += (float) $row['value'] - (float) $row['paid'];
            $row['balance'] = round($runningBalance, 2);
        }
        unset($row);

        return $rows;
    }


    public function getSupplierBalance(int $supplierId): array
    {
        $balance = SupplierBalance::firstOrCreate(
            ['supplier_id' => $supplierId],
            ['total_invoiced' => 0, 'total_paid' => 0, 'balance' => 0]
        );

        return [
            'total_invoiced' => (float) $balance->total_invoiced,
            'total_paid' => (float) $balance->total_paid,
            'balance' => (float) $balance->balance,
            'is_overpaid' => (float) $balance->balance < 0,
            'last_activity_at' => $balance->last_activity_at,
        ];
    }

    public function setOpeningBalance(Supplier $supplier, float $openingBalance, ?string $notes = null): array
    {
        if ($openingBalance < 0) {
            throw ValidationException::withMessages(['opening_balance' => ['الرصيد الافتتاحي لا يمكن أن يكون سالباً.']]);
        }

        $supplier->update([
            'opening_balance' => round($openingBalance, 2),
            'opening_balance_notes' => $notes,
        ]);

        $this->refreshSupplierBalance($supplier->id);

        return $this->supplierAccount($supplier);
    }

    private function supplierSummary(Supplier $supplier, ?User $user = null): array
    {
        $allowedCodes = $this->getAllowedDepartmentCodesForAccountant($user);
        $isRestricted = $allowedCodes !== null;

        $openingBalance = $isRestricted ? 0 : (float) ($supplier->opening_balance ?? 0);

        $invoicesQuery = SupplierInvoice::where('supplier_id', $supplier->id)
            ->where('status', '!=', 'DRAFT')
            ->when($isRestricted, function ($q) use ($allowedCodes) {
                $q->whereHas('purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            });

        $totalInvoiced = (float) (clone $invoicesQuery)->sum('amount');

        $paymentsQuery = SupplierPayment::where('supplier_id', $supplier->id)
            ->when($isRestricted, function ($q) use ($allowedCodes) {
                $q->whereHas('allocations.invoice.purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                    $dq->whereIn('code', $allowedCodes);
                });
            });

        $totalPaid = (float) $paymentsQuery->sum('amount');
        $balance = round($openingBalance + $totalInvoiced - $totalPaid, 2);

        $openInvoicesCount = (clone $invoicesQuery)->whereIn('status', ['OPEN', 'PARTIALLY_PAID'])->count();
        $invoicesCount = (clone $invoicesQuery)->count();
        $paymentsCount = (clone $paymentsQuery)->count();

        return [
            'supplier_id' => $supplier->id,
            'company_name' => $supplier->company_name,
            'code' => $supplier->code ?? null,
            'email' => $supplier->email,
            'phone' => $supplier->phone,
            'opening_balance' => $openingBalance,
            'opening_balance_notes' => $isRestricted ? null : $supplier->opening_balance_notes,
            'total_invoiced' => $totalInvoiced,
            'total_paid' => $totalPaid,
            'balance' => $balance,
            'is_overpaid' => $balance < 0,
            'open_invoices_count' => $openInvoicesCount,
            'invoices_count' => $invoicesCount,
            'payments_count' => $paymentsCount,
        ];
    }

    private function refreshSupplierBalance(int $supplierId): SupplierBalance
    {
        $supplier = Supplier::find($supplierId);
        $openingBalance = (float) ($supplier?->opening_balance ?? 0);
        $totalInvoiced = (float) SupplierInvoice::where('supplier_id', $supplierId)
            ->where('status', '!=', 'DRAFT')
            ->sum('amount');
        $totalPaid = (float) SupplierPayment::where('supplier_id', $supplierId)->sum('amount');
        $balance = round($openingBalance + $totalInvoiced - $totalPaid, 2);

        return SupplierBalance::updateOrCreate(
            ['supplier_id' => $supplierId],
            [
                'opening_balance' => $openingBalance,
                'total_invoiced' => $totalInvoiced,
                'total_paid' => $totalPaid,
                'balance' => $balance,
                'last_activity_at' => now(),
            ]
        );
    }

    public function calculateReceiptValue(PurchaseReceipt $receipt): float
    {
        $receipt->loadMissing('items.purchaseOrderItem');

        $po = $receipt->purchaseOrder;
        if ($po) {
            $orderTotal = (float) ($po->grand_total ?: $po->total_amount);
            // When an Actual PO is issued/finalized, its grand total is the authoritative Single Source of Truth
            if ($orderTotal > 0 && ($po->isActualPo() || $po->status !== 'PO_DRAFT')) {
                return $orderTotal;
            }
        }

        return round($receipt->items->sum(function ($receiptItem): float {
            $poItem = $receiptItem->purchaseOrderItem;
            $lineTotal = (float) ($poItem?->line_total ?: $poItem?->total_price);
            if ($lineTotal > 0) {
                return $lineTotal;
            }
            $qty = (float) ($poItem?->quantity ?? $receiptItem->received_quantity);
            $price = (float) ($poItem?->unit_price ?? 0);
            return round($qty * $price, 2);
        }), 2);
    }

    /**
     * Intelligently resolve the most relevant Cost Center for a supplier invoice.
     */
    public function resolveCostCenterForInvoice(SupplierInvoice $invoice): ?int
    {
        // 1. Direct attribute on invoice if present
        if (!empty($invoice->cost_center_id)) {
            return (int) $invoice->cost_center_id;
        }

        // 2. Check land allocations
        $firstAllocation = $invoice->landAllocations()->with('parcel')->first();
        if ($firstAllocation && $firstAllocation->parcel) {
            $parcel = $firstAllocation->parcel;
            $matched = CostCenter::where('is_active', true)
                ->where(function ($q) use ($parcel) {
                    $q->where('name', 'like', "%{$parcel->parcel_reference}%")
                      ->orWhere('name', 'like', "%{$parcel->region}%")
                      ->orWhere('code', 'like', "%{$parcel->parcel_reference}%");
                })->first();
            if ($matched) {
                return $matched->id;
            }
        }

        // 3. Check purchase order -> purchase request
        $pr = $invoice->purchaseOrder?->purchaseRequest;
        if ($pr) {
            if (!empty($pr->parcel_reference)) {
                $matched = CostCenter::where('is_active', true)
                    ->where(function ($q) use ($pr) {
                        $q->where('name', 'like', "%{$pr->parcel_reference}%")
                          ->orWhere('name', 'like', "%{$pr->region}%")
                          ->orWhere('code', 'like', "%{$pr->parcel_reference}%");
                    })->first();
                if ($matched) {
                    return $matched->id;
                }
            }
        }

        // 4. Default cost center code from config
        $defaultCode = config('accounting.default_cost_center_code', 'CC-101');
        $defaultCc = CostCenter::where('code', $defaultCode)->where('is_active', true)->first();
        if ($defaultCc) {
            return $defaultCc->id;
        }

        // 5. Any active cost center
        return CostCenter::where('is_active', true)->value('id');
    }

    /**
     * Automatically generate a balanced Journal Entry when a supplier invoice is matched/approved.
     */
    public function generateSupplierInvoiceJournalEntry(SupplierInvoice $invoice): ?JournalEntry
    {
        if ($invoice->journal_entry_id) {
            return JournalEntry::find($invoice->journal_entry_id);
        }

        $expenseCode = (string) config('accounting.material_expense_account_code', '511');
        $payableCode = (string) config('accounting.supplier_payable_account_code', '2111');

        $expenseAccount = Account::where('code', $expenseCode)->first();
        $payableAccount = Account::where('code', $payableCode)->first();

        // If GL accounts are not set up in current environment, gracefully skip
        if (!$expenseAccount || !$payableAccount) {
            Log::info("Journal entry skipped for supplier invoice {$invoice->invoice_number}: Accounts {$expenseCode} or {$payableCode} not found in chart of accounts.");
            return null;
        }

        $costCenterId = $this->resolveCostCenterForInvoice($invoice);

        $invoice->loadMissing(['supplier', 'purchaseOrder']);
        $supplierName = $invoice->supplier?->company_name ?? 'مورد';
        $poNumber = $invoice->purchaseOrder?->po_number ?? '';

        $desc = "فاتورة مشتريات مورد: {$supplierName} - رقم: {$invoice->invoice_number}";
        if ($poNumber) {
            $desc .= " (أمر شراء {$poNumber})";
        }

        $journalEntry = JournalEntry::create([
            'date' => $invoice->invoice_date ?: now()->toDateString(),
            'description' => $desc,
            'reference_number' => $invoice->invoice_number,
            'status' => 'POSTED',
        ]);

        // Debit: Material Expense Account (charged to Cost Center)
        JournalEntryLine::create([
            'journal_entry_id' => $journalEntry->id,
            'account_id' => $expenseAccount->id,
            'cost_center_id' => $costCenterId,
            'debit' => $invoice->amount,
            'credit' => 0,
            'description' => "تكلفة مواد وخامات - مورد: {$supplierName} - فاتورة: {$invoice->invoice_number}",
        ]);

        // Credit: Supplier Payable Account
        JournalEntryLine::create([
            'journal_entry_id' => $journalEntry->id,
            'account_id' => $payableAccount->id,
            'cost_center_id' => null,
            'debit' => 0,
            'credit' => $invoice->amount,
            'description' => "استحقاق فاتورة مورد - {$supplierName} - فاتورة: {$invoice->invoice_number}",
        ]);

        $invoice->update(['journal_entry_id' => $journalEntry->id]);

        return $journalEntry;
    }

    /**
     * Automatically generate a balanced Journal Entry when a supplier payment is recorded.
     */
    public function generateSupplierPaymentJournalEntry(SupplierPayment $payment): ?JournalEntry
    {
        if ($payment->journal_entry_id) {
            return JournalEntry::find($payment->journal_entry_id);
        }

        $payableCode = (string) config('accounting.supplier_payable_account_code', '2111');
        $bankCode    = (string) config('accounting.bank_account_code', '1112');
        $cashCode    = (string) config('accounting.treasury_cash_account_code', '1111');

        $isCash = strtoupper((string) $payment->payment_method) === 'CASH';
        $creditAccountCode = $isCash ? $cashCode : $bankCode;

        $payableAccount = Account::where('code', $payableCode)->first();
        $creditAccount  = Account::where('code', $creditAccountCode)->first();

        if (!$payableAccount || !$creditAccount) {
            Log::info("Journal entry skipped for payment {$payment->payment_number}: Accounts {$payableCode} or {$creditAccountCode} not found in chart of accounts.");
            return null;
        }

        $payment->loadMissing('supplier');
        $supplierName = $payment->supplier?->company_name ?? 'مورد';

        $methodLabel = match (strtoupper((string) $payment->payment_method)) {
            'CASH' => 'نقدي من الخزينة',
            'BANK_TRANSFER' => 'تحويل بنكي',
            'CHEQUE' => 'شيك مصرفي',
            default => (string) $payment->payment_method,
        };

        $desc = "سداد دفعة للمورد: {$supplierName} - رقم السند: {$payment->payment_number} ({$methodLabel})";

        $journalEntry = JournalEntry::create([
            'date' => $payment->payment_date ?: now()->toDateString(),
            'description' => $desc,
            'reference_number' => $payment->reference_number ?: $payment->payment_number,
            'status' => 'POSTED',
        ]);

        // Debit: Supplier Payable (reduce liability)
        JournalEntryLine::create([
            'journal_entry_id' => $journalEntry->id,
            'account_id' => $payableAccount->id,
            'cost_center_id' => null,
            'debit' => $payment->amount,
            'credit' => 0,
            'description' => "سداد مديونية للمورد: {$supplierName} - سند: {$payment->payment_number}",
        ]);

        // Credit: Bank or Cash Treasury (reduce asset cash)
        JournalEntryLine::create([
            'journal_entry_id' => $journalEntry->id,
            'account_id' => $creditAccount->id,
            'cost_center_id' => null,
            'debit' => 0,
            'credit' => $payment->amount,
            'description' => "صرف دفعة للمورد {$supplierName} ({$methodLabel})",
        ]);

        $payment->update(['journal_entry_id' => $journalEntry->id]);

        return $journalEntry;
    }
}
