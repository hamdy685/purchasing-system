import React, { useMemo } from 'react';
import { PurchaseRequest, PR_STATUS_LABELS } from '../../types/purchaseRequest';
import { getRequestLifecycle } from '../purchase-requests/PurchaseRequestTable';

export interface PurchaseRequestTimelineProps {
  request: PurchaseRequest;
  compact?: boolean;
  /** One line per stage instead of the card grid (request details page). */
  listView?: boolean;
}

export type TimelineCardState = 'COMPLETED' | 'ACTIVE' | 'PENDING' | 'REJECTED';

export interface TimelineChecklistItem {
  label: string;
  role: string;
  isCompleted: boolean;
  isBypassed?: boolean;
  statusText: string;
}

export interface TimelineCardItem {
  id: string;
  stepNumber: number | string;
  stepLabel?: string;
  title: string;
  role: string;
  assignee?: string | null;
  state: TimelineCardState;
  description: string;
  actionNote?: string;
  badgeText: string;
  icon: string;
  checklists?: TimelineChecklistItem[];
}

/**
 * Checks if a PR is designated for direct purchasing.
 */
export const isDirectProcurement = (request: PurchaseRequest): boolean => {
  return (
    request.procurement_route === 'DIRECT' ||
    Boolean(request.direct_supplier_id && (!request.quotes || request.quotes.length === 0))
  );
};

/**
 * Checks if a PR is designated for quotes comparison.
 */
export const isQuotesProcurement = (request: PurchaseRequest): boolean => {
  return (
    request.procurement_route === 'QUOTES' ||
    (Array.isArray(request.quotes) && request.quotes.length > 0)
  );
};

/**
 * Checks if the request has returned from procurement with direct pricing,
 * distinguishing the second GM approval from the initial approval.
 */
export const isPrPricingReturned = (request: PurchaseRequest): boolean => {
  if (!request) return false;
  const isInitial = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED_BY_REVIEWER'].includes(request.status);
  if (isInitial) return false;
  return (
    request.procurement_route === 'DIRECT' ||
    Boolean(request.direct_supplier_id || request.direct_supplier) ||
    Number(request.total_estimated_cost || 0) > 0 ||
    Boolean(request.items?.some((it) => Number(it.estimated_unit_price || 0) > 0))
  );
};

const historyHas = (request: PurchaseRequest, actions: string[]): boolean => {
  return request.approval_history?.some((entry) => actions.includes(entry.action)) || false;
};

/**
 * Calculates the current active step index in the documentary workflow.
 */
