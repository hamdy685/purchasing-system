import React, { useEffect, useState } from 'react';
import {
  buildGuestOfficeLink,
  getGuestOfficeLinkTokenApi,
  rotateGuestOfficeLinkTokenApi,
} from '../../api/guestOfficeRequests';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { parseApiError } from '../../utils/apiError';

/**
 * Admin card: the public office-supplies link to share, with copy and rotate.
 */
const GuestOfficeLinkCard: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getGuestOfficeLinkTokenApi()
      .then(setToken)
      .catch((err) => setMessage(parseApiError(err).message));
  }, []);

  const link = token ? buildGuestOfficeLink(token) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setMessage('تم نسخ اللينك.');
    } catch {
      setMessage('انسخ اللينك يدويًا من المربع.');
    }
  };

  const rotate = async () => {
    if (!window.confirm('تغيير اللينك هيوقف اللينك القديم عند كل الناس. متأكد؟')) return;
    setBusy(true);
    try {
      setToken(await rotateGuestOfficeLinkTokenApi());
      setMessage('تم تغيير اللينك. ابعت اللينك الجديد.');
    } catch (err) {
      setMessage(parseApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-black text-slate-100">لينك طلبات المكتبيات</h2>
        <p className="text-xs text-slate-400">أي حد معاه اللينك يطلب مكتبيات من غير حساب، والطلب يروح لمراجع القسم.</p>
      </div>
      <input
        readOnly
        value={link}
        dir="ltr"
        onFocus={(e) => e.target.select()}
        className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200"
        aria-label="لينك طلبات المكتبيات"
      />
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button type="button" variant="primary" size="sm" onClick={copy} disabled={!token} className="justify-center">
          نسخ اللينك
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={rotate} disabled={!token || busy} isLoading={busy} className="justify-center">
          تغيير اللينك
        </Button>
      </div>
      {message && <p className="text-xs text-slate-300">{message}</p>}
    </Card>
  );
};

export default GuestOfficeLinkCard;
