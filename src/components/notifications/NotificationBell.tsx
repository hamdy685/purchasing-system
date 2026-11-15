import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getNotificationsApi,
  getUnreadNotificationCountApi,
  markAllNotificationsAsReadApi,
  markNotificationAsReadApi,
  startNotificationsRealtime,
  stopNotificationsRealtime,
} from '../../api/notifications';
import type { Notification } from '../../types/notification';
import type { PurchaseRequest } from '../../types/purchaseRequest';
import { getPurchaseRequestApi } from '../../api/purchaseRequests';
import { PrDetailsModal } from '../procurement/PrDetailsModal';
import { useAuth } from '../../context/AuthContext';
import { resolveNotificationAction, isAllowedNotificationForUser } from '../../utils/notificationRouting';
import {
  onForegroundMessage,
  showNativeSystemNotification,
  requestAndRegisterPushToken,
} from '../../services/pushNotificationService';
import { formatTime12h } from '../../utils/dateTime';
import {
  isNotificationSoundEnabled,
  setNotificationSoundEnabled,
  playNotificationSound,
} from '../../utils/notificationSound';
import {
  broadcastNotificationCount,
  getCachedNotificationCount,
  useNotificationCount,
} from '../../utils/notificationBadge';

export const NotificationBell: React.FC = () => {
  const { user } = useAuth();
  const count = useNotificationCount();
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => isNotificationSoundEnabled());
  const [recentNotifications, setRecentNotifications] = useState<Notification[]>([]);
  const [latestToast, setLatestToast] = useState<Notification | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewPr, setPreviewPr] = useState<PurchaseRequest | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoadingId, setPreviewLoadingId] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownOpenRef = useRef(dropdownOpen);
  dropdownOpenRef.current = dropdownOpen;
  const navigate = useNavigate();

  const [pushPerm, setPushPerm] = useState<string>(() => {
    return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
  });
  const [pushActivating, setPushActivating] = useState(false);
  const [pushBannerMsg, setPushBannerMsg] = useState<string | null>(null);

  // 1. Lightweight count check (0.1 kB) - default background operation
  const fetchUnreadCountOnly = async () => {
    try {
      const unreadCount = await getUnreadNotificationCountApi().catch(() => 0);
      if (typeof unreadCount === 'number') {
        broadcastNotificationCount(unreadCount);
      }
    } catch {
      // Keep silent on transient connection issues
    }
  };

  // 2. Full notification list (13.7 kB) - only fetched on-demand when opening drawer or refreshing open drawer
  const fetchNotificationsList = async () => {
    try {
      setLoading(true);
      const [unreadCount, list] = await Promise.all([
        getUnreadNotificationCountApi().catch(() => 0),
        getNotificationsApi().catch(() => []),
      ]);
      const filtered = (list || []).filter((n) => isAllowedNotificationForUser(n, user));
      if (typeof unreadCount === 'number') {
        broadcastNotificationCount(unreadCount);
      }
      setRecentNotifications(filtered.slice(0, 6));
    } catch {
      // Keep silent on transient connection issues
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    // Initial fast badge fetch
    void fetchUnreadCountOnly();

    // Ensure push token is synced on mobile if permission was granted
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      void requestAndRegisterPushToken().catch(() => {});
    }

    // Deduplication tracking: keep set of recently handled notification IDs
    const seenNotificationIds = new Set<number>();

    const handleReceived = (event: Event) => {
      const notification = (event as CustomEvent<Notification>).detail;
      if (!notification || !mounted) return;
      if (!isAllowedNotificationForUser(notification, user)) return;

      // Deduplication: ignore if recently handled to prevent duplicate SSE + API events
      if (seenNotificationIds.has(notification.id)) {
        return;
      }
      seenNotificationIds.add(notification.id);
      if (seenNotificationIds.size > 200) {
        // Prevent memory leak
        const first = seenNotificationIds.values().next().value;
        if (first !== undefined) seenNotificationIds.delete(first);
      }

      setRecentNotifications((prev) => [notification, ...prev.filter((n) => n.id !== notification.id)].slice(0, 6));
      if (!notification.read_at) {
        broadcastNotificationCount(getCachedNotificationCount() + 1);
      }

      const action = resolveNotificationAction(notification, user);

      // Smart Selective Toast: Only trigger intrusive Toast for actionable / critical / returned events
      const shouldShowToast =
        action.isActionable ||
        action.priority === 'URGENT' ||
        action.priority === 'HIGH' ||
        (notification.type || '').includes('returned') ||
        (notification.type || '').includes('rejected') ||
        (notification.type || '').includes('failed');

      // Play custom notification chime
      void playNotificationSound(shouldShowToast ? 'urgent' : 'default');

      if (shouldShowToast) {
        setLatestToast(notification);

        // Trigger native mobile/browser system tray notification and vibration
        showNativeSystemNotification(notification.title || 'إشعار جديد يتطلب الإجراء', {
          body: notification.message || 'لديك معاملة جديدة تتطلب اتخاذ قرارك.',
          tag: `notif-${notification.id}`,
          data: { url: action.url },
        });

        window.setTimeout(() => {
          if (mounted) setLatestToast(null);
        }, 7000);
      }
    };

    const handleUpdated = (event?: Event) => {
      const custom = event as CustomEvent<{ optimistic?: boolean; id?: number; read_at?: string; unread_count?: number }>;
      if (custom?.detail?.optimistic) {
        if (typeof custom.detail.unread_count === 'number') {
          broadcastNotificationCount(custom.detail.unread_count);
        }
        if (custom.detail.id) {
          setRecentNotifications((prev) =>
            prev.map((n) => (n.id === custom.detail.id ? { ...n, read_at: custom.detail.read_at || new Date().toISOString() } : n))
          );
        }
        return; // Don't wipe optimistic update with a race-condition network poll
      }
      if (dropdownOpenRef.current) {
        void fetchNotificationsList();
      } else {
        void fetchUnreadCountOnly();
      }
    };

    // Foreground FCM listener
    const unsubscribeFcm = onForegroundMessage((payload) => {
      if (!mounted) return;
      void playNotificationSound('default');
      if (dropdownOpenRef.current) {
        void fetchNotificationsList();
      } else {
        void fetchUnreadCountOnly();
      }
      const title = payload.notification?.title || payload.data?.title || 'إشعار فوري جديد';
      const body = payload.notification?.body || payload.data?.body || 'لديك تحديث جديد بالنظام.';
      // Same tag as the server push, so the two mounted bells (mobile + desktop header)
      // and a repeat push for the same document collapse into one system notification.
      const notifiableType = String(payload.data?.notifiable_type || '').split('\\').pop();
      const notifiableId = payload.data?.notifiable_id;
      const tag = notifiableType && notifiableId
        ? `ishbilia-${notifiableType}-${notifiableId}`
        : `ishbilia-${title}-${body}`.slice(0, 120);
      showNativeSystemNotification(title, { body, tag, data: { url: payload.data?.url || '/notifications' } });
    });

    // Mobile visibility and focus listeners (instant sync when phone is unlocked or tab is opened)
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        if (dropdownOpenRef.current) {
          void fetchNotificationsList();
        } else {
          void fetchUnreadCountOnly();
        }
      }
    };

    startNotificationsRealtime();
    window.addEventListener('notification-received', handleReceived as EventListener);
    window.addEventListener('notifications-updated', handleUpdated);
    window.addEventListener('app-data-updated', handleUpdated);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);

    // Smart notification heartbeat: 20s interval for lightweight count (saves 99% bandwidth & CPU)
    const pollInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        if (dropdownOpenRef.current) {
          void fetchNotificationsList();
        } else {
          void fetchUnreadCountOnly();
        }
      }
    }, 20000);

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      mounted = false;
      stopNotificationsRealtime();
      unsubscribeFcm();
      window.clearInterval(pollInterval);
      window.removeEventListener('notification-received', handleReceived as EventListener);
      window.removeEventListener('notifications-updated', handleUpdated);
      window.removeEventListener('app-data-updated', handleUpdated);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [user]);

  const handleToggleDropdown = () => {
    setDropdownOpen((prev) => {
      const next = !prev;
      if (next) {
        void fetchNotificationsList();
      }
      return next;
    });
  };

  const handleNotificationClick = (notification: Notification) => {
    setLatestToast(null);
    setDropdownOpen(false);

    // Resolve target route
    const { url } = resolveNotificationAction(notification, user);

    // Instant Optimistic UI Update: decrement count & update styling immediately without waiting for API
    if (!notification.read_at) {
      const nowIso = new Date().toISOString();
      const nextCount = Math.max(0, count - 1);
      broadcastNotificationCount(nextCount);
      setRecentNotifications((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, read_at: nowIso } : n))
      );
      window.dispatchEvent(
        new CustomEvent('notifications-updated', {
          detail: { id: notification.id, read_at: nowIso, optimistic: true, unread_count: nextCount },
        })
      );

      // Background API call to persist on server and reconcile unread count
      markNotificationAsReadApi(notification.id)
        .then((res) => {
          if (typeof res?.unread_count === 'number') {
            broadcastNotificationCount(res.unread_count);
          }
        })
        .catch((err) => {
          console.error('Error marking notification as read:', err);
        });
    }

    navigate(url);
  };

  const handleQuickPreview = async (e: React.MouseEvent, prId: number) => {
    e.stopPropagation();
    try {
      setPreviewLoadingId(prId);
      const prData = await getPurchaseRequestApi(prId);
      setPreviewPr(prData);
      setPreviewOpen(true);
    } catch (err) {
      console.error('Failed to load preview for PR', prId, err);
    } finally {
      setPreviewLoadingId(null);
    }
  };

  const handleMarkAllRead = async () => {
    if (count === 0) return;
    setLoading(true);
    // Instant Optimistic Update
    broadcastNotificationCount(0);
    const nowIso = new Date().toISOString();
    setRecentNotifications((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at || nowIso }))
    );
    window.dispatchEvent(
      new CustomEvent('notifications-updated', {
        detail: { optimistic: true, unread_count: 0 },
      })
    );
    try {
      await markAllNotificationsAsReadApi();
    } catch (err) {
      console.error('Failed to mark all as read', err);
      void fetchNotificationsList();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button with Subtle Pulse */}
      <button
        type="button"
        onClick={handleToggleDropdown}
        className={`relative flex min-h-11 min-w-11 items-center justify-center rounded-xl p-2 text-slate-300 hover:bg-white/[0.06] hover:text-gold-300 transition-all cursor-pointer ${
          count > 0 ? 'animate-subtle-pulse text-gold-400' : ''
        }`}
        aria-label="الإشعارات"
        title="الإشعارات والتنبيهات"
      >
        <svg
          className={`w-5 h-5 transition-transform duration-300 ${count > 0 ? 'text-gold-400' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-gradient-to-r from-rose-500 via-rose-600 to-amber-600 text-white text-[10px] font-black flex items-center justify-center border border-white/20 shadow-lg shadow-rose-600/40">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {/* Realtime Toast Popover with Smooth Slide-in & Luxury Frosted Glass */}
      {latestToast && !dropdownOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setLatestToast(null)} />
          <div
            className="fixed inset-x-3 top-14 sm:inset-auto sm:left-0 sm:top-12 z-50 sm:w-80 rounded-2xl border border-gold-500/50 bg-slate-950/90 p-4 text-right shadow-2xl animate-slide-in-right backdrop-blur-2xl gold-glow"
            dir="rtl"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="flex items-center gap-1.5 text-xs font-black text-gold-300">
                <span>⚡</span> إشعار عاجل جديد
              </span>
              <button
                type="button"
                onClick={() => setLatestToast(null)}
                className="flex items-center gap-1 text-slate-400 hover:text-rose-400 text-xs font-bold px-2 py-0.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-rose-950/40 transition-colors cursor-pointer"
                title="إغلاق الإشعار"
              >
                <span>✕</span>
                <span>إغلاق</span>
              </button>
            </div>
            <p className="mt-2 text-sm font-bold text-slate-100">{latestToast.title}</p>
            <p className="mt-1 text-xs leading-5 text-slate-300 line-clamp-2">{latestToast.message}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => handleNotificationClick(latestToast)}
                className="flex-1 rounded-xl bg-gradient-to-r from-[#d4a84e] via-[#c5933d] to-[#a47430] hover:from-[#e2be76] hover:to-[#b88334] px-3 py-2 text-xs font-black text-slate-950 transition-all shadow-md shadow-gold-950/50 text-center cursor-pointer hover:-translate-y-0.5 active:translate-y-0"
              >
                {resolveNotificationAction(latestToast, user).actionLabel} ←
              </button>
            </div>
          </div>
        </>
      )}

      {/* Mobile Backdrop */}
      {dropdownOpen && (
        <div
          onClick={() => setDropdownOpen(false)}
          className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-40 sm:hidden animate-fade-in"
        />
      )}

      {/* Interactive Notifications Dropdown with Frosted Glass */}
      {dropdownOpen && (
        <div
          className="fixed inset-x-3 top-[4.25rem] sm:inset-auto sm:left-0 sm:top-12 z-50 sm:w-96 max-h-[calc(100dvh-5rem)] rounded-2xl border border-white/10 bg-slate-900/90 backdrop-blur-2xl shadow-2xl shadow-black/90 overflow-hidden animate-fade-in text-right flex flex-col"
          dir="rtl"
        >
          {/* Header with Close and Mark All buttons */}
          <div className="flex items-center justify-between border-b border-white/5 bg-slate-950/90 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-black text-slate-100">الإشعارات والتنبيهات</span>
              {count > 0 && (
                <span className="rounded-full bg-rose-500/20 text-rose-300 border border-rose-600/40 px-2 py-0.5 text-[10px] font-bold">
                  {count} جديد
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Sound Mute/Unmute Toggle */}
              <button
                type="button"
                onClick={() => {
                  const next = !soundEnabled;
                  setSoundEnabled(next);
                  setNotificationSoundEnabled(next);
                  if (next) {
                    void playNotificationSound('success');
                  }
                }}
                className={`flex items-center gap-1 rounded-lg border px-1.5 py-1 text-xs font-bold transition-colors cursor-pointer ${
                  soundEnabled
                    ? 'border-cyan-700/60 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-900/60'
                    : 'border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title={soundEnabled ? 'صوت الإشعارات مفعّل (انقر للكتم أو التجربة)' : 'صوت الإشعارات مكتوم (انقر للتفعيل)'}
              >
                <span className="text-xs">{soundEnabled ? '🔔' : '🔕'}</span>
                <span className="text-[10px] hidden sm:inline">{soundEnabled ? 'صوت' : 'صامت'}</span>
              </button>

              {count > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  disabled={loading}
                  className="text-[11px] font-bold text-cyan-400 hover:text-cyan-300 disabled:opacity-50 cursor-pointer"
                >
                  تحديد الكل كمقروء
                </button>
              )}

              {/* Explicit Close Button */}
              <button
                type="button"
                onClick={() => setDropdownOpen(false)}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs font-bold text-slate-300 hover:border-rose-500/60 hover:bg-rose-950/40 hover:text-rose-300 transition-colors cursor-pointer"
                aria-label="إغلاق نافذة الإشعارات"
                title="إغلاق نافذة الإشعارات"
              >
                <span>✕</span>
                <span className="text-[11px]">إغلاق</span>
              </button>
            </div>
          </div>

          {/* Mobile/Tablet Permission Banner to activate Notifications & Badge */}
          {typeof window !== 'undefined' && 'Notification' in window && (
            pushPerm === 'denied' ? (
              <div className="bg-rose-950/80 border-b border-rose-800/70 px-3 py-2 text-xs text-rose-200 animate-fade-in space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-bold text-[11px] text-rose-300">
                    <span>⚠️</span>
                    <span>إذن الإشعارات محظور في متصفح التابلت</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPushPerm(Notification.permission);
                    }}
                    className="text-[10px] text-cyan-400 underline hover:text-cyan-300 cursor-pointer"
                  >
                    إعادة الفحص 🔄
                  </button>
                </div>
                <p className="text-[10px] text-slate-300 leading-tight">
                  اضغط على رمز القفل 🔒 أعلى المتصفح بجانب الرابط، ثم اختر (أذونات الموقع ← الإشعارات ← سماح).
                </p>
              </div>
            ) : pushPerm !== 'granted' ? (
              <div className="bg-amber-950/70 border-b border-amber-800/60 px-3 py-2 text-xs text-amber-200 animate-fade-in space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base shrink-0">📱</span>
                    <span className="text-[11px] leading-tight font-medium">لتفعيل وصول الإشعارات على التابلت:</span>
                  </div>
                  <button
                    type="button"
                    disabled={pushActivating}
                    onClick={async (e) => {
                      e.stopPropagation();
                      setPushActivating(true);
                      setPushBannerMsg(null);
                      try {
                        const res = await requestAndRegisterPushToken();
                        setPushPerm(Notification.permission);
                        if (res.success) {
                          broadcastNotificationCount(count);
                          setPushBannerMsg('تم تفعيل إشعارات التابلت بنجاح! 🔔');
                        } else {
                          setPushBannerMsg(res.error || 'تعذر التفعيل.');
                        }
                      } finally {
                        setPushActivating(false);
                      }
                    }}
                    className="shrink-0 bg-amber-500 hover:bg-amber-400 text-slate-950 px-2.5 py-1 rounded-lg font-black text-[11px] shadow-sm transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {pushActivating ? 'جاري...' : 'تفعيل الإذن 🔔'}
                  </button>
                </div>
                {pushBannerMsg && (
                  <div className="text-[10px] text-amber-300 font-bold bg-slate-900/80 p-1.5 rounded mt-1 border border-amber-700/50">
                    {pushBannerMsg}
                  </div>
                )}
              </div>
            ) : null
          )}

          {/* List */}
          <div className="max-h-[min(60vh,380px)] overflow-y-auto divide-y divide-slate-800/60">
            {recentNotifications.length > 0 ? (
              recentNotifications.map((n) => {
                const action = resolveNotificationAction(n, user);
                const isUnread = !n.read_at;
                const prId = n.data?.purchase_request_id || (n.notifiable_type?.includes('PurchaseRequest') ? n.notifiable_id : null);
                const nType = (n.type || '').toLowerCase();
                const isSupplementNotification = nType.includes('supplement') || nType.includes('pr_supplement') || n.data?.is_supplementary || n.data?.supplement_id;
                const isUrgentSupplement = isSupplementNotification && (action.priority === 'URGENT' || isUnread);

                return (
                  <div
                    key={n.id}
                    onClick={() => handleNotificationClick(n)}
                    className={`p-3.5 transition-all cursor-pointer space-y-2 border-b border-slate-800/60 ${
                      isUrgentSupplement
                        ? 'bg-gradient-to-r from-amber-950/40 via-slate-900 to-amber-950/20 border-r-4 border-amber-500 hover:bg-amber-900/30 shadow-inner ring-1 ring-amber-500/30 animate-pulse'
                        : isUnread
                        ? 'bg-gradient-to-r from-cyan-950/50 via-slate-900 to-cyan-950/20 border-r-4 border-cyan-400 hover:bg-cyan-900/30 shadow-inner'
                        : 'bg-slate-950/70 border-r-4 border-slate-700/40 opacity-75 hover:opacity-100 hover:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-base shrink-0">{action.icon}</span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-xs ${isUnread ? 'font-black text-cyan-100' : 'font-bold text-slate-300'}`}>
                              {n.title}
                            </span>
                            {isUnread ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shrink-0">
                                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                                غير مقروء
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-slate-800/90 text-slate-400 border border-slate-700/50 shrink-0">
                                ✓ مقروء
                              </span>
                            )}
                            {isSupplementNotification && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/50 shrink-0 animate-pulse">
                                <span>⚡</span> كمالة عاجلة
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className="text-[11px] font-bold text-slate-400 shrink-0">
                        {formatTime12h(n.created_at)}
                      </span>
                    </div>

                    <p className={`text-xs leading-5 line-clamp-2 ${isUnread ? 'text-slate-200' : 'text-slate-400'}`}>
                      {n.message}
                    </p>

                    {/* Operational Core 4 Fields Strip (القطعة، المنطقة، الصنف، الكمية) */}
                    {(() => {
                      const data = (n as any).data || {};
                      let parcel = data.parcel_reference;
                      let region = data.region;
                      let item = data.item_description;
                      let qty = data.quantity;

                      if (!parcel && n.message) {
                        const parcelMatch = n.message.match(/القطعة:\s*([^|•\n]+)/);
                        if (parcelMatch) parcel = parcelMatch[1].trim();
                      }
                      if (!region && n.message) {
                        const regionMatch = n.message.match(/المنطقة:\s*([^|•\n]+)/);
                        if (regionMatch) region = regionMatch[1].trim();
                      }
                      if (!item && n.message) {
                        const itemMatch = n.message.match(/الصنف:\s*([^|•\n]+)/);
                        if (itemMatch) item = itemMatch[1].trim();
                      }
                      if (!qty && n.message) {
                        const qtyMatch = n.message.match(/الكمية:\s*([^|•\n]+)/);
                        if (qtyMatch) qty = qtyMatch[1].trim();
                      }

                      if (!parcel && !region && !item && !qty) return null;

                      return (
                        <div className="flex items-center gap-1.5 flex-wrap text-[10px] bg-slate-950/90 border border-slate-800 rounded-lg px-2 py-1 text-slate-300">
                          {parcel && <span className="text-cyan-300 font-mono font-bold">🏷️ {parcel}</span>}
                          {region && <span className="text-amber-300 font-bold">📍 {region}</span>}
                          {item && <span className="text-slate-100 font-bold truncate max-w-[150px]" title={item}>📦 {item}</span>}
                          {qty && <span className="text-emerald-300 font-mono font-bold">⚖️ {qty}</span>}
                        </div>
                      );
                    })()}

                    <div className="flex items-center justify-between pt-1 gap-2 flex-wrap">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                        isUnread
                          ? 'bg-cyan-950/80 text-cyan-300 border-cyan-800/70'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}>
                        {action.badgeLabel}
                      </span>
                      
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {/* Quick Preview Button */}
                        {Boolean(prId) && (
                          <button
                            type="button"
                            onClick={(e) => handleQuickPreview(e, Number(prId))}
                            disabled={previewLoadingId === Number(prId)}
                            className="flex items-center gap-1 rounded-lg border border-cyan-800/70 bg-cyan-950/70 px-2 py-1 text-[10px] font-bold text-cyan-300 hover:border-cyan-400 hover:bg-cyan-900/80 transition-all cursor-pointer disabled:opacity-50"
                            title="معاينة تفاصيل الطلب وبنوده مباشرة"
                          >
                            <span>👁️</span>
                            <span>{previewLoadingId === Number(prId) ? 'جارٍ التحميل...' : 'معاينة سريعة'}</span>
                          </button>
                        )}

                        {/* Direct Action Button */}
                        <button
                          type="button"
                          onClick={() => handleNotificationClick(n)}
                          className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-black transition-all cursor-pointer ${
                            isUnread
                              ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-xs'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                          }`}
                        >
                          <span>{action.actionLabel}</span>
                          <span>←</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="p-8 text-center text-xs text-slate-500">
                <span className="text-2xl block mb-2">📭</span>
                لا توجد إشعارات حالياً
              </div>
            )}
          </div>

          {/* Footer Actions with Full Center link and Close Button */}
          <div className="border-t border-slate-800 bg-slate-950/90 p-2.5 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setDropdownOpen(false);
                navigate('/notifications');
              }}
              className="flex-1 text-xs font-bold text-slate-300 hover:text-cyan-400 transition-colors py-1 text-right"
            >
              عرض مركز الإشعارات الكامل ←
            </button>

            <button
              type="button"
              onClick={() => setDropdownOpen(false)}
              className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
            >
              إغلاق النافذة
            </button>
          </div>
        </div>
      )}

      {/* Quick Preview Modal */}
      {previewPr && (
        <PrDetailsModal
          pr={previewPr}
          isOpen={previewOpen}
          onClose={() => {
            setPreviewOpen(false);
            setPreviewPr(null);
          }}
        />
      )}
    </div>
  );
};

export default NotificationBell;
