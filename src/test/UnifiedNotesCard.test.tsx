import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnifiedNotesCard } from '../components/common/UnifiedNotesCard';
import type { PurchaseRequest } from '../types/purchaseRequest';

const baseRequest = {
  id: 1,
  request_number: 'PR-2026-000001',
  notes: 'توريد وتركيب أبواب وشبابيك للمبنى الإداري',
  requester: { id: 9, name: 'م. كامل' },
  items: [{ id: 1, item_description: 'باب خشب', quantity: 4, uom: 'PCS', specifications: 'زان طبيعي' }],
  approval_history: [
    {
      action: 'APPROVED_BY_REVIEWER',
      comments: 'اعتمد المراجع الطلب وأرسله إلى المدير التنفيذي للقرار.',
      user_note: null,
      actor: { name: 'م. أيمن' },
    },
    {
      action: 'DIRECT_EXECUTIVE_REVIEW_REQUIRED',
      comments: 'أدخل مدير المشتريات البيانات المالية واختار المورد ثم أرسل الطلب إلى المدير التنفيذي المهندس محمد للاعتماد.',
      actor: { name: 'م. أحمد' },
    },
    {
      action: 'APPROVED_BY_EXECUTIVE',
      comments: 'التوريد قبل نهاية الشهر',
      user_note: 'التوريد قبل نهاية الشهر',
      actor: { name: 'م. محمد' },
    },
  ],
} as unknown as PurchaseRequest;

describe('UnifiedNotesCard', () => {
  it('shows only notes people typed, never system default texts', () => {
    render(<UnifiedNotesCard request={baseRequest} />);

    expect(screen.getByText('توريد وتركيب أبواب وشبابيك للمبنى الإداري')).toBeInTheDocument();
    expect(screen.getByText('التوريد قبل نهاية الشهر')).toBeInTheDocument();

    expect(screen.queryByText(/اعتمد المراجع الطلب وأرسله/)).not.toBeInTheDocument();
    expect(screen.queryByText(/أدخل مدير المشتريات البيانات المالية/)).not.toBeInTheDocument();
    expect(screen.queryByText(/DIRECT_EXECUTIVE_REVIEW_REQUIRED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/زان طبيعي/)).not.toBeInTheDocument();
  });

  it('renders nothing when nobody typed a note', () => {
    const { container } = render(
      <UnifiedNotesCard request={{ ...baseRequest, notes: '', approval_history: [baseRequest.approval_history![0]] } as PurchaseRequest} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
