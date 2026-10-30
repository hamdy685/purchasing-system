import React, { useState, useMemo, useEffect } from 'react';
import { ExcelGridRow, ExcelGridResponse, getExcelReportsGridApi } from '../../api/admin/controlCenter';
import { Button } from '../ui/Button';
import LoadingSpinner from '../LoadingSpinner';
import ErrorMessage from '../ErrorMessage';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { getWorkflowStatusLabel } from '../../utils/statusLabels';

interface ColumnDef {
  key: keyof ExcelGridRow;
  label: string;
  defaultVisible: boolean;
  align?: 'right' | 'center' | 'left';
  isNumeric?: boolean;
  format?: (val: any) => string;
}

const ALL_COLUMNS: ColumnDef[] = [
  { key: 'pr_number', label: 'رقم طلب الشراء PR', defaultVisible: true },
  { key: 'po_number', label: 'رقم أمر الشراء PO', defaultVisible: true },
  { key: 'receipt_number', label: 'رقم إذن الاستلام REC', defaultVisible: true },
  { key: 'department', label: 'القسم / الإدارة', defaultVisible: true },
  { key: 'supplier', label: 'المورد', defaultVisible: true },
  { key: 'item_name', label: 'الصنف / المادة', defaultVisible: true },
  { key: 'quantity_requested', label: 'الكمية المطلوبة', defaultVisible: true, isNumeric: true, format: (v) => formatCleanQty(v) },
  { key: 'quantity_received', label: 'الكمية المستلمة', defaultVisible: true, isNumeric: true, format: (v) => formatCleanQty(v) },
  { key: 'uom', label: 'الوحدة', defaultVisible: true },
  { key: 'unit_price', label: 'سعر الوحدة', defaultVisible: true, isNumeric: true, format: (v) => `${formatCleanNumber(v, 2)} ج.م` },
  { key: 'total_price', label: 'إجمالي القيمة', defaultVisible: true, isNumeric: true, format: (v) => `${formatCleanNumber(v, 2)} ج.م` },
  { key: 'parcel_reference', label: 'رقم قطعة الأرض', defaultVisible: true },
  { key: 'region', label: 'المنطقة', defaultVisible: true },
  { key: 'purpose', label: 'الغرض / المبرر', defaultVisible: false },
  { key: 'requester_name', label: 'مقدم الطلب', defaultVisible: true },
  { key: 'actual_receiver', label: 'المستلم الفعلي', defaultVisible: true },
  { key: 'po_status', label: 'حالة أمر الشراء', defaultVisible: true, format: (v) => getWorkflowStatusLabel(v) },
  { key: 'receipt_status', label: 'حالة الاستلام', defaultVisible: true, format: (v) => getWorkflowStatusLabel(v) },
  { key: 'invoice_status', label: 'حالة الفاتورة', defaultVisible: false, format: (v) => getWorkflowStatusLabel(v) },
  { key: 'created_at', label: 'التاريخ', defaultVisible: true },
];

