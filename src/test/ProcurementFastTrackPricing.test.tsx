import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProcurementManagerPage } from '../pages/procurement/ProcurementManagerPage';
import * as procurementApi from '../api/procurement';
import * as authStorage from '../utils/authStorage';
import * as authApi from '../api/auth';
import { AuthProvider } from '../context/AuthContext';

vi.mock('../api/procurement', async () => {
  const actual = await vi.importActual<typeof procurementApi>('../api/procurement');
  return {
    ...actual,
    getPendingProcurementApprovalApi: vi.fn(),
    getExecutivePendingRequestsApi: vi.fn(),
    getPendingQuoteRequestsApi: vi.fn(),
    getApprovedByProcurementPrsApi: vi.fn(),
    getProcurementDepartmentsApi: vi.fn(),
    getProcurementCatalogItemsApi: vi.fn(),
    getProcurementAnalyticsApi: vi.fn(),
    approveProcurementPrApi: vi.fn(),
  };
});

vi.mock('../api/purchaseOrders', () => ({
  getPurchaseOrdersApi: vi.fn().mockResolvedValue({ data: [], meta: { current_page: 1, total: 0 } }),
  getPurchaseOrderApi: vi.fn().mockResolvedValue({ id: 1 }),
}));

vi.mock('../api/suppliers', () => ({
  getSuppliersApi: vi.fn().mockResolvedValue([]),
  createSupplierApi: vi.fn(),
  updateSupplierApi: vi.fn(),
  deleteSupplierApi: vi.fn(),
}));

describe('ProcurementManagerPage - قرارات بانتظار المدير التنفيذي', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authStorage, 'getToken').mockReturnValue('mock_token');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue({
      id: 1,
      name: 'مدير المشتريات',
      email: 'procurement@ashbiliya.com',
      is_active: true,
      roles: ['procurement_manager'],
      permissions: ['purchase_request.view_approved', 'purchase_request.approve_procurement'],
    } as any);

    vi.mocked(procurementApi.getProcurementDepartmentsApi).mockResolvedValue([]);
    vi.mocked(procurementApi.getProcurementCatalogItemsApi).mockResolvedValue([]);
    vi.mocked(procurementApi.getProcurementAnalyticsApi).mockResolvedValue(null);
    vi.mocked(procurementApi.getPendingQuoteRequestsApi).mockResolvedValue([]);
    vi.mocked(procurementApi.getApprovedByProcurementPrsApi).mockResolvedValue([]);
  });

  it('renders the "قرارات بانتظار المدير التنفيذي" card with correct counts and buttons', async () => {
    // 1 PR pending executive preliminary approval
    const mockExecPr = {
      id: 501,
      request_number: 'PR-EXEC-501',
      status: 'PENDING_EXECUTIVE_APPROVAL',
      procurement_route: null,
      total_estimated_cost: 0,
      department: { id: 1, name: 'قسم الإنشاءات' },
      requester: { id: 10, name: 'م. حسام' },
      items: [
        {
          id: 1,
          item_description: 'حديد تسليح 16 مم',
          quantity: 20,
          uom: 'طن',
        },
      ],
      created_at: '2026-10-24T12:00:00Z',
    };

    // 1 PR pending procurement approval (approved preliminarily by GM)
    const mockPendingPr = {
      id: 502,
      request_number: 'PR-PENDING-502',
      status: 'PENDING_PROCUREMENT_APPROVAL',
      procurement_route: null,
      total_estimated_cost: 0,
      department: { id: 2, name: 'قسم التشطيبات' },
      requester: { id: 11, name: 'م. طارق' },
      items: [
        {
          id: 2,
          item_description: 'سيراميك أرضيات',
          quantity: 200,
          uom: 'متر',
        },
      ],
      created_at: '2026-10-24T13:00:00Z',
    };

    vi.mocked(procurementApi.getExecutivePendingRequestsApi).mockResolvedValue([mockExecPr as any]);
    vi.mocked(procurementApi.getPendingProcurementApprovalApi).mockResolvedValue([mockPendingPr as any]);

    render(
      <MemoryRouter>
        <AuthProvider>
          <ProcurementManagerPage />
        </AuthProvider>
      </MemoryRouter>
    );

    // Wait for the page to load
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'أقسام المشتريات' })).toBeInTheDocument();
    });

    // 1. Check Card 1: بانتظار المدير التنفيذي
    const execCardTitles = screen.getAllByText(/بانتظار المدير التنفيذي/i);
    expect(execCardTitles.length).toBeGreaterThanOrEqual(1);

    // The card counts only requests actually awaiting the executive (route-pending ones live in their own card)
    expect(screen.getAllByText(/^1 طلب$/i).length).toBeGreaterThanOrEqual(1);

    // Check the button inside the card
    const viewExecBtn = screen.getByRole('button', { name: /عرض طلبات المدير التنفيذي \(1\)/i });
    expect(viewExecBtn).toBeInTheDocument();

    // 2. Click the button to filter by EXECUTIVE_PENDING
    await userEvent.click(viewExecBtn);

    // Check that PR-EXEC-501 is rendered with fast-track pricing button
    await waitFor(() => {
      expect(screen.getByText('PR-EXEC-501')).toBeInTheDocument();
    });

    // Verify fast-track pricing banner for PR-EXEC-501
    expect(screen.getByText(/بانتظار موافقة المدير التنفيذي المبدئية — يمكنك التسعير وتخطي الاعتماد المبدئي مباشرة/i)).toBeInTheDocument();

    // Verify fast-track action button
    expect(screen.getByRole('button', { name: /تسعير مباشر وتخطي الاعتماد المبدئي/i })).toBeInTheDocument();

    // PR-PENDING-502 awaits a route decision, not the executive, so the executive filter hides it
    expect(screen.queryByText('PR-PENDING-502')).not.toBeInTheDocument();
  });
});
