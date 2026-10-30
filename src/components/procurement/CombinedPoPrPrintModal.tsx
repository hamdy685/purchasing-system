import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { printDocumentOnly } from '../../utils/print';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { getUnitLabel } from '../../utils/units';
import { CombinedPrintTemplate } from './CombinedPrintTemplate';

export interface CombinedPrintItem {
  id?: number;
  item_description: string;
  item_reference?: string;
  region?: string;
  quantity: number | string;
  uom?: string;
  unit_price: number | string;
  specifications?: string;
}

export interface CombinedPrintData {
  // PR Context
  prId?: number;
  prNumber: string;
  prDate?: string | null;
  requesterName?: string;
  departmentName?: string;
  reviewerName?: string;
  qualityReviewerName?: string;
  procurementReviewerName?: string;
  executiveApproverName?: string;
  accountantName?: string;
  projectName?: string;
  parcelReference?: string;
  projectOrParcel?: string;
  region?: string;
  dateNeeded?: string;
  prNotes?: string;

  // PO Context
  poNumber: string;
  poDate?: string | null;
  supplierName: string;
  supplierPhone?: string;
  supplierTaxNumber?: string;
  paymentTerms?: string;
  deliveryTerms?: string;
  deliveryDate?: string;
  poNotes?: string;
  items: CombinedPrintItem[];
  grandTotal: number;
}

interface CombinedPoPrPrintModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: CombinedPrintData;
}

