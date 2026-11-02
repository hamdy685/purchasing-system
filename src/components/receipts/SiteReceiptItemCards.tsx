import React, { useState } from 'react';
import { ReceiptRecord } from '../../api/purchaseReceipts';
import { getUnitLabel } from '../../utils/units';
import { formatCleanQty } from '../../utils/numberFormat';
import { SupplementItemBadge } from '../common/SupplementItemBadge';

export interface SiteReceiptItemCardsProps {
  receipt: ReceiptRecord;
  quantities: Record<string, string>;
  onQuantityChange: (key: string, value: string) => void;
  itemNotes: Record<string, string>;
  onItemNoteChange: (key: string, value: string) => void;
  /** State key for one line; defaults to `receipt-{receiptId}-{itemId}` */
  keyOf?: (itemId: number) => string;
}

/**
 * One simple card per receipt line for the site engineer / reviewer / office
 * requester: name, what the PO ordered, what arrived, and one big quantity field.
 */
export const SiteReceiptItemCards: React.FC<SiteReceiptItemCardsProps> = ({
  receipt,
  quantities,
  onQuantityChange,
  itemNotes,
  onItemNoteChange,
  keyOf,
}) => {
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  const items = receipt.items || [];

  if (items.length === 0) {
    return <p className="text-center text-xs text-slate-400">لا توجد بنود في هذا الإذن</p>;
  }

  const arrivedLabel = receipt.receipt_type === 'SITE_DIRECT' || receipt.receipt_type === 'REQUESTER_OFFICE' ? 'الوارد' : 'استلام المخزن';

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const key = keyOf ? keyOf(item.id) : `receipt-${receipt.id}-${item.id}`;
        const poItem = item.purchase_order_item;
        const prItem = poItem?.pr_item;
        const name = poItem?.item_description || poItem?.item?.name || 'بند استلام';
        const uom = getUnitLabel(prItem?.uom || poItem?.uom || '') || prItem?.uom || poItem?.uom || '';

        // The PR may use a different unit than the PO: show the arrived amount in the PR unit.
        const poQty = Number(poItem?.quantity || 0);
        const prQty = Number(prItem?.quantity || 0);
        const isDiffUom = Boolean(prItem?.uom && poItem?.uom && prItem.uom !== poItem.uom && poQty > 0 && prQty > 0);
        const arrived = isDiffUom
          ? Number(item.received_quantity) > poQty * 2
            ? Number(item.received_quantity)
            : Math.round(Number(item.received_quantity) * (prQty / poQty))
          : item.received_quantity;

        const val = quantities[key] ?? String(item.received_quantity ?? '');
        const noteVal = itemNotes[key] ?? (item.notes || '');
        const noteOpen = openNotes[item.id] || Boolean(noteVal);

        return (
          <div key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/90 p-3 space-y-2.5">
            <h4 className="text-base font-black text-white leading-snug flex items-center gap-2 flex-wrap">
              <span>{name}</span>
              <SupplementItemBadge isSupplementary={poItem?.is_supplementary} batchNumber={poItem?.supplement_batch} />
            </h4>

            <p className="text-xs text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
              {poItem?.quantity != null && (
                <span>
                  المطلوب: <strong className="font-mono text-slate-100">{formatCleanQty(poQty)} {getUnitLabel(poItem?.uom || '')}</strong>
                </span>
              )}
              {arrived != null && (
                <span>
                  {arrivedLabel}: <strong className="font-mono text-cyan-300">{formatCleanQty(Number(arrived))} {uom}</strong>
                </span>
              )}
            </p>

            <div className="relative flex items-center">
              <label htmlFor={`site-qty-${key}`} className="sr-only">الكمية المعتمدة</label>
              <input
                id={`site-qty-${key}`}
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder="الكمية المعتمدة"
                value={val}
                onChange={(e) => onQuantityChange(key, e.target.value)}
                className="w-full h-14 rounded-xl border-2 border-emerald-500/80 bg-slate-900 pl-20 pr-4 text-xl font-black text-emerald-200 placeholder:text-sm placeholder:font-normal placeholder:text-slate-500 focus:border-emerald-300 focus:ring-4 focus:ring-emerald-500/30 focus:outline-none"
              />
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 rounded-lg border border-emerald-500/50 bg-emerald-950/90 px-2.5 py-1 text-xs font-black text-emerald-300">
                {uom}
              </span>
            </div>

            {noteOpen ? (
              <input
                type="text"
                value={noteVal}
                onChange={(e) => onItemNoteChange(key, e.target.value)}
                placeholder="ملاحظة على الصنف"
                aria-label="ملاحظة على الصنف"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setOpenNotes((prev) => ({ ...prev, [item.id]: true }))}
                className="text-xs font-bold text-slate-400 hover:text-slate-200 cursor-pointer"
                style={{ minHeight: 0 }}
              >
                + ملاحظة
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default SiteReceiptItemCards;
