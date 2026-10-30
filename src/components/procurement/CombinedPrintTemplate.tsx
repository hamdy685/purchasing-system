import React from 'react';
import { PurchaseOrder } from '../../types/purchaseOrder';
import { getUnitLabel } from '../../utils/units';
import { formatCleanNumber } from '../../utils/numberFormat';
import { isActualPurchaseOrder, getActualPoLineItems } from '../../utils/actualPo';

export interface CombinedPrintTemplateProps {
  po?: PurchaseOrder | null;
  receipt?: any | null;
  pr?: any | null;

  // Manual / Individual Prop Overrides (optional)
  prNumber?: string;
  prDate?: string | null;
  requesterName?: string;
  reviewerName?: string;
  executionManagerName?: string;
  executiveApproverName?: string;
  departmentName?: string;
  projectOrParcel?: string;
  projectName?: string;
  parcelReference?: string;
  plotNumber?: string;
  region?: string;
  purpose?: string;
  prItems?: Array<{
    item_description?: string;
    item_name?: string;
    uom?: string;
    quantity?: number | string;
    specifications?: string;
    notes?: string;
  }>;

  poNumber?: string;
  poDate?: string | null;
  supplierName?: string;
  procurementName?: string;
  accountantName?: string;
  generalManagerName?: string;
  deliveryDate?: string;
  paymentTerms?: string;
  poItems?: Array<{
    id?: number;
    item_description?: string;
    item_name?: string;
    item_reference?: string;
    region?: string;
    uom?: string;
    quantity?: number | string;
    unit_price?: number | string;
    line_total?: number | string;
    specifications?: string;
    supplier_name?: string;
  }>;
  grandTotal?: number | string;

  // Shared & Contextual overrides
  items?: Array<{
    id?: number;
    item_description?: string;
    item_name?: string;
    item_reference?: string;
    region?: string;
    quantity?: number | string;
    uom?: string;
    unit_price?: number | string;
    line_total?: number | string;
    specifications?: string;
    delivery_date?: string;
    supplier_name?: string;
  }>;
  procurementReviewerName?: string;
  qualityReviewerName?: string;

  // GRN specific props
  grnNumber?: string;
  grnDate?: string | null;
  warehouseKeeperName?: string;
  warehouseKeeperPassText?: string;
  siteEngineerName?: string;
  engineerName?: string;
  actualReceiverName?: string;
  receiverName?: string;
  grnItems?: Array<{
    item_description?: string;
    item_name?: string;
    uom?: string;
    received_quantity?: number | string;
    quantity?: number | string;
    notes?: string;
  }>;
}

