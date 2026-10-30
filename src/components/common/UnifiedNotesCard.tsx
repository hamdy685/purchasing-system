import React, { useState } from 'react';
import { PurchaseRequest, ApprovalHistoryEntry } from '../../types/purchaseRequest';
import { PurchaseOrder } from '../../types/purchaseOrder';
import { Card } from '../ui/Card';
import { getUnitLabel } from '../../utils/units';

export interface UnifiedNotesCardProps {
  request?: PurchaseRequest | null;
  purchaseOrder?: PurchaseOrder | null;
  title?: string;
  className?: string;
  compact?: boolean;
}

interface ExtractedNote {
  id: string;
  category: 'requester' | 'reviewer' | 'executive' | 'procurement' | 'accounting' | 'quotes' | 'receipt';
  authorName?: string;
  authorRole?: string;
  badgeLabel: string;
  badgeColor: string;
  date?: string | null;
  content: string;
  extraMeta?: string;
}

const ACTION_MAPPING: Record<string, { label: string; category: ExtractedNote['category']; color: string }> = {
  CREATED: { label: 'إنشاء الطلب', category: 'requester', color: 'bg-slate-800 text-slate-300 border-slate-700' },
  SUBMITTED: { label: 'إرسال للمراجعة', category: 'requester', color: 'bg-cyan-950/80 text-cyan-300 border-cyan-800' },
  REVIEW_STARTED: { label: 'بدء المراجعة', category: 'reviewer', color: 'bg-indigo-950/80 text-indigo-300 border-indigo-800' },
  HEADER_UPDATED: { label: 'تعديل البيانات', category: 'reviewer', color: 'bg-indigo-950/80 text-indigo-300 border-indigo-800' },
  ITEM_UPDATED: { label: 'تعديل بند', category: 'reviewer', color: 'bg-indigo-950/80 text-indigo-300 border-indigo-800' },
  ITEM_ADDED: { label: 'إضافة بند', category: 'reviewer', color: 'bg-indigo-950/80 text-indigo-300 border-indigo-800' },
  ITEM_REMOVED: { label: 'حذف بند', category: 'reviewer', color: 'bg-indigo-950/80 text-indigo-300 border-indigo-800' },
  APPROVED_BY_REVIEWER: { label: 'اعتماد رئيس القسم', category: 'reviewer', color: 'bg-emerald-950/80 text-emerald-300 border-emerald-800' },
  REJECTED_BY_REVIEWER: { label: 'رفض رئيس القسم', category: 'reviewer', color: 'bg-rose-950/80 text-rose-300 border-rose-800' },
  APPROVED_BY_EXECUTIVE: { label: 'اعتماد المدير العام', category: 'executive', color: 'bg-amber-950/80 text-amber-300 border-amber-800' },
  EXECUTIVE_REJECTED: { label: 'رفض المدير العام', category: 'executive', color: 'bg-rose-950/80 text-rose-300 border-rose-800' },
  EDITED_BY_EXECUTIVE: { label: 'تعديل المدير العام', category: 'executive', color: 'bg-amber-950/80 text-amber-300 border-amber-800' },
  EXECUTIVE_SELECTED_QUOTE: { label: 'ترسية العرض', category: 'executive', color: 'bg-amber-950/80 text-amber-300 border-amber-800' },
  EXECUTIVE_REJECTED_QUOTES: { label: 'رفض العروض', category: 'executive', color: 'bg-rose-950/80 text-rose-300 border-rose-800' },
  THREE_QUOTES_REQUIRED: { label: 'طلب عروض أسعار', category: 'procurement', color: 'bg-cyan-950/80 text-cyan-300 border-cyan-800' },
  THREE_QUOTES_SUBMITTED: { label: 'تقديم العروض', category: 'procurement', color: 'bg-cyan-950/80 text-cyan-300 border-cyan-800' },
  DIRECT_PURCHASE_REQUEST_CREATED: { label: 'شراء مباشر', category: 'procurement', color: 'bg-cyan-950/80 text-cyan-300 border-cyan-800' },
  PO_CREATED: { label: 'إنشاء أمر شراء', category: 'procurement', color: 'bg-cyan-950/80 text-cyan-300 border-cyan-800' },
  PO_ISSUED: { label: 'إصدار أمر الشراء', category: 'procurement', color: 'bg-emerald-950/80 text-emerald-300 border-emerald-800' },
  ACCOUNTING_APPROVED_DIRECT: { label: 'اعتماد الحسابات', category: 'accounting', color: 'bg-blue-950/80 text-blue-300 border-blue-800' },
  APPROVED_BY_ACCOUNTING: { label: 'اعتماد الحسابات', category: 'accounting', color: 'bg-blue-950/80 text-blue-300 border-blue-800' },
  REJECTED: { label: 'رفض الطلب', category: 'reviewer', color: 'bg-rose-950/80 text-rose-300 border-rose-800' },
  WAREHOUSE_RECEIPT_APPROVED: { label: 'استلام المخزن', category: 'receipt', color: 'bg-teal-950/80 text-teal-300 border-teal-800' },
  SITE_ENGINEER_APPROVED: { label: 'اعتماد المهندس', category: 'receipt', color: 'bg-teal-950/80 text-teal-300 border-teal-800' },
};

