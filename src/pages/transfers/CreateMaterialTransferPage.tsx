import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import {
  createMaterialTransferApi,
  getMaterialTransferDetailsApi,
  updateMaterialTransferApi,
} from '../../api/materialTransfers';
import { MaterialTransferPayload, MaterialTransferRequest } from '../../types/materialTransfer';
import { PrintableMaterialTransfer } from '../../components/transfers/PrintableMaterialTransfer';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../utils/toast';
import { getPurchaseRequestReviewerOptionsApi } from '../../api/purchaseRequests';
import { ReviewerOption } from '../../types/purchaseRequest';

interface ItemRow {
  id?: number;
  item_description: string;
  uom: string;
  quantity: string;
  notes: string;
}

const COMMON_UOMS = [
  'طن',
  'م3',
  'عدد',
  'متر طولي',
  'لوح',
  'شيكارة',
  'لفة',
  'كجم',
  'لتر',
  'وحدة',
];

export const CreateMaterialTransferPage: React.FC = () => {
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { user } = useAuth();

  const isReviewer = Boolean(
    user?.roles?.some(r => {
      const slug = typeof r === 'string' ? r : (r as any)?.slug || (r as any)?.name;
      return ['reviewer', 'admin', 'general_manager'].includes(slug);
    })
  );

  const [loading, setLoading] = useState<boolean>(isEdit);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);

  // Form State
  const [transferDate, setTransferDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const [fromProject, setFromProject] = useState<string>('');
  const [toProject, setToProject] = useState<string>('');
  const [driverName, setDriverName] = useState<string>('');
  const [vehiclePlateNumber, setVehiclePlateNumber] = useState<string>('');
  const [generalNotes, setGeneralNotes] = useState<string>('');
  const [requestNumber, setRequestNumber] = useState<string>('');
  const [reviewerId, setReviewerId] = useState<string>('');
  const [reviewerOptions, setReviewerOptions] = useState<ReviewerOption[]>([]);

  // Non-reviewer requesters pick the reviewer who gets this request
  useEffect(() => {
    if (isReviewer) return;
    getPurchaseRequestReviewerOptionsApi()
      .then(setReviewerOptions)
      .catch(() => toast.error('تعذر تحميل قائمة المراجعين'));
  }, [isReviewer]);

  const [items, setItems] = useState<ItemRow[]>([
    { item_description: '', uom: 'طن', quantity: '', notes: '' },
  ]);

  // Load existing data if editing
  useEffect(() => {
    if (isEdit && id) {
      setLoading(true);
      getMaterialTransferDetailsApi(Number(id))
        .then(data => {
          setRequestNumber(data.request_number);
          setTransferDate(data.transfer_date ? data.transfer_date.split('T')[0] : '');
          setFromProject(data.from_project || '');
          setToProject(data.to_project || '');
          setDriverName(data.driver_name || '');
          setVehiclePlateNumber(data.vehicle_plate_number || '');
          setGeneralNotes(data.general_notes || '');
          setReviewerId(data.reviewer?.id ? String(data.reviewer.id) : '');

          if (data.items && data.items.length > 0) {
            setItems(
              data.items.map(it => ({
                id: it.id,
                item_description: it.item_description,
                uom: it.uom,
                quantity: String(it.quantity),
                notes: it.notes || '',
              }))
            );
          }
        })
        .catch(err => {
          toast.error(err?.response?.data?.message || 'تعذر تحميل بيانات الطلب');
          navigate('/material-transfers');
        })
        .finally(() => setLoading(false));
    }
  }, [isEdit, id, navigate]);

  const handleAddItem = () => {
    setItems(prev => [
      ...prev,
      { item_description: '', uom: 'طن', quantity: '', notes: '' },
    ]);
  };

  const handleRemoveItem = (index: number) => {
    if (items.length <= 1) {
      toast.error('يجب أن يحتوي الطلب على بند واحد على الأقل.');
      return;
    }
    setItems(prev => prev.filter((_, i) => i !== index));
  };

  const handleItemChange = (index: number, field: keyof ItemRow, value: string) => {
    setItems(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const validate = (isDraft: boolean): boolean => {
    if (!isDraft && !isReviewer && !reviewerId) {
      toast.error('اختار المراجع.');
      return false;
    }
    if (!transferDate) {
      toast.error('يرجى تحديد تاريخ النقل.');
      return false;
    }
    if (!fromProject.trim()) {
      toast.error('يرجى إدخال اسم المشروع المنقول منه.');
      return false;
    }
    if (!toProject.trim()) {
      toast.error('يرجى إدخال اسم المشروع المستلم.');
      return false;
    }
    if (fromProject.trim() === toProject.trim()) {
      toast.error('المشروع المنقول منه والمشروع المستلم يجب أن يكونا مختلفين.');
      return false;
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.item_description.trim()) {
        toast.error(`يرجى كتابة بيان الصنف / نوع الخامة للبند رقم ${i + 1}.`);
        return false;
      }
      if (!it.uom.trim()) {
        toast.error(`يرجى تحديد الوحدة للبند رقم ${i + 1}.`);
        return false;
      }
      const qty = parseFloat(it.quantity);
      if (isNaN(qty) || qty <= 0) {
        toast.error(`يرجى إدخال كمية صحيحة أكبر من صفر للبند رقم ${i + 1}.`);
        return false;
      }
    }

    return true;
  };

  const buildPayload = (isDraft: boolean): MaterialTransferPayload => {
    return {
      transfer_date: transferDate,
      from_project: fromProject.trim(),
      to_project: toProject.trim(),
      driver_name: driverName.trim() || undefined,
      vehicle_plate_number: vehiclePlateNumber.trim() || undefined,
      general_notes: generalNotes.trim() || undefined,
      reviewer_id: !isReviewer && reviewerId ? Number(reviewerId) : undefined,
      is_draft: isDraft,
      items: items.map(it => ({
        item_description: it.item_description.trim(),
        uom: it.uom.trim(),
        quantity: parseFloat(it.quantity),
        notes: it.notes.trim() || undefined,
      })),
    };
  };

  const handleSave = async (isDraft: boolean) => {
    if (!validate(isDraft)) return;

    setSubmitting(true);
    const payload = buildPayload(isDraft);

    try {
      if (isEdit && id) {
        await updateMaterialTransferApi(Number(id), payload);
        toast.success(
          isDraft
            ? '✅ تم حفظ تعديلات المسودة بنجاح.'
            : '🚀 تم تحديث وإرسال طلب نقل الخامات بنجاح.'
        );
      } else {
        const res = await createMaterialTransferApi(payload);
        toast.success(
          isDraft
            ? `✅ تم حفظ مسودة الطلب برقم (${res.request_number}).`
            : `🚀 تم إنشاء وإرسال طلب نقل الخامات بنجاح برقم (${res.request_number}).`
        );
      }
      navigate('/material-transfers');
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'حدث خطأ أثناء حفظ الطلب.');
    } finally {
      setSubmitting(false);
    }
  };

  // Preview Object
  const previewRequest: MaterialTransferRequest = {
    id: Number(id) || 0,
    request_number: requestNumber || 'MTR-NEW',
    transfer_date: transferDate,
    from_project: fromProject || 'مشروع أ',
    to_project: toProject || 'مشروع ب',
    driver_name: driverName || undefined,
    vehicle_plate_number: vehiclePlateNumber || undefined,
    status: isReviewer ? 'PENDING_ACCOUNTING' : 'PENDING_REVIEWER',
    status_label: isReviewer ? 'بانتظار الحسابات' : 'بانتظار المراجعة',
    general_notes: generalNotes,
    items: items.map((it, idx) => ({
      item_order: idx + 1,
      item_description: it.item_description || 'صنف افتراضي',
      uom: it.uom || 'وحدة',
      quantity: parseFloat(it.quantity) || 1,
      notes: it.notes,
    })),
    user: {
      id: user?.id || 1,
      name: user?.name || 'مقدم الطلب',
      email: user?.email || '',
    },
    created_at: new Date().toISOString(),
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-slate-400 gap-3" dir="rtl">
        <div className="w-10 h-10 border-4 border-amber-500/20 border-t-amber-500 rounded-full animate-spin" />
        <span className="text-sm font-bold">جاري تحميل بيانات طلب نقل الخامات...</span>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6" dir="rtl">
      {/* ── Breadcrumb & Top Bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
            <Link to="/material-transfers" className="hover:text-amber-400 transition-colors">
              طلبات نقل الخامات
            </Link>
            <span>/</span>
            <span className="text-amber-400 font-semibold">
              {isEdit ? `تعديل الطلب (${requestNumber})` : 'إنشاء طلب جديد'}
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2.5">
            <span className="p-2 bg-amber-500/10 text-amber-400 rounded-xl border border-amber-500/20 text-lg">
              🚚
            </span>
            <span>{isEdit ? `تعديل طلب نقل خامات (${requestNumber})` : 'إنشاء طلب نقل خامات جديد'}</span>
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white font-bold text-xs rounded-xl border border-slate-700 transition-all cursor-pointer shadow-sm active:scale-95"
          >
            <span>👁️</span>
            <span>معاينة النموذج الرسمي</span>
          </button>
          <Link
            to="/material-transfers"
            className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs font-semibold rounded-xl border border-slate-800 transition-colors"
          >
            إلغاء
          </Link>
        </div>
      </div>

      {/* ── Approval Workflow Path Notice Banner ── */}
      <div
        className={`p-4 rounded-2xl border text-xs leading-relaxed flex items-start gap-3 shadow-md ${
          isReviewer
            ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
            : 'bg-amber-950/30 border-amber-500/30 text-amber-200'
        }`}
      >
        <span className="text-xl shrink-0">{isReviewer ? '⚡' : 'ℹ️'}</span>
        <div className="space-y-1">
          <p className="font-bold text-sm">
            {isReviewer ? 'طلبك معتمد تلقائياً' : 'الطلب هيروح للمراجع اللي تختاره'}
          </p>
          <p className="text-slate-300">
            {isReviewer
              ? 'إنت مراجع، فالطلب هيتحول للحسابات على طول من غير مراجعة.'
              : 'المراجع اللي تختاره بس هو اللي يوافق أو يرفض أو يرجّع الطلب، وبعد موافقته يتحول للحسابات.'}
          </p>
        </div>
      </div>

      {/* ── Form Container ── */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 sm:p-7 shadow-xl space-y-6">
        
        {/* Section 1: Main Transfer Info */}
        <div>
          <h2 className="text-sm font-bold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800/80 pb-2">
            <span className="text-amber-400">1.</span>
            <span>بيانات المشروعات والتاريخ</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Transfer Date */}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                تاريخ النقل <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                value={transferDate}
                onChange={e => setTransferDate(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-amber-500 transition-colors"
                required
              />
            </div>

            {/* From Project */}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                من مشروع <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={fromProject}
                onChange={e => setFromProject(e.target.value)}
                placeholder="مثال: مشروع مروج - عمارة 14"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
                required
              />
            </div>

            {/* To Project */}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                إلى مشروع <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={toProject}
                onChange={e => setToProject(e.target.value)}
                placeholder="مثال: مشروع لؤلؤة - قطعة 18"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
                required
              />
            </div>

            {/* Reviewer (non-reviewer requesters only) */}
            {!isReviewer && (
              <div>
                <label htmlFor="mtr-reviewer" className="block text-xs font-bold text-slate-300 mb-1.5">
                  المراجع <span className="text-rose-500">*</span>
                </label>
                <select
                  id="mtr-reviewer"
                  value={reviewerId}
                  onChange={e => setReviewerId(e.target.value)}
                  className="w-full min-w-0 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-amber-500 transition-colors"
                  required
                >
                  <option value="">اختار المراجع</option>
                  {reviewerOptions.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Section 2: Driver & Vehicle Info */}
        <div>
          <h2 className="text-sm font-bold text-slate-200 mb-4 flex items-center gap-2 border-b border-slate-800/80 pb-2">
            <span className="text-amber-400">2.</span>
            <span>بيانات الناقل والمعدة</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Driver Name */}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                اسم السائق / الناقل
              </label>
              <input
                type="text"
                value={driverName}
                onChange={e => setDriverName(e.target.value)}
                placeholder="اسم السائق الثلاثي..."
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>

            {/* Vehicle Plate */}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                رقم السيارة / المعدة
              </label>
              <input
                type="text"
                value={vehiclePlateNumber}
                onChange={e => setVehiclePlateNumber(e.target.value)}
                placeholder="مثال: أ ب ج 1234 أو لودر كوماتسو"
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>
          </div>
        </div>

        {/* Section 3: Materials & Items Table */}
        <div>
          <div className="flex items-center justify-between mb-3 border-b border-slate-800/80 pb-2">
            <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <span className="text-amber-400">3.</span>
              <span>جدول الخامات المنقولة ({items.length} بند)</span>
            </h2>
            <button
              type="button"
              onClick={handleAddItem}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-xs font-bold transition-all cursor-pointer active:scale-95"
            >
              <span>➕</span>
              <span>إضافة بند جديد</span>
            </button>
          </div>

          <div className="space-y-3">
            {items.map((item, idx) => (
              <div
                key={idx}
                className="bg-slate-950/70 border border-slate-800 rounded-xl p-3.5 space-y-3 relative group transition-colors hover:border-slate-700"
              >
                <div className="flex items-center justify-between gap-2 border-b border-slate-800/60 pb-2 text-xs">
                  <span className="font-bold text-amber-400 flex items-center gap-1.5">
                    <span className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center text-[11px]">
                      {idx + 1}
                    </span>
                    <span>البند رقم {idx + 1}</span>
                  </span>
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(idx)}
                      className="text-rose-400 hover:text-rose-300 text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                      title="حذف هذا البند"
                    >
                      <span>🗑️</span>
                      <span>حذف</span>
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  {/* Description */}
                  <div className="sm:col-span-6">
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      نوع الخامة / بيان الصنف <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={item.item_description}
                      onChange={e => handleItemChange(idx, 'item_description', e.target.value)}
                      placeholder="مثال: حديد تسليح 12 مم، أسمنت بورتلاندي..."
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                      required
                    />
                  </div>

                  {/* UOM */}
                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      الوحدة <span className="text-rose-500">*</span>
                    </label>
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={item.uom}
                        onChange={e => handleItemChange(idx, 'uom', e.target.value)}
                        placeholder="طن، م3..."
                        list={`uom-list-${idx}`}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white focus:outline-none focus:border-amber-500"
                        required
                      />
                      <datalist id={`uom-list-${idx}`}>
                        {COMMON_UOMS.map(u => (
                          <option key={u} value={u} />
                        ))}
                      </datalist>
                    </div>
                  </div>

                  {/* Quantity */}
                  <div className="sm:col-span-3">
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      العدد / الكمية <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0.01"
                      value={item.quantity}
                      onChange={e => handleItemChange(idx, 'quantity', e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono font-bold focus:outline-none focus:border-amber-500"
                      required
                    />
                  </div>

                  {/* Notes / Material Condition */}
                  <div className="sm:col-span-12">
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      ملاحظات / حالة الخامة
                    </label>
                    <input
                      type="text"
                      value={item.notes}
                      onChange={e => handleItemChange(idx, 'notes', e.target.value)}
                      placeholder="مثال: بحالة جيدة خالي من الصدأ، متبقي من صب السقف..."
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Section 4: General Notes */}
        <div>
          <label className="block text-xs font-bold text-slate-300 mb-1.5">
            ملاحظات عامة على الطلب
          </label>
          <textarea
            rows={2}
            value={generalNotes}
            onChange={e => setGeneralNotes(e.target.value)}
            placeholder="أي توجيهات إضافية أو تعليمات خاصة بالاستلام أو النقل..."
            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition-colors resize-none"
          />
        </div>

        {/* ── Submit Action Buttons ── */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-slate-800">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="w-full sm:w-auto px-5 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white font-bold text-xs rounded-xl border border-slate-700 transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            <span>🖨️</span>
            <span>معاينة النموذج الرسمي المطبوع</span>
          </button>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              type="button"
              disabled={submitting}
              onClick={() => handleSave(true)}
              className="flex-1 sm:flex-none px-5 py-3 bg-slate-800 hover:bg-slate-700 text-amber-300 hover:text-amber-200 font-bold text-xs rounded-xl border border-slate-700 transition-all cursor-pointer disabled:opacity-50 active:scale-95 flex items-center justify-center gap-1.5"
            >
              <span>💾</span>
              <span>حفظ كمسودة</span>
            </button>

            <button
              type="button"
              disabled={submitting}
              onClick={() => handleSave(false)}
              className="flex-1 sm:flex-none px-7 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all cursor-pointer disabled:opacity-50 active:scale-95 flex items-center justify-center gap-2"
            >
              <span>🚀</span>
              <span>{isEdit ? 'تحديث وإرسال الطلب' : 'إرسال الطلب للاعتماد'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Printable Preview Modal ── */}
      {previewOpen && (
        <Modal
          isOpen={previewOpen}
          onClose={() => setPreviewOpen(false)}
          title="معاينة النموذج الرسمي لطلب نقل الخامات"
          size="2xl"
        >
          <PrintableMaterialTransfer
            request={previewRequest}
            onClose={() => setPreviewOpen(false)}
          />
        </Modal>
      )}
    </div>
  );
};