const formatDate = (value?: string | null): string => {
  if (!value) return '---';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const CombinedPrintTemplate = React.forwardRef<HTMLDivElement, CombinedPrintTemplateProps>(
  (props, ref) => {
    const {
      po,
      receipt: propReceipt,
      pr: propPr,
    } = props;

    // Resolve Context Entities
    const resolvedPr = propPr || po?.purchase_request || null;
    const resolvedReceipt = propReceipt || po?.receipts?.[0] || null;

    // ── 1. Section 1: Purchase Request (طلب الشراء) ───────────────────────────
    const displayPrNumber =
      props.prNumber ||
      resolvedPr?.request_number ||
      '---';

    const prDate = formatDate(props.prDate || resolvedPr?.created_at);

    // Resolve Project, Region, and Parcel Number without cross-pollution
    const isOfficeRequest = resolvedPr?.request_type === 'OFFICE_SUPPLIES';

    const rawProject =
      props.projectName ||
      resolvedPr?.project_name ||
      (po as any)?.project_name ||
      resolvedReceipt?.project_name ||
      (isOfficeRequest ? 'المقر الرئيسي / إداري' : '');
    const displayProject = rawProject && String(rawProject).trim() ? String(rawProject).trim() : (isOfficeRequest ? 'المقر الرئيسي / إداري' : 'غير مسجل');

    const rawRegion =
      props.region ||
      resolvedPr?.region ||
      po?.purchase_request?.region ||
      (po as any)?.region ||
      resolvedReceipt?.purchase_request?.region ||
      resolvedReceipt?.purchase_order?.purchase_request?.region ||
      resolvedPr?.items?.find((i: any) => i.region)?.region ||
      po?.items?.find((i: any) => i.region)?.region ||
      props.items?.find((i: any) => i.region)?.region ||
      '';
    const displayRegion = rawRegion && String(rawRegion).trim() ? String(rawRegion).trim() : 'غير مسجلة';

    const rawParcel =
      props.parcelReference ||
      props.plotNumber ||
      resolvedPr?.parcel_reference ||
      po?.purchase_request?.parcel_reference ||
      (po as any)?.parcel_reference ||
      resolvedReceipt?.purchase_request?.parcel_reference ||
      resolvedReceipt?.purchase_order?.purchase_request?.parcel_reference ||
      resolvedPr?.items?.find((i: any) => i.item_reference)?.item_reference ||
      po?.items?.find((i: any) => i.item_reference)?.item_reference ||
      props.items?.find((i: any) => i.item_reference)?.item_reference ||
      props.projectOrParcel ||
      '';
    const displayParcel = rawParcel && String(rawParcel).trim() ? String(rawParcel).trim() : 'غير مسجل';

    // Keep legacy projectName alias for any downstream references
    const projectName = displayProject;

    const requesterName =
      props.requesterName ||
      resolvedPr?.requester?.name ||
      po?.requested_by?.name ||
      '---';

    const reviewerName =
      props.reviewerName ||
      resolvedPr?.assigned_reviewer?.name ||
      (resolvedPr?.approval_history?.find((a: any) => a.action === 'APPROVED_BY_REVIEWER')?.actor?.name) ||
      '---';

    const gmName =
      props.executionManagerName ||
      props.executiveApproverName ||
      (resolvedPr?.approval_history?.find((a: any) =>
        a.action === 'APPROVED_BY_EXECUTIVE' || a.action === 'EXECUTIVE_SELECTED_QUOTE'
      )?.actor?.name) ||
      po?.executive_approver?.name ||
      '---';

    // PR Line Items - strictly isolate to items belonging to this PO
    let rawPrItems = props.prItems || props.items || resolvedPr?.items || [];
    if (po?.items && po.items.length > 0 && rawPrItems.length > 0) {
      const poPrItemIds = po.items.map((pi: any) => pi.pr_item_id).filter(Boolean);
      const poItemNames = po.items.map((pi: any) => (pi.item_description || pi.item_name || '').trim().toLowerCase());
      const filtered = rawPrItems.filter((item: any) => {
        if (poPrItemIds.length > 0 && item.id && poPrItemIds.includes(item.id)) {
          return true;
        }
        const desc = (item.item_description || item.item_name || item.item?.name || '').trim().toLowerCase();
        return desc && poItemNames.includes(desc);
      });
      if (filtered.length > 0) {
        rawPrItems = filtered;
      }
    }

    const requestPurpose =
      resolvedPr?.notes ||
      (po as any)?.purchase_request?.notes ||
      props.purpose ||
      (po as any)?.notes ||
      null;

    const resolvedPrItems = rawPrItems.length > 0
      ? rawPrItems.map((item: any) => ({
          description: item.item_description || item.item_name || item.item?.name || '---',
          uom: item.uom || 'PCS',
          quantity: item.quantity ?? '---',
          specifications: item.specifications || '---',
          purpose: requestPurpose || item.purpose || item.notes || item.specifications || '---',
        }))
      : (po?.items || []).map((poItem: any) => ({
          description: poItem.pr_item?.item_description || poItem.item_description || poItem.item_name || '---',
          uom: poItem.pr_item?.uom || poItem.uom || 'PCS',
          quantity: poItem.pr_item?.quantity || poItem.quantity || '---',
          specifications: poItem.pr_item?.specifications || poItem.specifications || '---',
          purpose: requestPurpose || poItem.pr_item?.notes || poItem.specifications || '---',
        }));

    // ── 2. Section 2: Actual Purchase Order (أمر الشراء الفعلي) ───────────────
    const displayPoNumber =
      props.poNumber ||
      po?.po_number ||
      '---';

    const poDate = formatDate(props.poDate || po?.finalized_at || po?.created_at);

    const supplierName =
      props.supplierName ||
      po?.supplier?.company_name ||
      '---';

    const procurementName =
      props.procurementName ||
      props.procurementReviewerName ||
      po?.finalized_by?.name ||
      po?.created_by?.name ||
      '---';

    const poGmName =
      props.generalManagerName ||
      (po as any)?.general_manager?.name ||
      (po?.approval_history?.find((a: any) => a.action === 'GM_APPROVED' || a.action === 'EXECUTIVE_APPROVED')?.actor?.name) ||
      'م. محمد عبدالكريم';

    // PO Line Items (Actual final quantities and prices approved by procurement)
    const isActual = isActualPurchaseOrder(po);
    const rawPoItems = props.poItems || props.items || (isActual ? getActualPoLineItems(po) : (po?.items || []));
    const resolvedPoItems = rawPoItems
      .filter((item: any) => {
        if (!isActual) return true;
        const qty = Number(item.quantity ?? 0);
        return qty > 0;
      })
      .map((item: any) => {
        const qty = Number(item.quantity || 0);
        const price = Number(item.unit_price || 0);
        const lineTotal = item.line_total !== undefined ? Number(item.line_total) : Math.round(qty * price * 100) / 100;
        const itemPurpose =
          requestPurpose ||
          item.specifications ||
          item.pr_item?.notes ||
          item.pr_item?.specifications ||
          item.notes ||
          '---';
        return {
          description: item.item_description || item.item_name || '---',
          supplier: item.supplier?.company_name || item.supplier_name || props.supplierName || po?.supplier?.company_name || '---',
          purpose: itemPurpose,
          uom: item.uom || 'PCS',
          quantity: item.quantity ?? 0,
          unit_price: price,
          line_total: lineTotal,
        };
      });

    const grandTotal =
      props.grandTotal !== undefined
        ? Number(props.grandTotal)
        : (isActual ? resolvedPoItems.reduce((acc, it) => acc + it.line_total, 0) : (po?.grand_total !== undefined ? Number(po.grand_total) : resolvedPoItems.reduce((acc, it) => acc + it.line_total, 0)));

    // ── 3. Section 3: Goods Receipt Note (إذن الاستلام) ──────────────────────
    const displayGrnNumber =
      props.grnNumber ||
      resolvedReceipt?.receipt_number ||
      (po?.po_number ? `GRN-${po.po_number}` : '---');

    const grnDate = formatDate(
      props.grnDate ||
      resolvedReceipt?.received_at ||
      resolvedReceipt?.site_engineer_approved_at ||
      resolvedReceipt?.created_at
    );

    const rawKeeperName =
      props.warehouseKeeperName ||
      resolvedReceipt?.warehouse_keeper?.name ||
      (resolvedReceipt?.warehouse_keeper && typeof resolvedReceipt.warehouse_keeper === 'string' ? resolvedReceipt.warehouse_keeper : null);

    const isDirectSite =
      resolvedReceipt?.receipt_type === 'SITE_DIRECT' ||
      resolvedPr?.requires_warehouse_receipt === false ||
      (po as any)?.requires_warehouse_receipt === false;

    const keeperPassText =
      props.warehouseKeeperPassText ||
      (rawKeeperName || resolvedReceipt?.warehouse_keeper_user_id || resolvedReceipt?.warehouse_submitted_at
        ? 'مر على إذن الاستلام'
        : isDirectSite
        ? 'لم يمر على إذن الاستلام'
        : resolvedReceipt
        ? 'لم يمر على إذن الاستلام'
        : 'غير مثبت');

    const storekeeperName = rawKeeperName || (isDirectSite ? '—' : '---');

    const actualReceiverName =
      props.actualReceiverName ||
      props.receiverName ||
      resolvedReceipt?.actual_receiver?.name ||
      resolvedReceipt?.actual_receiver_name ||
      resolvedReceipt?.receiver?.name ||
      resolvedReceipt?.actual_receiver_display_name ||
      (resolvedReceipt ? 'غير مسجل' : '---');

    // GRN Line Items: map receipt items, strictly filtering out zero-quantity or non-received items
    const rawGrnItems = (props.grnItems || resolvedReceipt?.items || []).filter((item: any) => {
      const qty = Number(item.received_quantity ?? item.quantity ?? 0);
      if (qty <= 0) return false;
      if (po?.id && item.purchase_order_id && Number(item.purchase_order_id) !== Number(po.id)) {
        return false;
      }
      return true;
    });
    const resolvedGrnItems = rawGrnItems.length > 0
      ? rawGrnItems.map((item: any) => {
          const poItem = item.purchase_order_item || po?.items?.find((p: any) => p.id === item.purchase_order_item_id);
          const grnPurpose =
            requestPurpose ||
            poItem?.specifications ||
            poItem?.pr_item?.notes ||
            poItem?.pr_item?.specifications ||
            item.notes ||
            '---';
          return {
            description: poItem?.item_description || poItem?.item_name || item.item_description || '---',
            purpose: grnPurpose,
            uom: poItem?.uom || item.uom || 'PCS',
            received_quantity: item.received_quantity ?? item.quantity ?? '---',
            notes: item.notes || resolvedReceipt?.warehouse_notes || 'مطابق للفحص والمعاينة',
          };
        })
      : resolvedPoItems.map((poItem: any) => ({
          description: poItem.description,
          purpose: poItem.purpose,
          uom: poItem.uom,
          received_quantity: poItem.quantity,
          notes: resolvedReceipt?.warehouse_notes || 'مطابق للفحص والمعاينة',
        }));

    return (
      <div
        ref={ref}
        className="combined-print-template print-document w-full print:w-full print:p-0 print:shadow-none bg-white text-black dir-rtl font-sans leading-relaxed"
        dir="rtl"
      >
        {/* ══════════════════════════════════════════════════════════════════════
            القسم الأول: طلب الشراء (Purchase Request)
           ══════════════════════════════════════════════════════════════════════ */}
        <section className="print:break-inside-avoid">
          {/* الترويسة: grid grid-cols-3 items-center mb-4 */}
          <div className="grid grid-cols-3 items-center mb-4">
            {/* يمين: بيانات المشروع والمنطقة وقطعة الأرض والتاريخ */}
            <div className="text-right text-xs leading-normal space-y-0.5">
              <div>
                <span className="font-bold text-gray-700">المشروع: </span>
                <span className="font-semibold text-gray-900">{displayProject}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">المنطقة: </span>
                <span className="font-semibold text-gray-900">{displayRegion}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">رقم قطعة الأرض: </span>
                <span className="font-mono font-semibold text-gray-900">{displayParcel}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">التاريخ: </span>
                <span className="font-mono font-semibold text-gray-900">{prDate}</span>
              </div>
            </div>

            {/* وسط: 'طلب شراء رقم: PR-XXX' بخط عريض وشريط بيانات الموقع */}
            <div className="text-center">
              <h2 className="text-base sm:text-lg font-bold text-black tracking-wide">
                طلب شراء رقم: <span className="font-mono text-gray-900">{displayPrNumber}</span>
              </h2>
              <div className="text-[10px] sm:text-xs font-semibold text-gray-700 mt-1 flex items-center justify-center gap-1.5 flex-wrap">
                <span>المشروع: <strong className="text-gray-900">{displayProject}</strong></span>
                <span className="text-gray-300">|</span>
                <span>المنطقة: <strong className="text-gray-900">{displayRegion}</strong></span>
                <span className="text-gray-300">|</span>
                <span>قطعة الأرض: <strong className="font-mono text-gray-900">{displayParcel}</strong></span>
              </div>
            </div>

            {/* يسار: شعار الشركة */}
            <div className="flex justify-end items-center gap-2">
              <img
                src="/eshbelia-logo.png"
                alt="شعار الشركة"
                className="h-10 w-auto object-contain"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
              />
              <div className="text-left text-xs font-bold leading-tight">
                <div className="text-gray-900">شركة إشبيلية</div>
                <div className="text-[10px] text-gray-500 font-normal">للتطوير العقاري والمقاولات</div>
              </div>
            </div>
          </div>

          {/* الجدول: جدول بسيط بحدود خفيفة border-gray-300 */}
          <table className="w-full border-collapse border border-gray-300 text-right text-[11pt]">
            <thead>
              <tr className="bg-gray-50 print:bg-gray-100 font-bold border-b border-gray-300 text-gray-800">
                <th className="border border-gray-300 p-2 text-center w-10">م</th>
                <th className="border border-gray-300 p-2">الصنف</th>
                <th className="border border-gray-300 p-2">المواصفات الفنية</th>
                <th className="border border-gray-300 p-2 text-center w-32">الغرض</th>
                <th className="border border-gray-300 p-2 text-center w-20">الوحدة</th>
                <th className="border border-gray-300 p-2 text-center w-28">الكمية المطلوبة</th>
              </tr>
            </thead>
            <tbody>
              {resolvedPrItems.length > 0 ? (
                resolvedPrItems.map((item: any, idx: number) => (
                  <tr key={`pr-item-${idx}`} className="border-b border-gray-300">
                    <td className="border border-gray-300 p-2 text-center font-bold text-gray-600">{idx + 1}</td>
                    <td className="border border-gray-300 p-2 font-semibold text-gray-900">{item.description}</td>
                    <td className="border border-gray-300 p-2 text-gray-700 text-[10.5pt]">{item.specifications}</td>
                    <td className="border border-gray-300 p-2 text-center text-gray-800 text-[10.5pt] font-medium">{item.purpose}</td>
                    <td className="border border-gray-300 p-2 text-center text-gray-700">{getUnitLabel(item.uom)}</td>
                    <td className="border border-gray-300 p-2 text-center font-mono font-bold text-gray-900">{item.quantity}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="border border-gray-300 p-3 text-center text-gray-500">لا توجد أصناف مسجلة بطلب الشراء</td>
                </tr>
              )}
            </tbody>
          </table>

          {/* التوقيعات الرقمية: flex justify-between text-sm font-bold mt-2 px-4 */}
          <div className="flex justify-between text-sm font-bold mt-2 px-4 text-gray-900">
            <div>مقدم الطلب: <span className="font-semibold text-black">{requesterName}</span></div>
            <div>المراجع: <span className="font-semibold text-black">{reviewerName}</span></div>
            <div>الاعتماد التنفيذي: <span className="font-semibold text-black">{gmName}</span></div>
          </div>
        </section>

        {/* فاصل أنيق بين الأقسام */}
        <div className="border-t-2 border-dashed border-gray-300 my-8" />

        {/* ══════════════════════════════════════════════════════════════════════
            القسم الثاني: أمر الشراء الفعلي (Actual Purchase Order)
           ══════════════════════════════════════════════════════════════════════ */}
        <section className="print:break-inside-avoid">
          {/* الترويسة: grid grid-cols-3 items-center mb-4 */}
          <div className="grid grid-cols-3 items-center mb-4">
            {/* يمين: بيانات المورد والتاريخ والموقع */}
            <div className="text-right text-xs leading-normal space-y-0.5">
              <div>
                <span className="font-bold text-gray-700">المورد: </span>
                <span className="font-semibold text-gray-900">{supplierName}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">المشروع: </span>
                <span className="font-semibold text-gray-900">{displayProject}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">المنطقة: </span>
                <span className="font-semibold text-gray-900">{displayRegion}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">رقم قطعة الأرض: </span>
                <span className="font-mono font-semibold text-gray-900">{displayParcel}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">تاريخ الأمر: </span>
                <span className="font-mono font-semibold text-gray-900">{poDate}</span>
              </div>
            </div>

            {/* وسط: 'أمر شراء فعلي رقم: PO-XXX' بخط عريض ومميز وشريط بيانات الموقع */}
            <div className="text-center">
              <h2 className="text-base sm:text-lg font-bold text-black tracking-wide">
                أمر شراء فعلي رقم: <span className="font-mono text-gray-900">{displayPoNumber}</span>
              </h2>
              <div className="text-[10px] sm:text-xs font-semibold text-gray-700 mt-1 flex items-center justify-center gap-1.5 flex-wrap">
                <span>المشروع: <strong className="text-gray-900">{displayProject}</strong></span>
                <span className="text-gray-300">|</span>
                <span>المنطقة: <strong className="text-gray-900">{displayRegion}</strong></span>
                <span className="text-gray-300">|</span>
                <span>قطعة الأرض: <strong className="font-mono text-gray-900">{displayParcel}</strong></span>
              </div>
            </div>

            {/* يسار: شعار الشركة */}
            <div className="flex justify-end items-center gap-2">
              <img
                src="/eshbelia-logo.png"
                alt="شعار الشركة"
                className="h-10 w-auto object-contain"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
              />
              <div className="text-left text-xs font-bold leading-tight">
                <div className="text-gray-900">شركة إشبيلية</div>
                <div className="text-[10px] text-gray-500 font-normal">للتطوير العقاري والمقاولات</div>
              </div>
            </div>
          </div>

          {/* الجدول: يعرض الكميات الفعلية النهائية المعتمدة */}
          <table className="w-full border-collapse border border-gray-300 text-right text-[11pt]">
            <thead>
              <tr className="bg-gray-50 print:bg-gray-100 font-bold border-b border-gray-300 text-gray-800">
                <th className="border border-gray-300 p-2 text-center w-10">م</th>
                <th className="border border-gray-300 p-2">الصنف</th>
                <th className="border border-gray-300 p-2 text-center w-32">الغرض</th>
                <th className="border border-gray-300 p-2 text-center w-28">المورد</th>
                <th className="border border-gray-300 p-2 text-center w-16">الوحدة</th>
                <th className="border border-gray-300 p-2 text-center w-20">الكمية</th>
                <th className="border border-gray-300 p-2 text-center w-24">السعر</th>
                <th className="border border-gray-300 p-2 text-center w-28">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {resolvedPoItems.length > 0 ? (
                resolvedPoItems.map((item: any, idx: number) => (
                  <tr key={`po-item-${idx}`} className="border-b border-gray-300">
                    <td className="border border-gray-300 p-2 text-center font-bold text-gray-600">{idx + 1}</td>
                    <td className="border border-gray-300 p-2 font-semibold text-gray-900">{item.description}</td>
                    <td className="border border-gray-300 p-2 text-center text-gray-800 text-[10.5pt] font-medium">{item.purpose}</td>
                    <td className="border border-gray-300 p-2 text-center text-gray-700 text-xs">{item.supplier}</td>
                    <td className="border border-gray-300 p-2 text-center text-gray-700">{getUnitLabel(item.uom)}</td>
                    <td className="border border-gray-300 p-2 text-center font-mono font-bold text-gray-900">{item.quantity}</td>
                    <td className="border border-gray-300 p-2 text-center font-mono text-gray-800">
                      {formatCleanNumber(item.unit_price)} ج.م
                    </td>
                    <td className="border border-gray-300 p-2 text-center font-mono font-bold text-gray-900">
                      {formatCleanNumber(item.line_total)} ج.م
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="border border-gray-300 p-3 text-center text-gray-500">لا توجد بنود بأمر الشراء</td>
                </tr>
              )}

              {/* صف الإجمالي النهائي بخلفية رمادية فاتحة جداً */}
              <tr className="bg-gray-100 print:bg-gray-100 font-bold border-t-2 border-gray-300">
                <td colSpan={7} className="border border-gray-300 p-2 text-left font-bold text-[11pt] text-gray-900">
                  الإجمالي النهائي:
                </td>
                <td className="border border-gray-300 p-2 text-center font-mono font-bold text-[11pt] text-black">
                  {formatCleanNumber(grandTotal)} ج.م
                </td>
              </tr>
            </tbody>
          </table>

          {/* التوقيعات الرقمية: flex justify-between text-sm font-bold mt-2 px-4 */}
          <div className="flex justify-between text-sm font-bold mt-2 px-4 text-gray-900">
            <div>إدارة المشتريات: <span className="font-semibold text-black">{procurementName}</span></div>
            <div>الاعتماد النهائي: <span className="font-semibold text-black">{poGmName}</span></div>
          </div>
        </section>

        {/* فاصل أنيق بين الأقسام */}
        <div className="border-t-2 border-dashed border-gray-300 my-8" />

        {/* ══════════════════════════════════════════════════════════════════════
            القسم الثالث: إذن الاستلام الفعلي (Goods Receipt Note - GRN)
           ══════════════════════════════════════════════════════════════════════ */}
        <section className="print:break-inside-avoid">
          {/* الترويسة: grid grid-cols-3 items-center mb-4 */}
          <div className="grid grid-cols-3 items-center mb-4">
            {/* يمين: بيانات المشروع والمنطقة وقطعة الأرض وتاريخ الاستلام */}
            <div className="text-right text-xs leading-normal space-y-0.5">
              <div>
                <span className="font-bold text-gray-700">المشروع: </span>
                <span className="font-semibold text-gray-900">{displayProject}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">المنطقة: </span>
                <span className="font-semibold text-gray-900">{displayRegion}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">رقم قطعة الأرض: </span>
                <span className="font-mono font-semibold text-gray-900">{displayParcel}</span>
              </div>
              <div>
                <span className="font-bold text-gray-700">تاريخ الاستلام: </span>
                <span className="font-mono font-semibold text-gray-900">{grnDate}</span>
              </div>
            </div>

            {/* وسط: 'إذن استلام فعلي رقم: GRN-XXX' بخط عريض وشريط بيانات الموقع */}
            <div className="text-center">
              <h2 className="text-base sm:text-lg font-bold text-black tracking-wide">
                إذن استلام فعلي رقم: <span className="font-mono text-gray-900">{displayGrnNumber}</span>
              </h2>
              <div className="text-[10px] sm:text-xs font-semibold text-gray-700 mt-1 flex items-center justify-center gap-1.5 flex-wrap">
                <span>المشروع: <strong className="text-gray-900">{displayProject}</strong></span>
                <span className="text-gray-300">|</span>
                <span>المنطقة: <strong className="text-gray-900">{displayRegion}</strong></span>
                <span className="text-gray-300">|</span>
                <span>قطعة الأرض: <strong className="font-mono text-gray-900">{displayParcel}</strong></span>
              </div>
            </div>

            {/* يسار: شعار الشركة */}
            <div className="flex justify-end items-center gap-2">
              <img
                src="/eshbelia-logo.png"
                alt="شعار الشركة"
                className="h-10 w-auto object-contain"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
              />
              <div className="text-left text-xs font-bold leading-tight">
                <div className="text-gray-900">شركة إشبيلية</div>
                <div className="text-[10px] text-gray-500 font-normal">للتطوير العقاري والمقاولات</div>
              </div>
            </div>
          </div>

          {/* الجدول: يعرض ما تم استلامه ومطابقته */}
          <table className="w-full border-collapse border border-gray-300 text-right text-[11pt]">
            <thead>
              <tr className="bg-gray-50 print:bg-gray-100 font-bold border-b border-gray-300 text-gray-800">
                <th className="border border-gray-300 p-2 text-center w-10">م</th>
                <th className="border border-gray-300 p-2">الصنف</th>
                <th className="border border-gray-300 p-2 text-center w-36">الغرض</th>
                <th className="border border-gray-300 p-2 text-center w-20">الوحدة</th>
                <th className="border border-gray-300 p-2 text-center w-28">الكمية المستلمة</th>
                <th className="border border-gray-300 p-2">حالة الفحص والملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {resolvedGrnItems.length > 0 ? (
                resolvedGrnItems.map((item: any, idx: number) => (
                  <tr key={`grn-item-${idx}`} className="border-b border-gray-300">
                    <td className="border border-gray-300 p-2 text-center font-bold text-gray-600">{idx + 1}</td>
                    <td className="border border-gray-300 p-2 font-semibold text-gray-900">{item.description}</td>
                    <td className="border border-gray-300 p-2 text-center text-gray-800 text-[10.5pt] font-medium">{item.purpose}</td>
                    <td className="border border-gray-300 p-2 text-center text-gray-700">{getUnitLabel(item.uom)}</td>
                    <td className="border border-gray-300 p-2 text-center font-mono font-bold text-gray-900">
                      {item.received_quantity}
                    </td>
                    <td className="border border-gray-300 p-2 text-gray-700 text-[10.5pt]">{item.notes}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="border border-gray-300 p-3 text-center text-gray-500">لا توجد بيانات استلام مسجلة</td>
                </tr>
              )}
            </tbody>
          </table>

          {/* التوقيعات الرقمية: flex justify-between text-sm font-bold mt-2 px-4 */}
          <div className="flex justify-between items-center text-sm font-bold mt-2 px-4 text-gray-900">
            <div>
              أمين المخزن: <span className="font-semibold text-black">{storekeeperName}</span>{' '}
              <span className="text-xs font-normal text-gray-700">({keeperPassText})</span>
            </div>
            <div>
              المستلم الفعلي: <span className="font-semibold text-black">{actualReceiverName}</span>
            </div>
          </div>
        </section>
      </div>
    );
  }
);

CombinedPrintTemplate.displayName = 'CombinedPrintTemplate';

export default CombinedPrintTemplate;
