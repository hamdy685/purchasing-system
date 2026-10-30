import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../../context/AuthContext';
import CreatePurchaseRequestPage from '../../pages/employee/CreatePurchaseRequestPage';
import { CreateSupplementModal } from '../../components/supplements/CreateSupplementModal';
import { PurchaseRequest } from '../../types/purchaseRequest';
import * as purchaseRequestsApi from '../../api/purchaseRequests';
import * as catalogApi from '../../api/catalog';
import * as supplementsApi from '../../api/supplements';
import * as authStorage from '../../utils/authStorage';
import * as authApi from '../../api/auth';

const mockEmployeeUser = {
  id: 1,
  name: 'علي الموظف',
  email: 'ali@ashbiliya.com',
  is_active: true,
  roles: ['employee'],
  permissions: [
    'purchase_request.create',
    'purchase_request.view_own',
    'purchase_request.edit_own',
    'purchase_request.submit',
  ],
  department: {
    id: 1,
    name: 'المكتب الفني',
    code: 'ENG',
  },
};

const mockDepartmentOptions = [
  {
    id: 1,
    name: 'المكتب الفني',
    code: 'ENG',
    manager: { id: 2, name: 'المهندس المراجع' },
    site_engineer: { id: 3, name: 'مهندس الموقع' },
  },
];

const mockCatalog = [
  {
    id: 10,
    name: 'حديد تسليح 16 مم',
    sku: 'STEEL-16',
    uom: 'طن',
  },
];

const mockParentRequest: PurchaseRequest = {
  id: 50,
  request_number: 'PR-2026-0050',
  status: 'APPROVED_BY_ACCOUNTING',
  request_type: 'PROJECT',
  parcel_reference: 'قطعة 244',
  region: 'النرجس الشمالي',
  date_needed: '2026-10-15',
  created_at: '2026-09-10T10:00:00Z',
  items: [
    {
      id: 501,
      purchase_request_id: 50,
      item_description: 'حديد عز 16 مم',
      quantity: 50,
      uom: 'طن',
    },
  ],
  approval_history: [],
};

describe('Scenario 2: اختبار تدفق الموظف ونموذج الإنشاء (Employee Flow & Wizard)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(authStorage, 'getToken').mockReturnValue('mock_token');
    vi.spyOn(authApi, 'getMeApi').mockResolvedValue(mockEmployeeUser);
    vi.spyOn(catalogApi, 'getCatalogItemsApi').mockResolvedValue(mockCatalog);
    vi.spyOn(purchaseRequestsApi, 'getPurchaseRequestDepartmentOptionsApi').mockResolvedValue(mockDepartmentOptions);
  });

  it('2.1 Verify CreatePurchaseRequestPage is divided into step-by-step wizard', async () => {
    render(
      <MemoryRouter initialEntries={['/requests/create']}>
        <AuthProvider>
          <Routes>
            <Route path="/requests/create" element={<CreatePurchaseRequestPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Assert the numbered form sections are rendered
    await waitFor(() => {
      expect(screen.getByText(/1\. بيانات الطلب والجهة المعالجة/i)).toBeInTheDocument();
      expect(screen.getByText(/2\. بنود ومواد الطلب/i)).toBeInTheDocument();
    });
  });

  it('2.2 Conditional Logic: selecting office supplies removes land parcel and region fields from the DOM', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/requests/create']}>
        <AuthProvider>
          <Routes>
            <Route path="/requests/create" element={<CreatePurchaseRequestPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/مشروعات ومواقع/i)).toBeInTheDocument();
    });

    // Default mode is PROJECT: parcel reference and region should exist in DOM
    expect(container.querySelector('#pr-parcel-reference')).toBeInTheDocument();
    expect(container.querySelector('#pr-region')).toBeInTheDocument();

    // Click "مستلزمات مكتبية" (OFFICE_SUPPLIES)
    const officeBtn = screen.getByRole('button', { name: /مستلزمات مكتبية/i });
    fireEvent.click(officeBtn);

    // Conditional logic verification: parcel reference and region MUST NOT be rendered
    expect(container.querySelector('#pr-parcel-reference')).not.toBeInTheDocument();
    expect(container.querySelector('#pr-region')).not.toBeInTheDocument();

    // Switch back to PROJECT: they reappear
    const projectBtn = screen.getByRole('button', { name: /مشروعات ومواقع/i });
    fireEvent.click(projectBtn);
    expect(container.querySelector('#pr-parcel-reference')).toBeInTheDocument();
    expect(container.querySelector('#pr-region')).toBeInTheDocument();
  });

  it('2.3 Strict absence of pricing or cost input fields in the employee creation interface', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/requests/create']}>
        <AuthProvider>
          <Routes>
            <Route path="/requests/create" element={<CreatePurchaseRequestPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/1\. بيانات الطلب والجهة المعالجة/i)).toBeInTheDocument();
    });

    // Pricing is exclusively reserved for procurement department
    const inputs = container.querySelectorAll('input');
    inputs.forEach((input) => {
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();

      expect(name).not.toContain('price');
      expect(name).not.toContain('cost');
      expect(id).not.toContain('price');
      expect(id).not.toContain('cost');
      expect(placeholder).not.toContain('سعر');
      expect(placeholder).not.toContain('تكلفة');
    });

    // Also assert there are no price or cost labels
    const labels = container.querySelectorAll('label');
    labels.forEach((label) => {
      const text = label.textContent || '';
      expect(text).not.toContain('السعر');
      expect(text).not.toContain('سعر الوحدة');
      expect(text).not.toContain('التكلفة التقديرية');
    });
  });

  it('2.4 Supplementary Request (كمالة): auto-fills parent PR details and binds parcel/region automatically', async () => {
    const mockOnClose = vi.fn();
    const mockOnSuccess = vi.fn();
    const createSupplementSpy = vi.spyOn(supplementsApi, 'createSupplementApi').mockResolvedValue({
      id: 99,
      purchase_request_id: 50,
      supplement_number: 'SUP-50-01',
      status: 'SUBMITTED',
      notes: 'كمية إضافية خرسانة',
      items: [],
      created_at: '2026-09-18T10:00:00Z',
    } as any);

    render(
      <CreateSupplementModal
        request={mockParentRequest}
        isOpen={true}
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />
    );

    // Verify parent request details are shown
    expect(screen.getByText(/PR-2026-0050/)).toBeInTheDocument();
    expect(screen.getByText(/قطعة 244/)).toBeInTheDocument();
    expect(screen.getByText(/النرجس الشمالي/)).toBeInTheDocument();

    // Fill in notes, item description and quantity
    const notesInput = screen.getByPlaceholderText(/حاجة إضافية للموقع/i);
    fireEvent.change(notesInput, { target: { value: 'كمية إضافية خرسانة لاستكمال الصب' } });

    const descInput = screen.getByPlaceholderText(/اسم المادة أو الصنف/i);
    fireEvent.change(descInput, { target: { value: 'حديد عز إضافي 16 مم' } });

    const qtyInput = screen.getByRole('spinbutton');
    fireEvent.change(qtyInput, { target: { value: '15' } });

    // Submit the supplement
    const submitBtn = screen.getByRole('button', { name: /إرسال طلب الكمالة/i });
    const form = submitBtn.closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(createSupplementSpy).toHaveBeenCalledWith(
        50,
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              item_description: 'حديد عز إضافي 16 مم',
              quantity: 15,
              item_reference: 'قطعة 244',
              region: 'النرجس الشمالي',
              estimated_unit_price: 0, // Pricing zeroed for procurement
            }),
          ]),
        })
      );
      expect(mockOnSuccess).toHaveBeenCalled();
      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});
