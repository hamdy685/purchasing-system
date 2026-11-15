import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getGuestOfficeFormApi,
  submitGuestOfficeRequestApi,
  type GuestDepartmentOption,
  type GuestOfficeRequestItem,
} from '../../api/guestOfficeRequests';
import { Button } from '../../components/ui/Button';
import { FormField, Input, Select, Textarea } from '../../components/ui/FormField';
import { parseApiError } from '../../utils/apiError';
import { DEFAULT_PR_UNIT_CODES, getUnitOptions } from '../../utils/units';

const UNIT_OPTIONS = getUnitOptions(DEFAULT_PR_UNIT_CODES);
const emptyItem = (): GuestOfficeRequestItem => ({ item_description: '', quantity: 1, uom: 'PCS' });

/**
 * Public office-supplies request form (no sign-in), opened from the shared link.
 */
const GuestOfficeRequestPage: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const [departments, setDepartments] = useState<GuestDepartmentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [linkInvalid, setLinkInvalid] = useState(false);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<GuestOfficeRequestItem[]>([emptyItem()]);
  const [website, setWebsite] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [sentNumber, setSentNumber] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getGuestOfficeFormApi(token)
      .then((list) => {
        if (active) setDepartments(list);
      })
      .catch(() => {
        if (active) setLinkInvalid(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  const updateItem = (index: number, patch: Partial<GuestOfficeRequestItem>) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const fieldError = (key: string) => fieldErrors[key]?.[0];

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const result = await submitGuestOfficeRequestApi(token, {
        name,
        phone: phone || undefined,
        target_department_id: Number(departmentId),
        notes,
        items: items.map((item) => ({ ...item, quantity: item.quantity === '' ? 0 : Number(item.quantity) })),
        website,
      });
      setSentNumber(result?.request_number ?? '');
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message || 'تعذر إرسال الطلب، حاول مرة أخرى.');
      setFieldErrors(parsed.errors ?? {});
    } finally {
      setSubmitting(false);
    }
  };

  const startNew = () => {
    setItems([emptyItem()]);
    setNotes('');
    setSentNumber(null);
    setError(null);
    setFieldErrors({});
  };

  return (
    <div dir="rtl" className="min-h-[100dvh] w-full bg-[#080b14] px-4 py-6 text-right text-slate-100">
      <div className="mx-auto w-full min-w-0 max-w-xl space-y-4">
        <header className="flex items-center gap-3">
          <img src="/eshbelia-logo.png" alt="" className="h-10 w-10 shrink-0 rounded-xl" />
          <div className="min-w-0">
            <h1 className="text-base font-black">طلب مستلزمات مكتبية</h1>
            <p className="text-xs text-slate-400">اشبيلية · يروح لمراجع قسمك</p>
          </div>
        </header>

        {loading ? (
          <p className="text-sm text-slate-400">جاري التحميل...</p>
        ) : linkInvalid ? (
          <div className="rounded-xl border border-rose-700/60 bg-rose-950/40 p-4 text-sm text-rose-200">
            اللينك ده مش شغال أو اتغيّر. اطلب اللينك الجديد من الإدارة.
          </div>
        ) : sentNumber !== null ? (
          <div className="space-y-3 rounded-xl border border-emerald-700/60 bg-emerald-950/40 p-4 text-sm">
            <p className="font-bold text-emerald-200">تم إرسال طلبك لمراجع القسم.</p>
            {sentNumber && (
              <p className="text-emerald-100">
                رقم الطلب: <span className="font-mono font-bold">{sentNumber}</span>
              </p>
            )}
            <Button type="button" variant="primary" onClick={startNew} className="w-full justify-center">
              طلب جديد
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/90 p-3.5">
              <FormField label="اسمك" required error={fieldError('name')}>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
              </FormField>
              <FormField label="رقم الموبايل" helperText="اختياري" error={fieldError('phone')}>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" maxLength={30} />
              </FormField>
              <FormField label="القسم التابع له" required error={fieldError('target_department_id')}>
                <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">اختر القسم</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="الغرض من الشراء" required error={fieldError('notes')}>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
              </FormField>
            </section>

            <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/90 p-3.5">
              <h2 className="text-sm font-black">الأصناف</h2>
              {fieldError('items') && <p className="text-xs font-bold text-rose-400">{fieldError('items')}</p>}
              {items.map((item, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-cyan-300">صنف {index + 1}</span>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                        className="text-xs text-rose-300 underline"
                      >
                        حذف
                      </button>
                    )}
                  </div>
                  <FormField label="الصنف" required error={fieldError(`items.${index}.item_description`)}>
                    <Input
                      value={item.item_description}
                      onChange={(e) => updateItem(index, { item_description: e.target.value })}
                      placeholder="مثال: ورق تصوير A4"
                      maxLength={500}
                    />
                  </FormField>
                  <div className="grid grid-cols-2 gap-2">
                    <FormField label="الكمية" required error={fieldError(`items.${index}.quantity`)}>
                      <Input
                        type="number"
                        min="0.01"
                        step="any"
                        inputMode="decimal"
                        value={item.quantity}
                        onChange={(e) => updateItem(index, { quantity: e.target.value === '' ? '' : Number(e.target.value) })}
                      />
                    </FormField>
                    <FormField label="الوحدة">
                      <Select value={item.uom} onChange={(e) => updateItem(index, { uom: e.target.value })}>
                        {UNIT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                onClick={() => setItems((prev) => [...prev, emptyItem()])}
                className="w-full justify-center border-dashed text-xs"
              >
                + إضافة صنف
              </Button>
            </section>

            {/* Hidden from people; bots that fill every field are ignored by the server. */}
            <input
              type="text"
              name="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
            />

            {error && (
              <div role="alert" className="rounded-xl border border-rose-700/60 bg-rose-950/40 p-3 text-xs text-rose-200">
                {error}
              </div>
            )}

            <Button type="submit" variant="primary" isLoading={submitting} disabled={submitting} className="w-full justify-center py-3 text-sm font-bold">
              إرسال الطلب
            </Button>
          </form>
        )}
      </div>
    </div>
  );
};

export default GuestOfficeRequestPage;
