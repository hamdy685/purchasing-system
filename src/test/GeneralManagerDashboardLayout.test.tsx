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

describe('GeneralManagerDashboardPage layout ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useAuth as any).mockReturnValue(mockGmAuth);
    vi.mocked(gmApi.getGeneralManagerPurchaseRequestsApi).mockResolvedValue([]);
    vi.mocked(gmApi.getGeneralManagerPurchaseOrdersApi).mockResolvedValue([]);
    vi.mocked(gmApi.getGeneralManagerPurchaseOrderSummariesApi).mockResolvedValue([]);
    vi.mocked(pqApi.getPendingQuoteRequestsApi).mockResolvedValue([]);
  });

  it('renders ActionRequiredInbox first at the top, and moved header/tablet/launcher to the bottom', async () => {
    const { container } = render(
      <MemoryRouter>
        <GeneralManagerDashboardPage />
      </MemoryRouter>
    );

    // Wait for the page to finish loading
    await waitFor(() => {
      expect(screen.getByText('القرارات التنفيذية المطلوبة منك الآن')).toBeInTheDocument();
    });

    const rootContainer = container.querySelector('.animate-fade-in');
    expect(rootContainer).not.toBeNull();

    // 1. Verify ActionRequiredInbox title exists at top
    const actionInboxTitle = screen.getByText('القرارات التنفيذية المطلوبة منك الآن');
    expect(actionInboxTitle).toBeInTheDocument();

    // 2. Verify Executive Header, Tablet Prompt, and Quick Launcher exist
    const headerTitle = screen.getByText(/لوحة المدير العام التنفيذية/i);
    expect(headerTitle).toBeInTheDocument();

    const tabletPrompt = screen.getByText('إشعارات التابلت وجهاز المدير العام');
    expect(tabletPrompt).toBeInTheDocument();

    const executiveBadge = screen.getByText('🛡️ الإدارة التنفيذية العليا');
    expect(executiveBadge).toBeInTheDocument();

    const quickLauncher = screen.getByText(/اختصارات الوصول السريع/i);
    expect(quickLauncher).toBeInTheDocument();

    // 3. Verify DOM position: ActionRequiredInbox comes BEFORE header, tablet prompt, and quick launcher
    const actionInboxPos = actionInboxTitle.compareDocumentPosition(headerTitle);
    // Node.DOCUMENT_POSITION_FOLLOWING is 4, meaning headerTitle is AFTER actionInboxTitle in the DOM
    expect(actionInboxPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const tabletPromptPos = actionInboxTitle.compareDocumentPosition(tabletPrompt);
    expect(tabletPromptPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const quickLauncherPos = actionInboxTitle.compareDocumentPosition(quickLauncher);
    expect(quickLauncherPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