export const AdminExcelGrid: React.FC = () => {
  const [data, setData] = useState<ExcelGridRow[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Excel-like controls
  const [search, setSearch] = useState<string>('');
  const [groupBy, setGroupBy] = useState<'none' | 'department' | 'supplier' | 'parcel_reference'>('none');
  const [isFrozen, setIsFrozen] = useState<boolean>(true);
  const [showColumnModal, setShowColumnModal] = useState<boolean>(false);

  // Column visibility
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(() => {
    const saved = localStorage.getItem('admin_excel_grid_cols');
    if (saved) {
      try { return JSON.parse(saved); } catch {}
    }
    const initial: Record<string, boolean> = {};
    ALL_COLUMNS.forEach(col => { initial[col.key] = col.defaultVisible; });
    return initial;
  });

  const loadGridData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getExcelReportsGridApi({ search: search.trim() || undefined });
      setData(res.data || []);
      setSummary(res.summary || null);
    } catch (err: any) {
      console.error('[AdminExcelGrid] Failed to load data:', err);
      setError(err?.response?.data?.message || 'تعذر تحميل بيانات شبكة التقارير.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGridData();
  }, []);

  const handleToggleColumn = (key: string) => {
    setVisibleColumns(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('admin_excel_grid_cols', JSON.stringify(next));
      return next;
    });
  };

  const handleSelectAllColumns = () => {
    const next: Record<string, boolean> = {};
    ALL_COLUMNS.forEach(col => { next[col.key] = true; });
    setVisibleColumns(next);
    localStorage.setItem('admin_excel_grid_cols', JSON.stringify(next));
  };

  const handleResetDefaultColumns = () => {
    const next: Record<string, boolean> = {};
    ALL_COLUMNS.forEach(col => { next[col.key] = col.defaultVisible; });
    setVisibleColumns(next);
    localStorage.setItem('admin_excel_grid_cols', JSON.stringify(next));
  };

  // Filtered rows
  const filteredRows = useMemo(() => {
    if (!search.trim()) return data;
    const term = search.toLowerCase();
    return data.filter(row => {
      return (
        row.pr_number?.toLowerCase().includes(term) ||
        row.po_number?.toLowerCase().includes(term) ||
        row.receipt_number?.toLowerCase().includes(term) ||
        row.supplier?.toLowerCase().includes(term) ||
        row.item_name?.toLowerCase().includes(term) ||
        row.department?.toLowerCase().includes(term) ||
        row.parcel_reference?.toLowerCase().includes(term)
      );
    });
  }, [data, search]);

  // Grouped rows
  const groupedData = useMemo(() => {
    if (groupBy === 'none') {
      return { 'كافة المعاملات': filteredRows };
    }
    const groups: Record<string, ExcelGridRow[]> = {};
    filteredRows.forEach(row => {
      const keyVal = (row[groupBy] as string) || 'غير محدد';
      if (!groups[keyVal]) groups[keyVal] = [];
      groups[keyVal].push(row);
    });
    return groups;
  }, [filteredRows, groupBy]);

  // Export to CSV with UTF-8 BOM
  const handleExportCsv = () => {
    if (!filteredRows.length) return;
    const activeCols = ALL_COLUMNS.filter(c => visibleColumns[c.key]);
    const headers = activeCols.map(c => `"${c.label}"`).join(',');

    const lines = filteredRows.map(row => {
      return activeCols.map(c => {
        const val = row[c.key];
        const formatted = c.format ? c.format(val) : (val ?? '—');
        return `"${String(formatted).replace(/"/g, '""')}"`;
      }).join(',');
    });

    const csvContent = '\uFEFF' + headers + '\n' + lines.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `تقارير_المشتريات_الأدمن_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const activeColumnsList = useMemo(() => {
    return ALL_COLUMNS.filter(c => visibleColumns[c.key]);
  }, [visibleColumns]);

  return (
    <div className="space-y-4 text-slate-100" dir="rtl">
      {/* ── Official Print Layout (Visible ONLY during window.print()) ── */}
      <div className="hidden print:block font-sans text-black bg-white p-0 m-0">
        <style>{`
          @media print {
            @page {
              size: A4 landscape;
              margin: 6mm 5mm 6mm 5mm;
            }
            body {
              background: #ffffff !important;
              color: #000000 !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
            .print-hidden-element {
              display: none !important;
            }
            table {
              width: 100% !important;
              border-collapse: collapse !important;
              font-size: 7.5px !important;
            }
            th, td {
              border: 1px solid #334155 !important;
              padding: 2.5px 3.5px !important;
              color: #000000 !important;
              text-align: right !important;
            }
            thead {
              display: table-header-group !important;
            }
            tr {
              page-break-inside: avoid !important;
            }
          }
        `}</style>

        {/* Official Letterhead */}
        <div className="border-b-2 border-black pb-2 mb-2.5 flex items-start justify-between">
          <div>
            <h1 className="text-base font-black text-black">شركة اشبيلية للتطوير العقاري والمقاولات</h1>
            <h2 className="text-xs font-bold text-slate-800">
              مركز تحكم دورة المشتريات — مصفوفة تقارير العمليات والأصناف والمطابقات
            </h2>
            <div className="text-[9px] text-slate-600 mt-0.5">
              نمط العرض:{' '}
              {groupBy === 'none'
                ? 'مسرد مسطح شامل'
                : groupBy === 'department'
                ? 'مجمع حسب القسم / الإدارة'
                : groupBy === 'supplier'
                ? 'مجمع حسب المورد'
                : 'مجمع حسب رقم قطعة الأرض'}
              {search && ` | تصفية البحث: "${search}"`}
            </div>
          </div>
          <div className="text-left text-[9px] font-mono border border-black p-1.5 rounded bg-slate-50">
            <div>تاريخ الطباعة: {new Date().toLocaleDateString('ar-EG')}</div>
            <div>وقت الطباعة: {new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</div>
            <div>الجهة: الإدارة العليا / مدير النظام</div>
          </div>
        </div>

        {/* Summary Metadata Strip */}
        {summary && (
          <div className="grid grid-cols-4 gap-2 mb-2.5 text-[10px] border border-black bg-slate-100 p-2 font-bold text-black">
            <div className="border-l border-slate-400 pl-2">
              <span className="text-slate-600 block text-[8px]">إجمالي السجلات:</span>
              <span className="font-mono text-xs">{filteredRows.length} سجل</span>
            </div>
            <div className="border-l border-slate-400 pl-2">
              <span className="text-slate-600 block text-[8px]">إجمالي الكميات المطلوبة:</span>
              <span className="font-mono text-xs">{formatCleanQty(summary.total_requested_quantity)}</span>
            </div>
            <div className="border-l border-slate-400 pl-2">
              <span className="text-slate-600 block text-[8px]">إجمالي الكميات المستلمة:</span>
              <span className="font-mono text-xs text-emerald-800">{formatCleanQty(summary.total_received_quantity)}</span>
            </div>
            <div>
              <span className="text-slate-600 block text-[8px]">إجمالي القيمة المالية:</span>
              <span className="font-mono text-xs">{formatCleanNumber(summary.total_amount, 2)} ج.م</span>
            </div>
          </div>
        )}

        {/* Printable Table */}
        <table className="w-full border-collapse border border-black text-[7.5px] text-right">
          <thead>
            <tr className="bg-slate-200 border-b border-black font-black text-black">
              <th className="p-1 text-center w-5">#</th>
              {activeColumnsList.map((col) => (
                <th key={col.key} className="p-1 border border-black font-black">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groupBy === 'none'
              ? filteredRows.map((row, idx) => (
                  <tr key={`print-${row.po_id}-${idx}`} className={idx % 2 === 1 ? 'bg-slate-50' : ''}>
                    <td className="p-1 text-center font-mono font-bold text-slate-700">{idx + 1}</td>
                    {activeColumnsList.map((col) => {
                      const val = row[col.key];
                      const formatted = col.format ? col.format(val) : (val ?? '—');
                      return (
                        <td key={col.key} className="p-1 border border-black">
                          {String(formatted)}
                        </td>
                      );
                    })}
                  </tr>
                ))
              : (Object.entries(groupedData) as [string, ExcelGridRow[]][]).map(([groupTitle, rows]) => (
                  <React.Fragment key={`print-group-${groupTitle}`}>
                    <tr className="bg-slate-300 font-black text-black">
                      <td colSpan={activeColumnsList.length + 1} className="p-1 font-bold border border-black text-[8.5px]">
                        📁 {groupTitle} ({rows.length} سجل)
                      </td>
                    </tr>
                    {rows.map((row, idx) => (
                      <tr key={`print-${groupTitle}-${row.po_id}-${idx}`} className={idx % 2 === 1 ? 'bg-slate-50' : ''}>
                        <td className="p-1 text-center font-mono font-bold text-slate-700">{idx + 1}</td>
                        {activeColumnsList.map((col) => {
                          const val = row[col.key];
                          const formatted = col.format ? col.format(val) : (val ?? '—');
                          return (
                            <td key={col.key} className="p-1 border border-black">
                              {String(formatted)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
          </tbody>
        </table>

        {/* Print Footer */}
        <div className="mt-2.5 pt-2 border-t border-black flex items-center justify-between text-[8px] text-slate-600">
          <div>شركة اشبيلية للتطوير العقاري والمقاولات — مستخرج رسمي لمدير النظام</div>
          <div>تقرير الرقابة الإدارية والمشتريات — طُبع آلياً من النظام</div>
        </div>
      </div>

      {/* ── Screen Interactive UI (Hidden during window.print()) ── */}
      <div className="print:hidden space-y-4">
        {/* ── Excel Control Toolbar ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/90 border border-slate-800 p-4 rounded-2xl backdrop-blur-md">
          {/* Search */}
          <div className="flex items-center gap-2 flex-1 min-w-[240px] max-w-md">
            <span className="text-slate-400">🔍</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث فوري في كل الحقول (أمر، طلب، صنف، مورد، قطعة أرض)..."
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-gold-500"
            />
          </div>

          {/* Group By Selector */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400 font-bold">تجميع حسب:</span>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as any)}
              className="bg-slate-950 border border-slate-700 text-slate-200 rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-gold-500 font-medium"
            >
              <option value="none">بدون تجميع (مسطح)</option>
              <option value="department">القسم / الإدارة</option>
              <option value="supplier">المورد</option>
              <option value="parcel_reference">رقم قطعة الأرض</option>
            </select>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {/* Column Pinning Toggle */}
            <button
              type="button"
              onClick={() => setIsFrozen(!isFrozen)}
              className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-colors ${
                isFrozen
                  ? 'bg-gold-500/20 border-gold-500/50 text-gold-300'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
              title="تثبيت الأعمدة الأساسية (PR & PO) أثناء التمرير الأفقي"
            >
              📌 {isFrozen ? 'الأعمدة مثبتة' : 'تثبيت الأعمدة'}
            </button>

            {/* Columns Selector */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowColumnModal(true)}
              className="font-bold text-xs"
            >
              ⚙️ الأعمدة ({activeColumnsList.length})
            </Button>

            {/* Print Button */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              disabled={!filteredRows.length}
              className="font-bold text-xs border-sky-500/40 text-sky-300 hover:bg-sky-950/40 flex items-center gap-1.5"
              title="طباعة التقرير أو حفظه بصيغة PDF معتمدة"
            >
              <span>🖨️ طباعة التقرير</span>
            </Button>

            {/* Export CSV */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={!filteredRows.length}
              className="font-bold text-xs border-emerald-500/40 text-emerald-300 hover:bg-emerald-950/40"
            >
              📊 تصدير Excel / CSV
            </Button>

            {/* Refresh */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={loadGridData}
              isLoading={loading}
              className="font-bold text-xs"
            >
              🔄 تحديث
            </Button>
          </div>
        </div>

      {error && <ErrorMessage error={error} />}

      {/* ── Summary Stats Cards ── */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-3.5">
            <span className="text-[11px] text-slate-400 font-bold block">إجمالي عدد السجلات:</span>
            <span className="text-lg font-black font-mono text-cyan-300">{filteredRows.length} سجل</span>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-3.5">
            <span className="text-[11px] text-slate-400 font-bold block">إجمالي الكميات المطلوبة:</span>
            <span className="text-lg font-black font-mono text-amber-300">
              {formatCleanQty(summary.total_requested_quantity)}
            </span>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-3.5">
            <span className="text-[11px] text-slate-400 font-bold block">إجمالي الكميات المستلمة:</span>
            <span className="text-lg font-black font-mono text-emerald-300">
              {formatCleanQty(summary.total_received_quantity)}
            </span>
          </div>
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-3.5">
            <span className="text-[11px] text-slate-400 font-bold block">إجمالي المبالغ المالية:</span>
            <span className="text-lg font-black font-mono text-gold-300">
              {formatCleanNumber(summary.total_amount, 2)} ج.م
            </span>
          </div>
        </div>
      )}

      {/* ── Interactive Excel Grid Table ── */}
      <div className="relative border border-slate-800 bg-slate-950/80 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-md">
        {loading ? (
          <div className="flex flex-col items-center justify-center p-12 space-y-3">
            <LoadingSpinner size="lg" />
            <span className="text-xs text-gold-300 font-bold">جاري تحميل مصفوفة البيانات الشاملة...</span>
          </div>
        ) : !filteredRows.length ? (
          <div className="p-12 text-center text-slate-500 font-medium text-xs">
            لا توجد سجلات مطابقة لمعايير البحث الحالية.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[650px] scrollbar-thin scrollbar-thumb-slate-700">
            <table className="w-full text-right text-xs border-collapse">
              <thead className="bg-slate-900 text-slate-300 sticky top-0 z-20 shadow-md">
                <tr className="border-b border-slate-800 divide-x divide-x-reverse divide-slate-800/60">
                  <th className="p-3 font-black text-center w-12 text-slate-500">#</th>
                  {activeColumnsList.map((col, idx) => {
                    const isFrozenCol = isFrozen && idx < 2;
                    return (
                      <th
                        key={col.key}
                        className={`p-3 font-black whitespace-nowrap text-slate-200 ${
                          isFrozenCol ? 'sticky z-30 bg-slate-900 border-l border-slate-700' : ''
                        }`}
                        style={isFrozenCol ? { right: idx === 0 ? 0 : '140px' } : undefined}
                      >
                        {col.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-800/40 text-slate-300">
                {Object.entries(groupedData).map(([groupTitle, groupRows]) => (
                  <React.Fragment key={groupTitle}>
                    {groupBy !== 'none' && (
                      <tr className="bg-slate-900/95 font-bold border-y border-gold-500/30">
                        <td colSpan={activeColumnsList.length + 1} className="p-2.5 text-gold-300 text-xs font-black">
                          📁 {groupTitle} ({groupRows.length} سجل)
                        </td>
                      </tr>
                    )}
                    {groupRows.map((row, rIdx) => (
                      <tr
                        key={`${row.po_id}-${row.item_name}-${rIdx}`}
                        className="hover:bg-slate-900/60 transition-colors divide-x divide-x-reverse divide-slate-800/40"
                      >
                        <td className="p-2.5 text-center text-slate-500 font-mono text-[11px]">{rIdx + 1}</td>
                        {activeColumnsList.map((col, idx) => {
                          const val = row[col.key];
                          const formatted = col.format ? col.format(val) : (val ?? '—');
                          const isFrozenCol = isFrozen && idx < 2;

                          return (
                            <td
                              key={col.key}
                              className={`p-2.5 whitespace-nowrap ${
                                col.isNumeric ? 'font-mono' : ''
                              } ${
                                isFrozenCol ? 'sticky z-10 bg-slate-950 font-bold text-cyan-300 border-l border-slate-800' : ''
                              }`}
                              style={isFrozenCol ? { right: idx === 0 ? 0 : '140px' } : undefined}
                            >
                              {formatted}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Columns Visibility Modal ── */}
      {showColumnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-6 space-y-4 animate-scale-in text-xs">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="text-sm font-black text-gold-300">⚙️ تخصيص وإظهار أعمدة الجدول ({ALL_COLUMNS.length} عمود)</h4>
              <button
                type="button"
                onClick={() => setShowColumnModal(false)}
                className="text-slate-400 hover:text-slate-200 font-bold"
              >
                ✕
              </button>
            </div>

            <div className="flex items-center gap-2 pb-2">
              <Button type="button" variant="secondary" size="sm" onClick={handleSelectAllColumns}>
                تحديد الكل
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={handleResetDefaultColumns}>
                استعادة الافتراضي
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2 max-h-[350px] overflow-y-auto p-1">
              {ALL_COLUMNS.map(col => (
                <label
                  key={col.key}
                  className="flex items-center gap-2 p-2 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(visibleColumns[col.key])}
                    onChange={() => handleToggleColumn(col.key)}
                    className="rounded border-slate-700 bg-slate-900 text-gold-500 focus:ring-gold-400 h-4 w-4"
                  />
                  <span className="font-medium text-slate-300">{col.label}</span>
                </label>
              ))}
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-800">
              <Button type="button" variant="primary" size="sm" onClick={() => setShowColumnModal(false)}>
                تم وحفظ التفضيلات
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
