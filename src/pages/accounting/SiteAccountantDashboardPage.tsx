import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../../components/ui/Button';
import { Card, KpiPill, KpiPillsBar } from '../../components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import ActionRequiredInbox, { ActionInboxItem } from '../../components/dashboard/ActionRequiredInbox';
import QuickLauncherBar from '../../components/dashboard/QuickLauncherBar';
import ErrorMessage from '../../components/ErrorMessage';
import LoadingSpinner from '../../components/LoadingSpinner';
import { parseApiError } from '../../utils/apiError';
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh';
import {
  ApprovedReceipt,
  SupplierInvoice,
  getApprovedReceiptsForAccountingApi,
  getSupplierInvoicesApi,
  matchSupplierInvoiceApi,
  markReceiptAsRecordedApi,
} from '../../api/supplierFinance';
import { getAccountingPurchaseOrdersApi } from '../../api/accounting';
import { getOwnPurchaseRequestsApi, submitPurchaseRequestApi } from '../../api/purchaseRequests';
import { getAccountingPendingMaterialTransfersApi } from '../../api/materialTransfers';
import { PurchaseOrder } from '../../types/purchaseOrder';
import { PurchaseRequest } from '../../types/purchaseRequest';
import { MaterialTransferRequest } from '../../types/materialTransfer';
import { getUnitLabel } from '../../utils/units';
import { formatCleanNumber } from '../../utils/numberFormat';
import ThreeWayMatchPrintModal from '../../components/accounting/ThreeWayMatchPrintModal';
import { InvoiceRegistrationModal } from '../../components/accounting/InvoiceRegistrationModal';
import { DocumentStatusButtons, getInvoiceDocumentButtons, getReceiptDocumentButtons } from '../../components/accounting/DocumentStatusButtons';
import { shareReceiptOnWhatsApp } from '../../utils/whatsapp';
import { getSummaryParcels, getSummaryRegions, getSummaryQuantities, getItemsSummaryDisplay } from '../../utils/formatRequestSummary';
import { formatDateTime24h } from '../../utils/dateTime';
import { getActualPoLineItems, calculateActualPoGrandTotal } from '../../utils/actualPo';

const cleanDate = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');
const money = (value: string | number | null | undefined) =>
  `${formatCleanNumber(value)} ج.م`;

const receiptValue = (receipt: ApprovedReceipt) => {
  const po = receipt.purchase_order;
  if (po) {
    const total = calculateActualPoGrandTotal(po);
    if (total > 0) return total;
  }
  return (receipt.items || [])
    .filter((it) => Number(it.received_quantity ?? 0) > 0)
    .reduce((sum, item) => {
      const poItem = item.purchase_order_item;
      const poQty = Number(item.received_quantity ?? poItem?.quantity ?? 0);
      const unitPrice = Number(poItem?.unit_price || 0);
      const lineTotal = poItem?.line_total !== undefined && poItem?.line_total !== null && Number(poItem.line_total) > 0
        ? Number(poItem.line_total)
        : Math.round(poQty * unitPrice * 100) / 100;
      return sum + lineTotal;
    }, 0);
};

