import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GuestOfficeRequestPage from '../pages/public/GuestOfficeRequestPage';
import * as api from '../api/guestOfficeRequests';

vi.mock('../api/guestOfficeRequests', () => ({
  getGuestOfficeFormApi: vi.fn(),
  submitGuestOfficeRequestApi: vi.fn(),
}));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/office-request/abc']}>
      <Routes>
        <Route path="/office-request/:token" element={<GuestOfficeRequestPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('GuestOfficeRequestPage', () => {
  beforeEach(() => {
    vi.mocked(api.getGuestOfficeFormApi).mockReset();
    vi.mocked(api.submitGuestOfficeRequestApi).mockReset();
  });

  it('sends an office request with the typed name and shows the request number', async () => {
    vi.mocked(api.getGuestOfficeFormApi).mockResolvedValue([{ id: 7, name: 'الموارد البشرية' }]);
    vi.mocked(api.submitGuestOfficeRequestApi).mockResolvedValue({ request_number: 'PR-2026-0001' });

    renderPage();
    await screen.findByRole('option', { name: 'الموارد البشرية' });

    const textboxes = screen.getAllByRole('textbox');
    fireEvent.change(textboxes[0], { target: { value: 'أحمد محمد' } });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '7' } });
    fireEvent.change(textboxes[2], { target: { value: 'ورق للمكتب' } });
    fireEvent.change(screen.getByPlaceholderText('مثال: ورق تصوير A4'), { target: { value: 'ورق A4' } });
    fireEvent.click(screen.getByRole('button', { name: 'إرسال الطلب' }));

    await screen.findByText('PR-2026-0001');
    expect(api.submitGuestOfficeRequestApi).toHaveBeenCalledWith('abc', expect.objectContaining({
      name: 'أحمد محمد',
      target_department_id: 7,
      notes: 'ورق للمكتب',
      items: [expect.objectContaining({ item_description: 'ورق A4', quantity: 1 })],
    }));
  });

  it('tells the person when the link is no longer valid', async () => {
    vi.mocked(api.getGuestOfficeFormApi).mockRejectedValue(new Error('404'));
    renderPage();
    await waitFor(() => expect(screen.getByText(/اللينك ده مش شغال/)).toBeInTheDocument());
  });
});