const formatDate = (value?: string | null) => {
  if (!value) return new Date().toISOString().split('T')[0];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const CombinedPoPrPrintModal: React.FC<CombinedPoPrPrintModalProps> = ({
  isOpen,
  onClose,
  data,
}) => {
  // View mode: 'SINGLE_PAGE_COMBINED' (Both on 1 A4 sheet) | 'PO_ONLY' | 'PR_ONLY' | 'TWO_PAGES'
  const [viewMode, setViewMode] = useState<'SINGLE_PAGE_COMBINED' | 'PO_ONLY' | 'PR_ONLY' | 'TWO_PAGES'>('SINGLE_PAGE_COMBINED');

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

  if (!isOpen) return null;

  const handlePrint = () => {
    printDocumentOnly('.combined-print-container .print-document', {
      title: `مستند_${data.poNumber || data.prNumber}`,
      orientation: 'portrait',
      pageMargin: '5mm',
    });
  };

  const handleShareWhatsApp = () => {
    const textLines = [
      '🏢 *شركة إشبيلية للتطوير العقاري والمقاولات*',
      '📄 *أمر وطلب شراء معتمد*',
      `📝 *طلب الشراء:* ${data.prNumber}`,
      `📑 *أمر الشراء:* ${data.poNumber}`,
      `🏬 *المورد:* ${data.supplierName || '—'}`,
      `📍 *المشروع / القطعة:* ${data.projectOrParcel || '—'} ${data.region ? `(${data.region})` : ''}`,
      `💰 *الإجمالي:* ${formatCleanNumber(data.grandTotal)} ج.م`,
    ];

    window.open(`https://wa.me/?text=${encodeURIComponent(textLines.join('\n'))}`, '_blank');
  };

  const items = data.items || [];
  const poDateFormatted = formatDate(data.poDate);
  const prDateFormatted = formatDate(data.prDate);
  const requestNumber = data.prNumber;
  const orderNumber = data.poNumber;
  const displayProject = data.projectName?.trim() || 'غير مسجل';
  const displayRegion = data.region?.trim() || 'غير مسجلة';
  const displayParcel = (data.parcelReference || data.projectOrParcel)?.trim() || 'غير مسجل';
  const projectOrRegion = displayRegion;
  const purpose = data.departmentName || data.poNotes || data.prNotes || 'اعتماد وتوريد للمشروع';

  return createPortal(
    <div
      className="combined-print-container fixed inset-0 z-[9999] flex min-h-screen items-center justify-center overflow-y-auto bg-slate-950/85 p-4 sm:p-6 backdrop-blur-sm print:static print:block print:bg-white"
      dir="rtl"
    >
      <div className="flex min-h-0 max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl sm:max-h-[calc(100dvh-3rem)] print:block print:max-w-none print:max-h-none print:border-none print:shadow-none">
        
        {/* Header Controls (Screen only) */}
        <div className="print:hidden flex flex-col sm:flex-row items-center justify-between gap-3 border-b border-slate-700 bg-slate-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🖨️</span>
            <div>
              <h2 className="font-bold text-slate-100 text-sm sm:text-base">
                طباعة طلب الشراء وأمر الشراء
              </h2>
              <p className="text-[11px] text-slate-400">
                مطابق تماماً للنموذج الرسمي (الجدول الأزرق والإجمالي الأصفر وبدون بيانات مالية في طلب الشراء)
              </p>
            </div>
          </div>

          {/* Mode Selector Tabs */}
          <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-xl border border-slate-700">
            <button
              type="button"
              onClick={() => setViewMode('SINGLE_PAGE_COMBINED')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === 'SINGLE_PAGE_COMBINED'
                  ? 'bg-amber-600 text-white shadow'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              📄 ورقة واحدة مدمجة (A4)
            </button>
            <button
              type="button"
              onClick={() => setViewMode('PO_ONLY')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === 'PO_ONLY'
                  ? 'bg-cyan-600 text-white shadow'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              أمر الشراء فقط
            </button>
            <button
              type="button"
              onClick={() => setViewMode('PR_ONLY')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === 'PR_ONLY'
                  ? 'bg-cyan-600 text-white shadow'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              طلب الشراء فقط (بدون ماليات)
            </button>
            <button
              type="button"
              onClick={() => setViewMode('TWO_PAGES')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === 'TWO_PAGES'
                  ? 'bg-cyan-600 text-white shadow'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              صفحتان كاملتان
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleShareWhatsApp}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white shadow transition"
            >
              <span>📱</span>
              <span>واتساب</span>
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-4 py-1.5 text-xs font-bold text-white shadow transition"
            >
              <span>🖨️</span>
              <span>طباعة المستند</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-600 bg-slate-700 text-lg font-black text-white hover:bg-rose-600 transition"
              title="إغلاق"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Printable Document Body */}
        <div className="flex-1 overflow-y-auto bg-slate-900 p-4 sm:p-6 print:overflow-visible print:bg-white print:p-0">
          <div className="print-document mx-auto max-w-[210mm] bg-white text-black print:max-w-none print:p-0">
            
            {/* ════════════════════════════════════════════════════════════
                OPTION 1: ورقة واحدة مدمجة (A4 واحدة شاملة للطلب والأمر)
               ════════════════════════════════════════════════════════════ */}
            {viewMode === 'SINGLE_PAGE_COMBINED' && (
              <CombinedPrintTemplate
                prNumber={data.prNumber}
                prDate={data.prDate}
                departmentName={data.departmentName}
                projectName={data.projectName}
                parcelReference={data.parcelReference || data.projectOrParcel}
                projectOrParcel={data.projectOrParcel}
                region={data.region}
                purpose={purpose}
                requesterName={data.requesterName || 'م. كامل'}
                reviewerName={data.reviewerName && data.reviewerName !== '—' ? data.reviewerName : 'م. كريم'}
                procurementReviewerName={data.procurementReviewerName || 'م. أحمد بدوي'}
                accountantName={data.accountantName || 'أ. حسن'}
                poNumber={data.poNumber}
                poDate={data.poDate}
                supplierName={data.supplierName}
                deliveryDate={data.deliveryDate}
                paymentTerms={data.paymentTerms}
                items={items.map((it) => ({
                  id: it.id,
                  item_description: it.item_description,
                  item_reference: it.item_reference,
                  region: it.region,
                  quantity: it.quantity,
                  uom: it.uom,
                  unit_price: it.unit_price,
                  specifications: it.specifications,
                }))}
                grandTotal={data.grandTotal}
              />
            )}

            {/* ════════════════════════════════════════════════════════════
                OPTION 2 & 4: أمر الشراء فقط أو مع الصفحتين (A4 كاملة)
               ════════════════════════════════════════════════════════════ */}
            {(viewMode === 'PO_ONLY' || viewMode === 'TWO_PAGES') && (
              <section className="p-6 sm:p-8 bg-white text-black flex flex-col justify-between" style={{ minHeight: '270mm', pageBreakInside: 'avoid', breakAfter: viewMode === 'TWO_PAGES' ? 'page' : 'auto' }}>
                <div>
                  <div className="flex items-start justify-between gap-2 pb-2">
                    <div className="text-left shrink-0 w-1/4">
                      <img src="/eshbelia-logo.png" alt="شركة إشبيلية" className="h-16 w-auto object-contain" onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }} />
                      <div className="text-[10px] text-amber-700 font-black text-center w-16 mt-0.5">ISHBILIA<br />اشبيلية</div>
                    </div>
                    <div className="text-center self-center w-2/4">
                      <h1 className="text-3xl sm:text-4xl font-black text-black">أمر شراء</h1>
                      <div className="text-[11px] font-semibold text-slate-700 mt-1 flex items-center justify-center gap-1.5 flex-wrap">
                        <span>المشروع: <strong className="text-black">{displayProject}</strong></span>
                        <span className="text-slate-400">|</span>
                        <span>المنطقة: <strong className="text-black">{displayRegion}</strong></span>
                        <span className="text-slate-400">|</span>
                        <span>قطعة الأرض: <strong className="font-mono text-black">{displayParcel}</strong></span>
                      </div>
                    </div>
                    <div className="text-right text-xs font-bold text-black space-y-1 w-1/4 shrink-0" dir="rtl">
                      <div className="flex items-center justify-end gap-1"><span className="font-mono font-black text-sm">{poDateFormatted}</span><span>/التاريخ</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-mono font-black text-sm">{orderNumber}</span><span>/رقم الطلب</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-normal truncate">{displayProject}</span><span>/المشروع</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-normal truncate">{displayRegion}</span><span>/المنطقة</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-mono font-bold truncate">{displayParcel}</span><span>/قطعة الأرض</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-normal truncate">{purpose}</span><span>/غرض الشراء</span></div>
                    </div>
                  </div>

                  <table className="w-full border-collapse border-2 border-black text-right text-xs mt-3" style={{ border: '2px solid #000' }}>
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
                      {items.map((item, idx) => {
                        const qty = Number(item.quantity) || 0;
                        const price = Number(item.unit_price) || 0;
                        const lineTotal = Math.round(qty * price * 100) / 100;
                        return (
                          <tr key={idx} className="h-7 border border-black">
                            <td className="border border-black p-1.5 text-center font-mono font-bold">{idx + 1}</td>
                            <td className="border border-black p-1.5 font-bold">{item.item_description}</td>
                            <td className="border border-black p-1.5 text-center">{getUnitLabel(item.uom || 'PCS')}</td>
                            <td className="border border-black p-1.5 text-center font-mono font-black">{formatCleanQty(qty)}</td>
                            <td className="border border-black p-1.5 text-center font-mono font-bold">{price > 0 ? formatCleanNumber(price) : ''}</td>
                            <td className="border border-black p-1.5 text-center font-mono font-black">{lineTotal > 0 ? formatCleanNumber(lineTotal) : '0'}</td>
                            <td className="border border-black p-1.5 text-xs font-semibold">
                              {idx === 0 ? `مورد / ${data.supplierName || '—'}` : (item.item_reference ? `قطعة ${item.item_reference}` : '')}
                            </td>
                          </tr>
                        );
                      })}
                      {Array.from({ length: Math.max(10 - items.length, 0) }, (_, i) => (
                        <tr key={`po-full-pad-${i}`} className="h-7 border border-black">
                          <td className="border border-black p-1.5 text-center font-mono font-bold text-slate-400">{items.length + i + 1}</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5 text-xs">{i === 0 && items.length === 0 ? `مورد / ${data.supplierName}` : ''}</td>
                        </tr>
                      ))}
                      <tr className="border-2 border-black" style={{ borderTop: '2px solid #000' }}>
                        <td colSpan={4} className="border border-black p-2 text-center font-black text-base tracking-widest bg-white">
                          الأجـــــــــــــــــمالـــــــــي
                        </td>
                        <td
                          colSpan={2}
                          className="border-2 border-black p-2 text-center font-mono font-black text-xl bg-[#FFFF00] bg-yellow-total text-black"
                          style={{ backgroundColor: '#FFFF00', border: '2px solid #000' }}
                        >
                          {formatCleanNumber(data.grandTotal)}
                        </td>
                        <td className="border border-black p-2 bg-white"></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="pt-8 pb-4">
                  <div className="flex items-center justify-around text-center px-12">
                    <div className="w-1/2">
                      <div className="text-base font-black text-black">المشتريات</div>
                      <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                      <div className="text-xs text-slate-700 font-semibold mt-1">م. أحمد بدوي</div>
                    </div>
                    <div className="w-1/2">
                      <div className="text-base font-black text-black">الحسابات</div>
                      <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                      <div className="text-xs text-slate-700 font-semibold mt-1">{data.accountantName || 'أ. حسن'}</div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* ════════════════════════════════════════════════════════════
                OPTION 3 & 4: طلب الشراء فقط (A4 كاملة - بدون بيانات مالية)
               ════════════════════════════════════════════════════════════ */}
            {(viewMode === 'PR_ONLY' || viewMode === 'TWO_PAGES') && (
              <section className="p-6 sm:p-8 bg-white text-black flex flex-col justify-between" style={{ minHeight: '270mm', pageBreakInside: 'avoid' }}>
                <div>
                  <div className="flex items-start justify-between gap-2 pb-2">
                    <div className="text-left shrink-0 w-1/4">
                      <img src="/eshbelia-logo.png" alt="شركة إشبيلية" className="h-16 w-auto object-contain" onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }} />
                      <div className="text-[10px] text-amber-700 font-black text-center w-16 mt-0.5">ISHBILIA<br />اشبيلية</div>
                    </div>
                    <div className="text-center self-center w-2/4">
                      <h1 className="text-3xl sm:text-4xl font-black text-black">طلب شراء</h1>
                      <div className="text-[11px] font-semibold text-slate-700 mt-1 flex items-center justify-center gap-1.5 flex-wrap">
                        <span>المشروع: <strong className="text-black">{displayProject}</strong></span>
                        <span className="text-slate-400">|</span>
                        <span>المنطقة: <strong className="text-black">{displayRegion}</strong></span>
                        <span className="text-slate-400">|</span>
                        <span>قطعة الأرض: <strong className="font-mono text-black">{displayParcel}</strong></span>
                      </div>
                    </div>
                    <div className="text-right text-xs font-bold text-black space-y-1 w-1/4 shrink-0" dir="rtl">
                      <div className="flex items-center justify-end gap-1"><span className="font-mono font-black text-sm">{prDateFormatted}</span><span>/التاريخ</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-mono font-black text-sm">{requestNumber}</span><span>/رقم الطلب</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-normal truncate">{displayProject}</span><span>/المشروع</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-normal truncate">{displayRegion}</span><span>/المنطقة</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-mono font-bold truncate">{displayParcel}</span><span>/قطعة الأرض</span></div>
                      <div className="flex items-center justify-end gap-1"><span className="font-normal truncate">{purpose}</span><span>/غرض الشراء</span></div>
                    </div>
                  </div>

                  <table className="w-full border-collapse border-2 border-black text-right text-xs mt-3" style={{ border: '2px solid #000' }}>
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
                      {items.map((item, idx) => (
                        <tr key={idx} className="h-7 border border-black">
                          <td className="border border-black p-1.5 text-center font-mono font-bold">{idx + 1}</td>
                          <td className="border border-black p-1.5 font-bold">{item.item_description}</td>
                          <td className="border border-black p-1.5 text-center">{getUnitLabel(item.uom || 'PCS')}</td>
                          <td className="border border-black p-1.5 text-center font-mono font-black">{formatCleanQty(item.quantity)}</td>
                          <td className="border border-black p-1.5 text-center font-mono font-semibold text-slate-800">{item.item_reference || data.projectOrParcel || '—'}</td>
                          <td className="border border-black p-1.5 text-xs text-slate-700">{item.specifications || '—'}</td>
                          <td className="border border-black p-1.5 text-xs font-semibold text-slate-800">{item.region || (idx === 0 ? `طلب: ${data.requesterName || ''}` : '')}</td>
                        </tr>
                      ))}
                      {Array.from({ length: Math.max(10 - items.length, 0) }, (_, i) => (
                        <tr key={`pr-full-pad-${i}`} className="h-7 border border-black">
                          <td className="border border-black p-1.5 text-center font-mono font-bold text-slate-400">{items.length + i + 1}</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                          <td className="border border-black p-1.5">&nbsp;</td>
                        </tr>
                      ))}
                      <tr className="border-2 border-black" style={{ borderTop: '2px solid #000' }}>
                        <td colSpan={4} className="border border-black p-2 text-center font-black text-sm bg-slate-100">
                          إجمالي بنود طلب الشراء: ({items.length}) بنود معتمدة
                        </td>
                        <td colSpan={3} className="border border-black p-2 text-right text-xs font-bold text-slate-700 bg-slate-50">
                          طلب الشراء لأغراض الفحص والموافقة الفنية ولا يتضمن أي بيانات مالية
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="pt-8 pb-4">
                  <div className="flex items-center justify-between text-center px-12">
                    <div className="w-1/3">
                      <div className="text-base font-black text-black">مقدم الطلب</div>
                      <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                      <div className="text-xs text-slate-700 font-semibold mt-1">{data.requesterName || 'م. كامل'}</div>
                    </div>
                    <div className="w-1/3">
                      <div className="text-base font-black text-black">المراجع</div>
                      <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                      <div className="text-xs text-slate-700 font-semibold mt-1">{data.reviewerName && data.reviewerName !== '—' ? data.reviewerName : 'م. كريم'}</div>
                    </div>
                    <div className="w-1/3">
                      <div className="text-base font-black text-black">المشتريات</div>
                      <div className="mt-4 border-b border-black w-32 mx-auto"></div>
                      <div className="text-xs text-slate-700 font-semibold mt-1">{data.procurementReviewerName || 'م. أحمد بدوي'}</div>
                    </div>
                  </div>
                </div>
              </section>
            )}

          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CombinedPoPrPrintModal;
