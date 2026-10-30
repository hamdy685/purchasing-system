import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../../context/AuthContext';
import { PurchaseRequest } from '../../types/purchaseRequest';
import PurchaseRequestTable from '../../components/purchase-requests/PurchaseRequestTable';
import { PurchaseRequestsPage } from '../../pages/employee/PurchaseRequestsPage';
import * as purchaseRequestsApi from '../../api/purchaseRequests';
import * as authStorage from '../../utils/authStorage';
import * as authApi from '../../api/auth';

const mockProcurementUser = {
  id: 1,
  name: 'المهندس أحمد بدوي',
  email: 'ahmed@ashbiliya.com',
  is_active: true,
  roles: ['procurement_manager'],
  permissions: [
    'purchase_request.view_all',
    'purchase_request.view_own',
    'purchase_request.edit_own',
    'purchase_request.submit',
  ],
  department: {
    id: 1,
    name: 'المشتريات',
    code: 'PROC',
  },
};

const generateMockRequests = (count: number): PurchaseRequest[] => {
  return Array.from({ length: count }, (_, i) => {
    const id = i + 1;
    const isDraft = i < 17; // 17 drafts
    const isApproved = i >= 17 && i < 26; // 9 approved
    const status = isDraft ? 'DRAFT' : isApproved ? 'APPROVED_BY_REVIEWER' : 'SUBMITTED';

    return {
      id,
      request_number: `PR-2026-${String(id).padStart(4, '0')}`,
      status,
      request_type: i % 5 === 0 ? 'OFFICE_SUPPLIES' : 'PROJECT',
      parcel_reference: i % 5 === 0 ? undefined : `قطعة ${100 + i}`,
      region: i % 5 === 0 ? undefined : 'حي النرجس',
      date_needed: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
      department: { id: 1, name: 'المشتريات', code: 'PROC' },
      items: [
        {
          id: id * 10,
          purchase_request_id: id,
          item_description: `صنف رقم ${id} مواد إنشائية`,
          quantity: 10 + (i % 50),
          uom: 'طن',
        },
      ],
      approval_history: [],
    };
  });
};

describe('Scenario 1: اختبار استرجاع وعرض البيانات (Data Rendering Test)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(authStorage, 'getToken').mockReturnValue('mock_token');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue(mockProcurementUser);
  });

  it('1.1 Array from API is mapped correctly in PurchaseRequestTable with all request numbers', () => {
    const mockRequests = generateMockRequests(10);
    const mockOnSubmit = vi.fn();
    const mockOnDelete = vi.fn();

    render(
      <MemoryRouter>
        <AuthProvider>
          <PurchaseRequestTable
            requests={mockRequests}
            onOpenSubmitModal={mockOnSubmit}
            onOpenDeleteModal={mockOnDelete}
          />
        </AuthProvider>
      </MemoryRouter>
    );

    // Verify all 10 request numbers are rendered
    mockRequests.forEach((pr) => {
      const links = screen.getAllByText(pr.request_number);
      expect(links.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('1.2 Matches rendered row/card count exactly with the 90 items reported in header tabs', async () => {
    const mock90Requests = generateMockRequests(90);
    vi.spyOn(purchaseRequestsApi, 'getOwnPurchaseRequestsApi').mockResolvedValue(mock90Requests);

    const { container } = render(
      <MemoryRouter initialEntries={['/requests']}>
        <AuthProvider>
          <Routes>
            <Route path="/requests" element={<PurchaseRequestsPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Wait for requests to load and display
    await waitFor(() => {
      expect(screen.getByText(/المعروض:/i)).toBeInTheDocument();
      expect(screen.getByText('90')).toBeInTheDocument();
    });

    // Check tabs counter
    const allTab = screen.getByRole('button', { name: /الكل\s*\(90\)/i });
    expect(allTab).toBeInTheDocument();

    const draftsTab = screen.getByRole('button', { name: /مسودات \(17\)/i });
    expect(draftsTab).toBeInTheDocument();

    // Verify table has exactly 90 data rows rendered in desktop TableBody
    const tbody = container.querySelector('tbody');
    expect(tbody).toBeInTheDocument();
    const renderedTableRows = tbody?.querySelectorAll('tr');
    expect(renderedTableRows?.length).toBe(90);

    // Verify mobile cards also render all 90 items
    const mobileCards = container.querySelectorAll('article');
    expect(mobileCards.length).toBe(90);

    // Verify none of the table rows have opacity 0 or hidden style
    renderedTableRows?.forEach((row) => {
      expect(row).not.toHaveClass('stagger-card');
      expect(window.getComputedStyle(row).opacity).not.toBe('0');
    });
  }, 15000);

  it('1.3 Switching tabs updates rendered row count dynamically to match selected status badge count', async () => {
    const mock90Requests = generateMockRequests(90);
    vi.spyOn(purchaseRequestsApi, 'getOwnPurchaseRequestsApi').mockResolvedValue(mock90Requests);

    const { container } = render(
      <MemoryRouter initialEntries={['/requests']}>
        <AuthProvider>
          <Routes>
            <Route path="/requests" element={<PurchaseRequestsPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/المعروض:/i)).toBeInTheDocument();
      expect(screen.getByText('90')).toBeInTheDocument();
    });

    // Click on drafts tab (17 items)
    const draftsTab = screen.getByRole('button', { name: /مسودات \(17\)/i });
    fireEvent.click(draftsTab);

    // Table should now render exactly 17 rows
    const tbody = container.querySelector('tbody');
    const filteredRows = tbody?.querySelectorAll('tr');
    expect(filteredRows?.length).toBe(17);
  }, 15000);
});
