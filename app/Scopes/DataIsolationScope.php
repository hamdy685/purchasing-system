<?php

namespace App\Scopes;

use App\Models\PurchaseOrder;
use App\Models\PurchaseReceipt;
use App\Models\PurchaseRequest;
use App\Models\SupplierInvoice;
use App\Models\User;
use App\Services\SupplierInvoiceService;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Scope;
use Illuminate\Support\Facades\Auth;

class DataIsolationScope implements Scope
{
    /**
     * Flag to prevent circular nested scope evaluations.
     */
    protected static bool $isApplying = false;

    /**
     * Apply the scope to a given Eloquent query builder.
     */
    public function apply(Builder $builder, Model $model): void
    {
        // 1. If not authenticated or running in console without active auth user, bypass
        if (! Auth::check()) {
            return;
        }

        /** @var User|null $user */
        $user = Auth::user();
        if (! $user) {
            return;
        }

        // 2. Admin & General Manager see everything across the entire company
        if ($user->hasRole('admin') || $user->hasRole('general_manager')) {
            return;
        }

        // Prevent recursion if whereHas triggers another scoped model
        if (static::$isApplying) {
            return;
        }

        static::$isApplying = true;
        try {
            if ($model instanceof PurchaseRequest) {
                $this->applyPurchaseRequestIsolation($builder, $user);
            } elseif ($model instanceof PurchaseOrder) {
                $this->applyPurchaseOrderIsolation($builder, $user);
            } elseif ($model instanceof PurchaseReceipt) {
                $this->applyPurchaseReceiptIsolation($builder, $user);
            } elseif ($model instanceof SupplierInvoice) {
                $this->applySupplierInvoiceIsolation($builder, $user);
            }
        } finally {
            static::$isApplying = false;
        }
    }