export const SiteAccountantDashboardPage: React.FC = () => {
  const { user, hasRole } = useAuth();
  const [receipts, setReceipts] = useState<ApprovedReceipt[]>([]);
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [ownRequests, setOwnRequests] = useState<PurchaseRequest[]>([]);
  const [transfers, setTransfers] = useState<MaterialTransferRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'RECEIPTS' | 'INVOICES' | 'ORDERS' | 'MY_REQUESTS'>('RECEIPTS');
  const [receiptsFilter, setReceiptsFilter] = useState<'pending' | 'recorded' | 'all'>('pending');
  const [recordedReceipts, setRecordedReceipts] = useState<ApprovedReceipt[]>([]);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<number | null>(null);
  const [selectedCycleReceipt, setSelectedCycleReceipt] = useState<ApprovedReceipt | null>(null);
  const [registerInvoiceReceipt, setRegisterInvoiceReceipt] = useState<ApprovedReceipt | null>(null);
  const [sharingWhatsAppReceiptId, setSharingWhatsAppReceiptId] = useState<number | null>(null);

  const handleWhatsAppShare = async (receipt: ApprovedReceipt) => {
    if (sharingWhatsAppReceiptId) return;
    setSharingWhatsAppReceiptId(receipt.id);
    try {
      await shareReceiptOnWhatsApp(receipt, receiptValue(receipt), {
        po: receipt.purchase_order,
      });
    } catch (err) {
      console.error('WhatsApp share error:', err);
    } finally {
      setSharingWhatsAppReceiptId(null);
    }
  };

  const loadDashboardData = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [receiptsData, recordedData, invoicesData, posData, requestsData, transfersData] = await Promise.all([
        getApprovedReceiptsForAccountingApi({ status: 'pending' }).catch(() => []),
        getApprovedReceiptsForAccountingApi({ recorded: true }).catch(() => []),
        getSupplierInvoicesApi().catch(() => []),
        getAccountingPurchaseOrdersApi().catch(() => []),
        getOwnPurchaseRequestsApi().catch(() => []),
        getAccountingPendingMaterialTransfersApi().catch(() => ({ data: [] })),
      ]);
      setReceipts(receiptsData || []);
      setRecordedReceipts(recordedData || []);
      setInvoices(invoicesData || []);
      setPurchaseOrders(posData || []);
      setOwnRequests(requestsData || []);
      setTransfers(transfersData?.data || []);
    } catch (err) {
      if (!silent) setError(parseApiError(err).message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleMarkRecorded = async (receiptId: number, notes?: string) => {
    setRecordingId(receiptId);
    try {
      await markReceiptAsRecordedApi(receiptId, notes);
      setActionSuccess('تم تأكيد تسجيل المعاملة في شيت الإكسيل الخارجي بنجاح ✅');
      await loadDashboardData(true);
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setRecordingId(null);
    }
  };

  useEffect(() => {
    void loadDashboardData(false);
  }, []);

  useRealtimeRefresh(() => {
    void loadDashboardData(true);
  });

  const pendingMatchInvoices = useMemo(
    () => invoices.filter((inv) => inv.matching_status === 'PENDING'),
    [invoices]
  );

  const draftRequests = useMemo(
    () => ownRequests.filter((r) => r.status === 'DRAFT'),
    [ownRequests]
  );

  const accountantScope = useMemo(() => {
    if (hasRole('development_accountant')) {
      return {
        dashboardTitle: 'لوحة حسابات التطوير والتسويق والمبيعات',
        defaultName: 'المهندس أحمد',
        deptBadge: 'التطوير • التسويق • المبيعات',
        inboxTitle: 'المهام والإجراءات العاجلة للأقسام المسندة (تطوير • تسويق • مبيعات)',
        defaultDeptName: 'قسم التطوير / التسويق / المبيعات',
        scopeDescription: 'متابعة أذونات استلام وأوامر شراء أقسام التطوير والتسويق والمبيعات، تسجيل فواتير الموردين، وإجراء المطابقة الثلاثية.',
      };
    }
    if (hasRole('licenses_accountant')) {
      return {
        dashboardTitle: 'لوحة حسابات التراخيص',
        defaultName: 'د. عزة',
        deptBadge: 'قسم التراخيص',
        inboxTitle: 'المهام والإجراءات العاجلة المطلوبة منك الآن',
        defaultDeptName: 'قسم التراخيص',
        scopeDescription: 'متابعة أذونات استلام وأوامر شراء التراخيص، تسجيل فواتير الموردين، وإصدار طلبات الشراء.',
      };
    }
    if (hasRole('buffet_accountant')) {
      return {
        dashboardTitle: 'لوحة حسابات المكتبيات والبوفيه',
        defaultName: 'المهندسة شروق',
        deptBadge: 'قسم المكتبيات والبوفيه',
        inboxTitle: 'المهام والإجراءات العاجلة المطلوبة منكِ الآن',
        defaultDeptName: 'المكتبيات والبوفيه',
        scopeDescription: 'متابعة أذونات استلام وأوامر شراء المكتبيات والبوفيه، تسجيل فواتير الموردين، وإصدار طلبات الشراء.',
      };
    }
    if (hasRole('general_accountant')) {
      return {
        dashboardTitle: 'لوحة حسابات (التنفيذ • التشطيبات • المباني • المكتبيات)',
        defaultName: 'المهندسة حبيبة',
        deptBadge: 'التنفيذ • التشطيبات • المباني • المكتبيات',
        inboxTitle: 'المهام والإجراءات العاجلة للأقسام المسندة (تنفيذ • تشطيبات • مباني • مكتبيات)',
        defaultDeptName: 'التنفيذ / التشطيبات / المباني / المكتبيات',
        scopeDescription: 'متابعة أذونات استلام وأوامر شراء أقسام التنفيذ والتشطيبات والمباني والمكتبيات، تسجيل فواتير الموردين، وإجراء المطابقة الثلاثية.',
      };
    }
    return {
      dashboardTitle: 'لوحة متابعة الحسابات',
      defaultName: 'المحاسب',
      deptBadge: 'الحسابات',
      inboxTitle: 'المهام والإجراءات العاجلة المطلوبة منك الآن',
      defaultDeptName: 'الأقسام المسندة',
      scopeDescription: 'متابعة المهام والإجراءات العاجلة، تسجيل فواتير الموردين، ومطابقة أذونات الاستلام.',
    };
  }, [user, hasRole]);

  // Helper to build items list for a receipt strictly relying on Actual PO
  const buildReceiptItemsList = (receipt: ApprovedReceipt) => {
    const po = receipt.purchase_order;
    if (po) {
      const actualItems = getActualPoLineItems(po);
      if (actualItems.length > 0) {
        return actualItems.map((poi: any) => {
          const poQty = Number(poi.quantity ?? poi.actual_quantity ?? 0);
          const unitPrice = Number(poi.unit_price || 0);
          const lineTotal = poi.line_total !== undefined && poi.line_total !== null && Number(poi.line_total) > 0
            ? Number(poi.line_total)
            : Math.round(poQty * unitPrice * 100) / 100;
          return {
            description: poi.item_name || poi.item_description || 'صنف',
            quantity: poQty,
            uom: poi.uom,
            specifications: poi.specifications,
            parcel: poi.item_reference,
            region: poi.region,
            unit_price: unitPrice,
            line_total: lineTotal,
          };
        });
      }
    }

    return (receipt.items || [])
      .filter((it) => Number(it.received_quantity ?? 0) > 0)
      .map((it) => {
        const poItem = it.purchase_order_item;
        const poQty = Number(it.received_quantity ?? poItem?.quantity ?? poItem?.actual_quantity ?? 0);
        const unitPrice = Number(poItem?.unit_price || 0);
        const lineTotal = poItem?.line_total !== undefined && poItem?.line_total !== null && Number(poItem.line_total) > 0
          ? Number(poItem.line_total)
          : Math.round(poQty * unitPrice * 100) / 100;
        return {
          description: poItem?.item_name || poItem?.item_description || 'صنف',
          quantity: poQty,
          uom: poItem?.uom,
          specifications: poItem?.specifications,
          parcel: poItem?.item_reference,
          region: poItem?.region,
          unit_price: unitPrice,
          line_total: lineTotal,
        };
      });
  };

  // Build Action Required Inbox Items
  const actionInboxItems: ActionInboxItem[] = useMemo(() => {
    const items: ActionInboxItem[] = [];

    // 1. Approved Receipts waiting for recording
    for (const receipt of receipts) {
      const po = receipt.purchase_order;
      const isActualPo = Boolean(po?.finalized_at);
      const isSupplement = Boolean(
        (po as any)?.is_supplementary ||
        (receipt as any)?.is_supplementary ||
        po?.items?.some((i: any) => i.is_supplementary) ||
        receipt.items?.some((i: any) => (i.purchase_order_item as any)?.is_supplementary) ||
        (po as any)?.notes?.includes('كمالة') ||
        (po?.purchase_request as any)?.has_pending_supplement ||
        ((po?.purchase_request as any)?.supplements && (po?.purchase_request as any)?.supplements.length > 0)
      );
      const itemsList = buildReceiptItemsList(receipt);

      items.push({
        id: `rcpt-${receipt.id}`,
        rawId: receipt.id,
        type: 'RECEIPT',
        code: receipt.receipt_number,
        title: isSupplement
          ? (isActualPo ? '⚡ أمر شراء فعلي (طلب كمالة) بانتظار التسجيل' : '⚡ إذن استلام (طلب كمالة) بانتظار التسجيل')
          : (isActualPo ? 'أمر شراء فعلي معتمد بانتظار التسجيل' : 'إذن استلام معتمد بانتظار التسجيل'),
        subtitle: (isSupplement ? '⚡ طلب كمالة • ' : '') + (receipt.purchase_order?.supplier?.company_name || 'مورد غير محدد'),
        stageBadge: isSupplement ? {
          text: 'طلب كمالة',
          icon: '⚡',
          className: 'bg-amber-500/20 text-amber-300 border-amber-500/50',
        } : undefined,
        department: receipt.purchase_order?.purchase_request?.department?.name || accountantScope.defaultDeptName,
        supplier: receipt.purchase_order?.supplier?.company_name,
        amount: Number(po?.grand_total || 0) > 0
          ? Number(po?.grand_total)
          : receiptValue(receipt),
        urgency: 'HIGH',
        reason: isSupplement
          ? 'تم اعتماد استلام طلب كمالة في الموقع وينتظر تأكيد تسجيله في شيت الإكسيل الخارجي بواسطة المحاسب.'
          : 'تم اعتماد إذن الاستلام في الموقع وينتظر تأكيد تسجيله في شيت الإكسيل الخارجي بواسطة المحاسب.',
        actionUrl: `/accounting/supplier-finance?tab=payments&purchase_receipt_id=${receipt.id}`,
        actionLabel: 'تسجيل الفاتورة',
        onAction: () => {
          setRegisterInvoiceReceipt(receipt);
        },
        timeAgo: po?.purchase_request?.created_at ? formatDateTime24h(po.purchase_request.created_at) : (receipt.received_at ? formatDateTime24h(receipt.received_at) : cleanDate(receipt.received_at)),
        created_at: po?.purchase_request?.created_at || receipt.received_at || undefined,
        items_count: itemsList.length,
        items_list: itemsList,
        onDirectApprove: async (_item: any, comment?: string) => {
          await handleMarkRecorded(receipt.id, comment || undefined);
        },
        directApproveLabel: 'تم التسجيل',
        directApproveClassName: 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/40',
        directApproveIcon: <span>✓</span>,
        requireApproveModal: false,
        onPreviewReceipt: () => {
          setSelectedCycleReceipt(receipt);
        },
        documentSlot: <DocumentStatusButtons {...getReceiptDocumentButtons(receipt, () => setSelectedCycleReceipt(receipt))} />,
      });
    }

    // 2. Invoices waiting for three-way match
    for (const invoice of pendingMatchInvoices) {
      items.push({
        id: `inv-${invoice.id}`,
        rawId: invoice.id,
        type: 'INVOICE',
        code: invoice.invoice_number,
        title: 'فاتورة مورد مسجلة بانتظار المطابقة الثلاثية',
        subtitle: invoice.supplier?.company_name || 'مورد غير محدد',
        department: invoice.purchase_order?.purchase_request?.department?.name,
        supplier: invoice.supplier?.company_name,
        amount: invoice.amount,
        urgency: 'NORMAL',
        reason: 'فاتورة مورد تم إدخالها وتتطلب تنفيذ المطابقة الثلاثية لإرسالها للصرف المالي.',
        actionUrl: '/accounting/supplier-finance?tab=payments',
        actionLabel: 'تنفيذ المطابقة',
        documentSlot: <DocumentStatusButtons {...getInvoiceDocumentButtons(invoice)} />,
        timeAgo: invoice.purchase_order?.purchase_request?.created_at ? formatDateTime24h(invoice.purchase_order.purchase_request.created_at) : (invoice.created_at ? formatDateTime24h(invoice.created_at) : cleanDate(invoice.created_at || invoice.invoice_date)),
        created_at: (invoice.purchase_order?.purchase_request?.created_at || invoice.created_at || invoice.invoice_date) ?? undefined,
      });
    }

    // 3. Draft PRs created by this site accountant
    for (const pr of draftRequests) {
      items.push({
        id: `pr-${pr.id}`,
        rawId: pr.id,
        type: 'PR',
        code: pr.request_number,
        title: pr.justification || 'مسودة طلب شراء',
        subtitle: `طلب شراء - ${pr.items?.length || 0} بنود`,
        department: pr.department?.name,
        urgency: 'NORMAL',
        reason: 'مسودة طلب شراء محفوظة لديك وجاهزة للإرسال لدورة المراجعة والاعتماد.',
        actionUrl: `/requests/${pr.id}`,
        actionLabel: 'إرسال للاعتماد',
        timeAgo: pr.created_at ? formatDateTime24h(pr.created_at) : cleanDate(pr.created_at || pr.date_needed),
        created_at: pr.created_at || undefined,
        items_count: pr.items?.length || 0,
        items_list: pr.items?.map((it) => ({
          description: it.item_description || it.item?.name || 'صنف',
          quantity: it.quantity,
          uom: it.uom,
          parcel: it.item_reference,
          region: it.region,
        })),
        onDirectSubmit: async () => {
          await submitPurchaseRequestApi(pr.id);
          setActionSuccess(`تم إرسال طلب الشراء ${pr.request_number} بنجاح ✅`);
          await loadDashboardData(true);
        },
      });
    }

    // 4. Pending Material Transfers waiting for accounting & archiving
    for (const mtr of transfers) {
      items.push({
        id: `mtr-${mtr.id}`,
        rawId: mtr.id,
        type: 'MATERIAL_TRANSFER',
        code: mtr.request_number,
        title: `طلب نقل خامات (${mtr.request_number}): من ${mtr.from_project} إلى ${mtr.to_project}`,
        subtitle: 'طلب نقل خامات معتمد بانتظار الإجراء المحاسبي والأرشفة',
        department: 'إدارة المشروعات',
        requester: mtr.user?.name,
        urgency: 'HIGH',
        reason: 'تم اعتماد الطلب فنيًا وبانتظار التوجيه المحاسبي وإتمام الأرشفة في أرشيف المنقولات',
        actionUrl: '/accounting/material-transfers',
        actionLabel: 'معالجة وأرشفة الطلب',
        created_at: mtr.created_at || undefined,
        timeAgo: mtr.created_at ? formatDateTime24h(mtr.created_at) : undefined,
        items_count: mtr.items?.length || 0,
        items_list: (mtr.items || []).map((it) => ({
          description: it.item_description,
          quantity: it.quantity,
          uom: it.uom,
        })),
      });
    }

    return items;
  }, [receipts, pendingMatchInvoices, draftRequests, transfers]);

  const handleMatchInvoice = async (invoice: SupplierInvoice) => {
    setError(null);
    try {
      await matchSupplierInvoiceApi(invoice.id);
      setActionSuccess(`تمت مطابقة الفاتورة ${invoice.invoice_number} بنجاح ✅`);
      await loadDashboardData(true);
    } catch (err) {
      setError(parseApiError(err).message);
    }
  };

  if (loading) {
    return <LoadingSpinner message="جاري تحميل لوحة متابعة الحسابات..." fullScreen />;
  }

  return (
    <div className="space-y-6 animate-fade-in" dir="rtl">
      {/* Header Banner */}
      <div className="flex flex-col gap-3 rounded-2xl border border-cyan-800/60 bg-gradient-to-r from-slate-900 via-slate-900/95 to-cyan-950/40 p-4 sm:p-5 shadow-xl sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-500/20 border border-cyan-400/50 text-2xl shadow-inner">
            📊
          </span>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-black text-slate-100">{accountantScope.dashboardTitle}</h1>
              <span className="rounded-xl border border-cyan-500/50 bg-cyan-950/80 px-2.5 py-0.5 text-[11px] font-black text-cyan-300">
                {user?.name || accountantScope.defaultName}
              </span>
              <span className="rounded-xl border border-amber-700/50 bg-amber-950/40 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                {accountantScope.deptBadge}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {accountantScope.scopeDescription}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap sm:shrink-0">
          <Link to="/accounting/supplier-finance">
            <Button variant="primary" size="sm" className="font-bold flex items-center gap-1.5 shadow-md shadow-cyan-950/40">
              <span>🧾</span>
              <span>تسجيل فاتورة مورد</span>
            </Button>
          </Link>
          <Link to="/requests/create">
            <Button variant="secondary" size="sm" className="font-bold flex items-center gap-1.5 border-amber-700/60 text-amber-200 hover:bg-amber-950/40">
              <span>✍️</span>
              <span>إنشاء طلب شراء جديد</span>
            </Button>
          </Link>
        </div>
      </div>

      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} onRetry={() => void loadDashboardData()} />}
      {actionSuccess && (
        <div className="rounded-xl border border-emerald-700/60 bg-emerald-950/40 p-3 text-xs font-bold text-emerald-300 flex items-center justify-between">
          <span>{actionSuccess}</span>
          <button type="button" onClick={() => setActionSuccess(null)} className="text-emerald-400 hover:text-white px-2">
            ✕
          </button>
        </div>
      )}

      {/* ── اختصارات الإجراءات السريعة (Quick Launcher Bar) ── */}
      <QuickLauncherBar className="mb-2" />

      {/* Action Required Inbox (الأخبار والمهام العاجلة المطلوبة فوراً) */}
      <ActionRequiredInbox
        title={accountantScope.inboxTitle}
        description="أذونات استلام معتمدة جاهزة للفوترة، وفواتير مسجلة تنتظر المطابقة، ومسودات طلباتك."
        roleName="قسم الحسابات"
        items={actionInboxItems}
        onItemActionComplete={() => void loadDashboardData(true)}
      />

      {/* KPI Pills Bar (Horizontal Slim Strip) */}
      <KpiPillsBar className="my-1">
        <KpiPill
          title="أذونات جاهزة للفوترة"
          value={receipts.length}
          accentColor="amber"
          icon={<span className="text-xs">🧾</span>}
          isActive={activeTab === 'RECEIPTS'}
          onClick={() => setActiveTab('RECEIPTS')}
          clickableHint="عرض أذونات الاستلام"
        />
        <Link to="/accounting/material-transfers">
          <KpiPill
            title="نقل خامات بانتظار الأرشفة"
            value={transfers.length}
            accentColor="cyan"
            icon={<span className="text-xs">🚚</span>}
            clickableHint="معالجة وأرشفة المنقولات ←"
          />
        </Link>
        <KpiPill
          title="فواتير بانتظار المطابقة"
          value={pendingMatchInvoices.length}
          accentColor="cyan"
          icon={<span className="text-xs">⏳</span>}
          isActive={activeTab === 'INVOICES'}
          onClick={() => setActiveTab('INVOICES')}
          clickableHint="عرض فواتير المطابقة"
        />
        <KpiPill
          title="إجمالي الفواتير المسجلة"
          value={invoices.length}
          accentColor="emerald"
          icon={<span className="text-xs">📑</span>}
          isActive={activeTab === 'INVOICES'}
          onClick={() => setActiveTab('INVOICES')}
          clickableHint="عرض أرشيف الفواتير"
        />
        <KpiPill
          title="أوامر الشراء الجارية"
          value={purchaseOrders.length}
          accentColor="slate"
          icon={<span className="text-xs">📋</span>}
          isActive={activeTab === 'ORDERS'}
          onClick={() => setActiveTab('ORDERS')}
          clickableHint="عرض أوامر الشراء"
        />
        <KpiPill
          title="طلبات الشراء الخاصة بي"
          value={ownRequests.length}
          accentColor="slate"
          icon={<span className="text-xs">✍️</span>}
          isActive={activeTab === 'MY_REQUESTS'}
          onClick={() => setActiveTab('MY_REQUESTS')}
          clickableHint="عرض طلبات الشراء"
        />
      </KpiPillsBar>

      {/* Tab 1: Approved Receipts with Sub-filter (Pending / Recorded / All) */}
      {activeTab === 'RECEIPTS' && (
        <Card className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-black text-slate-100 flex items-center gap-2">
                <span>🧾</span> إذونات الاستلام المعتمدة
                <span className="text-xs font-bold text-slate-400">
                  ({receiptsFilter === 'recorded' ? recordedReceipts.length : receiptsFilter === 'all' ? receipts.length + recordedReceipts.length : receipts.length})
                </span>
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                {receiptsFilter === 'pending' ? 'إذونات معتمدة بانتظار التسجيل في شيت الإكسيل الخارجي.' : receiptsFilter === 'recorded' ? 'إذونات تم تأكيد تسجيلها بواسطة المحاسب.' : 'جميع إذونات الاستلام المعتمدة.'}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Sub-filter toggle buttons */}
              <div className="flex rounded-xl border border-slate-700 overflow-hidden text-[11px] font-bold">
                <button
                  type="button"
                  onClick={() => setReceiptsFilter('pending')}
                  className={`px-3 py-1.5 transition-colors ${receiptsFilter === 'pending' ? 'bg-amber-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}
                >
                  ⏳ بانتظار التسجيل ({receipts.length})
                </button>
                <button
                  type="button"
                  onClick={() => setReceiptsFilter('recorded')}
                  className={`px-3 py-1.5 transition-colors border-x border-slate-700 ${receiptsFilter === 'recorded' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}
                >
                  ✅ تم التسجيل ({recordedReceipts.length})
                </button>
                <button
                  type="button"
                  onClick={() => setReceiptsFilter('all')}
                  className={`px-3 py-1.5 transition-colors ${receiptsFilter === 'all' ? 'bg-cyan-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}
                >
                  📋 الكل ({receipts.length + recordedReceipts.length})
                </button>
              </div>
              <Link to="/accounting/supplier-finance">
                <Button size="sm" variant="secondary" className="text-xs">
                  فتح شاشة الفوترة ←
                </Button>
              </Link>
            </div>
          </div>

          {(() => {
            const displayReceipts = receiptsFilter === 'recorded' ? recordedReceipts : receiptsFilter === 'all' ? [...receipts, ...recordedReceipts] : receipts;
            return displayReceipts.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>إذن الاستلام</TableHead>
                      <TableHead>أمر الشراء</TableHead>
                      <TableHead>المورد</TableHead>
                      <TableHead>ملخص البنود</TableHead>
                      <TableHead>رقم القطعة / المشروع</TableHead>
                      <TableHead>الكمية المستلمة</TableHead>
                      <TableHead>القسم</TableHead>
                      <TableHead>تاريخ الاستلام</TableHead>
                      <TableHead>قيمة المستلم</TableHead>
                      <TableHead>حالة التسجيل</TableHead>
                      <TableHead>الإجراء</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayReceipts.slice(0, 20).map((receipt) => {
                      const isRecorded = receipt.is_accountant_recorded || Boolean(receipt.accountant_recorded_at);
                      const isRecording = recordingId === receipt.id;
                      const receiptItemsForSummary = (receipt.items || []).map((it) => it.purchase_order_item || { item_description: 'صنف' });
                      const itemsDisplay = getItemsSummaryDisplay(receiptItemsForSummary);
                      const itemNames = receiptItemsForSummary.map((it) => it.item_description || (it as any).item_name || (it as any).item?.name).filter(Boolean);
                      const parcelsDisplay = getSummaryParcels(receipt);
                      const regionsDisplay = getSummaryRegions(receipt);
                      const quantitiesInfo = getSummaryQuantities(receipt.items?.map((it) => ({
                        quantity: it.received_quantity,
                        uom: it.purchase_order_item?.uom,
                        item_description: it.purchase_order_item?.item_description,
                      })));
                      const isSupplement = Boolean(
                        (receipt as any).is_supplementary ||
                        (receipt.purchase_order as any)?.is_supplementary ||
                        receipt.items?.some((it) => (it.purchase_order_item as any)?.is_supplementary) ||
                        receipt.purchase_order?.notes?.includes('كمالة') ||
                        (receipt.purchase_order?.purchase_request as any)?.has_pending_supplement
                      );
                      return (
                        <TableRow key={receipt.id} className={isRecorded ? 'opacity-80' : ''}>
                          <TableCell className="font-mono font-bold text-cyan-300 whitespace-nowrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span>{receipt.receipt_number}</span>
                              {isSupplement && (
                                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-black text-amber-300 border border-amber-500/50">
                                  ⚡ طلب كمالة
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono whitespace-nowrap">
                            {receipt.purchase_order?.po_number || '—'}
                          </TableCell>
                          <TableCell className="font-bold text-slate-200">
                            {receipt.purchase_order?.supplier?.company_name || '—'}
                          </TableCell>
                          <TableCell className="font-semibold text-slate-100 max-w-[170px] truncate text-xs">
                            <span title={itemNames.join('، ')}>{itemsDisplay}</span>
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            <div className="font-mono text-cyan-300 font-bold">{parcelsDisplay}</div>
                            {regionsDisplay !== '—' && (
                              <div className="text-[10px] text-copper-300">{regionsDisplay}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            <div title={quantitiesInfo.tooltip}>
                              <div className="font-mono font-bold text-amber-300">{quantitiesInfo.display}</div>
                              {quantitiesInfo.subtext && (
                                <div className="text-[10px] text-slate-400 font-normal leading-tight">{quantitiesInfo.subtext}</div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-slate-300">
                            {receipt.purchase_order?.purchase_request?.department?.name || '—'}
                          </TableCell>
                          <TableCell className="font-mono text-slate-300 whitespace-nowrap">
                            {cleanDate(receipt.received_at)}
                          </TableCell>
                          <TableCell className="font-mono font-bold text-emerald-300 whitespace-nowrap">
                            {money(receiptValue(receipt))}
                          </TableCell>
                          <TableCell>
                            {isRecorded ? (
                              <div className="space-y-0.5">
                                <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-black text-emerald-300 border border-emerald-500/40">
                                  ✅ مُسجّل
                                </span>
                                {receipt.accountant_recorded_by && (
                                  <div className="text-[10px] text-slate-400">
                                    بواسطة: {receipt.accountant_recorded_by.name}
                                  </div>
                                )}
                                {receipt.accountant_recorded_at && (
                                  <div className="text-[10px] text-slate-500 font-mono">
                                    {cleanDate(receipt.accountant_recorded_at)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-black text-amber-300 border border-amber-500/40">
                                ⏳ بانتظار التسجيل
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {/* 1. عرض ورؤية وطباعة المستندات الثلاثية */}
                              <Button
                                size="sm"
                                variant="secondary"
                                className="whitespace-nowrap font-bold text-[11px] text-cyan-300 border-cyan-700/60 hover:bg-cyan-950/40"
                                onClick={() => setSelectedCycleReceipt(receipt)}
                                title="عرض وطباعة الدورة المستندية (طلب الشراء • أمر الشراء الفعلي • إذن الاستلام)"
                              >
                                👁️ عرض / 🖨️ طباعة
                              </Button>

                              {/* 2. زرّا حالة المستندات: إذن الاستلام والفاتورة (أخضر إذا توفر ورمادي إذا لم يتوفر) */}
                              <DocumentStatusButtons {...getReceiptDocumentButtons(receipt, () => setSelectedCycleReceipt(receipt))} />


                              {/* 2. إرسال عبر واتساب */}
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={sharingWhatsAppReceiptId === receipt.id}
                                className="whitespace-nowrap font-bold text-[11px] text-emerald-400 border-emerald-700/60 hover:bg-emerald-950/40"
                                onClick={() => void handleWhatsAppShare(receipt)}
                                title="إرسال بيانات البند المستلم عبر واتساب"
                              >
                                {sharingWhatsAppReceiptId === receipt.id ? '⏳ جاري الفتح...' : '💬 واتساب'}
                              </Button>

                              {/* 3. زر تسجيل الفاتورة في نفس الصفحة */}
                              <Button
                                size="sm"
                                variant="primary"
                                className="whitespace-nowrap font-bold text-[11px] bg-cyan-600 hover:bg-cyan-500 shadow-cyan-950/40"
                                onClick={() => setRegisterInvoiceReceipt(receipt)}
                                title="تسجيل فاتورة المورد لهذا الإذن في نفس الصفحة دون مغادرة"
                              >
                                🧾 تسجيل فاتورة
                              </Button>

                              {/* 4. زر تم التسجيل بالشيت الخارجي */}
                              {!isRecorded ? (
                                <Button
                                  size="sm"
                                  variant="primary"
                                  className="whitespace-nowrap font-bold text-[11px] bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/40"
                                  disabled={isRecording}
                                  onClick={() => void handleMarkRecorded(receipt.id)}
                                  title="تأكيد التسجيل في شيت الإكسيل الخارجي"
                                >
                                  {isRecording ? 'جاري التسجيل...' : '📝 تم التسجيل'}
                                </Button>
                              ) : (
                                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-300 border border-emerald-500/30 whitespace-nowrap">
                                  ✅ تم التسجيل
                                </span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="py-12 text-center text-xs text-slate-500">
                {receiptsFilter === 'pending' ? '✨ لا توجد إذونات استلام معتمدة تنتظر التسجيل حالياً.' : receiptsFilter === 'recorded' ? '📋 لم يتم تسجيل أي إذونات بعد.' : '✨ لا توجد إذونات استلام معتمدة.'}
              </div>
            );
          })()}
        </Card>
      )}

      {/* Tab 2: Invoices and Matching Status */}
      {activeTab === 'INVOICES' && (
        <Card className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-black text-slate-100 flex items-center gap-2">
                <span>📑</span> فواتير الموردين المسجلة ({invoices.length})
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                الفواتير المسجلة الخاصة بـ {accountantScope.deptBadge} وحالة المطابقة الثلاثية.
              </p>
            </div>
            <Link to="/accounting/supplier-finance">
              <Button size="sm" variant="secondary" className="text-xs">
                فتح سجل الفواتير الكامل ←
              </Button>
            </Link>
          </div>

          {invoices.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>رقم الفاتورة</TableHead>
                    <TableHead>المورد</TableHead>
                    <TableHead>أمر الشراء</TableHead>
                    <TableHead>تاريخ الفاتورة</TableHead>
                    <TableHead>قيمة الفاتورة</TableHead>
                    <TableHead>حالة المطابقة</TableHead>
                    <TableHead>الإجراء</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.slice(0, 10).map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono font-bold text-cyan-300 whitespace-nowrap">
                        {inv.invoice_number}
                      </TableCell>
                      <TableCell className="font-bold text-slate-200">
                        {inv.supplier?.company_name || '—'}
                      </TableCell>
                      <TableCell className="font-mono whitespace-nowrap">
                        {inv.purchase_order?.po_number || '—'}
                      </TableCell>
                      <TableCell className="font-mono text-slate-300 whitespace-nowrap">
                        {cleanDate(inv.invoice_date)}
                      </TableCell>
                      <TableCell className="font-mono font-bold text-emerald-300 whitespace-nowrap">
                        {money(inv.amount)}
                      </TableCell>
                      <TableCell>
                        {inv.matching_status === 'MATCHED' ? (
                          <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-black text-emerald-300">
                            ✅ مطابقة
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-black text-amber-300">
                            ⏳ بانتظار المطابقة
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {inv.matching_status === 'PENDING' ? (
                          <Button
                            size="sm"
                            variant="primary"
                            className="whitespace-nowrap font-bold"
                            onClick={() => void handleMatchInvoice(inv)}
                          >
                            تنفيذ المطابقة
                          </Button>
                        ) : (
                          <span className="text-xs font-bold text-emerald-400">جاهزة للصرف</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="py-12 text-center text-xs text-slate-500">
              لا توجد فواتير مسجلة حتى الآن.
            </div>
          )}
        </Card>
      )}

      {/* Tab 3: Purchase Orders */}
      {activeTab === 'ORDERS' && (
        <Card className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-black text-slate-100 flex items-center gap-2">
                <span>📋</span> أوامر الشراء الصادرة ({purchaseOrders.length})
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                أوامر الشراء المعتمدة التابعة لـ {accountantScope.deptBadge} لمتابعة توريداتها.
              </p>
            </div>
            <Link to="/accounting/purchase-orders">
              <Button size="sm" variant="secondary" className="text-xs">
                عرض كافة أوامر الشراء ←
              </Button>
            </Link>
          </div>

          {purchaseOrders.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>رقم الأمر</TableHead>
                    <TableHead>المورد</TableHead>
                    <TableHead>ملخص البنود</TableHead>
                    <TableHead>رقم القطعة / المشروع</TableHead>
                    <TableHead>الكمية والوحدة</TableHead>
                    <TableHead>القسم</TableHead>
                    <TableHead>إجمالي الأمر</TableHead>
                    <TableHead>حالة التوريد</TableHead>
                    <TableHead>الإجراء</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchaseOrders.slice(0, 10).map((po) => {
                    const itemsDisplay = getItemsSummaryDisplay(po.items);
                    const parcelsDisplay = getSummaryParcels(po);
                    const regionsDisplay = getSummaryRegions(po);
                    const quantitiesInfo = getSummaryQuantities(po.items);
                    const itemNames = (po.items || []).map((it) => it.item_description || it.item_name || (it as any).item?.name).filter(Boolean);

                    const isSupplement = Boolean(
                      po.is_supplementary ||
                      po.items?.some((i) => i.is_supplementary) ||
                      po.notes?.includes('كمالة') ||
                      (po.purchase_request as any)?.has_pending_supplement
                    );

                    return (
                      <TableRow key={po.id}>
                        <TableCell className="font-mono font-bold text-cyan-300 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span>{po.po_number}</span>
                            {isSupplement && (
                              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-black text-amber-300 border border-amber-500/50">
                                ⚡ طلب كمالة
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-bold text-slate-200">
                          {po.supplier?.company_name || '—'}
                        </TableCell>
                        <TableCell className="font-semibold text-slate-100 max-w-[170px] truncate text-xs">
                          <span title={itemNames.join('، ')}>{itemsDisplay}</span>
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          <div className="font-mono text-cyan-300 font-bold">{parcelsDisplay}</div>
                          {regionsDisplay !== '—' && (
                            <div className="text-[10px] text-copper-300">{regionsDisplay}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          <div title={quantitiesInfo.tooltip}>
                            <div className="font-mono font-bold text-amber-300">{quantitiesInfo.display}</div>
                            {quantitiesInfo.subtext && (
                              <div className="text-[10px] text-slate-400 font-normal leading-tight">{quantitiesInfo.subtext}</div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-slate-300">
                          {po.purchase_request?.department?.name || '—'}
                        </TableCell>
                        <TableCell className="font-mono font-bold text-emerald-300 whitespace-nowrap">
                          {money(po.grand_total)}
                        </TableCell>
                        <TableCell>
                          <span className="rounded-full bg-cyan-950 border border-cyan-800 px-2.5 py-0.5 text-[10px] font-bold text-cyan-300">
                            {po.delivery_status || po.status}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Link to={`/accounting/purchase-orders/${po.id}`}>
                            <Button size="sm" variant="secondary" className="whitespace-nowrap text-xs">
                              عرض التفاصيل
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="py-12 text-center text-xs text-slate-500">
              لا توجد أوامر شراء صادرة حالياً.
            </div>
          )}
        </Card>
      )}

      {/* Tab 4: My Own Purchase Requests */}
      {activeTab === 'MY_REQUESTS' && (
        <Card className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-black text-slate-100 flex items-center gap-2">
                <span>✍️</span> طلبات الشراء الخاصة بي ({ownRequests.length})
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                طلبات الشراء التي قمتِ بإنشائها ومتابعة مراحل اعتمادها.
              </p>
            </div>
            <Link to="/requests/create">
              <Button size="sm" variant="primary" className="text-xs font-bold">
                + طلب شراء جديد
              </Button>
            </Link>
          </div>

          {ownRequests.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>رقم الطلب</TableHead>
                    <TableHead>الغرض / المبرر</TableHead>
                    <TableHead>عدد البنود</TableHead>
                    <TableHead>تاريخ الاحتياج</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead>الإجراء</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ownRequests.slice(0, 10).map((pr) => (
                    <TableRow key={pr.id}>
                      <TableCell className="font-mono font-bold text-cyan-300 whitespace-nowrap">
                        {pr.request_number}
                      </TableCell>
                      <TableCell className="text-slate-200 max-w-[200px] truncate">
                        {pr.justification || '—'}
                      </TableCell>
                      <TableCell className="font-bold text-center">
                        {pr.items?.length || 0}
                      </TableCell>
                      <TableCell className="font-mono text-slate-300 whitespace-nowrap">
                        {cleanDate(pr.date_needed)}
                      </TableCell>
                      <TableCell>
                        <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[10px] font-bold text-slate-200">
                          {pr.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Link to={`/requests/${pr.id}`}>
                          <Button size="sm" variant="secondary" className="whitespace-nowrap text-xs">
                            عرض الطلب
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="py-12 text-center text-xs text-slate-500">
              لم تقومي بإنشاء أي طلبات شراء بعد. اضغطي على "طلب شراء جديد" لإنشاء أول طلب.
            </div>
          )}
        </Card>
      )}

      {/* ── مودال عرض وطباعة الدورة المستندية الثلاثية ── */}
      <ThreeWayMatchPrintModal
        receipt={selectedCycleReceipt}
        isOpen={Boolean(selectedCycleReceipt)}
        onClose={() => setSelectedCycleReceipt(null)}
        onMarkRecorded={async () => {
          if (selectedCycleReceipt) {
            await handleMarkRecorded(selectedCycleReceipt.id);
            setSelectedCycleReceipt(null);
          }
        }}
        onRegisterInvoice={() => {
          if (selectedCycleReceipt) {
            const r = selectedCycleReceipt;
            setSelectedCycleReceipt(null);
            setRegisterInvoiceReceipt(r);
          }
        }}
      />

      {/* ── مودال تسجيل فاتورة المورد في نفس الصفحة ── */}
      <InvoiceRegistrationModal
        receipt={registerInvoiceReceipt}
        isOpen={Boolean(registerInvoiceReceipt)}
        onClose={() => setRegisterInvoiceReceipt(null)}
        onSuccess={(msg) => {
          setActionSuccess(msg);
          void loadDashboardData(true);
        }}
      />
    </div>
  );
};

export default SiteAccountantDashboardPage;