const CATEGORY_ICONS: Record<ExtractedNote['category'], string> = {
  requester: '👤',
  reviewer: '🔍',
  executive: '👑',
  procurement: '💼',
  accounting: '📊',
  quotes: '🏷️',
  receipt: '🏢',
};

export const UnifiedNotesCard: React.FC<UnifiedNotesCardProps> = ({
  request,
  purchaseOrder,
  title = 'ملاحظات وتوجيهات الطلب',
  className = '',
}) => {
  const [selectedFilter, setSelectedFilter] = useState<string>('ALL');

  const notesList: ExtractedNote[] = [];
  const pr = request || (purchaseOrder?.purchase_request as PurchaseRequest | undefined);
  const po = purchaseOrder;

  // 1. Requester Header Notes & Justification
  if (pr?.notes && pr.notes.trim()) {
    notesList.push({
      id: 'pr-notes',
      category: 'requester',
      authorName: pr.requester?.name || 'مقدم الطلب',
      authorRole: 'مقدم الطلب',
      badgeLabel: 'ملاحظات الطلب',
      badgeColor: 'bg-slate-800 text-slate-300 border-slate-700',
      date: pr.created_at,
      content: pr.notes,
    });
  }

  if (pr?.justification && pr.justification.trim() && pr.justification.trim() !== pr.notes?.trim()) {
    notesList.push({
      id: 'pr-justification',
      category: 'requester',
      authorName: pr.requester?.name || 'مقدم الطلب',
      authorRole: 'مبررات الاحتياج',
      badgeLabel: 'مبررات الشراء',
      badgeColor: 'bg-cyan-950/80 text-cyan-300 border-cyan-800',
      date: pr.created_at,
      content: pr.justification,
    });
  }

  // 2. Item notes (specifications already show in the items table)
  const items = pr?.items || po?.items || [];
  items.forEach((item, idx) => {
    const itemNum = idx + 1;
    const hasItemNotes = Boolean('notes' in item && item.notes && (item.notes as string).trim());

    if (hasItemNotes) {
      const parts: string[] = [`ملاحظة: ${(item as any).notes}`];

      const metaParts: string[] = [];
      if (item.item_reference) metaParts.push(`قطعة: ${item.item_reference}`);
      if (item.region) metaParts.push(`منطقة: ${item.region}`);
      if (item.quantity) metaParts.push(`كمية: ${item.quantity} ${getUnitLabel(item.uom)}`);

      notesList.push({
        id: `pr-item-${item.id || idx}`,
        category: 'requester',
        authorName: pr?.requester?.name || 'مقدم الطلب',
        authorRole: `بند #${itemNum}: ${item.item_description}`,
        badgeLabel: `بند #${itemNum}`,
        badgeColor: 'bg-indigo-950/80 text-indigo-300 border-indigo-800',
        date: pr?.created_at,
        content: parts.join(' | '),
        extraMeta: metaParts.join(' · '),
      });
    }
  });

  // 3. Notes people typed on approval actions (system default texts never show here)
  const history: ApprovalHistoryEntry[] = pr?.approval_history || (po?.approval_history as any) || [];
  history.forEach((entry, idx) => {
    if (entry.user_note && entry.user_note.trim()) {
      const mapping = ACTION_MAPPING[entry.action] || {
        label: 'ملاحظة',
        category: 'reviewer' as const,
        color: 'bg-slate-800 text-slate-300 border-slate-700',
      };

      notesList.push({
        id: `history-${idx}`,
        category: mapping.category,
        authorName: entry.actor?.name || 'المسؤول',
        authorRole: (entry.actor as any)?.role || undefined,
        badgeLabel: mapping.label,
        badgeColor: mapping.color,
        date: entry.created_at,
        content: entry.user_note,
      });
    }
  });

  // 4. Rejection or Return Reason
  if (pr?.rejection_reason && pr.rejection_reason.trim() && !notesList.some(n => n.content.includes(pr.rejection_reason!))) {
    notesList.push({
      id: 'pr-rejection-reason',
      category: 'reviewer',
      authorName: pr.assigned_reviewer?.name || 'المراجع',
      authorRole: 'سبب الرفض',
      badgeLabel: 'سبب الرفض',
      badgeColor: 'bg-rose-950/80 text-rose-300 border-rose-800',
      date: pr.updated_at,
      content: pr.rejection_reason,
    });
  }

  // 5. Quotation Notes and Recommendations
  const quotes = pr?.quotes || [];
  quotes.forEach((quote, qIdx) => {
    const supplierName = quote.supplier?.company_name || `مورد #${quote.supplier_id || qIdx + 1}`;

    if (quote.notes && quote.notes.trim()) {
      notesList.push({
        id: `quote-notes-${quote.id || qIdx}`,
        category: 'quotes',
        authorName: supplierName,
        authorRole: 'عرض المورد',
        badgeLabel: 'شروط العرض',
        badgeColor: 'bg-amber-950/80 text-amber-300 border-amber-800',
        date: quote.created_at,
        content: quote.notes,
        extraMeta: `المورد: ${supplierName} (${parseFloat(quote.total_amount || '0').toLocaleString()} ${quote.currency || 'EGP'})`,
      });
    }

    if (quote.recommendations && quote.recommendations.length > 0) {
      quote.recommendations.forEach((rec, rIdx) => {
        if (rec.comment && rec.comment.trim()) {
          const isAcc = rec.role_type === 'ACCOUNTING';
          const recRole = isAcc ? 'الحسابات' : 'مدير القسم';
          const recDecision = rec.decision === 'RECOMMEND' ? 'مرشح للموافقة' : 'متحفظ عليه';

          notesList.push({
            id: `quote-rec-${quote.id}-${rec.id || rIdx}`,
            category: isAcc ? 'accounting' : 'reviewer',
            authorName: rec.user?.name || (isAcc ? 'الحسابات' : 'مدير القسم'),
            authorRole: `ترشيح ${recRole}`,
            badgeLabel: `ترشيح ${recRole} (${recDecision})`,
            badgeColor: isAcc ? 'bg-blue-950/80 text-blue-300 border-blue-800' : 'bg-indigo-950/80 text-indigo-300 border-indigo-800',
            content: rec.comment,
            extraMeta: `المورد: ${supplierName}`,
          });
        }
      });
    }
  });

  // 6. Purchase Order Notes
  if (po) {
    if (po.notes && po.notes.trim()) {
      notesList.push({
        id: 'po-notes',
        category: 'procurement',
        authorName: po.created_by?.name || 'المشتريات',
        authorRole: 'أمر الشراء',
        badgeLabel: 'ملاحظات PO',
        badgeColor: 'bg-cyan-950/80 text-cyan-300 border-cyan-800',
        date: po.created_at,
        content: po.notes,
      });
    }

    if (po.delivery_notes && po.delivery_notes.trim()) {
      notesList.push({
        id: 'po-delivery-notes',
        category: 'procurement',
        authorName: po.created_by?.name || 'المشتريات',
        authorRole: 'تعليمات التوريد',
        badgeLabel: 'شروط التسليم',
        badgeColor: 'bg-emerald-950/80 text-emerald-300 border-emerald-800',
        date: po.created_at,
        content: po.delivery_notes,
      });
    }

    if (po.financial_notes && po.financial_notes.trim()) {
      notesList.push({
        id: 'po-financial-notes',
        category: 'accounting',
        authorName: po.accounting_reviewer?.name || 'الحسابات',
        authorRole: 'الملاحظات المالية',
        badgeLabel: 'مالية PO',
        badgeColor: 'bg-blue-950/80 text-blue-300 border-blue-800',
        date: po.updated_at,
        content: po.financial_notes,
      });
    }

    if (po.payment_terms && po.payment_terms.trim()) {
      notesList.push({
        id: 'po-payment-terms',
        category: 'procurement',
        authorName: po.created_by?.name || 'المشتريات',
        authorRole: 'شروط الدفع',
        badgeLabel: 'شروط السداد',
        badgeColor: 'bg-slate-800 text-slate-300 border-slate-700',
        date: po.created_at,
        content: po.payment_terms,
      });
    }
  }

  // 7. Receipts Notes
  if (pr?.purchase_orders) {
    pr.purchase_orders.forEach((poItem) => {
      poItem.receipts?.forEach((receipt, rIdx) => {
        if (receipt.receiver_notes && receipt.receiver_notes.trim()) {
          notesList.push({
            id: `receipt-notes-${receipt.id || rIdx}`,
            category: 'receipt',
            authorName: 'مسؤول الاستلام بالموقع',
            authorRole: receipt.receipt_type === 'SITE' ? 'مهندس الموقع' : 'أمين المخزن',
            badgeLabel: `استلام #${receipt.receipt_number}`,
            badgeColor: 'bg-teal-950/80 text-teal-300 border-teal-800',
            date: receipt.received_at,
            content: receipt.receiver_notes,
          });
        }
      });
    });
  }

  // If no notes exist at all, don't show the card to keep pages clean and minimal
  if (notesList.length === 0) {
    return null;
  }

  const filteredNotes = selectedFilter === 'ALL'
    ? notesList
    : notesList.filter(n => n.category === selectedFilter);

  return (
    <Card className={`border border-slate-800 bg-slate-950/60 p-3 sm:p-4 rounded-xl text-right space-y-2.5 ${className}`}>
      {/* Clean Minimal Header */}
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">📝</span>
          <h4 className="text-xs font-bold text-slate-200">{title}</h4>
          <span className="rounded-full bg-slate-800 border border-slate-700 px-1.5 py-0.2 text-[10px] font-mono text-cyan-300 font-bold">
            {notesList.length}
          </span>
        </div>

        {/* Minimal Category Tabs (only if more than 3 notes from different categories) */}
        {notesList.length > 3 && (
          <div className="flex items-center gap-1 text-[10px]">
            <button
              type="button"
              onClick={() => setSelectedFilter('ALL')}
              className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                selectedFilter === 'ALL'
                  ? 'bg-cyan-500 text-slate-950 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              الكل
            </button>
            {['requester', 'reviewer', 'executive', 'procurement', 'accounting', 'quotes', 'receipt'].map((catKey) => {
              const count = notesList.filter(n => n.category === catKey).length;
              if (count === 0) return null;
              return (
                <button
                  key={catKey}
                  type="button"
                  onClick={() => setSelectedFilter(catKey)}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    selectedFilter === catKey
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {CATEGORY_ICONS[catKey as ExtractedNote['category']]}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Simple, Compact Notes List */}
      <div className="space-y-2">
        {filteredNotes.map((note) => {
          const icon = CATEGORY_ICONS[note.category] || '📝';

          return (
            <div
              key={note.id}
              className="rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5 text-xs space-y-1.5 hover:border-slate-700 transition-colors"
            >
              {/* Note Header */}
              <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs shrink-0">{icon}</span>
                  <strong className="text-slate-200">{note.authorName}</strong>
                  {note.authorRole && (
                    <span className="text-slate-400 text-[10px]">({note.authorRole})</span>
                  )}
                  {note.extraMeta && (
                    <span className="text-[10px] text-slate-400 font-mono">[{note.extraMeta}]</span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${note.badgeColor}`}>
                    {note.badgeLabel}
                  </span>
                  {note.date && (
                    <time className="text-[9px] font-mono text-slate-500">
                      {new Date(note.date).toLocaleDateString('ar-EG')}
                    </time>
                  )}
                </div>
              </div>

              {/* Note Content */}
              <div className="rounded-md bg-slate-950/80 p-2 text-slate-200 text-xs leading-relaxed whitespace-pre-wrap font-sans border border-slate-800/60">
                {note.content}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

export default UnifiedNotesCard;
