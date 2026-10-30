import React from 'react';
import { createPortal } from 'react-dom';
import { PurchaseOrder } from '../../types/purchaseOrder';
import { getUnitLabel } from '../../utils/units';
import { printDocumentOnly } from '../../utils/print';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { extractRebarInfo } from '../../utils/rebar';
import { isActualPurchaseOrder, getActualPoLineItems, calculateActualPoGrandTotal, calculateActualPoFinancials } from '../../utils/actualPo';

interface PurchaseOrderPrintModalProps {
  po: PurchaseOrder;
  isOpen: boolean;
  onClose: () => void;
}

const formatDate = (value?: string | null) => {
  if (!value) return new Date().toISOString().split('T')[0];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const TOTAL_FIXED_ROWS = 10;

export const PurchaseOrderPrintModal: React.FC<PurchaseOrderPrintModalProps> = ({ po, isOpen, onClose }) => {
  React.useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const isActual = isActualPurchaseOrder(po);
  const items = React.useMemo(() => getActualPoLineItems(po), [po]);
  const financials = React.useMemo(() => {
    return calculateActualPoFinancials(
      items,
      po.discount_type || 'NONE',
      Number(po.discount_percentage) || 0,
      Number(po.tax_amount) || 0
    );
  }, [items, po]);
  const grandTotal = Number(po?.grand_total) || financials.grandTotal;

  if (!isOpen || !po) return null;

  const handlePrint = () => {
    printDocumentOnly('.po-print-container .print-document', {
      title: `${isActual ? 'أمر_شراء_فعلي' : 'أمر_شراء'}_${po.po_number}`,
      orientation: 'portrait',
      pageMargin: '6mm',
    });
  };

  const handleShare = () => {
    const text = [
      '🏢 شركة إشبيلية للتطوير العقاري والمقاولات',
      '📑 ' + (isActual ? 'أمر شراء فعلي رقم: ' : 'أمر شراء رقم: ') + po.po_number,
      '🏬 المورد: ' + (po.supplier?.company_name || '—'),
      '📍 المشروع: ' + (po.purchase_request?.region || items[0]?.region || '—'),
      '💰 الإجمالي: ' + formatCleanNumber(grandTotal) + ' ج.م',
    ].join('\n');
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  };

  const discountRowsCount = (financials.discountAmount > 0 || Number(po.discount_amount) > 0) ? 2 : 0;
  const emptyRowsCount = Math.max(TOTAL_FIXED_ROWS - items.length - discountRowsCount, 0);

  const requestNumber = po.po_number || po.purchase_request?.request_number || '—';
  const isOfficePr = po.purchase_request?.request_type === 'OFFICE_SUPPLIES';
  const displayProject = po.project_name?.trim() || po.purchase_request?.project_name?.trim() || (isOfficePr ? 'المقر الرئيسي / إداري' : 'غير مسجل');
  const displayRegion = (po.region || po.purchase_request?.region || po.items?.find((i) => i.region)?.region)?.trim() || 'غير مسجلة';
  const displayParcel = (po.parcel_reference || po.purchase_request?.parcel_reference || po.items?.find((i) => i.item_reference)?.item_reference)?.trim() || 'غير مسجل';
  const purpose = po.purchase_request?.department?.name || po.notes || po.purchase_request?.notes || 'اعتماد وتوريد للمشروع';

  return createPortal((
    <div className="po-print-container fixed inset-0 z-[9999] flex min-h-screen items-center justify-center overflow-y-auto bg-slate-950/80 p-4 print:static print:block print:bg-white print:p-0" dir="rtl">
      <div className="flex min-h-0 max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl print:block print:max-w-none print:max-h-none print:border-none print:shadow-none">
        {/* Modal Top Bar */}
        <div className="print:hidden flex items-center justify-between gap-3 border-b border-slate-700 bg-slate-800 px-5 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">🖨️</span>
            <h2 className="font-bold text-slate-100 text-sm sm:text-base">معاينة وطباعة أمر الشراء (ورقة واحدة رسمية)</h2>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleShare} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 transition">
              مشاركة واتساب
            </button>
            <button type="button" onClick={handlePrint} className="rounded-lg bg-cyan-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-cyan-500 transition shadow">
              طباعة فورية
            </button>
            <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-600 bg-slate-700 text-lg font-black text-white hover:bg-rose-600 transition" title="إغلاق">
              ×
            </button>
          </div>
        </div>

        {/* Printable Paper Area (1 Single Page A4) */}
        <div className="flex-1 overflow-y-auto bg-slate-900 p-4 sm:p-6 print:overflow-visible print:bg-white print:p-0">
          <div className="print-document mx-auto max-w-[210mm] bg-white p-6 sm:p-8 text-black print:max-w-none print:p-2 flex flex-col justify-between" style={{ minHeight: '270mm' }}>
            
            {/* Header matching exact user template */}
            <div>
              <div className="flex items-start justify-between gap-2 pb-2">
                {/* 1. Logo on top left */}
                <div className="text-left shrink-0 w-1/4">
                  <img
                    src="/eshbelia-logo.png"
                    alt="شركة إشبيلية"
                    className="h-16 w-auto object-contain"
                    onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }}
                  />
                  <div className="text-[10px] text-amber-700 font-black tracking-wider text-center w-16 mt-0.5">
                    ISHBILIA<br />اشبيلية
                  </div>
                </div>

                {/* 2. Big Title in Center */}
                <div className="text-center self-center w-2/4">
                  <h1 className="text-3xl sm:text-4xl font-black text-black tracking-wide font-sans">
                    {isActual ? 'أمر شراء فعلي' : 'أمر شراء'}
                  </h1>
                  {isActual && (
                    <div className="text-[11px] font-bold text-slate-800 tracking-wider mt-0.5">
                      (Actual Purchase Order • توريد واستلام فعلي معتمد)
                    </div>
                  )}
                  <div className="text-[10px] sm:text-xs font-semibold text-slate-700 mt-1 flex items-center justify-center gap-1.5 flex-wrap">
                    <span>المشروع: <strong className="text-black">{displayProject}</strong></span>
                    <span className="text-slate-400">|</span>
                    <span>المنطقة: <strong className="text-black">{displayRegion}</strong></span>
                    <span className="text-slate-400">|</span>
                    <span>قطعة الأرض: <strong className="font-mono text-black">{displayParcel}</strong></span>
                  </div>
                </div>

                {/* 3. Metadata on Top Right */}
                <div className="text-right text-xs font-bold text-black space-y-0.5 w-1/4 shrink-0" dir="rtl">
                  <div className="flex items-center justify-end gap-1">
                    <span className="font-mono font-black text-sm">{formatDate(po.created_at)}</span>
                    <span className="text-slate-800">/التاريخ</span>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <span className="font-mono font-black text-sm">{requestNumber}</span>
                    <span className="text-slate-800">/رقم الطلب</span>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <span className="font-normal text-slate-900 truncate">{displayProject}</span>
                    <span className="text-slate-800 shrink-0">/المشروع</span>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <span className="font-normal text-slate-900 truncate">{displayRegion}</span>
                    <span className="text-slate-800 shrink-0">/المنطقة</span>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <span className="font-mono font-bold text-slate-900 truncate">{displayParcel}</span>
                    <span className="text-slate-800 shrink-0">/قطعة الأرض</span>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <span className="font-normal text-slate-900 truncate">{purpose}</span>
                    <span className="text-slate-800 shrink-0">/غرض الشراء</span>
                  </div>
                </div>
              </div>

              {/* Table with Blue Header matching exact template */}
              <div className="mt-3 overflow-x-auto print:overflow-visible">
                <table className="w-full border-collapse border-2 border-black text-right text-xs" style={{ border: '2px solid #000' }}>
                  <thead>
                    <tr className="bg-[#5B9BD5] bg-header-blue text-black font-black text-center" style={{ backgroundColor: '#5B9BD5' }}>
                      <th className="border border-black p-2 w-10 text-center font-black">م</th>
                      <th className="border border-black p-2 text-right font-black">الصنف</th>
                      <th className="border border-black p-2 w-16 text-center font-black">الوحدة</th>
                      <th className="border border-black p-2 w-20 text-center font-black">الكمية</th>
                      <th className="border border-black p-2 w-24 text-center font-black">السعر</th>
                      <th className="border border-black p-2 w-28 text-center font-black">الاجمالى</th>
                      <th className="border border-black p-2 w-44 text-right font-black">ملاحظات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, index) => {
                      const qty = Number(item.quantity) || 0;
                      const price = Number(item.unit_price) || 0;
                      const lineTotal = Number(item.line_total) || Math.round(qty * price * 100) / 100;
                      const isFirstRow = index === 0;

                      return (
                        <tr key={item.id || index} className="h-7 border border-black">
                          <td className="border border-black p-1.5 text-center font-mono font-bold">{index + 1}</td>
                          <td className="border border-black p-1.5 font-bold">
                            <div>{item.item_name || item.item_description}</div>
                            {item.specifications && (
                              <div className="text-[10px] text-slate-600 font-normal">{item.specifications}</div>
                            )}
                          </td>
                          <td className="border border-black p-1.5 text-center font-bold">
                            <div>{getUnitLabel(item.uom || 'PCS')}</div>
                            {extractRebarInfo(item.specifications) && (
                              <div className="text-[9px] text-slate-700 font-mono">
                                ({extractRebarInfo(item.specifications)?.barCount} سيخ)
                              </div>
                            )}
                          </td>
                          <td className="border border-black p-1.5 text-center font-mono font-black">{formatCleanQty(qty)}</td>
                          <td className="border border-black p-1.5 text-center font-mono font-bold">{price > 0 ? formatCleanNumber(price) : ''}</td>
                          <td className="border border-black p-1.5 text-center font-mono font-black">{lineTotal > 0 ? formatCleanNumber(lineTotal) : '0'}</td>
                          <td className="border border-black p-1.5 text-xs font-semibold">
                            {isFirstRow && (
                              <div className="font-bold text-slate-900 mb-0.5">
                                مورد / {po.supplier?.company_name || '—'}
                              </div>
                            )}
                            {item.supplier && item.supplier.id !== po.supplier_id && (
                              <div className="text-cyan-900 font-bold text-[11px]">
                                مورد البند: {item.supplier.company_name}
                              </div>
                            )}
                            {item.item_reference ? (
                              <div className="text-slate-700 text-[11px]">قطعة {item.item_reference}</div>
                            ) : null}
                            {po.discount_type === 'SELECTED_ITEMS' && item.is_discount_applied && (
                              <div className="text-amber-800 font-bold text-[10px]">🏷️ خاضع لخصم ({Number(po.discount_percentage || 0)}%)</div>
                            )}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Empty padding rows to guarantee exactly 10 rows just like the paper form */}
                    {Array.from({ length: emptyRowsCount }, (_, i) => {
                      const rowNum = items.length + i + 1;
                      const isFirstIfNoItems = items.length === 0 && i === 0;
                      return (
                        <tr key={`empty-row-${i}`} className="h-7 border border-black">
                          <td className="border border-black p-1.5 text-center font-mono font-bold text-slate-400">{rowNum}</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5 text-center">&nbsp;</td>
                          <td className="border border-black p-1.5 text-center">&nbsp;</td>
                          <td className="border border-black p-1.5 text-center">&nbsp;</td>
                          <td className="border border-black p-1.5 text-center font-mono text-slate-400">{i === 0 && items.length === 0 ? '0' : ''}</td>
                          <td className="border border-black p-1.5 text-xs">
                            {isFirstIfNoItems ? `مورد / ${po.supplier?.company_name || '—'}` : ''}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Subtotal & Discount Rows if discount exists */}
                    {(financials.discountAmount > 0 || Number(po.discount_amount) > 0) && (
                      <>
                        <tr className="border border-black bg-slate-50 font-bold text-xs">
                          <td colSpan={4} className="border border-black p-1 text-center">
                            إجمالي البنود قبل الخصم
                          </td>
                          <td colSpan={2} className="border border-black p-1 text-center font-mono font-bold">
                            {formatCleanNumber(financials.subtotal || Number(po.subtotal))}
                          </td>
                          <td className="border border-black p-1 text-[11px] text-slate-600">
                            {po.discount_type === 'SELECTED_ITEMS' ? `بنود محددة (${financials.targetedCount})` : 'إجمالي الأمر'}
                          </td>
                        </tr>
                        <tr className="border border-black bg-rose-50/70 font-bold text-xs text-rose-900">
                          <td colSpan={4} className="border border-black p-1 text-center">
                            الخصم المطبق ({financials.discountPercentage}%) {po.discount_type === 'SELECTED_ITEMS' ? 'على البنود المحددة' : 'على الإجمالي'}
                          </td>
                          <td colSpan={2} className="border border-black p-1 text-center font-mono font-bold text-rose-700">
                            - {formatCleanNumber(Number(po.discount_amount) || financials.discountAmount)}
                          </td>
                          <td className="border border-black p-1 text-[11px] text-rose-700">
                            صافي بعد الخصم
                          </td>
                        </tr>
                      </>
                    )}

                    {/* Total Row with Vibrant Yellow Box matching exact template */}
                    <tr className="border-2 border-black" style={{ borderTop: '2px solid #000' }}>
                      <td colSpan={4} className="border border-black p-2 text-center font-black text-base tracking-widest bg-white">
                        {financials.discountAmount > 0 || Number(po.discount_amount) > 0 ? 'صافي الإجمالي النهائي المستحق' : 'الأجـــــــــــــــــمالـــــــــي'}
                      </td>
                      <td
                        colSpan={2}
                        className="border-2 border-black p-2 text-center font-mono font-black text-xl bg-[#FFFF00] bg-yellow-total text-black shadow-inner"
                        style={{ backgroundColor: '#FFFF00', border: '2px solid #000' }}
                      >
                        {formatCleanNumber(grandTotal)}
                      </td>
                      <td className="border border-black p-2 bg-white text-center font-bold text-xs">
                        {po.currency || 'ج.م'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bottom 2 Signatures */}
            <div className="pt-8 pb-4">
              <div className="flex items-center justify-around text-center px-12">
                {/* 1. المشتريات (Right) */}
                <div className="w-1/2">
                  <div className="text-base font-black text-black">المشتريات</div>
                  <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                  <div className="text-xs text-slate-700 font-semibold mt-1">
                    {po.created_by?.name || 'م. أحمد بدوي'}
                  </div>
                </div>

                {/* 2. الحسابات (Left) */}
                <div className="w-1/2">
                  <div className="text-base font-black text-black">الحسابات</div>
                  <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                  <div className="text-xs text-slate-700 font-semibold mt-1">
                    {po.accounting_reviewer?.name || 'أ. حسن'}
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  ), document.body);
};

export default PurchaseOrderPrintModal;
