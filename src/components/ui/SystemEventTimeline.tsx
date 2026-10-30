import React, { useEffect, useState } from 'react';
import {
  getPurchaseOrderEventsApi,
  getPurchaseRequestEventsApi,
  SystemEvent,
} from '../../api/systemEvents';
import { Card } from './Card';
import { TableSkeleton } from './StateFeedback';
import ErrorMessage from '../ErrorMessage';
import { parseApiError } from '../../utils/apiError';
import { PR_ACTION_LABELS, PR_STATUS_LABELS } from '../../types/purchaseRequest';

interface Props {
  entity: 'purchase_request' | 'purchase_order';
  entityId: number;
  title?: string;
  defaultCollapsed?: boolean;
}

const ACTION_LABELS: Record<string, string> = {
  CREATED: 'إنشاء السجل',
  UPDATED: 'تعديل البيانات',
  DELETED: 'حذف أو إلغاء السجل',
  PR_SUBMITTED: 'إرسال طلب الشراء',
  REVIEW_STARTED: 'بدء المراجعة',
  APPROVED_BY_REVIEWER: 'اعتماد رئيس القسم',
  REJECTED_BY_REVIEWER: 'رفض رئيس القسم',
  PO_CREATED: 'إنشاء أمر الشراء',
  PO_ISSUED: 'إصدار أمر الشراء',
  FAST_TRACK_PRICING_SKIPPED_PRELIMINARY: 'تسعير مباشر وتخطي الاعتماد المبدئي',
  DIRECT_EXECUTIVE_REVIEW_REQUIRED: 'تسعير المشتريات وإرساله للمدير التنفيذي',
  APPROVED_BY_REVIEWER_FAST_TRACK: 'اعتماد رئيس القسم (مسار سريع)',
};

const formatDateTime = (event: SystemEvent) => {
  if (event.occurred_at) {
    return new Intl.DateTimeFormat('ar-EG', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(event.occurred_at));
  }
  return [event.date, event.time].filter(Boolean).join(' — ') || 'غير محدد';
};

const stateLabel = (state?: string | null) => {
  if (!state) return null;
  const labels: Record<string, string> = {
    DRAFT: 'مسودة', SUBMITTED: 'مُرسل للمراجعة', UNDER_REVIEW: 'قيد المراجعة',
    PENDING_PROCUREMENT_APPROVAL: 'بانتظار اعتماد المشتريات',
    APPROVED_BY_REVIEWER: 'اعتماد رئيس القسم', APPROVED_BY_PROCUREMENT: 'معتمد من المشتريات',
    PO_DRAFT: 'مسودة أمر شراء', ISSUED: 'صادر', REJECTED: 'مرفوض',
  };
  return labels[state] || PR_STATUS_LABELS[state as keyof typeof PR_STATUS_LABELS] || state;
};

export const SystemEventTimeline: React.FC<Props> = ({
  entity,
  entityId,
  title = 'السجل الزمني للأحداث',
  defaultCollapsed = true,
}) => {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const loader = entity === 'purchase_request'
      ? getPurchaseRequestEventsApi(entityId)
      : getPurchaseOrderEventsApi(entityId);
    loader.then((data) => {
      if (active) setEvents(data);
    }).catch((err) => {
      if (active) setError(parseApiError(err).message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [entity, entityId]);

  const transitionEvents = events.filter((event) => Boolean(event.from_state || event.to_state));

  return (
    <div dir="rtl">
      <Card className="p-3.5 space-y-3">
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm">⏱️</span>
          <h2 className="text-xs font-black text-slate-200">{title}</h2>
          {transitionEvents.length > 0 && (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-400">
              {transitionEvents.length} أحداث
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-xs font-bold text-gold-400 hover:text-gold-300 flex items-center gap-1 cursor-pointer transition-colors"
        >
          <span>{isExpanded ? 'طي السجل ▲' : 'عرض السجل الزمني ▼'}</span>
        </button>
      </div>

      <div
        className={`transition-all duration-300 ease-in-out overflow-hidden ${
          isExpanded
            ? 'max-h-[1200px] opacity-100 pt-2 border-t border-white/10 space-y-3'
            : 'max-h-0 opacity-0 pt-0 border-t-0 pointer-events-none'
        }`}
      >
        <p className="text-[11px] text-slate-400">مسار انتقال حالة الطلب فقط — كل مرحلة مكتملة عليها علامة صح.</p>
        {loading && <TableSkeleton rows={3} columns={3} message="جاري تحميل سجل الأحداث الزمني..." />}
        {!loading && error && <ErrorMessage error={error} />}
        {!loading && !error && transitionEvents.length === 0 && (
          <p className="text-xs text-slate-500">لا توجد انتقالات حالة مسجلة لهذا السجل حتى الآن.</p>
        )}
        {!loading && !error && transitionEvents.length > 0 && (
          <div className="relative space-y-3 before:absolute before:right-[7px] before:top-2 before:h-[calc(100%-8px)] before:w-px before:bg-white/10">
            {transitionEvents.map((event) => (
              <div key={event.id} className="relative pr-7">
                <span className="absolute right-0 top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-4 border-slate-900 bg-emerald-400 text-[8px] font-black text-slate-950 shadow-sm">✓</span>
                <div className="flex flex-col gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-3 shadow-inner">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-black text-gold-300">{ACTION_LABELS[event.action] || PR_ACTION_LABELS[event.action] || event.action}</span>
                    <time className="text-[10px] font-semibold text-slate-500" dir="ltr">{formatDateTime(event)}</time>
                  </div>
                  <div className="text-[11px] text-slate-300">المنفذ: <span className="font-bold text-slate-100">{event.actor?.name || 'النظام'}</span></div>
                  {event.description && <p className="text-xs leading-5 text-slate-400">{event.description}</p>}
                  {(event.from_state || event.to_state) && event.from_state !== event.to_state && (
                    <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold">
                      {event.from_state && <span className="rounded-md bg-white/[0.05] border border-white/10 px-2 py-0.5 text-slate-300">من: {stateLabel(event.from_state)}</span>}
                      {event.to_state && <span className="rounded-md bg-gold-950/80 border border-gold-500/40 px-2 py-0.5 text-gold-300">إلى: {stateLabel(event.to_state)}</span>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </Card>
    </div>
  );
};

export default SystemEventTimeline;
