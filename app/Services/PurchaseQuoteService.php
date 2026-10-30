<?php

namespace App\Services;

use App\Models\ApprovalHistory;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestQuote;
use App\Models\PurchaseRequestQuoteRecommendation;
use App\Models\Supplier;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class PurchaseQuoteService
{
    public const QUOTES_PENDING = 'PENDING_QUOTE_RECOMMENDATIONS';
    public const EXECUTIVE_DECISION_PENDING = 'PENDING_EXECUTIVE_QUOTE_DECISION';

    public function createQuotes(User $procurementManager, PurchaseRequest $request, array $quotes): PurchaseRequest
    {
        if ($request->status !== self::QUOTES_PENDING) {
            throw new \RuntimeException('يجب أن يكون الطلب في مرحلة تجهيز عروض الأسعار.');
        }
        $request->loadMissing('items');
        $quoteCount = count($quotes);
        if ($quoteCount < 2) {
            throw ValidationException::withMessages([
                'quotes' => ['يجب إدخال عرضين على الأقل.'],
            ]);
        }

        $supplierIds = collect($quotes)->pluck('supplier_id')->map(fn ($id) => (int) $id)->values();
        if ($supplierIds->unique()->count() !== $quoteCount) {
            throw ValidationException::withMessages([
                'quotes' => ['يجب اختيار مورد مختلف لكل عرض.'],
            ]);
        }

        $requestQuantity = max((float) $request->items->sum('quantity'), 1.0);
        $quotes = collect($quotes)->map(function (array $quote) use ($requestQuantity): array {
            $totalAmount = (float) ($quote['total_amount'] ?? 0);
            $unitPrice = array_key_exists('unit_price', $quote)
                ? (float) $quote['unit_price']
                : round($totalAmount / $requestQuantity, 2);

            if ($unitPrice <= 0 || $totalAmount <= 0) {
                throw ValidationException::withMessages([
                    'quotes' => ['يجب إدخال سعر وحدة وإجمالي موجب لكل عرض.'],
                ]);
            }

            return array_merge($quote, [
                'unit_price' => $unitPrice,
                'total_amount' => $totalAmount,
            ]);
        })->values()->all();

        $activeSuppliers = Supplier::query()
            ->whereIn('id', $supplierIds->all())
            ->where('is_active', true)
            ->count();
        if ($activeSuppliers !== $quoteCount) {
            throw ValidationException::withMessages([
                'quotes' => ['يجب أن يكون كل الموردين المختارين نشطين.'],
            ]);
        }

        return DB::transaction(function () use ($procurementManager, $request, $quotes, $quoteCount): PurchaseRequest {
            $pr = PurchaseRequest::query()->lockForUpdate()->findOrFail($request->id);
            $pr->loadMissing(['requester.roles', 'items.item', 'landParcel']);
            $isExecutiveRequester = $pr->requester?->hasRole('general_manager') ?? false;
            $pr->quotes()->delete();

            foreach ($quotes as $index => $quote) {
                $filePath = null;
                $fileName = null;
                $fileSize = null;
                $mimeType = null;
                $fileDriveId = null;

                if (isset($quote['file']) && $quote['file'] instanceof \Illuminate\Http\UploadedFile) {
                    $supplier = !empty($quote['supplier_id']) ? \App\Models\Supplier::find((int) $quote['supplier_id']) : null;
                    $ext = $quote['file']->getClientOriginalExtension() ?: 'pdf';
                    $customName = \App\Services\DocumentNamingService::generateQuotationName(
                        $pr,
                        $supplier,
                        $quote['items'] ?? null,
                        $ext,
                        $index + 1
                    );
                    $saved = \App\Services\StorageService::storeUploadedFile($quote['file'], 'quotes', $customName);
                    $filePath = $saved['path'];
                    $fileName = $saved['name'];
                    $fileSize = $saved['size'];
                    $mimeType = $saved['mime_type'];
                    $fileDriveId = $saved['drive_id'] ?? null;
                } elseif (!empty($quote['file_path'])) {
                    $filePath = $quote['file_path'];
                    $fileName = $quote['file_name'] ?? basename($filePath);
                    $fileSize = $quote['file_size'] ?? null;
                    $mimeType = $quote['mime_type'] ?? null;
                    $fileDriveId = $quote['file_drive_id'] ?? \App\Services\GoogleDriveService::extractFileId($filePath);
                }

                $pr->quotes()->create([
                    'supplier_id' => (int) $quote['supplier_id'],
                    'created_by_user_id' => $procurementManager->id,
                    'total_amount' => (float) $quote['total_amount'],
                    'unit_price' => (float) $quote['unit_price'],
                    'currency' => 'EGP',
                    'notes' => $quote['notes'] ?? null,
                    'file_path' => $filePath,
                    'file_name' => $fileName,
                    'file_size' => $fileSize,
                    'file_drive_id' => $fileDriveId,
                    'mime_type' => $mimeType,
                    'status' => 'SUBMITTED',
                ]);
            }

            $pr->update(['status' => self::QUOTES_PENDING]);
            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $pr->id,
                'actor_user_id' => $procurementManager->id,
                'action' => 'QUOTES_SUBMITTED',
                'from_state' => self::QUOTES_PENDING,
                'to_state' => self::QUOTES_PENDING,
                'comments' => $isExecutiveRequester
                    ? "تم إرسال {$quoteCount} عروض أسعار إلى الحسابات للترشيح، ثم المدير العام لاتخاذ القرار النهائي."
                    : "تم إرسال {$quoteCount} عروض أسعار من موردين مختلفين إلى الحسابات ورئيس القسم للترشيح.",
            ]);

            $notificationService = app(NotificationService::class);

            // Auto-resolve pending notifications for procurement manager
            $notificationService->markEntityNotificationsAsRead($pr, $procurementManager);

            // Sequential quote workflow: Financial Director (Hasan) is notified FIRST.
            // Exclude subsidiary department accountants.
            $financialDirectors = User::whereHas('roles', fn ($q) => $q->where('slug', 'accountant'))
                ->where('is_active', true)
                ->get();
            if ($financialDirectors->isEmpty()) {
                $financialDirectors = $notificationService->resolveUsersWithPermission('purchase_quote.recommend');
            }

            $notificationService->queueUsers(
                $financialDirectors,
                'purchase_quote_pending_recommendation',
                'عروض أسعار بانتظار التوصية المالية',
                $isExecutiveRequester
                    ? "أرسل مدير المشتريات {$quoteCount} عروض أسعار للطلب {$pr->request_number}. يرجى تقديم التوصية المالية للطلب."
                    : "أرسل مدير المشتريات {$quoteCount} عروض أسعار للطلب {$pr->request_number}. يرجى مراجعة العروض وتقديم التوصية المالية أولاً.",
                $pr
            );

            return $pr->fresh(['requester.roles', 'department', 'assignedReviewer', 'siteEngineer', 'quotes.supplier', 'quotes.recommendations.user', 'items.item', 'approvalHistory']);
        });
    }

    /** Backward-compatible alias for older callers. */
    public function createThreeQuotes(User $procurementManager, PurchaseRequest $request, array $quotes): PurchaseRequest
    {
        return $this->createQuotes($procurementManager, $request, $quotes);
    }

    public function recommend(User $actor, PurchaseRequestQuote $quote, string $decision, ?string $comment): PurchaseRequest
    {
        if (! in_array($decision, ['RECOMMEND', 'REJECT'], true)) {
            throw ValidationException::withMessages(['decision' => ['القرار يجب أن يكون ترشيح أو رفض.']]);
        }
        $request = $quote->purchaseRequest->loadMissing(['targetDepartment', 'department', 'requester.roles']);
        $isExecutiveRequester = $request->requester?->hasRole('general_manager') ?? false;
        if ($request->status !== self::QUOTES_PENDING) {
            throw new \RuntimeException('العروض ليست في مرحلة ترشيح الحسابات ومدير القسم الحالية.');
        }

        $roleType = $actor->hasRole('accountant') ? 'ACCOUNTING' : 'DEPARTMENT';
        if ($isExecutiveRequester && $roleType !== 'ACCOUNTING') {
            throw new \RuntimeException('طلب المدير العام يحتاج ترشيح الحسابات فقط، ثم ينتقل للمدير العام لاتخاذ القرار النهائي.');
        }
        $assignedDepartmentManagerId = $request->targetDepartment?->manager_user_id ?? $request->department?->manager_user_id;
        $legacyReviewerId = $request->reviewer_user_id;
        if ($roleType === 'DEPARTMENT' && !in_array((int) $actor->id, array_filter([(int) $assignedDepartmentManagerId, (int) $legacyReviewerId]), true)) {
            throw new \RuntimeException('ترشيح القسم متاح لمدير القسم المستهدف فقط.');
        }

        return DB::transaction(function () use ($actor, $quote, $decision, $comment, $request, $roleType, $isExecutiveRequester): PurchaseRequest {
            PurchaseRequestQuoteRecommendation::updateOrCreate(
                [
                    'purchase_request_quote_id' => $quote->id,
                    'user_id' => $actor->id,
                    'role_type' => $roleType,
                ],
                ['decision' => $decision, 'comment' => $comment]
            );

            // When a quote is recommended, mark all other quotes for this PR as rejected by this role
            if ($decision === 'RECOMMEND') {
                $otherQuoteIds = $request->quotes()->where('id', '!=', $quote->id)->pluck('id');
                foreach ($otherQuoteIds as $otherQuoteId) {
                    PurchaseRequestQuoteRecommendation::updateOrCreate(
                        [
                            'purchase_request_quote_id' => $otherQuoteId,
                            'user_id' => $actor->id,
                            'role_type' => $roleType,
                        ],
                        ['decision' => 'REJECT', 'comment' => null]
                    );
                }
            }

            $notificationService = app(NotificationService::class);
            // Auto-resolve pending recommendation notification for the actor
            $notificationService->markEntityNotificationsAsRead($request, $actor, 'purchase_quote_pending_recommendation');

            $requiredRoleTypes = $isExecutiveRequester ? ['ACCOUNTING'] : ['ACCOUNTING', 'DEPARTMENT'];
            $recommendationCount = PurchaseRequestQuoteRecommendation::whereHas('quote', fn ($q) => $q->where('purchase_request_id', $request->id))
                ->whereIn('role_type', $requiredRoleTypes)
                ->select('role_type')
                ->distinct()
                ->count('role_type');

            if ($recommendationCount >= count($requiredRoleTypes)) {
                $request->update(['status' => self::EXECUTIVE_DECISION_PENDING]);
                $requester = $request->requester;
                $directManager = ($requester && $requester->manager_id)
                    ? User::with('roles')->where('id', $requester->manager_id)->where('is_active', true)->first()
                    : null;
                $isExecutionManager = $directManager && $directManager->hasRole('execution_manager');

                if ($isExecutionManager) {
                    $notificationService->queueNotification(
                        $directManager->id,
                        'purchase_quote_recommendations_ready',
                        'ترشيحات عروض الأسعار جاهزة لقرارك',
                        "اكتملت ترشيحات الحسابات ومدير القسم للطلب {$request->request_number}. القرار لمدير مشروعات التنفيذ ({$directManager->name}).",
                        $request
                    );
                } else {
                    $gmUsers = User::whereHas('roles', fn ($q) => $q->where('slug', 'general_manager'))->where('is_active', true)->get();
                    $notificationService->queueUsers(
                        $gmUsers,
                        'purchase_quote_recommendations_ready',
                        'ترشيحات عروض الأسعار جاهزة',
                        $isExecutiveRequester
                            ? "اكتمل ترشيح الحسابات للطلب {$request->request_number}. القرار النهائي للمدير العام."
                            : "اكتملت ترشيحات الحسابات ومدير القسم للطلب {$request->request_number}. القرار للمدير التنفيذي.",
                        $request
                    );
                }
            } elseif ($roleType === 'ACCOUNTING' && ! $isExecutiveRequester) {
                // Sequential workflow step 2: Financial Director has recommended -> notify Department Reviewer
                $reviewers = collect();
                $reviewerId = $request->targetDepartment?->manager_user_id ?? $request->department?->manager_user_id ?? $request->reviewer_user_id;
                if ($reviewerId) {
                    $reviewer = User::find($reviewerId);
                    if ($reviewer && $reviewer->is_active) {
                        $reviewers->push($reviewer);
                    }
                }
                if ($reviewers->isNotEmpty()) {
                    $notificationService->queueUsers(
                        $reviewers,
                        'purchase_quote_pending_recommendation',
                        'عروض أسعار بانتظار ترشيح القسم',
                        "أتمّ المدير المالي ترشيحه للطلب {$request->request_number}. يرجى مراجعة وترشيح العرض الأنسب من جهة القسم.",
                        $request
                    );
                }
            }

            return $request->fresh(['quotes.supplier', 'quotes.recommendations.user', 'requester.roles', 'department', 'items.item']);
        });
    }

    public function decide(User $executive, PurchaseRequestQuote $quote, string $decision, ?string $comment): PurchaseRequest
    {
        if (! in_array($decision, ['SELECT', 'REJECT'], true)) {
            throw ValidationException::withMessages(['decision' => ['القرار يجب أن يكون اختيار العرض أو رفضه.']]);
        }
        $request = $quote->purchaseRequest->loadMissing(['targetDepartment', 'department']);
        if ($request->status !== self::EXECUTIVE_DECISION_PENDING) {
            throw new \RuntimeException('الطلب ليس بانتظار القرار التنفيذي على عروض الأسعار.');
        }

        if ($executive->hasRole('execution_manager')) {
            $request->loadMissing('requester');
            if ((int) $request->requester?->manager_id !== (int) $executive->id) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('غير مصرح لك باتخاذ قرار على عروض أسعار لا تتبع موظفيك.');
            }
        } elseif (! $executive->hasRole('admin')) {
            $request->loadMissing('requester.manager.roles');
            if ($request->requester?->manager?->hasRole('execution_manager')) {
                throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('هذا الطلب يتبع مدير مشروعات التنفيذ ولا يقرره المدير العام.');
            }
        }

        return DB::transaction(function () use ($executive, $quote, $decision, $comment, $request): PurchaseRequest {
            if ($decision === 'SELECT') {
                $request->update([
                    'selected_quote_id' => $quote->id,
                    'status' => 'APPROVED_BY_PROCUREMENT',
                ]);
                $request->quotes()->where('id', '!=', $quote->id)->update(['status' => 'REJECTED']);
                $quote->update(['status' => 'SELECTED', 'selected_at' => now()]);
                $toState = 'APPROVED_BY_PROCUREMENT';
                $action = 'EXECUTIVE_SELECTED_QUOTE';
                $message = 'اختار المدير التنفيذي العرض وأعاده إلى مدير المشتريات لإنشاء أمر الشراء.';
            } else {
                $request->update([
                    'status' => 'REJECTED',
                    'rejection_reason' => $comment ?? 'تم رفض عروض الأسعار من المدير التنفيذي.',
                ]);
                $request->quotes()->update(['status' => 'REJECTED']);
                $toState = 'REJECTED';
                $action = 'EXECUTIVE_REJECTED_QUOTES';
                $message = 'رفض المدير التنفيذي عروض الأسعار والطلب.';
            }
            $request->save();

            app(NotificationService::class)->markEntityNotificationsAsRead($request);

            ApprovalHistory::create([
                'target_type' => PurchaseRequest::class,
                'target_id' => $request->id,
                'actor_user_id' => $executive->id,
                'action' => $action,
                'from_state' => self::EXECUTIVE_DECISION_PENDING,
                'to_state' => $toState,
                'user_note' => ApprovalHistory::typedNote($comment),
                'comments' => $comment ?? $message,
            ]);

            app(SystemEventService::class)->recordAction(
                $request,
                $action,
                $message,
                ['event_type' => 'purchase_quote.executive_decision', 'from_state' => self::EXECUTIVE_DECISION_PENDING, 'to_state' => $toState, 'actor_user_id' => $executive->id]
            );

            $notificationService = app(NotificationService::class);
            $notificationService->markEntityNotificationsAsRead($request);
            $notificationService->queueUsers(
                $notificationService->resolveUsersWithPermission('purchase_request.approve_procurement'),
                'purchase_quote_decision_complete',
                'تم اتخاذ قرار عروض الأسعار',
                "تم اتخاذ قرار عروض الأسعار للطلب {$request->request_number}. يمكن لمدير المشتريات متابعة أمر الشراء.",
                $request
            );

            return $request->fresh(['requester.roles', 'department', 'assignedReviewer', 'siteEngineer', 'selectedQuote.supplier', 'quotes.supplier', 'quotes.recommendations.user', 'items.item', 'approvalHistory']);
        });
    }
}