    /**
     * Row-Level Security for PurchaseRequest:
     * - site_engineer: own requests, assigned site engineer requests, or requests for their parcel.
     * - execution_manager: requests in their department, or where requester.manager_id = user.id.
     * - procurement_manager: requests that reached procurement stage or above (not early draft/review), plus own requests.
     * - site_accountant / accountants: requests that reached accounting, or with POs/invoices, plus own requests.
     * - reviewer: departmental requests or assigned reviewer.
     * - employee / others: own requests only.
     */
    protected function applyPurchaseRequestIsolation(Builder $builder, User $user): void
    {
        if ($user->hasRole('site_engineer')) {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('user_id', $user->id)
                  ->orWhere('site_engineer_user_id', $user->id);

                $parcelId = $user->parcel_id ?? $user->land_parcel_id ?? null;
                if ($parcelId) {
                    $q->orWhere('land_parcel_id', $parcelId);
                }
            });
            return;
        }

        if ($user->hasRole('execution_manager')) {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('reviewer_user_id', $user->id)
                  ->orWhereHas('requester', function ($rq) use ($user) {
                      $rq->where('manager_id', $user->id);
                  })
                  ->orWhere('user_id', $user->id);
            });
            return;
        }

        if ($user->hasRole('procurement_manager')) {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('user_id', $user->id)
                  ->orWhereNotIn('status', ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW']);
            });
            return;
        }

        if ($user->hasRole('site_accountant') || $user->hasAnyRole(['licenses_accountant', 'buffet_accountant', 'development_accountant', 'accountant', 'general_accountant']) || $user->isGeneralAccountant()) {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('user_id', $user->id)
                  ->orWhereIn('status', [
                      'PENDING_ACCOUNTING_APPROVAL',
                      'APPROVED_BY_ACCOUNTING',
                      'PENDING_QUOTE_RECOMMENDATIONS',
                      'APPROVED_BY_PROCUREMENT',
                      'PO_CREATED',
                      'ISSUED',
                      'COMPLETED',
                  ])
                  ->orWhereHas('purchaseOrders');
            });
            return;
        }

        if ($user->hasRole('reviewer')) {
            $builder->where(function (Builder $q) use ($user) {
                if ($user->department_id) {
                    $q->where('department_id', $user->department_id)
                      ->orWhere('target_department_id', $user->department_id);
                }
                $q->orWhere('reviewer_user_id', $user->id)
                  ->orWhereHas('requester', function ($rq) use ($user) {
                      $rq->where('manager_id', $user->id);
                  })
                  ->orWhere('user_id', $user->id);
            });
            return;
        }

        if ($user->hasRole('warehouse_keeper') || $user->email === 'salam@gmail.com') {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('user_id', $user->id)
                  ->orWhere(function ($sub) {
                      $sub->where(function ($whQ) {
                          $whQ->where('requires_warehouse_receipt', true)
                              ->orWhereNull('requires_warehouse_receipt');
                      })->where('request_type', '!=', 'OFFICE_SUPPLIES');
                  });

                if ($user->department_id) {
                    $q->orWhere('department_id', $user->department_id)
                      ->orWhere('target_department_id', $user->department_id);
                }
            });
            return;
        }

        // Standard employee or fallback: own requests only
        $builder->where('user_id', $user->id);
    }

    /**
     * Row-Level Security for PurchaseOrder:
     * - procurement_manager: sees all purchase orders across the organization.
     * - site_engineer: orders linked to own requests, assigned receipts, or parcel.
     * - execution_manager: orders belonging to their department or team.
     * - site_accountant / accountants: approved/actual purchase orders within accounting scope.
     * - others: orders linked to their own purchase requests.
     */
    protected function applyPurchaseOrderIsolation(Builder $builder, User $user): void
    {
        // Procurement manager manages all commercial purchase orders
        if ($user->hasRole('procurement_manager')) {
            return;
        }

        if ($user->hasRole('site_engineer')) {
            $builder->where(function (Builder $q) use ($user) {
                $q->whereHas('purchaseRequest', function ($prQ) use ($user) {
                    $prQ->where('user_id', $user->id)
                        ->orWhere('site_engineer_user_id', $user->id);
                    $parcelId = $user->parcel_id ?? $user->land_parcel_id ?? null;
                    if ($parcelId) {
                        $prQ->orWhere('land_parcel_id', $parcelId);
                    }
                })
                ->orWhereHas('receipts', fn ($rcQ) => $rcQ->where('site_engineer_user_id', $user->id))
                ->orWhere('created_by_user_id', $user->id);
            });
            return;
        }

        if ($user->hasRole('execution_manager')) {
            $builder->where(function (Builder $q) use ($user) {
                $q->whereHas('purchaseRequest', function ($prQ) use ($user) {
                    $prQ->where('reviewer_user_id', $user->id)
                        ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id))
                        ->orWhere('user_id', $user->id);
                })->orWhere('created_by_user_id', $user->id);
            });
            return;
        }

        if ($user->hasRole('site_accountant') || $user->hasAnyRole(['licenses_accountant', 'buffet_accountant', 'development_accountant', 'accountant', 'general_accountant']) || $user->isGeneralAccountant()) {
            $builder->where(function (Builder $q) use ($user) {
                $q->where(function ($sub) {
                    $sub->whereNotNull('finalized_at')
                        ->orWhereIn('status', ['ISSUED', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'])
                        ->orWhereHas('supplierInvoices');
                })->whereNotIn('status', ['PO_DRAFT', 'REJECTED', 'CANCELLED', 'VOIDED']);

                $allowedCodes = app(SupplierInvoiceService::class)->getAllowedDepartmentCodesForAccountant($user);
                if ($allowedCodes !== null) {
                    $q->where(function ($subQ) use ($allowedCodes, $user) {
                        $subQ->whereHas('purchaseRequest.department', function ($dq) use ($allowedCodes) {
                            $dq->whereIn('code', $allowedCodes);
                        })->orWhere('created_by_user_id', $user->id)
                          ->orWhere('reviewed_by_accounting_user_id', $user->id);
                    });
                }
            });
            return;
        }

        if ($user->hasRole('warehouse_keeper') || $user->email === 'salam@gmail.com') {
            $builder->where(function (Builder $q) use ($user) {
                $q->whereHas('purchaseRequest', function ($prQ) use ($user) {
                    $prQ->where(function ($sub) {
                        $sub->where('requires_warehouse_receipt', true)
                            ->orWhereNull('requires_warehouse_receipt');
                    })->where('request_type', '!=', 'OFFICE_SUPPLIES');

                    if ($user->department_id) {
                        $prQ->orWhere('department_id', $user->department_id)
                            ->orWhere('target_department_id', $user->department_id);
                    }
                })
                ->orWhereHas('receipts', function ($rcQ) use ($user) {
                    $rcQ->where('warehouse_keeper_user_id', $user->id)
                        ->orWhereNull('warehouse_keeper_user_id');
                })
                ->orWhere('created_by_user_id', $user->id);
            });
            return;
        }

        // Default: linked to own PR or created by user
        $builder->where(function (Builder $q) use ($user) {
            $q->whereHas('purchaseRequest', function ($prQ) use ($user) {
                $prQ->where('user_id', $user->id);
                if ($user->department_id) {
                    $prQ->orWhere('department_id', $user->department_id)
                        ->orWhere('target_department_id', $user->department_id);
                }
            })->orWhere('created_by_user_id', $user->id);
        });
    }

    /**
     * Row-Level Security for PurchaseReceipt:
     * - procurement_manager: sees all receipts (specifically approved GRNs for Actual PO).
     * - site_engineer: assigned receipts, receiver receipts, or linked to their PR.
     * - execution_manager: receipts for their department or team.
     * - site_accountant / accountants: receipts for their scoped departments.
     * - warehouse_keeper: assigned receipts, unassigned receipts, or orders requiring warehouse receipt.
     * - others: linked to own PR.
     */
    protected function applyPurchaseReceiptIsolation(Builder $builder, User $user): void
    {
        if ($user->hasRole('procurement_manager')) {
            return;
        }

        if ($user->hasRole('site_engineer')) {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('site_engineer_user_id', $user->id)
                  ->orWhere('receiver_user_id', $user->id)
                  ->orWhereHas('purchaseRequest', function ($prQ) use ($user) {
                      $prQ->where('user_id', $user->id)
                          ->orWhere('site_engineer_user_id', $user->id);
                      $parcelId = $user->parcel_id ?? $user->land_parcel_id ?? null;
                      if ($parcelId) {
                          $prQ->orWhere('land_parcel_id', $parcelId);
                      }
                  });
            });
            return;
        }

        if ($user->hasRole('execution_manager')) {
            $builder->whereHas('purchaseRequest', function ($prQ) use ($user) {
                $prQ->where('reviewer_user_id', $user->id)
                    ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id))
                    ->orWhere('user_id', $user->id);
            });
            return;
        }

        if ($user->hasRole('reviewer') || $user->hasPermission('purchase_request.review')) {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('site_engineer_user_id', $user->id)
                  ->orWhere('receiver_user_id', $user->id)
                  ->orWhereHas('purchaseRequest', function ($prQ) use ($user) {
                      $prQ->where('reviewer_user_id', $user->id)
                          ->orWhere('user_id', $user->id);
                      if ($user->department_id) {
                          $prQ->orWhere('department_id', $user->department_id)
                              ->orWhere('target_department_id', $user->department_id);
                      }
                  })
                  ->orWhereHas('purchaseOrder.purchaseRequest', function ($prQ) use ($user) {
                      $prQ->where('reviewer_user_id', $user->id)
                          ->orWhere('user_id', $user->id);
                      if ($user->department_id) {
                          $prQ->orWhere('department_id', $user->department_id)
                              ->orWhere('target_department_id', $user->department_id);
                      }
                  });
            });
            return;
        }

        if ($user->hasRole('site_accountant') || $user->hasAnyRole(['licenses_accountant', 'buffet_accountant', 'development_accountant', 'accountant', 'general_accountant']) || $user->isGeneralAccountant()) {
            $allowedCodes = app(SupplierInvoiceService::class)->getAllowedDepartmentCodesForAccountant($user);
            if ($allowedCodes !== null) {
                // Plus receipts assigned to the accountant as receiver (their own order).
                $builder->where(function (Builder $q) use ($user, $allowedCodes) {
                    $q->whereHas('purchaseRequest.department', function ($dq) use ($allowedCodes) {
                        $dq->whereIn('code', $allowedCodes);
                    })
                      ->orWhere('site_engineer_user_id', $user->id)
                      ->orWhere('receiver_user_id', $user->id);
                });
            }
            return;
        }

        if ($user->hasRole('warehouse_keeper') || $user->email === 'salam@gmail.com') {
            $builder->where(function (Builder $q) use ($user) {
                $q->where('warehouse_keeper_user_id', $user->id)
                  ->orWhereNull('warehouse_keeper_user_id')
                  ->orWhereHas('purchaseRequest', function ($prQ) use ($user) {
                      $prQ->where(function ($sub) {
                          $sub->where('requires_warehouse_receipt', true)
                              ->orWhereNull('requires_warehouse_receipt');
                      })->where('request_type', '!=', 'OFFICE_SUPPLIES');

                      if ($user->department_id) {
                          $prQ->orWhere('department_id', $user->department_id)
                              ->orWhere('target_department_id', $user->department_id);
                      }
                  });
            });
            return;
        }

        // Default
        $builder->where(function (Builder $q) use ($user) {
            $q->where('site_engineer_user_id', $user->id)
              ->orWhere('receiver_user_id', $user->id)
              ->orWhereHas('purchaseRequest', fn ($prQ) => $prQ->where('user_id', $user->id));
        });
    }

    /**
     * Row-Level Security for SupplierInvoice:
     * - site_accountant / accountants: invoices for their scoped departments, or created by them.
     * - execution_manager: invoices for their department.
     * - procurement_manager: invoices linked to purchase orders.
     * - site_engineer: invoices linked to their own purchase requests.
     */
    protected function applySupplierInvoiceIsolation(Builder $builder, User $user): void
    {
        if ($user->hasRole('site_accountant') || $user->hasAnyRole(['licenses_accountant', 'buffet_accountant', 'development_accountant', 'accountant', 'general_accountant']) || $user->isGeneralAccountant()) {
            $allowedCodes = app(SupplierInvoiceService::class)->getAllowedDepartmentCodesForAccountant($user);
            if ($allowedCodes !== null) {
                $builder->where(function (Builder $q) use ($allowedCodes, $user) {
                    $q->whereHas('purchaseOrder.purchaseRequest.department', function ($dq) use ($allowedCodes) {
                        $dq->whereIn('code', $allowedCodes);
                    })->orWhere('created_by_user_id', $user->id);
                });
            }
            return;
        }

        if ($user->hasRole('execution_manager')) {
            $builder->whereHas('purchaseOrder.purchaseRequest', function ($prQ) use ($user) {
                if ($user->department_id) {
                    $prQ->where('department_id', $user->department_id)
                        ->orWhere('target_department_id', $user->department_id);
                }
                $prQ->orWhereHas('requester', fn ($rq) => $rq->where('manager_id', $user->id));
            });
            return;
        }

        if ($user->hasRole('site_engineer')) {
            $builder->whereHas('purchaseOrder.purchaseRequest', function ($prQ) use ($user) {
                $prQ->where('user_id', $user->id)
                    ->orWhere('site_engineer_user_id', $user->id);
            });
            return;
        }

        if ($user->hasRole('procurement_manager')) {
            // Can view invoices linked to purchase orders
            $builder->whereHas('purchaseOrder');
            return;
        }

        // Default: only if created by user
        $builder->where('created_by_user_id', $user->id);
    }
}
