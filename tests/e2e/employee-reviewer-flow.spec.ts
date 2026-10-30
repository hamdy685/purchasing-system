import { test, expect } from '@playwright/test';

test.describe('E2E User Journey: Employee Creation & Reviewer Approval Flow', () => {
  // Shared in-memory state for mock API transitions
  let currentPrState = {
    id: 991,
    request_number: 'PR-2026-E2E-991',
    status: 'DRAFT',
    request_type: 'PROJECT',
    parcel_reference: 'قطعة 404',
    region: 'العاصمة الإدارية',
    date_needed: '2026-10-15',
    department: { id: 1, name: 'التنفيذ', code: 'EXECUTION' },
    target_department: { id: 1, name: 'التنفيذ', code: 'EXECUTION' },
    requester: { id: 10, name: 'م. كامل', email: 'kamel@gmail.com' },
    assigned_reviewer: { id: 2, name: 'م. أيمن ماهر', email: 'ayman@gmail.com' },
    site_engineer_user_id: 10,
    site_engineer: { id: 10, name: 'م. كامل', department_name: 'التنفيذ' },
    items: [
      {
        id: 1,
        item_description: 'حديد تسليح عز 16 مم',
        item_reference: 'STEEL-16',
        region: 'العاصمة الإدارية',
        quantity: 10,
        uom: 'TON',
        specifications: 'مطابق للمواصفات القياسية المصرية',
      },
    ],
    approval_history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  test.beforeEach(async ({ page }) => {
    // Intercept backend API routes to make test 100% deterministic and self-contained
    await page.route('**/api/v1/auth/login', async (route) => {
      const postData = route.request().postDataJSON() || {};
      if (postData.email === 'kamel@gmail.com') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            token: 'mock-token-employee',
            token_type: 'Bearer',
            user: {
              id: 10,
              name: 'م. كامل',
              email: 'kamel@gmail.com',
              is_active: true,
              roles: [{ id: 1, name: 'مهندس موقع', slug: 'site_engineer' }, { id: 10, name: 'موظف', slug: 'employee' }],
              permissions: [
                'purchase_request.create',
                'purchase_request.edit_own',
                'purchase_request.view_own',
                'purchase_request.submit',
              ],
              department: { id: 1, name: 'التنفيذ', code: 'EXECUTION' },
            },
          }),
        });
      } else if (postData.email === 'ayman@gmail.com') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            token: 'mock-token-reviewer',
            token_type: 'Bearer',
            user: {
              id: 2,
              name: 'م. أيمن ماهر',
              email: 'ayman@gmail.com',
              is_active: true,
              roles: [{ id: 2, name: 'مراجع', slug: 'reviewer' }],
              permissions: [
                'purchase_request.view_assigned',
                'purchase_request.approve',
                'purchase_request.review',
                'purchase_request.reject',
              ],
              department: { id: 1, name: 'التنفيذ', code: 'EXECUTION' },
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'بيانات الدخول غير صحيحة.' }),
        });
      }
    });

    await page.route('**/api/v1/auth/me', async (route) => {
      const authHeader = route.request().headers()['authorization'] || '';
      if (authHeader.includes('mock-token-reviewer')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: 2,
              name: 'م. أيمن ماهر',
              email: 'ayman@gmail.com',
              is_active: true,
              roles: [{ id: 2, name: 'مراجع', slug: 'reviewer' }],
              permissions: [
                'purchase_request.view_assigned',
                'purchase_request.approve',
                'purchase_request.review',
                'purchase_request.reject',
              ],
              department: { id: 1, name: 'التنفيذ', code: 'EXECUTION' },
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: 10,
              name: 'م. كامل',
              email: 'kamel@gmail.com',
              is_active: true,
              roles: [{ id: 1, name: 'مهندس موقع', slug: 'site_engineer' }, { id: 10, name: 'موظف', slug: 'employee' }],
              permissions: [
                'purchase_request.create',
                'purchase_request.edit_own',
                'purchase_request.view_own',
                'purchase_request.submit',
              ],
              department: { id: 1, name: 'التنفيذ', code: 'EXECUTION' },
            },
          }),
        });
      }
    });

    await page.route(/\/api\/v1\/purchase-requests\/department-options/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 1,
              name: 'التنفيذ',
              code: 'EXECUTION',
              manager: { id: 2, name: 'م. أيمن ماهر' },
              site_engineer: { id: 10, name: 'م. كامل' },
            },
          ],
        }),
      });
    });

    await page.route(/\/api\/v1\/purchase-requests\/site-engineer/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          site_engineers: [
            { id: 10, name: 'م. كامل', role_name: 'مهندس موقع', department_name: 'التنفيذ' },
          ],
          other_users: [],
        }),
      });
    });

    await page.route(/\/api\/v1\/.*land-parcels/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 101, parcel_reference: 'قطعة 404', region: 'العاصمة الإدارية', is_active: true },
          ],
        }),
      });
    });

    await page.route(/\/api\/v1\/catalog/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    await page.route(/\/api\/v1\/notifications/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], unread_count: 0 }),
      });
    });

    await page.route(/\/api\/v1\/purchase-requests\/\d+\/submit/, async (route) => {
      currentPrState.status = 'SUBMITTED';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: currentPrState }),
      });
    });

    await page.route(/\/api\/v1\/activity/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    await page.route(/\/api\/v1\/purchase-requests\/\d+$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: currentPrState }),
      });
    });

    await page.route(/\/api\/v1\/purchase-requests$/, async (route) => {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() || {};
        currentPrState.request_type = payload.request_type || 'PROJECT';
        currentPrState.parcel_reference = payload.parcel_reference || 'قطعة 404';
        currentPrState.status = 'DRAFT';
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ data: currentPrState }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [currentPrState] }),
        });
      }
    });

    await page.route(/\/api\/v1\/reviewer\/requests/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [currentPrState] }),
      });
    });

    await page.route(/\/api\/v1\/reviewer\/purchase-requests\/\d+/, async (route) => {
      const url = route.request().url();
      if (url.endsWith('/start-review')) {
        currentPrState.status = 'UNDER_REVIEW';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: currentPrState }),
        });
      } else if (url.endsWith('/approve')) {
        currentPrState.status = 'APPROVED_BY_REVIEWER';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'تم اعتماد طلب الشراء بنجاح وإرساله للمدير العام.',
            data: currentPrState,
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: currentPrState }),
        });
      }
    });

    await page.route(/\/api\/v1\/reviewer\/purchase-requests$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [currentPrState] }),
      });
    });
  });

  test('Complete journey: Employee creates request, tests conditional fields, submits -> Reviewer views & approves', async ({ page }) => {
    // -------------------------------------------------------------
    // 1. Employee Login
    // -------------------------------------------------------------
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#email')).toBeVisible();

    await page.fill('#email', 'kamel@gmail.com');
    await page.fill('#password', '123456');
    await page.click('button[type="submit"]');

    // Wait for redirect away from login
    await page.waitForURL((url) => !url.pathname.includes('/login'));

    // -------------------------------------------------------------
    // 2. Navigate to Create Purchase Request
    // -------------------------------------------------------------
    await page.goto('/requests/create', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('group', { name: 'نوع الطلب' })).toBeVisible();

    // -------------------------------------------------------------
    // 3. Conditional Fields Verification (Office Supplies vs Projects)
    // -------------------------------------------------------------
    // Initially PROJECT is selected: Land Parcel & Region section is visible
    const landParcelSection = page.getByText('تحديد قطعة الأرض والمنطقة للطلب');
    await expect(landParcelSection).toBeVisible();
    await expect(page.locator('#pr-parcel-reference')).toBeVisible();

    // Click "مستلزمات مكتبية" (OFFICE_SUPPLIES)
    const officeBtn = page.getByRole('button', { name: /مستلزمات مكتبية/i });
    await officeBtn.click();

    // VERIFY CONDITIONAL FIELDS DISAPPEAR FROM DOM
    await expect(landParcelSection).not.toBeVisible();
    await expect(page.locator('#pr-parcel-reference')).not.toBeVisible();

    // Switch back to "مشروعات ومواقع" (PROJECT)
    const projectBtn = page.getByRole('button', { name: /مشروعات ومواقع/i });
    await projectBtn.click();

    // Verify fields reappear
    await expect(landParcelSection).toBeVisible();
    await expect(page.locator('#pr-parcel-reference')).toBeVisible();

    // -------------------------------------------------------------
    // 4. Fill and Submit Request
    // -------------------------------------------------------------
    // Select Target Department
    await page.waitForSelector('#pr-target-department:not([disabled])');
    await page.selectOption('#pr-target-department', '1');

    // Fill Land Parcel and Region
    await page.fill('#pr-parcel-reference', 'قطعة 404');
    await page.fill('#pr-region', 'العاصمة الإدارية');

    // Fill Item 1 Description and Quantity
    await page.locator('input[placeholder*="حديد تسليح"]:visible').first().fill('حديد تسليح عز 16 مم');
    await page.locator('input[type="number"]:visible').first().fill('10');

    // Submit Request
    const submitBtn = page.getByRole('button', { name: /إرسال طلب الشراء فوراً/i });
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    // Wait for redirect to details or requests list
    await page.waitForURL((url) => url.pathname.includes('/requests'));

    // Verify request number is visible on screen
    await expect(page.getByText('PR-2026-E2E-991')).toBeVisible();

    // -------------------------------------------------------------
    // 5. Reviewer Login
    // -------------------------------------------------------------
    // Clear session storage & cookies
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', 'ayman@gmail.com');
    await page.fill('#password', '123456');
    await page.click('button[type="submit"]');

    // Wait for redirect to reviewer home/dashboard
    await page.waitForURL((url) => !url.pathname.includes('/login'));

    // -------------------------------------------------------------
    // 6. Reviewer Views Request in Dashboard / Reviewer Requests Table
    // -------------------------------------------------------------
    await page.goto('/reviewer/requests', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('PR-2026-E2E-991').first()).toBeVisible();

    // Navigate to Request Details
    await page.goto(`/reviewer/requests/${currentPrState.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('PR-2026-E2E-991').first()).toBeVisible();

    // -------------------------------------------------------------
    // 7. Reviewer Approves Request
    // -------------------------------------------------------------
    // Click "اعتماد" button
    const approveBtn = page.getByRole('button', { name: /اعتماد/i }).first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // Confirm dialog opens -> click "اعتماد الطلب" inside modal
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const confirmModalApproveBtn = dialog.getByRole('button', { name: /اعتماد الطلب/i });
    await expect(confirmModalApproveBtn).toBeVisible();
    await confirmModalApproveBtn.click();

    // Verify approval success message
    await expect(page.getByText(/تم اعتماد طلب الشراء بنجاح/i)).toBeVisible();
  });
});
