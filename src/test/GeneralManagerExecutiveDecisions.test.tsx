import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GeneralManagerDashboardPage from '../pages/general-manager/GeneralManagerDashboardPage';
import { useAuth } from '../context/AuthContext';
import * as gmApi from '../api/generalManager';
import * as pqApi from '../api/purchaseQuotes';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../api/generalManager', () => ({
  getGeneralManagerPurchaseRequestsApi: vi.fn(),
  getGeneralManagerPurchaseOrdersApi: vi.fn(),
  getGeneralManagerPurchaseOrderSummariesApi: vi.fn(),
  approveGeneralManagerPurchaseRequestApi: vi.fn(),
  rejectGeneralManagerPurchaseRequestApi: vi.fn(),
}));

vi.mock('../api/purchaseQuotes', () => ({
  getPendingQuoteRequestsApi: vi.fn(),
}));

vi.mock('../services/pushNotificationService', () => ({
  getPushSupportStatus: () => true,
  getPushPermissionState: () => 'default',
  isIosDevice: () => false,
  isStandalonePwa: () => false,
  requestAndRegisterPushToken: vi.fn(),
}));

const mockGmAuth: any = {
  user: {
    id: 1,
    name: 'المهندس محمد عبدالكريم',
    email: 'gm@company.test',
    roles: [{ id: 1, slug: 'general_manager', name: 'المدير العام' }],
  },
  token: 'fake-token',
  hasRole: (slug: string) => slug === 'general_manager' || slug === 'execution_manager',
  hasAnyRole: (slugs: string[]) => slugs.includes('general_manager'),
  hasPermission: () => true,
  isLoading: false,
};

describe('GeneralManagerDashboardPage Executive Decisions Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useAuth as any).mockReturnValue(mockGmAuth);
    vi.mocked(gmApi.getGeneralManagerPurchaseOrdersApi).mockResolvedValue([]);
    vi.mocked(gmApi.getGeneralManagerPurchaseOrderSummariesApi).mockResolvedValue([]);
  });

  it('renders initial approval, final approval, and quote awarding items with accurate badges, next actors, and action buttons', async () => {
    const mockRequests: any[] = [
      // PR-162: Initial approval, unpriced, goes to procurement
      {
        id: 162,
        request_number: 'PR-162',
        status: 'PENDING_EXECUTIVE_APPROVAL',
        executive_stage: 'INITIAL_APPROVAL',
        is_returned_from_procurement: false,
        next_actor_label: 'إدارة المشتريات',
        total_estimated_cost: '0.00',
        justification: 'طلب توريد أسمنت أولي لموقع النرجس',
        department: { id: 1, name: 'إدارة المشروعات' },
        requester: { id: 5, name: 'م. أحمد مهندس الموقع' },
        items: [
          {
            id: 1,
            item_description: 'أسمنت بورتلاندي',
            quantity: '50',
            uom: 'TON',
            estimated_unit_price: '0.00',
          },
        ],
      },
      // PR-160: Final approval, priced by procurement, goes to accounting
      {
        id: 160,
        request_number: 'PR-160',
        status: 'PENDING_EXECUTIVE_APPROVAL',
        executive_stage: 'FINAL_APPROVAL',
        is_returned_from_procurement: true,
        next_actor_label: 'الإدارة المالية (الحسابات)',
        total_estimated_cost: '34500.00',
        procurement_route: 'DIRECT',
        direct_supplier: { id: 10, company_name: 'شركة الأهرام للتجارة' },
        justification: 'توريد كابلات كهربائية مسعرة',
        department: { id: 2, name: 'الكهرباء' },
        requester: { id: 6, name: 'م. خالد' },
        items: [
          {
            id: 2,
            item_description: 'كابل نحاس 16 مم',
            quantity: '100',
            uom: 'M',
            estimated_unit_price: '345.00',
            estimated_line_total: '34500.00',
          },
        ],
      },
      // Duplicate PR-160 to verify deduplication
      {
        id: 160,
        request_number: 'PR-160',
        status: 'PENDING_EXECUTIVE_APPROVAL',
        executive_stage: 'FINAL_APPROVAL',
      },
    ];

    const mockQuoteRequests: any[] = [
      {
        id: 155,
        request_number: 'PR-155',
        status: 'PENDING_EXECUTIVE_QUOTE_DECISION',
        executive_stage: 'QUOTE_AWARD',
        justification: 'عروض أسعار توريد حديد تسليح',
        department: { id: 1, name: 'إدارة المشروعات' },
        requester: { id: 7, name: 'م. طارق' },
        total_estimated_cost: '120000.00',
        quotes: [{ id: 1 }, { id: 2 }, { id: 3 }],
        items: [{ id: 3, item_description: 'حديد 16 مم', quantity: '10' }],
      },
    ];

    vi.mocked(gmApi.getGeneralManagerPurchaseRequestsApi).mockResolvedValue(mockRequests);
    vi.mocked(pqApi.getPendingQuoteRequestsApi).mockResolvedValue(mockQuoteRequests);

    render(
      <MemoryRouter>
        <GeneralManagerDashboardPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('القرارات التنفيذية المطلوبة منك الآن')).toBeInTheDocument();
    });

    // 1. Verify PR-162 (Initial Approval)
    expect(screen.getByText('PR-162')).toBeInTheDocument();
    expect(screen.getByText('رايح للمشتريات (طلب جديد)')).toBeInTheDocument();
    expect(screen.getByText('موافقة وإرسال للمشتريات')).toBeInTheDocument();

    // 2. Verify PR-160 (Final Approval)
    expect(screen.getByText('PR-160')).toBeInTheDocument();
    expect(screen.getByText('راجع من المشتريات (مسعر)')).toBeInTheDocument();
    expect(screen.getByText('اعتماد تنفيذي نهائي')).toBeInTheDocument();

    // 3. Verify deduplication: PR-160 is rendered only once
    const pr160Elements = screen.getAllByText('PR-160');
    expect(pr160Elements.length).toBe(1);

    // 4. Verify PR-155 (Quote awarding decision)
    expect(screen.getByText('PR-155')).toBeInTheDocument();
    expect(screen.getByText('ترسية عروض أسعار')).toBeInTheDocument();
    expect(screen.getByText('البت والترسية التنفيذية لعروض الأسعار')).toBeInTheDocument();

    // 5. Verify KPI counter has real dynamic count
    expect(screen.getByText('2 طلب')).toBeInTheDocument();
    expect(screen.getByText('1 معاملة')).toBeInTheDocument();
  });
});