export const getTimelineStepIndex = (request: PurchaseRequest): number => {
  const status = request.status as string;
  const isDirect = isDirectProcurement(request);
  const isReturned = isPrPricingReturned(request);

  if (status === 'REJECTED') return -1;
  if (status === 'DRAFT') return 0;
  if (status === 'SUBMITTED' || status === 'UNDER_REVIEW') return 1;

  // Initial executive approval (before procurement pricing, when not direct)
  if (status === 'PENDING_EXECUTIVE_APPROVAL' && !isDirect) return 2;

  // Procurement pricing / quotes preparation
  if (status === 'PENDING_PROCUREMENT_APPROVAL') return 3;

  // PO & Fulfillment milestones
  const pos = (request as any).purchase_orders || [];
  const hasIssuedPo =
    (request.issued_purchase_orders_count ?? 0) > 0 ||
    pos.some((po: any) =>
      ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'].includes(po.status)
    ) ||
    Boolean(request.purchase_order_issued) ||
    status === 'ISSUED' ||
    status === 'PO_DRAFT';

  const hasApprovedReceipt =
    pos.some(
      (po: any) =>
        po.has_approved_receipt || (po.receipts || []).some((r: any) => r.status === 'APPROVED')
    ) || historyHas(request, ['SITE_ENGINEER_APPROVED', 'RECEIPT_APPROVED_BY_SITE_ENGINEER', 'INTERNAL_STOCK_RECEIPT_APPROVED']);

  const hasActualPoFinalized =
    pos.some(
      (po: any) =>
        Boolean(po.finalized_at) ||
        Boolean(po.is_actual_po) ||
        po.status === 'FINAL_APPROVED'
    ) ||
    historyHas(request, ['ACTUAL_PO_FINALIZED', 'ACTUAL_PO_ISSUED']) ||
    ['COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status);

  if (hasActualPoFinalized) return isDirect ? 8 : 9;
  if (hasApprovedReceipt || pos.some((po: any) => po.status === 'PENDING_ACTUAL_PO')) return isDirect ? 8 : 9;
  if (hasIssuedPo || status === 'PENDING_SITE_ENGINEER') return isDirect ? 7 : 8;

  if (isDirect) {
    // Direct purchase path
    if (status === 'PENDING_EXECUTIVE_APPROVAL') return 4;
    if (status === 'PENDING_ACCOUNTING_APPROVAL') return 5;
    if (status === 'APPROVED_BY_ACCOUNTING') return 6;
  } else {
    // Quotes comparison path
    if (status === 'PENDING_QUOTE_RECOMMENDATIONS') {
      const hasAccountingRec = request.quotes?.some((q) =>
        q.recommendations?.some((r) => r.role_type === 'ACCOUNTING')
      );
      return hasAccountingRec ? 5 : 4;
    }
    if (status === 'PENDING_EXECUTIVE_QUOTE_DECISION') return 6;
  }

  if (status === 'APPROVED_BY_PROCUREMENT' || (isDirect && status === 'APPROVED_BY_ACCOUNTING')) {
    return isDirect ? 6 : 7;
  }

  return 0;
};

/**
 * Dynamically constructs the card workflow array based on request status and procurement route.
 */
export const generateTimelineCards = (request: PurchaseRequest): TimelineCardItem[] => {
  const status = request.status as string;
  const isRejected = status === 'REJECTED';
  const isDirect = isDirectProcurement(request);
  const isReturned = isPrPricingReturned(request);

  // Check quotes recommendation progress
  const quotes = request.quotes || [];
  const accountingRecommended = quotes.some((q) =>
    (q.recommendations || []).some((r) => r.role_type === 'ACCOUNTING')
  );
  const departmentRecommended = quotes.some((q) =>
    (q.recommendations || []).some((r) => r.role_type === 'DEPARTMENT')
  );

  // Check PO and downstream fulfillment states
  const pos = (request as any).purchase_orders || [];
  const hasIssuedPo =
    (request.issued_purchase_orders_count ?? 0) > 0 ||
    pos.some((po: any) =>
      ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'].includes(po.status)
    ) ||
    Boolean(request.purchase_order_issued) ||
    status === 'ISSUED' ||
    status === 'PO_DRAFT';

  const hasApprovedReceipt =
    pos.some(
      (po: any) =>
        po.has_approved_receipt || (po.receipts || []).some((r: any) => r.status === 'APPROVED')
    ) || historyHas(request, ['SITE_ENGINEER_APPROVED', 'RECEIPT_APPROVED_BY_SITE_ENGINEER']);

  const hasWarehouseReceipt =
    pos.some((po: any) => (po.receipts || []).length > 0) ||
    historyHas(request, ['WAREHOUSE_RECEIPT_APPROVED', 'PURCHASE_RECEIPT_CREATED', 'WAREHOUSE_RECEIPT_SUBMITTED']);

  const isAccountingProcessed =
    status === 'ACCOUNTING_PROCESSED' ||
    status === 'COMPLETED' ||
    pos.some((po: any) => po.is_paid || po.financial_status === 'PAID');

  const hasActualPoFinalized =
    pos.some(
      (po: any) =>
        Boolean(po.finalized_at) ||
        Boolean(po.is_actual_po) ||
        po.status === 'FINAL_APPROVED'
    ) ||
    historyHas(request, ['ACTUAL_PO_FINALIZED', 'ACTUAL_PO_ISSUED']) ||
    ['COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status);

  const cards: TimelineCardItem[] = [];

  // ─────────────────────────────────────────────────────────────
  // البطاقة 1: إنشاء الطلب (مقدم الطلب)
  // ─────────────────────────────────────────────────────────────
  const card1State: TimelineCardState =
    isRejected && status === 'REJECTED' && !request.submitted_at
      ? 'REJECTED'
      : status === 'DRAFT'
      ? 'ACTIVE'
      : 'COMPLETED';

  cards.push({
    id: 'step-1-create',
    stepNumber: 1,
    stepLabel: '1',
    title: 'إنشاء الطلب',
    role: 'مقدم الطلب',
    assignee: request.requester?.name || 'الموظف',
    state: card1State,
    description: 'تسجيل مسودة الطلب وتحديد الأصناف والكميات وتاريخ الاحتياج.',
    badgeText: card1State === 'COMPLETED' ? 'مكتمل ✅' : card1State === 'ACTIVE' ? 'مسودة حالية ✍️' : 'بانتظار الإجراء ⚪',
    icon: '✍️',
    actionNote: card1State === 'ACTIVE' ? 'الطلب ما زال مسودة لديك. اضغط على «إرسال الطلب» لإرساله للمراجعة.' : undefined,
  });

  // ─────────────────────────────────────────────────────────────
  // البطاقة 2: المراجعة الفنية (رئيس القسم / المراجع)
  // ─────────────────────────────────────────────────────────────
  let card2State: TimelineCardState = 'PENDING';
  if (status === 'DRAFT') {
    card2State = 'PENDING';
  } else if (status === 'SUBMITTED' || status === 'UNDER_REVIEW') {
    card2State = isRejected ? 'REJECTED' : 'ACTIVE';
  } else if (isRejected && historyHas(request, ['REJECTED_BY_REVIEWER'])) {
    card2State = 'REJECTED';
  } else {
    card2State = 'COMPLETED';
  }

  cards.push({
    id: 'step-2-review',
    stepNumber: 2,
    stepLabel: '2',
    title: 'المراجعة الفنية وتحديد الاستلام',
    role: 'رئيس القسم / المراجع',
    assignee: request.assigned_reviewer?.name || request.target_department?.name || request.department?.name || 'المراجع',
    state: card2State,
    description: 'فحص الاحتياج وتحديد مهندس الموقع / مسؤول الاستلام الميداني.',
    badgeText: card2State === 'COMPLETED' ? 'معتمد فنيًا ✅' : card2State === 'ACTIVE' ? 'قيد المراجعة 🔵' : card2State === 'REJECTED' ? 'مرفوض ❌' : 'بانتظار دوره ⚪',
    icon: '🔍',
    actionNote: card2State === 'ACTIVE' ? 'الطلب قيد مراجعة وتدقيق رئيس القسم لتحديد مسؤول الاستلام والاعتماد.' : undefined,
  });

  // ─────────────────────────────────────────────────────────────
  // البطاقة 3: الاعتماد المبدئي للمشتريات (المدير التنفيذي)
  // ─────────────────────────────────────────────────────────────
  let card3State: TimelineCardState = 'PENDING';
  if (['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'].includes(status)) {
    card3State = 'PENDING';
  } else if (status === 'PENDING_EXECUTIVE_APPROVAL' && !isDirect) {
    card3State = isRejected ? 'REJECTED' : 'ACTIVE';
  } else if (isRejected && historyHas(request, ['REJECTED_BY_EXECUTIVE']) && !isDirect) {
    card3State = 'REJECTED';
  } else {
    card3State = 'COMPLETED';
  }

  const preliminarySkipped = card3State === 'COMPLETED' && historyHas(request, ['FAST_TRACK_PRICING_SKIPPED_PRELIMINARY']);

  cards.push({
    id: 'step-3-exec-initial',
    stepNumber: 3,
    stepLabel: '3',
    title: 'الاعتماد المبدئي للمشتريات',
    role: 'المدير العام والتنفيذي',
    assignee: 'م. محمد (المدير العام)',
    state: card3State,
    description: 'الموافقة الإدارية المبدئية للتصريح لإدارة المشتريات بالبدء في التسعير.',
    badgeText: preliminarySkipped ? 'تم التخطي (تسعير مباشر) ⏭' : card3State === 'COMPLETED' ? 'موافقة مبدئية ✅' : card3State === 'ACTIVE' ? 'بانتظار القرار 🔵' : card3State === 'REJECTED' ? 'مرفوض ❌' : 'بانتظار دوره ⚪',
    icon: '👔',
    actionNote: card3State === 'ACTIVE' ? 'معروض الآن على طاولة المدير التنفيذي للتصريح ببدء إجراءات المشتريات.' : undefined,
  });

  // ─────────────────────────────────────────────────────────────
  // البطاقة 4: إعداد التسعير / عروض الأسعار (إدارة المشتريات)
  // ─────────────────────────────────────────────────────────────
  let card4State: TimelineCardState = 'PENDING';
  if (['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'].includes(status)) {
    card4State = 'PENDING';
  } else if (status === 'PENDING_EXECUTIVE_APPROVAL' && !isDirect) {
    card4State = 'PENDING';
  } else if (status === 'PENDING_PROCUREMENT_APPROVAL') {
    card4State = isRejected ? 'REJECTED' : 'ACTIVE';
  } else if (isRejected && historyHas(request, ['REJECTED_BY_PROCUREMENT'])) {
    card4State = 'REJECTED';
  } else {
    card4State = 'COMPLETED';
  }

  cards.push({
    id: 'step-4-procurement-route',
    stepNumber: 4,
    stepLabel: '4',
    title: 'إعداد التسعير / عروض الأسعار',
    role: 'إدارة المشتريات',
    assignee: 'مدير المشتريات',
    state: card4State,
    description: 'تحديد مسار الشراء (مباشر بتسعير محدد أو جمع عروض أسعار تنافسية).',
    badgeText: card4State === 'COMPLETED' ? 'تم التسعير ✅' : card4State === 'ACTIVE' ? 'قيد التسعير والمفاضلة 🔵' : card4State === 'REJECTED' ? 'مرفوض ❌' : 'بانتظار دوره ⚪',
    icon: '🏷️',
    actionNote: card4State === 'ACTIVE' ? 'تقوم إدارة المشتريات الآن بالتواصل مع الموردين وإعداد عروض الأسعار.' : undefined,
  });

  // ─────────────────────────────────────────────────────────────
  // [نقطة التفرع - Branching Logic]
  // ─────────────────────────────────────────────────────────────
  if (isDirect) {
    // ─────────────── مسار الشراء المباشر ───────────────
    // البطاقة 5 (مباشر): اعتماد التسعير والمورد (المدير التنفيذي)
    let card5DirectState: TimelineCardState = 'PENDING';
    if (status === 'PENDING_EXECUTIVE_APPROVAL') {
      card5DirectState = isRejected ? 'REJECTED' : 'ACTIVE';
    } else if (['PENDING_ACCOUNTING_APPROVAL', 'APPROVED_BY_ACCOUNTING', 'APPROVED_BY_PROCUREMENT', 'COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status) || hasIssuedPo) {
      card5DirectState = 'COMPLETED';
    } else {
      card5DirectState = 'PENDING';
    }

    cards.push({
      id: 'step-5-direct-exec',
      stepNumber: 5,
      stepLabel: '5',
      title: 'اعتماد التسعير والمورد',
      role: 'المدير العام والتنفيذي',
      assignee: 'المدير التنفيذي',
      state: card5DirectState,
      description: `مراجعة واعتماد السعر الإجمالي (${Number(request.total_estimated_cost || 0).toLocaleString('ar-EG')} ج.م) واسم المورد المباشر.`,
      badgeText: card5DirectState === 'COMPLETED' ? 'تم اعتماد التسعير ✅' : card5DirectState === 'ACTIVE' ? 'بانتظار اعتماد السعر 🔵' : 'بانتظار دوره ⚪',
      icon: '🤝',
      actionNote: card5DirectState === 'ACTIVE' ? 'الطلب معروض على المدير التنفيذي لاعتماد عرض السعر المباشر والمورد المحدد.' : undefined,
    });

    // البطاقة 6 (مباشر): المراجعة والاعتماد المالي (المدير المالي / الحسابات)
    let card6DirectState: TimelineCardState = 'PENDING';
    if (status === 'PENDING_ACCOUNTING_APPROVAL') {
      card6DirectState = isRejected ? 'REJECTED' : 'ACTIVE';
    } else if (['APPROVED_BY_ACCOUNTING', 'APPROVED_BY_PROCUREMENT', 'COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status) || hasIssuedPo) {
      card6DirectState = 'COMPLETED';
    } else {
      card6DirectState = 'PENDING';
    }

    cards.push({
      id: 'step-6-direct-accounting',
      stepNumber: 6,
      stepLabel: '6',
      title: 'المراجعة والاعتماد المالي',
      role: 'المدير المالي / الحسابات',
      assignee: 'الإدارة المالية',
      state: card6DirectState,
      description: 'تدقيق البنود المالية، ميزانية قطعة الأرض، وشروط الدفع للمورد.',
      badgeText: card6DirectState === 'COMPLETED' ? 'معتمد ماليًا ✅' : card6DirectState === 'ACTIVE' ? 'بانتظار الموافقة المالية 🔵' : 'بانتظار دوره ⚪',
      icon: '💳',
      actionNote: card6DirectState === 'ACTIVE' ? 'الطلب لدى الإدارة المالية للتدقيق المحاسبي ومطابقة حسابات المورد وقطعة الأرض.' : undefined,
    });
  } else {
    // ─────────────── مسار عروض الأسعار ───────────────
    // البطاقة 5أ: دراسة العروض مالياً (المدير المالي)
    let card5aState: TimelineCardState = 'PENDING';
    if (status === 'PENDING_QUOTE_RECOMMENDATIONS') {
      card5aState = accountingRecommended ? 'COMPLETED' : isRejected ? 'REJECTED' : 'ACTIVE';
    } else if (['PENDING_EXECUTIVE_QUOTE_DECISION', 'APPROVED_BY_PROCUREMENT', 'COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status) || hasIssuedPo) {
      card5aState = 'COMPLETED';
    } else {
      card5aState = 'PENDING';
    }

    cards.push({
      id: 'step-5a-quote-accounting',
      stepNumber: '5-أ',
      stepLabel: '5-أ',
      title: 'دراسة العروض مالياً',
      role: 'المدير المالي / الحسابات',
      assignee: 'الإدارة المالية',
      state: card5aState,
      description: 'مقارنة أسعار الموردين وشروط السداد وترشيح العرض الأنسب مالياً.',
      badgeText: card5aState === 'COMPLETED' ? 'ترشيح مالي مكتمل ✅' : card5aState === 'ACTIVE' ? 'بانتظار ترشيح الحسابات 🔵' : 'بانتظار دوره ⚪',
      icon: '📊',
      actionNote: card5aState === 'ACTIVE' ? 'عروض الأسعار معروضة الآن على الإدارة المالية لإجراء المقارنة وتقديم الترشيح المالي.' : undefined,
    });

    // البطاقة 5ب: دراسة العروض فنياً (رئيس القسم) - نشطة بالتوازي في PENDING_QUOTE_RECOMMENDATIONS
    let card5bState: TimelineCardState = 'PENDING';
    if (status === 'PENDING_QUOTE_RECOMMENDATIONS') {
      card5bState = departmentRecommended ? 'COMPLETED' : isRejected ? 'REJECTED' : 'ACTIVE';
    } else if (['PENDING_EXECUTIVE_QUOTE_DECISION', 'APPROVED_BY_PROCUREMENT', 'COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status) || hasIssuedPo) {
      card5bState = 'COMPLETED';
    } else {
      card5bState = 'PENDING';
    }

    cards.push({
      id: 'step-5b-quote-dept',
      stepNumber: '5-ب',
      stepLabel: '5-ب',
      title: 'دراسة العروض فنياً',
      role: 'رئيس القسم / المراجع',
      assignee: request.assigned_reviewer?.name || 'مدير القسم',
      state: card5bState,
      description: 'مطابقة المواصفات الفنية وجودة الخامات بين العروض المقدمة بالتوازي مع الترشيح المالي.',
      badgeText: card5bState === 'COMPLETED' ? 'ترشيح فني مكتمل ✅' : card5bState === 'ACTIVE' ? 'بانتظار ترشيح القسم 🔵' : 'بانتظار دوره ⚪',
      icon: '📐',
      actionNote: card5bState === 'ACTIVE'
        ? accountingRecommended
          ? 'أتمت الحسابات ترشيحها، وبانتظار استكمال الترشيح الفني من رئيس القسم.'
          : 'عروض الأسعار متاحة للمراجعة والترشيح الفني بالتوازي مع التدقيق المالي.'
        : undefined,
    });

    // البطاقة 6: قرار الترسية واختيار العرض الفائز (المدير التنفيذي)
    let card6QuoteState: TimelineCardState = 'PENDING';
    if (status === 'PENDING_EXECUTIVE_QUOTE_DECISION') {
      card6QuoteState = isRejected ? 'REJECTED' : 'ACTIVE';
    } else if (['APPROVED_BY_PROCUREMENT', 'COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status) || hasIssuedPo) {
      card6QuoteState = 'COMPLETED';
    } else {
      card6QuoteState = 'PENDING';
    }

    cards.push({
      id: 'step-6-quote-decision',
      stepNumber: 6,
      stepLabel: '6',
      title: 'الترسية واختيار العرض الفائز',
      role: 'المدير العام والتنفيذي',
      assignee: 'المدير التنفيذي',
      state: card6QuoteState,
      description: 'مراجعة ترشيحات الحسابات والقسم واعتماد الترسية على المورد الفائز.',
      badgeText: card6QuoteState === 'COMPLETED' ? 'تمت الترسية ✅' : card6QuoteState === 'ACTIVE' ? 'بانتظار قرار الترسية 🔵' : 'بانتظار دوره ⚪',
      icon: '🏆',
      actionNote: card6QuoteState === 'ACTIVE' ? 'ترشيحات العروض مكتملة وجاهزة، بانتظار قرار الترسية النهائي من المدير التنفيذي.' : undefined,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // [نهاية المسار الموحد - البطاقات 7 و 8 و 9]
  // ─────────────────────────────────────────────────────────────

  // البطاقة 7: إصدار أمر الشراء (PO)
  let cardPoState: TimelineCardState = 'PENDING';
  if (hasIssuedPo || hasApprovedReceipt || hasActualPoFinalized) {
    cardPoState = 'COMPLETED';
  } else if (status === 'APPROVED_BY_PROCUREMENT' || (isDirect && status === 'APPROVED_BY_ACCOUNTING')) {
    cardPoState = isRejected ? 'REJECTED' : 'ACTIVE';
  } else {
    cardPoState = 'PENDING';
  }

  cards.push({
    id: 'step-7-po-issue',
    stepNumber: 7,
    stepLabel: '7',
    title: 'إصدار أمر الشراء (PO)',
    role: 'إدارة المشتريات',
    assignee: 'مدير المشتريات',
    state: cardPoState,
    description: 'توليد أمر الشراء الرسمي، ربط التعميد، وإرساله للمورد للتنفيذ.',
    badgeText: cardPoState === 'COMPLETED' ? 'أمر الشراء صادر ✅' : cardPoState === 'ACTIVE' ? 'جاهز لإصدار الـ PO 🔵' : 'بانتظار دوره ⚪',
    icon: '📋',
    actionNote: cardPoState === 'ACTIVE' ? 'تمت كافة الاعتمادات بنجاح، بانتظار قيام مدير المشتريات بإصدار أمر الشراء.' : undefined,
  });

  // فحص شرط الاستلام المخزني والتخطي التلقائي (Auto-Bypass)
  const requiresWarehouse = request.request_type !== 'OFFICE_SUPPLIES' && (request.requires_warehouse_receipt ?? true);
  const isWarehouseBypassed =
    !requiresWarehouse ||
    pos.some((po: any) => po.warehouse_approval?.is_bypassed || (po.receipts || []).some((r: any) => r.receipt_type === 'SITE_DIRECT'));

  const warehouseStepCompleted = isWarehouseBypassed || hasWarehouseReceipt || hasApprovedReceipt || hasActualPoFinalized;
  const siteEngineerStepCompleted = hasApprovedReceipt || hasActualPoFinalized;

  // البطاقة 8: استلام المخزن والفحص الهندسي
  let cardReceiptState: TimelineCardState = 'PENDING';
  if (siteEngineerStepCompleted) {
    cardReceiptState = 'COMPLETED';
  } else if (hasWarehouseReceipt || isWarehouseBypassed || hasIssuedPo || status === 'PENDING_SITE_ENGINEER') {
    cardReceiptState = isRejected ? 'REJECTED' : 'ACTIVE';
  } else {
    cardReceiptState = 'PENDING';
  }

  const checklists: TimelineChecklistItem[] = [
    {
      label: 'استلام المخزن',
      role: 'أمين المخزن',
      isCompleted: warehouseStepCompleted,
      isBypassed: isWarehouseBypassed,
      statusText: isWarehouseBypassed
        ? 'تم التخطي التلقائي / لا يوجد مخزن'
        : (hasWarehouseReceipt || siteEngineerStepCompleted)
        ? 'تم الاستلام بالمخزن'
        : hasIssuedPo
        ? 'بانتظار استلام أمين المخزن'
        : 'بانتظار التوريد',
    },
    {
      label: 'الفحص الهندسي',
      role: 'مهندس الموقع',
      isCompleted: siteEngineerStepCompleted,
      statusText: siteEngineerStepCompleted
        ? 'تم الفحص والاعتماد الهندسي'
        : (hasWarehouseReceipt || isWarehouseBypassed) && (hasIssuedPo || status === 'PENDING_SITE_ENGINEER')
        ? 'بانتظار فحص واعتماد مهندس الموقع'
        : isWarehouseBypassed
        ? 'بانتظار التوريد للموقع'
        : 'بانتظار استلام المخزن أولاً',
    },
  ];

  let card8BadgeText = 'بانتظار التوريد ⚪';
  if (cardReceiptState === 'COMPLETED') {
    card8BadgeText = 'تم الاستلام والفحص ✅';
  } else if (cardReceiptState === 'ACTIVE') {
    if (isWarehouseBypassed) {
      card8BadgeText = 'بانتظار الفحص الهندسي 🔵';
    } else if (hasWarehouseReceipt) {
      card8BadgeText = 'بانتظار الفحص الهندسي 🔵';
    } else {
      card8BadgeText = 'قيد التوريد والفحص 🔵';
    }
  }

  cards.push({
    id: 'step-8-receipt-inspection',
    stepNumber: 8,
    stepLabel: '8',
    title: 'استلام المخزن والفحص الهندسي',
    role: isWarehouseBypassed ? 'مهندس الموقع (تخطي المخزن)' : 'أمين المخزن ومهندس الموقع',
    assignee: request.site_engineer?.name || 'مسؤول الاستلام الميداني',
    state: cardReceiptState,
    description: isWarehouseBypassed
      ? 'تم التخطي التلقائي للاستلام المخزني لعدم اشتراط المخزن لهذا الطلب. يتطلب فقط الفحص الهندسي الميداني بالموقع.'
      : 'تحرير إذن الاستلام المخزني ومطابقة واعتماد الفحص الهندسي الميداني بالموقع.',
    badgeText: card8BadgeText,
    icon: '🏗️',
    actionNote: cardReceiptState === 'ACTIVE'
      ? isWarehouseBypassed
        ? 'تم التخطي التلقائي للاستلام المخزني (لا يوجد مخزن)، وبانتظار اعتماد وفحص مهندس الموقع في الميدان.'
        : hasWarehouseReceipt
        ? 'تم تحرير إذن الاستلام بالمخزن، وبانتظار اعتماد ومطابقة مهندس الموقع في الميدان.'
        : 'أمر الشراء صادر، وبانتظار وصول وتوريد المواد للموقع/المخزن.'
      : undefined,
    checklists,
  });

  // البطاقة 9: إصدار أمر الشراء الفعلي (Actual PO) - المحطة النهائية والمكتملة (100%)
  let cardActualPoState: TimelineCardState = 'PENDING';
  if (hasActualPoFinalized) {
    cardActualPoState = 'COMPLETED';
  } else if (hasApprovedReceipt || pos.some((po: any) => po.status === 'PENDING_ACTUAL_PO')) {
    cardActualPoState = isRejected ? 'REJECTED' : 'ACTIVE';
  } else {
    cardActualPoState = 'PENDING';
  }

  cards.push({
    id: 'step-9-actual-po',
    stepNumber: 9,
    stepLabel: '9',
    title: 'إصدار أمر الشراء الفعلي (Actual PO)',
    role: 'إدارة المشتريات',
    assignee: 'مدير المشتريات',
    state: cardActualPoState,
    description: cardActualPoState === 'COMPLETED'
      ? '💡 تم الفحص الهندسي بنجاح، وتم إصدار أمر الشراء الفعلي (Actual PO) وبكده تكون خلصت وتمت بنجاح.'
      : 'إصدار أمر الشراء الفعلي بالكميات المستلمة بعد الفحص الهندسي لإغلاق المعاملة.',
    badgeText:
      cardActualPoState === 'COMPLETED'
        ? 'أمر شراء فعلي معتمد (100%) ✅'
        : cardActualPoState === 'ACTIVE'
        ? 'بانتظار إصدار الأمر الفعلي 🔵'
        : 'المحطة الختامية ⚪',
    icon: '🎯',
    actionNote:
      cardActualPoState === 'COMPLETED'
        ? '💡 تم الفحص الهندسي بنجاح، وتم إصدار أمر الشراء الفعلي (Actual PO) وبكده تكون خلصت وتمت بنجاح.'
        : cardActualPoState === 'ACTIVE'
        ? 'تم الفحص الهندسي بنجاح، وبانتظار قيام مدير المشتريات بإصدار أمر الشراء الفعلي (Actual PO) لإغلاق المعاملة بنسبة 100%.'
        : undefined,
  });

  return cards;
};

/**
 * Returns a summary guidance message for the entire workflow progress.
 */
export const getActionGuidance = (request: PurchaseRequest): { text: string; bg: string; icon: string } => {
  const status = String(request.status);
  const isDirect = isDirectProcurement(request);
  const isReturned = isPrPricingReturned(request);
  const pos = (request as any).purchase_orders || [];

  const hasApprovedReceipt =
    pos.some(
      (po: any) =>
        po.has_approved_receipt || (po.receipts || []).some((r: any) => r.status === 'APPROVED')
    ) || historyHas(request, ['SITE_ENGINEER_APPROVED', 'RECEIPT_APPROVED_BY_SITE_ENGINEER']);

  const hasWarehouseReceipt =
    pos.some((po: any) => (po.receipts || []).length > 0) ||
    historyHas(request, ['WAREHOUSE_RECEIPT_APPROVED', 'PURCHASE_RECEIPT_CREATED', 'WAREHOUSE_RECEIPT_SUBMITTED']);

  const hasIssuedPo =
    (request.issued_purchase_orders_count ?? 0) > 0 ||
    pos.some((po: any) =>
      ['ISSUED', 'PENDING_ACCOUNTING_REVIEW', 'APPROVED_BY_ACCOUNTING', 'FINAL_APPROVED'].includes(po.status)
    ) ||
    Boolean(request.purchase_order_issued);

  const hasActualPoFinalized =
    pos.some(
      (po: any) =>
        Boolean(po.finalized_at) ||
        Boolean(po.is_actual_po) ||
        po.status === 'FINAL_APPROVED'
    ) ||
    historyHas(request, ['ACTUAL_PO_FINALIZED', 'ACTUAL_PO_ISSUED']) ||
    ['COMPLETED', 'ACCOUNTING_PROCESSED'].includes(status);

  if (status === 'DRAFT') {
    return {
      icon: '✍️',
      text: 'الطلب ما زال مسودة لديك. اضغط على «إرسال الطلب» لإرساله إلى رئيس قسمك للمراجعة والاعتماد.',
      bg: 'border-slate-700 bg-slate-900/80 text-slate-200',
    };
  }
  if (status === 'REJECTED') {
    return {
      icon: '❌',
      text: `تم رفض هذا الطلب وإيقاف دورة العمل. ${request.rejection_reason ? `سبب الرفض: ${request.rejection_reason}` : ''}`,
      bg: 'border-rose-800 bg-rose-950/60 text-rose-200',
    };
  }
  if (status === 'ACCOUNTING_PROCESSED' || status === 'COMPLETED' || hasActualPoFinalized) {
    return {
      icon: '🎉',
      text: '💡 تم الفحص الهندسي بنجاح، وتم إصدار أمر الشراء الفعلي (Actual PO) وبكده تكون خلصت وتمت بنجاح (100%).',
      bg: 'border-emerald-600 bg-emerald-950/60 text-emerald-100',
    };
  }
  if (hasApprovedReceipt || pos.some((po: any) => po.status === 'PENDING_ACTUAL_PO')) {
    return {
      icon: '🎯',
      text: 'تم فحص واعتماد المواد هندسياً بالموقع بنجاح، وبانتظار قيام مدير المشتريات بإصدار أمر الشراء الفعلي (Actual PO) لإغلاق المعاملة بنسبة 100%.',
      bg: 'border-cyan-600 bg-cyan-950/50 text-cyan-100',
    };
  }
  if (hasWarehouseReceipt) {
    return {
      icon: '📦',
      text: 'تم تسجيل استلام المواد بالمخزن بنجاح، وبانتظار اعتماد ومطابقة مهندس الموقع في الميدان.',
      bg: 'border-amber-600 bg-amber-950/50 text-amber-200',
    };
  }
  if (hasIssuedPo) {
    const isWarehouseBypassed =
      request.request_type !== 'OFFICE_SUPPLIES' &&
      request.requires_warehouse_receipt === false;

    if (isWarehouseBypassed) {
      return {
        icon: '🏗️',
        text: 'تم إصدار أمر الشراء (PO) للمورد مع تخطي المخزن تلقائياً. بانتظار توريد الشحنة وفحصها واعتمادها ميدانياً من مهندس الموقع.',
        bg: 'border-cyan-700/50 bg-cyan-950/40 text-cyan-200',
      };
    }

    return {
      icon: '🚚',
      text: 'تم إصدار أمر الشراء (PO) للمورد. بانتظار توريد الشحنة وتأكيد استلامها بالمخزن والموقع.',
      bg: 'border-cyan-700/50 bg-cyan-950/40 text-cyan-200',
    };
  }
  if (status === 'APPROVED_BY_ACCOUNTING' || (isDirect && status === 'APPROVED_BY_PROCUREMENT')) {
    return {
      icon: '💼',
      text: 'تمت كافة الاعتمادات المالية والإدارية بنجاح، والطلب الآن لدى مدير المشتريات لإصدار أمر الشراء.',
      bg: 'border-amber-700/50 bg-amber-950/40 text-amber-200',
    };
  }
  if (status === 'PENDING_EXECUTIVE_QUOTE_DECISION') {
    return {
      icon: '🏆',
      text: 'اكتملت ترشيحات عروض الأسعار من الحسابات والقسم الفني، وبانتظار قرار الترسية النهائي من المدير التنفيذي.',
      bg: 'border-purple-700/50 bg-purple-950/40 text-purple-200',
    };
  }
  if (status === 'PENDING_QUOTE_RECOMMENDATIONS') {
    return {
      icon: '📊',
      text: 'عروض الأسعار مسجلة لدى النظام، وبانتظار اكتمال الترشيح المالي (الحسابات) والترشيح الفني (رئيس القسم).',
      bg: 'border-cyan-700/50 bg-cyan-950/40 text-cyan-200',
    };
  }
  if (status === 'PENDING_ACCOUNTING_APPROVAL') {
    return {
      icon: '💳',
      text: 'اعتمد المدير التنفيذي التسعير والمورد، والطلب الآن لدى الإدارة المالية للتدقيق والموافقة المالية.',
      bg: 'border-amber-700/50 bg-amber-950/40 text-amber-200',
    };
  }
  if (status === 'PENDING_EXECUTIVE_APPROVAL') {
    return {
      icon: '👔',
      text: isReturned
        ? 'أتمّت المشتريات التسعير، والطلب معروض على المدير التنفيذي لاعتماد الأسعار والمورد المحدد.'
        : 'تم اعتماد الطلب من رئيس القسم، وهو الآن بانتظار الموافقة المبدئية من المدير التنفيذي للتصريح بالشراء.',
      bg: 'border-violet-700/50 bg-violet-950/40 text-violet-200',
    };
  }
  if (status === 'PENDING_PROCUREMENT_APPROVAL') {
    return {
      icon: '🏷️',
      text: 'الطلب لدى إدارة المشتريات لاختيار المسار المناسب (شراء مباشر وتسعير أو جمع عروض أسعار).',
      bg: 'border-cyan-700/50 bg-cyan-950/40 text-cyan-200',
    };
  }
  if (status === 'SUBMITTED' || status === 'UNDER_REVIEW') {
    return {
      icon: '⏳',
      text: `الطلب الآن بانتظار مراجعة واعتماد رئيس القسم (${request.target_department?.name || request.department?.name || 'قسمك'}).`,
      bg: 'border-cyan-700/50 bg-cyan-950/40 text-cyan-200',
    };
  }

  return {
    icon: 'ℹ️',
    text: 'الطلب جارٍ متابعته في دورة المشتريات.',
    bg: 'border-slate-700 bg-slate-900/60 text-slate-300',
  };
};

export const PurchaseRequestTimeline: React.FC<PurchaseRequestTimelineProps> = ({
  request,
  compact = false,
  listView = false,
}) => {
  const isDirect = isDirectProcurement(request);
  const isQuotes = isQuotesProcurement(request);
  const isRejected = request.status === 'REJECTED';

  const cards = useMemo(() => generateTimelineCards(request), [request]);
  const guidance = useMemo(() => getActionGuidance(request), [request]);
  const activeStepIndex = useMemo(() => getTimelineStepIndex(request), [request]);
  const lifecycle = useMemo(() => getRequestLifecycle(request), [request]);

  const completedCardsCount = cards.filter((c) => c.state === 'COMPLETED').length;
  const isActualPoComplete = cards.some((c) => c.id === 'step-9-actual-po' && c.state === 'COMPLETED');
  const progressPercent =
    isActualPoComplete || completedCardsCount >= cards.length
      ? 100
      : Math.round((completedCardsCount / Math.max(cards.length, 1)) * 100);

  if (listView) {
    return (
      <section className="space-y-3" dir="rtl" aria-label="شريط تتبع دورة عمل طلب الشراء">
        <div className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold leading-6 ${guidance.bg}`}>
          <span className="text-lg shrink-0 select-none">{guidance.icon}</span>
          <p className="flex-1">{guidance.text}</p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-black text-slate-100">مراحل الطلب</h3>
          {!isRejected && (
            <span className="text-[11px] font-bold text-slate-400">
              {completedCardsCount} من {cards.length}
            </span>
          )}
        </div>

        <ol className="space-y-1.5">
          {cards.map((card) => {
            const isCompleted = card.state === 'COMPLETED';
            const isActive = card.state === 'ACTIVE';
            const isCardRejected = card.state === 'REJECTED';
            const marker = isCompleted ? '✓' : isCardRejected ? '✕' : isActive ? '●' : String(card.stepNumber);
            const markerStyle = isCompleted
              ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
              : isCardRejected
              ? 'bg-rose-500/20 border-rose-500/50 text-rose-300'
              : isActive
              ? 'bg-cyan-500/30 border-cyan-400 text-cyan-200'
              : 'bg-slate-900 border-slate-700 text-slate-500';

            return (
              <li
                key={card.id}
                aria-current={isActive ? 'step' : undefined}
                className={`rounded-xl border px-3 py-2 ${
                  isActive ? 'border-cyan-500/50 bg-cyan-950/30' : isCardRejected ? 'border-rose-500/40 bg-rose-950/20' : 'border-slate-800 bg-slate-950/50'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border font-mono text-[11px] font-black ${markerStyle}`}>
                    {marker}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-bold ${isCompleted || isActive ? 'text-slate-100' : 'text-slate-400'}`}>{card.title}</p>
                    <p className="text-[10px] text-slate-500">{card.assignee || card.role}</p>
                  </div>
                  {(isActive || isCardRejected || card.badgeText.includes('تخطي')) && (
                    <span className={`shrink-0 text-[10px] font-bold ${isCardRejected ? 'text-rose-300' : isActive ? 'text-cyan-300' : 'text-slate-400'}`}>
                      {card.badgeText.replace(/[✅🔵❌⚪⏭]/gu, '').trim()}
                    </span>
                  )}
                </div>
                {isActive && card.checklists && card.checklists.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pr-8 text-[10px] text-slate-400">
                    {card.checklists.map((chk, cIdx) => (
                      <span key={cIdx} className={chk.isCompleted ? 'text-emerald-300' : ''}>
                        {chk.isCompleted ? '✔' : '⏳'} {chk.label}: {chk.statusText}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  return (
    <section className="space-y-4" dir="rtl" aria-label="شريط تتبع دورة عمل طلب الشراء">
      {/* ── Status & Guidance Banner ── */}
      <div
        className={`flex items-start sm:items-center gap-3.5 rounded-2xl border p-4 text-xs font-semibold shadow-xl backdrop-blur-md transition-all ${guidance.bg}`}
      >
        <span className="text-2xl shrink-0 select-none animate-bounce">{guidance.icon}</span>
        <div className="flex-1 leading-6">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <strong className="text-[11px] font-black uppercase tracking-wider opacity-90">
              الوضع الحالي للطلب:
            </strong>
            <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-black/30 border border-white/10 text-white">
              {lifecycle.statusLabel}
            </span>
            {lifecycle.poNumber && (
              <span className="font-mono text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-bold">
                أمر شراء: {lifecycle.poNumber}
              </span>
            )}
          </div>
          <p className="text-xs font-medium">{guidance.text}</p>
        </div>
      </div>

      {/* ── Header Bar: Workflow Route & Progress ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-950 border border-cyan-600/50 text-cyan-300 text-xs font-black">
            📊
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-100 flex items-center gap-2">
              <span>خارطة تتبع المعاملة (Workflow Pipeline)</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              مسار ديناميكي يعكس مراحل الدورة المستندية وحالة كل مرحلة لحظيًا
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 self-end sm:self-auto">
          {/* Route Badge */}
          <span
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1 text-xs font-bold shadow-sm ${
              isRejected
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                : isDirect
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                : isQuotes
                ? 'border-purple-500/40 bg-purple-500/10 text-purple-300'
                : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200'
            }`}
          >
            <span>{isRejected ? '✕' : isDirect ? '⚡' : '📋'}</span>
            <span>
              {isRejected
                ? 'طلب مرفوض'
                : isDirect
                ? 'مسار الشراء المباشر'
                : isQuotes
                ? 'مسار مناقصة عروض الأسعار'
                : 'مسار التوريد المعتمد'}
            </span>
          </span>

          {/* Progress Indicator */}
          {!isRejected && (
            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-xl bg-slate-900 border border-slate-800 text-[11px] font-bold text-slate-300">
              <span>الإنجاز:</span>
              <span className="font-mono text-emerald-400">{progressPercent}%</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Dynamic Workflow Cards Grid ── */}
      <div
        className={`grid gap-3 ${
          compact
            ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
            : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
        }`}
      >
        {cards.map((card, idx) => {
          const isCompleted = card.state === 'COMPLETED';
          const isActive = card.state === 'ACTIVE';
          const isPending = card.state === 'PENDING';
          const isCardRejected = card.state === 'REJECTED';

          // Visual styles based on card state
          let cardBorderBg = 'border-slate-800 bg-slate-950/60 text-slate-400';
          let iconContainerStyle = 'bg-slate-800 border-slate-700 text-slate-400';
          let badgeStyle = 'bg-slate-900 border-slate-800 text-slate-400';

          if (isCompleted) {
            cardBorderBg =
              'border-emerald-500/40 bg-gradient-to-b from-emerald-950/30 to-slate-950/70 text-slate-200 hover:border-emerald-500/60';
            iconContainerStyle = 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-sm';
            badgeStyle = 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300';
          } else if (isActive) {
            cardBorderBg =
              'border-cyan-400/80 bg-gradient-to-b from-cyan-950/50 to-slate-950/90 text-slate-100 ring-2 ring-cyan-400/30 shadow-lg shadow-cyan-950/50';
            iconContainerStyle =
              'bg-cyan-500/30 border-cyan-400 text-cyan-200 shadow-md shadow-cyan-500/30 animate-pulse';
            badgeStyle = 'bg-cyan-950/90 border-cyan-400/60 text-cyan-200 font-black animate-pulse';
          } else if (isCardRejected) {
            cardBorderBg =
              'border-rose-500/60 bg-gradient-to-b from-rose-950/40 to-slate-950/80 text-rose-200';
            iconContainerStyle = 'bg-rose-500/20 border-rose-500/50 text-rose-300';
            badgeStyle = 'bg-rose-950/90 border-rose-500/50 text-rose-300';
          }

          return (
            <div
              key={card.id}
              className={`relative flex flex-col justify-between rounded-2xl border p-4 transition-all duration-300 backdrop-blur-md group ${cardBorderBg}`}
            >
              {/* Card Top: Step number/icon & Status Badge */}
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border font-mono text-xs font-black transition-transform group-hover:scale-105 ${iconContainerStyle}`}
                  >
                    {isCompleted ? '✓' : isCardRejected ? '✕' : card.icon}
                  </div>
                  <span className="text-[11px] font-mono font-bold text-slate-400">
                    مرحلة #{card.stepNumber}
                  </span>
                </div>

                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg border text-[11px] font-bold shadow-xs ${badgeStyle}`}
                >
                  <span>{isCompleted ? '✅' : isActive ? '🔵' : isCardRejected ? '❌' : '⚪'}</span>
                  <span>{card.badgeText}</span>
                </span>
              </div>

              {/* Card Body: Title, Role & Assignee */}
              <div className="space-y-1.5 flex-1">
                <h4 className="text-xs sm:text-sm font-black text-slate-100 leading-snug">
                  {card.title}
                </h4>

                <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-300">
                  <span className="text-slate-500">المسؤول:</span>
                  <span
                    className={
                      isActive
                        ? 'text-cyan-300 font-extrabold'
                        : isCompleted
                        ? 'text-emerald-300'
                        : 'text-slate-300'
                    }
                  >
                    {card.assignee || card.role}
                  </span>
                </div>

                {!compact && (
                  <p className="text-[11px] leading-5 text-slate-400 pt-1 line-clamp-2">
                    {card.description}
                  </p>
                )}

                {/* Visual Checklists for Separated Steps (e.g. Warehouse & Site Inspection) */}
                {!compact && card.checklists && card.checklists.length > 0 && (
                  <div className="mt-2.5 space-y-1.5 pt-2 border-t border-slate-800/80">
                    <div className="text-[10px] font-bold text-slate-400 flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        <span>📋</span>
                        <span>مراحل الاستلام والفحص:</span>
                      </span>
                      {card.checklists.some((c) => c.isBypassed) && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold">
                          تخطي تلقائي للمخزن
                        </span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {card.checklists.map((chk, cIdx) => (
                        <div
                          key={cIdx}
                          className={`flex items-center justify-between gap-2 px-2 py-1 rounded-lg text-[10px] font-semibold border transition-all ${
                            chk.isCompleted
                              ? chk.isBypassed
                                ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                                : 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                              : isActive
                              ? 'bg-cyan-950/20 border-cyan-500/30 text-cyan-200'
                              : 'bg-slate-900/40 border-slate-800 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`font-mono text-xs font-black ${
                                chk.isCompleted ? 'text-emerald-400' : 'text-slate-500'
                              }`}
                            >
                              {chk.isCompleted ? '✔' : '⏳'}
                            </span>
                            <span className="font-bold">{chk.label}</span>
                            <span className="text-[9px] text-slate-400">({chk.role})</span>
                          </div>
                          <span
                            className={`text-[9px] font-mono ${
                              chk.isBypassed
                                ? 'text-emerald-300 font-bold'
                                : chk.isCompleted
                                ? 'text-emerald-300'
                                : 'text-slate-400'
                            }`}
                          >
                            {chk.statusText}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Card Bottom: Active Action Note or Actual PO Completed Note */}
              {((isActive && card.actionNote) || (isCompleted && card.id === 'step-9-actual-po')) && (
                <div
                  className={`mt-3 rounded-xl border p-2 text-[10px] font-semibold leading-4 ${
                    isCompleted && card.id === 'step-9-actual-po'
                      ? 'border-emerald-500/50 bg-emerald-950/50 text-emerald-200 shadow-sm'
                      : 'border-cyan-500/40 bg-cyan-950/40 text-cyan-200'
                  }`}
                >
                  <span>
                    {isCompleted && card.id === 'step-9-actual-po'
                      ? '💡 تم الفحص الهندسي بنجاح، وتم إصدار أمر الشراء الفعلي (Actual PO) وبكده تكون خلصت وتمت بنجاح.'
                      : `💡 ${card.actionNote}`}
                  </span>
                </div>
              )}

              {/* Subtle visual connector dot */}
              {idx < cards.length - 1 && (
                <div className="hidden lg:block absolute -left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-slate-800 border-2 border-slate-700 z-10" />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default PurchaseRequestTimeline;
