import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSuppliersApi } from '../../api/suppliers';
import { createDirectPoApi, getProcurementDepartmentsApi, getProcurementSiteEngineersApi, ProcurementDepartmentOption, ProcurementSiteEngineerOption } from '../../api/procurement';
import { Supplier } from '../../types/purchaseOrder';
import { parseApiError } from '../../utils/apiError';
import { DEFAULT_PR_UNIT_CODES, getUnitLabel, getUnitOptions } from '../../utils/units';
import { SearchableSelect } from '../ui/FormField';
import { SupplierSelectWithQuickAdd } from '../common/SupplierSelectWithQuickAdd';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { isRebarUnit, calculateRebarTons } from '../../utils/rebar';
import { ActionConfirmationModal, ConfirmationAlert } from '../common/ActionConfirmationModal';
import { tafqeetCurrency } from '../../utils/tafqeet';

interface ItemRow {
  item_id?: number | null;
  item_description: string;
  item_reference: string;
  region: string;
  quantity: number;
  uom: string;
  unit_price: number;
  specifications: string;
}

interface DirectPoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (requestId: number) => void;
}

const UNIT_OPTIONS = getUnitOptions(DEFAULT_PR_UNIT_CODES);

const emptyItem = (): ItemRow => ({
  item_description: '',
  item_reference: '',
  region: '',
  quantity: 1,
  uom: 'PCS',
  unit_price: 0,
  specifications: '',
});

// Line as sent to the API: rebar bars/parcels are converted to tons (unit price kept as entered).
const toSubmittedItem = (item: ItemRow) => {
  const qty = Number(item.quantity);
  const uomUpper = (item.uom || '').trim().toUpperCase();
  const isRebar = isRebarUnit(item.uom) || uomUpper === 'PARCEL' || (item.uom || '').includes('طرد');
  let finalQty = qty;
  let finalUom = item.uom;
  let finalSpec = item.specifications.trim();

  if (isRebar && finalUom !== 'TON' && finalUom !== 'طن') {
    const tons = calculateRebarTons(qty, item.uom);
    if (tons > 0) {
      finalQty = tons;
      finalUom = 'TON';
      const extra = (uomUpper === 'PARCEL' || (item.uom || '').includes('طرد'))
        ? `(ما يعادل ${formatCleanQty(qty)} طرد حديد - زنة الطرد 1.940 طن)`
        : `(ما يعادل ${formatCleanQty(qty)} سيخ حديد ${getUnitLabel(item.uom)})`;
      finalSpec = finalSpec ? `${finalSpec} - ${extra}` : extra;
    }
  }

  return {
    item_id: item.item_id || null,
    item_description: item.item_description.trim(),
    item_reference: item.item_reference.trim() || '',
    region: item.region.trim() || '',
    quantity: finalQty,
    uom: finalUom,
    unit_price: Number(item.unit_price),
    specifications: finalSpec || undefined,
  };
};

