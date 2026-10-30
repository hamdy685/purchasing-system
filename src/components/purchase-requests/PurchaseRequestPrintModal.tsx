import React from 'react';
import { createPortal } from 'react-dom';
import { PurchaseRequest } from '../../types/purchaseRequest';
import { getUnitLabel } from '../../utils/units';
import { printDocumentOnly } from '../../utils/print';
import { formatCleanQty } from '../../utils/numberFormat';
import { extractRebarInfo } from '../../utils/rebar';

interface PurchaseRequestPrintModalProps {
  pr: PurchaseRequest;
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

export const PurchaseRequestPrintModal: React.FC<PurchaseRequestPrintModalProps> = ({ pr, isOpen, onClose }) => {
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

  if (!isOpen || !pr) return null;

  const handlePrint = () => {
    printDocumentOnly('.pr-print-container .print-document', {
      title: `طلب_شراء_${pr.request_number}`,
      orientation: 'portrait',
      pageMargin: '6mm',
    });
  };

  const handleShare = () => {
    const text = [
      '🏢 شركة إشبيلية للتطوير العقاري والمقاولات',
      '📄 طلب شراء رقم: ' + pr.request_number,
      '👤 صاحب الطلب: ' + (pr.requester?.name || '—'),
      '🏢 القسم: ' + (pr.department?.name || '—'),
      '📍 المشروع: ' + (pr.region || pr.items?.[0]?.region || '—'),
      '📦 البنود: ' + (pr.items || []).map((i) => i.item_description).join('، '),
    ].join('\n');
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  };

  const items = pr.items || [];
  const emptyRowsCount = Math.max(TOTAL_FIXED_ROWS - items.length, 0);

  const requestNumber = pr.request_number;
  const isOfficePr = pr.request_type === 'OFFICE_SUPPLIES';
  const displayProject = pr.project_name?.trim() || (isOfficePr ? 'المقر الرئيسي / إداري' : 'غير مسجل');
  const displayRegion = (pr.region || pr.items?.find((i) => i.region)?.region)?.trim() || 'غير مسجلة';
  const displayParcel = (pr.parcel_reference || pr.items?.find((i) => i.item_reference)?.item_reference)?.trim() || 'غير مسجل';
  const purpose = pr.department?.name || pr.notes || 'طلب صرف واحتياج للمشروع';

  return createPortal((
    <div className="pr-print-container fixed inset-0 z-[9999] flex min-h-screen items-center justify-center overflow-y-auto bg-slate-950/80 p-4 print:static print:block print:bg-white print:p-0" dir="rtl">
      <div className="flex min-h-0 max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl print:block print:max-w-none print:max-h-none print:border-none print:shadow-none">
        {/* Modal Top Bar */}
        <div className="print:hidden flex items-center justify-between gap-3 border-b border-slate-700 bg-slate-800 px-5 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-lg">🖨️</span>
            <h2 className="font-bold text-slate-100 text-sm sm:text-base">معاينة وطباعة طلب الشراء (بدون بيانات مالية - ورقة واحدة)</h2>
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

        {/* Printable Paper Area (1 Single Page A4 - NO FINANCIAL DATA) */}
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
                    طلب شراء
                  </h1>
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
                    <span className="font-mono font-black text-sm">{formatDate(pr.created_at)}</span>
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

              {/* Table with Blue Header matching exact template (NO FINANCIAL DATA) */}
              <div className="mt-3 overflow-x-auto print:overflow-visible">
                <table className="w-full border-collapse border-2 border-black text-right text-xs" style={{ border: '2px solid #000' }}>
                  <thead>
                    <tr className="bg-[#5B9BD5] bg-header-blue text-black font-black text-center" style={{ backgroundColor: '#5B9BD5' }}>
                      <th className="border border-black p-2 w-10 text-center font-black">م</th>
                      <th className="border border-black p-2 text-right font-black">الصنف</th>
                      <th className="border border-black p-2 w-16 text-center font-black">الوحدة</th>
                      <th className="border border-black p-2 w-20 text-center font-black">الكمية</th>
                      <th className="border border-black p-2 w-32 text-center font-black">الموقع / قطعة الأرض</th>
                      <th className="border border-black p-2 w-44 text-right font-black">المواصفات الفنية</th>
                      <th className="border border-black p-2 w-32 text-right font-black">ملاحظات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, index) => {
                      const qty = Number(item.quantity) || 0;

                      return (
                        <tr key={item.id || index} className="h-7 border border-black">
                          <td className="border border-black p-1.5 text-center font-mono font-bold">{index + 1}</td>
                          <td className="border border-black p-1.5 font-bold">
                            <div>{item.item_description}</div>
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
                          <td className="border border-black p-1.5 text-center font-mono font-semibold text-slate-800">
                            {item.item_reference || pr.parcel_reference || '—'}
                          </td>
                          <td className="border border-black p-1.5 text-xs text-slate-700">
                            {item.specifications || '—'}
                          </td>
                          <td className="border border-black p-1.5 text-xs font-semibold text-slate-800">
                            {item.notes || (index === 0 ? (pr.requester?.name ? `طلب المهندس / ${pr.requester.name}` : '') : '')}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Empty padding rows to guarantee exactly 10 rows just like the paper form */}
                    {Array.from({ length: emptyRowsCount }, (_, i) => {
                      const rowNum = items.length + i + 1;
                      return (
                        <tr key={`empty-pr-row-${i}`} className="h-7 border border-black">
                          <td className="border border-black p-1.5 text-center font-mono font-bold text-slate-400">{rowNum}</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5 text-center">&nbsp;</td>
                          <td className="border border-black p-1.5 text-center">&nbsp;</td>
                          <td className="border border-black p-1.5 text-center">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                        </tr>
                      );
                    })}

                    {/* Non-financial Footer Note row matching the grid */}
                    <tr className="border-2 border-black" style={{ borderTop: '2px solid #000' }}>
                      <td colSpan={4} className="border border-black p-2 text-center font-black text-sm tracking-wide bg-slate-100">
                        إجمالي بنود طلب الشراء: ({items.length}) بنود معتمدة
                      </td>
                      <td colSpan={3} className="border border-black p-2 text-right text-xs font-bold text-slate-700 bg-slate-50">
                        طلب الشراء لأغراض الفحص والموافقة الفنية ولا يتضمن أي بيانات مالية
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bottom 3 Signatures */}
            <div className="pt-8 pb-4">
              <div className="flex items-center justify-between text-center px-6">
                {/* 1. مقدم الطلب (Right) */}
                <div className="w-1/3">
                  <div className="text-base font-black text-black">مقدم الطلب</div>
                  <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                  <div className="text-xs text-slate-700 font-semibold mt-1">
                    {pr.requester?.name || 'م. كامل'}
                  </div>
                </div>

                {/* 2. المراجع (Center) */}
                <div className="w-1/3">
                  <div className="text-base font-black text-black">المراجع</div>
                  <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                  <div className="text-xs text-slate-700 font-semibold mt-1">
                    {pr.assigned_reviewer?.name || (pr.department as any)?.manager?.name || 'م. كريم'}
                  </div>
                </div>

                {/* 3. المشتريات (Left) */}
                <div className="w-1/3">
                  <div className="text-base font-black text-black">المشتريات</div>
                  <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                  <div className="text-xs text-slate-700 font-semibold mt-1">
                    م. أحمد بدوي
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

export default PurchaseRequestPrintModal;