export const DirectPoModal: React.FC<DirectPoModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [departments, setDepartments] = useState<ProcurementDepartmentOption[]>([]);
  const [siteEngineers, setSiteEngineers] = useState<ProcurementSiteEngineerOption[]>([]);
  const [supplierId, setSupplierId] = useState<string>('');
  const [oneTimeSupplierName, setOneTimeSupplierName] = useState<string>('');
  const [departmentId, setDepartmentId] = useState<string>('');
  const [siteEngineerId, setSiteEngineerId] = useState<string>('');
  const [deliveryDate, setDeliveryDate] = useState(() => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  });
  const [items, setItems] = useState<ItemRow[]>([emptyItem()]);
  const [requiresWarehouseReceipt, setRequiresWarehouseReceipt] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    Promise.all([
      getSuppliersApi().catch(() => []),
      getProcurementDepartmentsApi().catch(() => []),
      getProcurementSiteEngineersApi().catch(() => []),
    ]).then(([supplierData, departmentData, engineerData]) => {
      setSuppliers(supplierData || []);
      setDepartments(departmentData || []);
      setSiteEngineers(engineerData || []);
    });
  }, [isOpen]);

  const grandTotal = useMemo(
    () => items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) * Number(item.unit_price)), 0),
    [items],
  );

  const departmentOptions = useMemo(() => {
    return departments.map((d) => ({
      value: String(d.id),
      label: d.name,
      subLabel: d.code || undefined,
    }));
  }, [departments]);

  const engineerOptions = useMemo(() => {
    const sorted = [...siteEngineers].sort((a, b) => {
      const aIsBadawy = a.id === 6 || a.name.includes('بدوي');
      const bIsBadawy = b.id === 6 || b.name.includes('بدوي');
      if (aIsBadawy) return -1;
      if (bIsBadawy) return 1;
      return a.name.localeCompare(b.name, 'ar');
    });

    return sorted.map((e) => {
      const isBadawy = e.id === 6 || e.name.includes('بدوي');
      return {
        value: String(e.id),
        label: e.name,
        subLabel: isBadawy ? 'مدير المشتريات / مستلم' : (e.department_name || undefined),
      };
    });
  }, [siteEngineers]);

  const selectedDepartment = useMemo(() => {
    return departments.find((d) => String(d.id) === departmentId);
  }, [departments, departmentId]);

  const selectedDepartmentEngineer = useMemo(() => {
    if (!departmentId) return null;
    if (selectedDepartment?.site_engineer?.id) {
      return {
        id: selectedDepartment.site_engineer.id,
        name: selectedDepartment.site_engineer.name,
      };
    }
    const matching = siteEngineers.find((e) => String(e.department_id) === departmentId);
    if (matching) {
      return {
        id: matching.id,
        name: matching.name,
      };
    }
    return null;
  }, [departmentId, selectedDepartment, siteEngineers]);

  const handleDepartmentChange = (val: string | number) => {
    const newDeptId = String(val);
    setDepartmentId(newDeptId);

    if (!newDeptId) {
      setSiteEngineerId('');
      return;
    }

    const dept = departments.find((d) => String(d.id) === newDeptId);
    if (dept?.site_engineer?.id) {
      setSiteEngineerId(String(dept.site_engineer.id));
    } else {
      const matching = siteEngineers.find((e) => String(e.department_id) === newDeptId);
      if (matching) {
        setSiteEngineerId(String(matching.id));
      } else {
        setSiteEngineerId('');
      }
    }
  };


  const updateItem = (index: number, field: keyof ItemRow, value: string | number) => {
    setItems(current => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, [field]: value } : item
    )));
  };

  const addItem = () => setItems(current => [...current, emptyItem()]);

  const removeItem = (index: number) => {
    if (items.length <= 1) return;
    setItems(current => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const isSteel = (item: ItemRow) => {
    const desc = (item.item_description || '').toLowerCase();
    const uomUpper = (item.uom || '').trim().toUpperCase();
    return (
      isRebarUnit(item.uom) ||
      uomUpper === 'PARCEL' ||
      desc.includes('حديد') ||
      desc.includes('تسليح') ||
      desc.includes('rebar') ||
      desc.includes('كانات') ||
      desc.includes('لنية') ||
      desc.includes('لينية')
    );
  };

  // Mirrors the backend (SteelConsolidationService): two or more rebar lines on the same plot and region
  // are saved as ONE purchase line named "حديد". This is only a preview; the server decides.
  const steelConsolidationPreview = useMemo(() => {
    const groups = new Map<string, { count: number; tons: number; amount: number }>();
    items.forEach((item) => {
      const line = toSubmittedItem(item);
      const isTonUnit = line.uom === 'TON' || line.uom === 'طن';
      if (!isSteel(item) || !isTonUnit || line.quantity <= 0) return;
      const key = `${line.item_reference}|${line.region}`;
      const group = groups.get(key) || { count: 0, tons: 0, amount: 0 };
      group.count += 1;
      group.tons += line.quantity;
      group.amount += line.quantity * line.unit_price;
      groups.set(key, group);
    });
    return Array.from(groups.values()).filter((group) => group.count >= 2);
  }, [items]);

  if (!isOpen) return null;

  const confirmationAlerts = useMemo(() => {
    const alerts: ConfirmationAlert[] = [];
    const rebarItems = items.filter(isSteel);

    if (steelConsolidationPreview.length > 0) {
      alerts.push({
        type: 'rebar',
        title: '🏗️ تجميع بنود الحديد في بند واحد (حديد)',
        message: 'سيتم حفظ أقطار الحديد كبند واحد باسم "حديد" (الكمية بالطن والقيمة = مجموع قيم الأقطار) في أمر الشراء والاستلام والحسابات، مع الاحتفاظ بتفاصيل الأقطار للمرجعية فقط.',
        badge: 'حديد موحد',
      });
    } else if (rebarItems.length > 0) {
      alerts.push({
        type: 'rebar',
        title: '🏗️ تنبيه وزنة حديد كاملة (مسار مستقل ومطابقة قبان)',
        message: 'يحتوي هذا الطلب المباشر على بنود حديد تسليح، وسيتم توجيهه كوزنة حديد مستقلة وكاملة تخضع لإجراءات وتصاريح وزن القبان ومطابقة مهندس الموقع بالمشروع.',
        badge: 'وزنة حديد',
      });
    }

    return alerts;
  }, [items, steelConsolidationPreview]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if ((!supplierId && !oneTimeSupplierName.trim()) || !departmentId || !siteEngineerId) {
      setError('يرجى ملء كافة الحقول الإلزامية واختيار المورد والقسم ومهندس الموقع / المستلم.');
      return;
    }
    const invalidItems = items.some(item => !item.item_description.trim() || Number(item.quantity) <= 0 || Number(item.unit_price) <= 0);
    if (invalidItems) {
      setError('يرجى التأكد من كتابة الصنف وتحديد الكمية وسعر الوحدة لجميع البنود.');
      return;
    }

    setError(null);
    setIsConfirmModalOpen(true);
  };

  const executeDirectPo = async () => {
    setIsConfirmModalOpen(false);
    setLoading(true);
    setError(null);
    try {
      const result = await createDirectPoApi({
        supplier_id: supplierId ? Number(supplierId) : undefined,
        one_time_supplier_name: oneTimeSupplierName.trim() || undefined,
        department_id: Number(departmentId),
        site_engineer_user_id: Number(siteEngineerId),
        requires_warehouse_receipt: requiresWarehouseReceipt,
        delivery_date: deliveryDate || undefined,
        items: items.map(toSubmittedItem),
      });
      onSuccess(result.id);
      onClose();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setLoading(false);
    }
  };

  return createPortal((
    <div className="modal-top-viewport fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/80 p-2 sm:p-4 backdrop-blur-sm" dir="rtl" role="dialog" aria-modal="true">
      <div className="flex max-h-[calc(100vh-1rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-cyan-800/70 bg-[#0f172a] shadow-2xl sm:max-h-[calc(100vh-2rem)]">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-3 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-2">
            <span className="text-xl text-emerald-400">▣</span>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-black text-emerald-400 break-words">إنشاء طلب شراء مباشر</h2>
              <p className="mt-0.5 hidden sm:block text-[11px] text-slate-400">يرسل أولًا للمدير التنفيذي ثم للحسابات قبل إنشاء أمر الشراء</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={loading} className="inline-flex min-h-[44px] min-w-[44px] sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-xl border border-slate-600 bg-slate-900/60 text-2xl font-black leading-none text-slate-300 transition-colors hover:border-cyan-400 hover:bg-slate-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-400/70 disabled:opacity-50 cursor-pointer" aria-label="إغلاق النافذة" title="إغلاق النافذة">×</button>
        </div>

        <form onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto">
          {error && <div className="mx-3 mt-3 sm:mx-5 sm:mt-4 rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300">{error}</div>}

          <div className="grid grid-cols-1 gap-3 sm:gap-4 px-3 pt-4 sm:px-5 sm:pt-5 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <SupplierSelectWithQuickAdd
                suppliers={suppliers}
                selectedSupplierId={supplierId}
                onSelectSupplierId={(val) => setSupplierId(val)}
                oneTimeSupplierName={oneTimeSupplierName}
                onChangeOneTimeSupplierName={(name) => setOneTimeSupplierName(name)}
                onSupplierCreated={(newSup) => {
                  setSuppliers((prev) => [...prev, newSup]);
                  setSupplierId(String(newSup.id));
                  setOneTimeSupplierName('');
                }}
                required
                label="المورد المطلوب"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-200 mb-1">
                القسم الموجه له <span className="text-rose-400">*</span>
              </label>
              <SearchableSelect
                options={departmentOptions}
                value={departmentId}
                onChange={handleDepartmentChange}
                placeholder="اختر أو ابحث عن القسم..."
                searchPlaceholder="ابحث باسم القسم..."
                emptyMessage="لا يوجد قسم بهذا الاسم"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-slate-200">
                  المستلم المسؤول بالموقع <span className="text-rose-400">*</span>
                </label>
                {selectedDepartmentEngineer && (
                  <span className="text-[10px] text-emerald-400 font-bold bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded">
                    ✓ اقتراح القسم
                  </span>
                )}
              </div>
              <SearchableSelect
                options={engineerOptions}
                value={siteEngineerId}
                onChange={(val) => setSiteEngineerId(String(val))}
                placeholder="اختر مسؤول الاستلام بالموقع..."
                searchPlaceholder="ابحث باسم المستلم..."
                emptyMessage="لا يوجد مستلم بهذا الاسم"
              />
            </div>
            <label className="block text-xs font-bold text-slate-200">
              تاريخ الحاجة
              <input type="date" value={deliveryDate} onChange={event => setDeliveryDate(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-cyan-500/80 bg-[#0b1424] px-3 text-xs text-slate-100 outline-none focus:border-cyan-300" />
            </label>

            {/* خيار استلام وفحص المخزن (عم سلامة) */}
            <div className="rounded-xl border border-slate-700/80 bg-slate-800/60 p-3 space-y-2 col-span-full">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <span className="text-xl shrink-0 mt-0.5">🏬</span>
                  <div>
                    <span className="font-bold text-slate-100 text-xs block">
                      استلام وفحص بالمخزن (عم سلامة)
                    </span>
                    <span className="text-[11px] text-slate-400 block mt-0.5">
                      {requiresWarehouseReceipt
                        ? 'نعم (الافتراضي) — يمر أمر الشراء على عم سلامة في المخزن لاستلام البضاعة وفحصها وإصدار إذن الاستلام.'
                        : 'لا (توريد مباشر) — يتم توريد البضاعة مباشرة للموقع لمهندس الموقع دون المرور على المخزن أو إشعار عم سلامة.'}
                    </span>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer select-none shrink-0">
                  <input
                    type="checkbox"
                    checked={requiresWarehouseReceipt}
                    onChange={(e) => setRequiresWarehouseReceipt(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>
              <div className="flex items-center gap-2 pt-1.5 border-t border-slate-700/50 text-[11px]">
                <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${requiresWarehouseReceipt ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'}`}>
                  {requiresWarehouseReceipt ? '✅ يمر على عم سلامة في المخزن' : '⚡ توريد مباشر للموقع (يتخطى عم سلامة)'}
                </span>
              </div>
            </div>
          </div>

          <div className="px-3 pb-4 pt-5 sm:px-5 sm:pb-5 sm:pt-6">
            <div className="mb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div>
                <h3 className="text-sm font-black text-slate-200 flex items-center gap-2">
                  <span>أصناف وتفاصيل طلب الشراء المباشر</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  أدخل الأصناف بأقطارها؛ بنود حديد التسليح لنفس قطعة الأرض والمنطقة تُجمع تلقائياً في بند واحد (حديد)
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={addItem}
                  className="rounded-xl border border-slate-600 bg-slate-800/80 hover:bg-slate-700 px-3.5 py-2 text-xs font-bold text-slate-200 transition-colors hover:border-cyan-400 hover:text-cyan-300 cursor-pointer"
                >
                  ＋ إضافة صنف آخر
                </button>
              </div>
            </div>

            {steelConsolidationPreview.length > 0 && (
              <div className="mb-3 rounded-2xl border border-amber-500/50 bg-gradient-to-r from-amber-950/70 via-slate-900 to-amber-950/40 p-3 text-xs font-bold text-amber-200 flex items-center gap-2.5 shadow-lg" data-testid="steel-consolidation-preview">
                <span className="text-xl shrink-0">⚖️</span>
                <span className="leading-relaxed">
                  {steelConsolidationPreview.map((group, index) => (
                    <span key={index} className="block">
                      سيتم حفظ ({group.count}) بنود حديد كبند واحد «حديد»: {formatCleanQty(group.tons)} طن بقيمة {formatCleanNumber(group.amount, 2)} ج.م
                      (سعر الطن المرجّح {formatCleanNumber(group.tons > 0 ? group.amount / group.tons : 0, 2)} ج.م)
                    </span>
                  ))}
                </span>
              </div>
            )}

            <div className="hidden rounded border border-cyan-500/70 sm:block">
              <table className="w-full border-collapse text-right text-[11px]">
                <thead className="bg-[#0c1728] text-cyan-400">
                  <tr>
                    <th className="border-b border-slate-700 px-2 py-3 text-center">#</th>
                    <th className="border-b border-slate-700 px-2 py-3">رقم قطعة الأرض <span className="text-rose-400">*</span></th>
                    <th className="border-b border-slate-700 px-2 py-3">اسم الصنف <span className="text-rose-400">*</span></th>
                    <th className="border-b border-slate-700 px-2 py-3">الوحدة <span className="text-rose-400">*</span></th>
                    <th className="border-b border-slate-700 px-2 py-3">الكمية <span className="text-rose-400">*</span></th>
                    <th className="border-b border-slate-700 px-2 py-3">السعر <span className="text-rose-400">*</span></th>
                    <th className="border-b border-slate-700 px-2 py-3">الإجمالي</th>
                    <th className="border-b border-slate-700 px-2 py-3">المنطقة</th>
                    <th className="border-b border-slate-700 px-2 py-3">المواصفات والتفاصيل</th>
                    <th className="border-b border-slate-700 px-2 py-3 text-center">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const isBundledRow = item.specifications?.includes('وزنة حديد مجمعة') || item.item_description.includes('وزنة حديد');
                    return (
                    <tr key={index} className={`${isBundledRow ? 'bg-amber-950/30 border-l-4 border-l-amber-500' : 'bg-[#172337]'} align-middle transition-colors`}>
                      <td className="border-t border-slate-700 px-2 py-3 text-center font-mono text-slate-400">
                        {index + 1}
                        {isBundledRow && <span className="block text-[9px] text-amber-400">⚖️ مجمع</span>}
                      </td>
                      <td className="border-t border-slate-700 px-2 py-2"><input required value={item.item_reference} onChange={event => updateItem(index, 'item_reference', event.target.value)} placeholder="رقم قطعة الأرض" dir="ltr" className="h-9 w-32 rounded border border-slate-600 bg-[#0b1424] px-2 text-xs text-slate-100 outline-none focus:border-cyan-400" /></td>
                      <td className="border-t border-slate-700 px-2 py-2">
                        <input required value={item.item_description} onChange={event => updateItem(index, 'item_description', event.target.value)} placeholder="اسم الصنف" className={`h-9 w-40 rounded border ${isBundledRow ? 'border-amber-500/80 font-bold text-amber-200' : 'border-slate-600 text-slate-100'} bg-[#0b1424] px-2 text-xs outline-none focus:border-cyan-400`} />
                        {isBundledRow && (
                          <span className="mt-1 block text-[9px] font-black text-amber-300">
                            بند وزنة موحد (استلام ومحاسبة)
                          </span>
                        )}
                      </td>
                      <td className="border-t border-slate-700 px-2 py-2"><select required aria-label="وحدة البند" value={item.uom} onChange={event => updateItem(index, 'uom', event.target.value)} className="h-9 w-24 rounded border border-slate-600 bg-[#0b1424] px-2 text-xs text-slate-100 outline-none focus:border-cyan-400">{UNIT_OPTIONS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</select></td>
                      <td className="border-t border-slate-700 px-2 py-2"><input required type="number" min="0" step="any" aria-label="كمية البند" value={item.quantity ?? ''} onFocus={e => e.target.select()} onChange={event => updateItem(index, 'quantity', event.target.value === '' ? '' : Number(event.target.value))} className="h-9 w-20 rounded border border-slate-600 bg-[#0b1424] px-2 text-center font-mono text-xs text-slate-100 outline-none focus:border-cyan-400" /></td>
                      <td className="border-t border-slate-700 px-2 py-2"><input required type="number" min="0" step="any" aria-label="سعر الوحدة" value={item.unit_price ?? ''} onFocus={e => e.target.select()} onChange={event => updateItem(index, 'unit_price', event.target.value === '' ? '' : Number(event.target.value))} className="h-9 w-24 rounded border border-slate-600 bg-[#0b1424] px-2 text-center font-mono text-xs text-slate-100 outline-none focus:border-cyan-400" /></td>
                      <td className="border-t border-slate-700 px-2 py-2 text-center font-mono font-black text-emerald-300">{formatCleanNumber((Number(item.quantity) || 0) * (Number(item.unit_price) || 0))} ج.م</td>
                      <td className="border-t border-slate-700 px-2 py-2"><input required value={item.region} onChange={event => updateItem(index, 'region', event.target.value)} placeholder="المنطقة" className="h-9 w-28 rounded border border-slate-600 bg-[#0b1424] px-2 text-xs text-slate-100 outline-none focus:border-cyan-400" /></td>
                      <td className="border-t border-slate-700 px-2 py-2"><input value={item.specifications} onChange={event => updateItem(index, 'specifications', event.target.value)} placeholder="المواصفات" className="h-9 w-36 rounded border border-slate-600 bg-[#0b1424] px-2 text-xs text-slate-100 outline-none focus:border-cyan-400" /></td>
                      <td className="border-t border-slate-700 px-2 py-2 text-center"><button type="button" onClick={() => removeItem(index)} disabled={items.length <= 1} className="rounded border border-rose-500/70 px-2 py-1 text-sm text-rose-300 disabled:cursor-not-allowed disabled:opacity-30" aria-label="حذف البند">▥</button></td>
                    </tr>
                  );})}
                </tbody>
                <tfoot>
                  <tr className="bg-[#0c1728]">
                    <td colSpan={6} className="border-t border-cyan-500/70 px-3 py-3 text-left text-sm font-black text-slate-200">الإجمالي المالي المقترح للموافقة:</td>
                    <td className="border-t border-cyan-500/70 px-3 py-3 text-center font-mono text-base font-black text-emerald-300">{formatCleanNumber(grandTotal)} ج.م</td>
                    <td colSpan={3} className="border-t border-cyan-500/70" />
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="space-y-3 sm:hidden">
              {items.map((item, index) => {
                const isBundledRow = item.specifications?.includes('وزنة حديد مجمعة') || item.item_description.includes('وزنة حديد');
                return (
                <article key={`mobile-item-${index}`} className={`rounded-xl border ${isBundledRow ? 'border-amber-500/80 bg-gradient-to-br from-amber-950/40 via-slate-900 to-slate-900 shadow-md shadow-amber-950/30' : 'border-slate-700 bg-[#172337]'} p-3.5 transition-all`}>
                  <div className="flex items-start justify-between gap-3 border-b border-slate-700/80 pb-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-bold text-cyan-300">بند #{index + 1}</span>
                        {isBundledRow && (
                          <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/40">
                            ⚖️ وزنة مجمعة (استلام ومحاسبة)
                          </span>
                        )}
                      </div>
                      <p className="mt-1 break-words text-sm font-black text-slate-100">{item.item_description || 'اسم الصنف غير مكتوب'}</p>
                    </div>
                    <button type="button" onClick={() => removeItem(index)} disabled={items.length <= 1} className="h-9 w-9 shrink-0 rounded border border-rose-500/70 text-sm text-rose-300 disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer" aria-label="حذف البند">×</button>
                  </div>
                  <div className="mt-3 space-y-3">
                    <label className="block text-[11px] font-bold text-slate-300">رقم قطعة الأرض <span className="text-rose-400">*</span><input required value={item.item_reference} onChange={event => updateItem(index, 'item_reference', event.target.value)} placeholder="رقم قطعة الأرض" dir="ltr" className="mt-1.5 h-11 w-full rounded border border-slate-600 bg-[#0b1424] px-3 text-sm text-slate-100 outline-none focus:border-cyan-400" /></label>
                    <label className="block text-[11px] font-bold text-slate-300">اسم الصنف <span className="text-rose-400">*</span><input required value={item.item_description} onChange={event => updateItem(index, 'item_description', event.target.value)} placeholder="اسم الصنف" className="mt-1.5 h-11 w-full rounded border border-slate-600 bg-[#0b1424] px-3 text-sm text-slate-100 outline-none focus:border-cyan-400" /></label>
                    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
                      <label className="block text-[11px] font-bold text-slate-300">الوحدة <span className="text-rose-400">*</span><select required value={item.uom} onChange={event => updateItem(index, 'uom', event.target.value)} className="mt-1.5 h-11 w-full min-w-0 rounded border border-slate-600 bg-[#0b1424] px-3 text-sm text-slate-100 outline-none focus:border-cyan-400">{UNIT_OPTIONS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</select></label>
                      <label className="block text-[11px] font-bold text-slate-300">الكمية <span className="text-rose-400">*</span><input required type="number" min="0" step="any" value={item.quantity ?? ''} onFocus={e => e.target.select()} onChange={event => updateItem(index, 'quantity', event.target.value === '' ? '' : Number(event.target.value))} className="mt-1.5 h-11 w-full rounded border border-slate-600 bg-[#0b1424] px-3 text-center font-mono text-sm text-slate-100 outline-none focus:border-cyan-400" /></label>
                      <label className="block text-[11px] font-bold text-slate-300">سعر الوحدة <span className="text-rose-400">*</span><input required type="number" min="0" step="any" value={item.unit_price ?? ''} onFocus={e => e.target.select()} onChange={event => updateItem(index, 'unit_price', event.target.value === '' ? '' : Number(event.target.value))} className="mt-1.5 h-11 w-full rounded border border-slate-600 bg-[#0b1424] px-3 text-center font-mono text-sm text-slate-100 outline-none focus:border-cyan-400" /></label>
                      <div className="rounded border border-emerald-500/30 bg-emerald-950/20 px-3 py-2.5"><span className="text-[11px] text-slate-400">إجمالي البند</span><p className="mt-1 font-mono text-sm font-black text-emerald-300">{formatCleanNumber((Number(item.quantity) || 0) * (Number(item.unit_price) || 0))} ج.م</p></div>
                    </div>
                    <label className="block text-[11px] font-bold text-slate-300">المنطقة <span className="text-rose-400">*</span><input required value={item.region} onChange={event => updateItem(index, 'region', event.target.value)} placeholder="المنطقة" className="mt-1.5 h-11 w-full rounded border border-slate-600 bg-[#0b1424] px-3 text-sm text-slate-100 outline-none focus:border-cyan-400" /></label>
                    <label className="block text-[11px] font-bold text-slate-300">المواصفات والتفاصيل<input value={item.specifications} onChange={event => updateItem(index, 'specifications', event.target.value)} placeholder="المواصفات" className="mt-1.5 h-11 w-full rounded border border-slate-600 bg-[#0b1424] px-3 text-sm text-slate-100 outline-none focus:border-cyan-400" /></label>
                  </div>
                </article>
              );
            })}
            </div>
          </div>
        </form>

        <div className="flex shrink-0 flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 border-t border-slate-600 bg-[#1b283b] px-3 py-3 sm:px-5">
          <button type="button" onClick={addItem} disabled={loading} className="w-full sm:w-auto min-h-[44px] sm:min-h-0 rounded-xl border border-slate-500 px-4 py-2 text-xs font-bold text-slate-200 hover:border-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-50">＋ إضافة صنف آخر</button>
          <div className="flex w-full sm:w-auto flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
            <button type="button" onClick={onClose} disabled={loading} className="w-full sm:w-auto min-h-[44px] sm:min-h-0 rounded-xl border border-slate-500 px-5 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50">إلغاء</button>
            <button
              type="submit"
              disabled={loading}
              onClick={handleSubmit}
              className="w-full sm:w-auto min-h-[44px] sm:min-h-0 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-xs font-black text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none transition-all cursor-pointer"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>جاري إرسال الطلب...</span>
                </>
              ) : (
                <span>إرسال طلب الشراء للحسابات  ▧</span>
              )}
            </button>
          </div>
        </div>
      </div>

      <ActionConfirmationModal
        isOpen={isConfirmModalOpen}
        onClose={() => setIsConfirmModalOpen(false)}
        onConfirm={executeDirectPo}
        isLoading={loading}
        title="مراجعة وتأكيد طلب الشراء المباشر"
        subtitle="أمر شراء مباشر"
        confirmLabel="حسناً، إرسال الطلب المباشر"
        cancelLabel="رجوع للتعديل"
        confirmVariant="success"
        documentType="DIRECT_PO"
        department={departments.find(d => String(d.id) === String(departmentId))?.name || '—'}
        supplierName={suppliers.find(s => String(s.id) === String(supplierId))?.company_name || oneTimeSupplierName.trim() || '—'}
        receiverName={siteEngineers.find(e => String(e.id) === String(siteEngineerId))?.name || '—'}
        totalAmount={grandTotal}
        tafqeetText={grandTotal > 0 ? tafqeetCurrency(grandTotal) : undefined}
        itemsCount={items.length}
        alerts={confirmationAlerts}
        promptQuestion="أنت على وشك إنشاء طلب شراء مباشر وإرساله إلى المدير التنفيذي والحسابات بالبيانات الموضحة أعلاه، هل ترغب في الاستمرار؟"
      />
    </div>
  ), document.body);
};

export default DirectPoModal;
