import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { getApprovedPurchaseRequestApi } from '../../api/procurement';
import { getSuppliersApi } from '../../api/suppliers';
import { createPurchaseOrderApi, createBatchPurchaseOrdersApi, submitPurchaseOrderApi, createConsolidatedPurchaseOrdersApi, previewConsolidatedPurchaseOrdersApi } from '../../api/purchaseOrders';
import { المورد, ConsolidatedPoPreview, PurchaseOrderGroupPayload } from '../../types/purchaseOrder';
import { PurchaseRequest } from '../../types/purchaseRequest';
import LoadingSpinner from '../../components/LoadingSpinner';
import ErrorMessage from '../../components/ErrorMessage';
import DirectPoModal from '../../components/procurement/DirectPoModal';
import { ProcurementSupplementProcessModal } from '../../components/supplements/ProcurementSupplementProcessModal';
import { parseApiError } from '../../utils/apiError';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { CurrencyDisplay } from '../../components/ui/CurrencyDisplay';
import { getUnitLabel, getUnitOptions, DEFAULT_PR_UNIT_CODES } from '../../utils/units';

const UNIT_OPTIONS = getUnitOptions(DEFAULT_PR_UNIT_CODES);
import { tafqeetCurrency } from '../../utils/tafqeet';
import { UnifiedNotesCard } from '../../components/common/UnifiedNotesCard';
import { SupplierSelectWithQuickAdd } from '../../components/common/SupplierSelectWithQuickAdd';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';
import { CombinedPoPrPrintModal, CombinedPrintData } from '../../components/procurement/CombinedPoPrPrintModal';
import { isRebarUnit, calculateRebarTons } from '../../utils/rebar';
import { ActionConfirmationModal, ConfirmationAlert } from '../../components/common/ActionConfirmationModal';

const getLocalDateIso = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};

interface PoItemInput {
  pr_item_id: number;
  item_id?: number | null;
  item_description: string;
  item_reference: string;
  region: string;
  original_quantity: number;
  quantity: number | string;
  uom: string;
  unit_price: number | string;
  specifications: string;
  supplier_id?: number | null;
  raw_pr_quantity?: number;
  raw_pr_uom?: string;
  is_rebar_converted?: boolean;
  is_already_ordered?: boolean;
  selected?: boolean;
  group_id?: string;
  group_name?: string;
  group_type?: 'SHARED_SHIPMENT' | 'STEEL_WEIGHING';
}

export const CreatePurchaseOrderPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const prId = Number(searchParams.get('pr'));
  const quoteId = Number(searchParams.get('quote'));

  const [pr, setPr] = useState<PurchaseRequest | null>(null);
  const [suppliers, setSuppliers] = useState<المورد[]>([]);
  const [supplierId, setSupplierId] = useState<string>('');
  const [oneTimeSupplierName, setOneTimeSupplierName] = useState<string>('');
  const [paymentTerms, setPaymentTerms] = useState<string>('');
  const [deliveryDate, setDeliveryDate] = useState<string>(getLocalDateIso());
  const [budgetCode, setBudgetCode] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [showCombinedPrintModal, setShowCombinedPrintModal] = useState<boolean>(false);
  const [poItems, setPoItems] = useState<PoItemInput[]>([]);
  const [orderMode, setOrderMode] = useState<'SEPARATE_DEFAULT' | 'COMBINED_SINGLE'>('SEPARATE_DEFAULT');
  const [nextGroupIndex, setNextGroupIndex] = useState<number>(1);

  const [loading, setLoading] = useState<boolean>(false);
  const [fetching, setFetching] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [isDirectPoModalOpen, setIsDirectPoModalOpen] = useState<boolean>(false);
  const [isSupplementModalOpen, setIsSupplementModalOpen] = useState<boolean>(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState<boolean>(false);
  // Mandatory department consolidation: the server decides the orders (one per supplier and scope).
  const consolidatedRequired = Boolean(pr?.consolidated_po_required);
  const [consolidationPreview, setConsolidationPreview] = useState<ConsolidatedPoPreview[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  // One key per issue attempt, so a double submit or a retry never issues the orders twice.
  const issueKeyRef = useRef<string | null>(null);

  const pendingSupplement = useMemo(() => {
    return Array.isArray(pr?.supplements)
      ? pr.supplements.find((s: any) => ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED'].includes(s.status))
      : null;
  }, [pr?.supplements]);

  useEffect(() => {
    const init = async () => {
      setFetching(true);
      try {
        const sups = await getSuppliersApi();
        setSuppliers(sups || []);
        if (prId) {
          const prData = await getApprovedPurchaseRequestApi(prId);
          setPr(prData);
          if (quoteId && prData?.selected_quote?.id && quoteId !== prData.selected_quote.id) {
            throw new Error('العرض المختار في الرابط لا يطابق العرض المعتمد لهذا الطلب.');
          }
          const pendingSupp = Array.isArray(prData?.supplements)
            ? prData.supplements.find((s: any) => ['PENDING_PROCUREMENT_APPROVAL', 'REVIEWER_APPROVED'].includes(s.status))
            : null;

          let initialSupplierId = '';
          if (prData?.selected_quote?.supplier_id) {
            initialSupplierId = String(prData.selected_quote.supplier_id);
          } else if (prData?.direct_supplier_id) {
            initialSupplierId = String(prData.direct_supplier_id);
          }
          if (!initialSupplierId) {
            const firstItemSupplier = prData?.items?.find((i) => i.supplier_id)?.supplier_id;
            if (firstItemSupplier) {
              initialSupplierId = String(firstItemSupplier);
            }
          }
          if (!initialSupplierId && pendingSupp?.supplier_id) {
            initialSupplierId = String(pendingSupp.supplier_id);
          }
          if (!initialSupplierId && prData?.purchase_orders?.[0]?.supplier_id) {
            initialSupplierId = String(prData.purchase_orders[0].supplier_id);
          }
          setSupplierId(initialSupplierId);

          if (prData && prData.items) {
            // If PR already has an issued PO and has a pending supplement, focus on supplement items
            const sourceItems = (pendingSupp && prData.purchase_orders?.length)
              ? prData.items.filter((i) => i.is_supplementary || i.supplement_id === pendingSupp.id)
              : prData.items;

            const itemsToMap = sourceItems.length > 0 ? sourceItems : prData.items;

            // Keep approved PR items in the Purchase Order with automatic rebar-to-ton conversion
            setPoItems(
              itemsToMap.map((i) => {
                const rawQty = parseFloat(i.quantity) || 1;
                const uomUpper = (i.uom || '').trim().toUpperCase();
                const isRebar = isRebarUnit(i.uom) || uomUpper === 'PARCEL' || (i.uom || '').includes('طرد');

                let finalQty = rawQty;
                let finalUom = i.uom || 'PCS';
                let isConverted = false;
                let extraSpec = '';

                if (isRebar && uomUpper !== 'TON' && uomUpper !== 'طن') {
                  const tons = calculateRebarTons(rawQty, i.uom);
                  if (tons > 0) {
                    finalQty = tons;
                    finalUom = 'TON';
                    isConverted = true;
                    if (uomUpper === 'PARCEL' || (i.uom || '').includes('طرد')) {
                      extraSpec = `(ما يعادل ${formatCleanQty(rawQty)} طرد حديد - زنة الطرد 1.940 طن)`;
                    } else {
                      extraSpec = `(ما يعادل ${formatCleanQty(rawQty)} سيخ حديد ${getUnitLabel(i.uom)})`;
                    }
                  }
                }

                let specifications = (i.specifications || '').trim();
                if (extraSpec && !specifications.includes('ما يعادل')) {
                  specifications = specifications ? `${specifications} - ${extraSpec}` : extraSpec;
                }

                return {
                  pr_item_id: i.id,
                  item_id: i.item_id || null,
                  item_description: i.item_description,
                  item_reference: i.item_reference || '',
                  region: i.region || '',
                  original_quantity: finalQty,
                  quantity: finalQty,
                  uom: finalUom,
                  unit_price: Number(prData.selected_quote?.unit_price || i.estimated_unit_price || 0),
                  specifications,
                  supplier_id: i.supplier_id ? Number(i.supplier_id) : (initialSupplierId ? Number(initialSupplierId) : null),
                  raw_pr_quantity: rawQty,
                  raw_pr_uom: i.uom || 'PCS',
                  is_rebar_converted: isConverted,
                  is_already_ordered: Boolean(i.is_ordered || (i as any).purchase_order_id),
                  selected: false,
                  group_id: '',
                  group_name: '',
                };
              })
            );
          }
        }
      } catch (err) {
        const parsed = parseApiError(err);
        setError(parsed.message);
      } finally {
        setFetching(false);
      }
    };
    init();
  }, [prId]);

  const syncPoItemsForSupplier = (targetSupplierId: string, currentPr: PurchaseRequest) => {
    if (!currentPr.items) return;
    const targetNum = targetSupplierId ? Number(targetSupplierId) : null;
    setPoItems((prev) =>
      prev.map((item) => ({
        ...item,
        supplier_id: item.supplier_id || targetNum,
      }))
    );
  };

  const handleItemSupplierChange = (index: number, val: number | null) => {
    setPoItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], supplier_id: val };
      return updated;
    });
    if (val && !supplierId) {
      setSupplierId(String(val));
    }
  };


  const handleItemQuantityChange = (index: number, val: string) => {
    setPoItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], quantity: val === '' ? '' : (parseFloat(val) || 0) };
      return updated;
    });
  };

  const handleItemPriceChange = (index: number, val: string) => {
    setPoItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], unit_price: val === '' ? '' : (parseFloat(val) || 0) };
      return updated;
    });
  };

  const handleItemUomChange = (index: number, val: string) => {
    setPoItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], uom: val };
      return updated;
    });
  };

  const handleItemTextChange = (index: number, field: 'item_reference' | 'region', value: string) => {
    setPoItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const calculateGrandTotal = () => {
    return poItems.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0), 0);
  };

  const activeItems = useMemo(() => {
    return poItems.filter((i) => !i.is_already_ordered);
  }, [poItems]);

  const hasMultipleSteelItems = useMemo(() => {
    const steelItems = activeItems.filter((i) =>
      isRebarUnit(i.uom) ||
      (i.item_description || '').includes('حديد') ||
      (i.uom || '').trim().toUpperCase() === 'TON' ||
      (i.uom || '').trim().toUpperCase() === 'PARCEL'
    );
    return steelItems.length >= 2;
  }, [activeItems]);

  const resolvedGroups = useMemo(() => {
    if (orderMode === 'COMBINED_SINGLE') {
      return [{
        id: 'all',
        name: 'أمر شراء مجمع لكافة البنود',
        items: activeItems,
        isCustomGroup: false,
      }];
    }

    const map = new Map<string, { id: string; name: string; items: PoItemInput[]; isCustomGroup: boolean; group_type?: 'SHARED_SHIPMENT' | 'STEEL_WEIGHING' }>();

    activeItems.forEach((item, idx) => {
      const gid = item.group_id ? `group_${item.group_id}` : `separate_item_${item.pr_item_id || idx}`;
      const gname = item.group_name || `بند مستقل: ${item.item_description}`;
      if (!map.has(gid)) {
        map.set(gid, {
          id: gid,
          name: gname,
          items: [],
          isCustomGroup: Boolean(item.group_id),
          group_type: item.group_type,
        });
      }
      map.get(gid)!.items.push(item);
    });

    return Array.from(map.values());
  }, [orderMode, activeItems]);

  const handleToggleSelectItem = (index: number) => {
    setPoItems((prev) => {
      const updated = [...prev];
      if (updated[index] && !updated[index].is_already_ordered) {
        updated[index] = { ...updated[index], selected: !updated[index].selected };
      }
      return updated;
    });
  };

  const handleSelectAllActive = (select: boolean) => {
    setPoItems((prev) =>
      prev.map((item) =>
        item.is_already_ordered ? item : { ...item, selected: select }
      )
    );
  };

  const isSteelItemChecker = (item: PoItemInput): boolean => {
    const desc = (item.item_description || '').toLowerCase();
    const uom = (item.uom || '').toLowerCase();
    const nonSteel = ['رمل', 'سن', 'أسمنت', 'طوب', 'خشب', 'بلوك', 'عزل', 'مواسير', 'سيراميك', 'دهان', 'جبس', 'بلاط'];
    if (nonSteel.some((ns) => desc.includes(ns))) return false;
    return (
      isRebarUnit(item.uom) ||
      desc.includes('حديد') ||
      desc.includes('تسليح') ||
      desc.includes('rebar') ||
      desc.includes('كانات') ||
      desc.includes('لنية') ||
      desc.includes('لينية') ||
      uom.includes('ton') ||
      uom.includes('طن')
    );
  };

  // ── Handler 1: Shared Shipment Group (دمج كشحنة واحدة) ──
  const handleGroupAsShipment = () => {
    const selectedIndices = poItems
      .map((item, idx) => (!item.is_already_ordered && item.selected ? idx : -1))
      .filter((idx) => idx !== -1);

    if (selectedIndices.length < 2) {
      setError('يرجى تحديد بندين على الأقل لدمجهما كشحنة مشتركة (نقلة / سيارة واحدة).');
      return;
    }

    const selectedItems = selectedIndices.map((idx) => poItems[idx]);
    const alreadySteel = selectedItems.find((it) => it.group_type === 'STEEL_WEIGHING');
    if (alreadySteel) {
      setError(`البند [${alreadySteel.item_description}] مدمج حالياً في وزنة حديد. يرجى فك دمجه أولاً قبل إدراجه في شحنة مشتركة.`);
      return;
    }

    const gid = `shp_${nextGroupIndex}`;
    const gname = `شحنة مشتركة #${nextGroupIndex} (نقلة واحدة)`;

    setPoItems((prev) => {
      const updated = [...prev];
      selectedIndices.forEach((idx) => {
        updated[idx] = {
          ...updated[idx],
          group_id: gid,
          group_name: gname,
          group_type: 'SHARED_SHIPMENT',
          selected: false,
        };
      });
      return updated;
    });

    setNextGroupIndex((prev) => prev + 1);
    setError(null);
  };

  // ── Handler 2: Steel Weighing Group (تجميع وزنة حديد) ──
  const handleGroupAsSteelWeighing = (autoAllSteel = false) => {
    let indicesToGroup: number[] = [];

    if (autoAllSteel) {
      indicesToGroup = poItems
        .map((item, idx) => (!item.is_already_ordered && isSteelItemChecker(item) ? idx : -1))
        .filter((idx) => idx !== -1);
      if (indicesToGroup.length < 2) {
        setError('لم يتم العثور على بندين أو أكثر من حديد التسليح لدمجهما تلقائياً.');
        return;
      }
    } else {
      indicesToGroup = poItems
        .map((item, idx) => (!item.is_already_ordered && item.selected ? idx : -1))
        .filter((idx) => idx !== -1);

      if (indicesToGroup.length < 1) {
        setError('يرجى تحديد بنود حديد التسليح المراد تجميعها كوزنة ميزان بسكول واحدة.');
        return;
      }

      // Strict validation: ALL selected items MUST be steel items
      const nonSteelIdx = indicesToGroup.find((idx) => !isSteelItemChecker(poItems[idx]));
      if (nonSteelIdx !== undefined) {
        setError(`البند [${poItems[nonSteelIdx].item_description}] ليس من حديد التسليح. تجميع وزنة الحديد مخصص لبنود حديد التسليح فقط ويمنع خلط مواد أخرى معه.`);
        return;
      }

      // Cross-conflict check: cannot be in a shared shipment
      const inShipmentIdx = indicesToGroup.find((idx) => poItems[idx].group_type === 'SHARED_SHIPMENT');
      if (inShipmentIdx !== undefined) {
        setError(`البند [${poItems[inShipmentIdx].item_description}] مدمج حالياً ضمن شحنة مشتركة. يرجى فك دمج الشحنة أولاً قبل تجميعها كوزنة حديد.`);
        return;
      }
    }

    // On issue, the server merges these lines into ONE PO line "حديد" (value = sum of the lines,
    // weighted ton price), so different diameter prices are allowed. Plot/region must match.
    const selectedItems = indicesToGroup.map((idx) => poItems[idx]);
    const plots = new Set(selectedItems.map((it) => `${(it.item_reference || '').trim()}|${(it.region || '').trim()}`));
    if (plots.size > 1) {
      setError('لا يمكن تجميع بنود الحديد في بند واحد لأن قطعة الأرض أو المنطقة مختلفة بين البنود.');
      return;
    }

    const gid = `steel_${nextGroupIndex}`;
    const gname = `حديد (مجمع من ${indicesToGroup.length} أقطار) #${nextGroupIndex}`;

    setPoItems((prev) => {
      const updated = [...prev];
      indicesToGroup.forEach((idx) => {
        updated[idx] = {
          ...updated[idx],
          group_id: gid,
          group_name: gname,
          group_type: 'STEEL_WEIGHING',
          selected: false,
        };
      });
      return updated;
    });

    setNextGroupIndex((prev) => prev + 1);
    setError(null);
  };

  const handleUngroupSelectedItems = () => {
    setPoItems((prev) =>
      prev.map((item) =>
        item.selected
          ? { ...item, group_id: '', group_name: '', group_type: undefined, selected: false }
          : item
      )
    );
    setError(null);
  };

  const handleResetAllSeparations = () => {
    setPoItems((prev) =>
      prev.map((item) => ({
        ...item,
        group_id: '',
        group_name: '',
        group_type: undefined,
        selected: false,
      }))
    );
    setError(null);
  };

  const effectiveSupplierId = useMemo(() => {
    if (supplierId) return String(supplierId);
    const itemSup = poItems.find((i) => i.supplier_id && !i.is_already_ordered)?.supplier_id || poItems.find((i) => i.supplier_id)?.supplier_id;
    if (itemSup) return String(itemSup);
    if ((pendingSupplement as any)?.supplier_id) return String((pendingSupplement as any).supplier_id);
    if (pr?.direct_supplier_id) return String(pr.direct_supplier_id);
    if (pr?.purchase_orders?.[0]?.supplier_id) return String(pr.purchase_orders[0].supplier_id);
    return '';
  }, [supplierId, poItems, pendingSupplement, pr]);

  const hasSupplier = Boolean(
    supplierId ||
    effectiveSupplierId ||
    oneTimeSupplierName.trim()
  );

  const selectedSupplier = useMemo(() => {
    const sId = supplierId || effectiveSupplierId;
    return suppliers.find((s) => String(s.id) === String(sId));
  }, [suppliers, supplierId, effectiveSupplierId]);

  const supplierDisplayName = useMemo(() => {
    return selectedSupplier?.company_name || oneTimeSupplierName.trim() || 'مورد غير محدد';
  }, [selectedSupplier, oneTimeSupplierName]);

  // Computed data for the action confirmation modal
  const confirmationData = useMemo(() => {
    const finalSupplierId = supplierId || effectiveSupplierId;
    const itemsWithQtyChange = poItems.filter(item => item.quantity !== item.original_quantity);
    const finalGroups = resolvedGroups.filter((g) => g.items.length > 0);
    const grandTotal = poItems.reduce(
      (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0),
      0
    );

    // Rebar / Steel detection
    const rebarItems = poItems.filter((item) => {
      const desc = (item.item_description || '').toLowerCase();
      const uom = (item.uom || '').toLowerCase();
      return (
        isRebarUnit(item.uom) ||
        desc.includes('حديد') ||
        desc.includes('تسليح') ||
        desc.includes('rebar') ||
        desc.includes('كانات') ||
        desc.includes('لنية') ||
        desc.includes('لينية') ||
        uom.includes('ton') ||
        uom.includes('طن')
      );
    });

    let totalRebarTons = 0;
    rebarItems.forEach((it) => {
      const qty = Number(it.quantity) || 0;
      if (isRebarUnit(it.uom)) {
        totalRebarTons += calculateRebarTons(qty, it.uom);
      } else if ((it.uom || '').toLowerCase().includes('ton') || (it.uom || '').includes('طن')) {
        totalRebarTons += qty;
      }
    });

    const alerts: ConfirmationAlert[] = [];

    if (rebarItems.length > 0) {
      alerts.push({
        type: 'rebar',
        title: '🏗️ تنبيه وزنة حديد كاملة (مسار مستقل ومطابقة قبان)',
        message: `يحتوي هذا الأمر على بنود حديد تسليح (${rebarItems.map(i => i.item_description).slice(0, 3).join('، ')}${totalRebarTons > 0 ? ` بإجمالي تقديري ${formatCleanQty(totalRebarTons)} طن` : ''})، وسيتم توجيهها كوزنة حديد مستقلة وكاملة تخضع لإجراءات وتصاريح وزن القبان ومطابقة مهندس الموقع بالمشروع.`,
        badge: totalRebarTons > 0 ? `${formatCleanQty(totalRebarTons)} طن حديد` : 'وزنة حديد',
      });
    }

    if (finalGroups.length > 1) {
      alerts.push({
        type: 'grouped',
        title: '📋 تنبيه أوامر شراء مجمعة / متعددة الموردين',
        message: `سيتم تقسيم هذا الطلب وإصدار (${finalGroups.length}) أوامر شراء مستقلة ومجمعة وفق توزيع الموردين والمجموعات المحدد في الجدول أدناه.`,
        badge: `${finalGroups.length} أوامر شراء`,
      });
    }

    if (itemsWithQtyChange.length > 0) {
      alerts.push({
        type: 'warning',
        title: 'تعديل في كميات الأصناف عن الطلب الأصلي',
        message: `تم تعديل كميات (${itemsWithQtyChange.length}) صنف عن طلب الشراء الأصلي. الملاحظات المسجلة: "${notes || 'بدون ملاحظات'}".`,
      });
    }

    return {
      documentCode: pr?.request_number || (prId ? `#${prId}` : '—'),
      department: pr?.department?.name || '—',
      projectSite: poItems[0]?.item_reference ? `قطعة ${poItems[0]?.item_reference} - ${poItems[0]?.region}` : (pr?.project_name || pr?.parcel_reference || '—'),
      supplierName: supplierDisplayName,
      totalAmount: grandTotal,
      tafqeetText: grandTotal > 0 ? tafqeetCurrency(grandTotal) : undefined,
      itemsCount: poItems.length,
      alerts,
    };
  }, [supplierId, effectiveSupplierId, poItems, resolvedGroups, notes, pr, prId, supplierDisplayName]);

  const buildGroupsPayload = (groups: typeof resolvedGroups, finalSupplierId: string): PurchaseOrderGroupPayload[] =>
    groups.map((g) => ({
      group_name: g.name,
      group_type: (g.group_type || 'NONE') as 'SHARED_SHIPMENT' | 'STEEL_WEIGHING' | 'NONE',
      supplier_id: g.items[0]?.supplier_id || (finalSupplierId ? Number(finalSupplierId) : undefined),
      payment_terms: paymentTerms || undefined,
      delivery_date: deliveryDate || undefined,
      notes: notes || undefined,
      items: g.items.map((item) => ({
        pr_item_id: item.pr_item_id,
        item_id: item.item_id,
        item_description: item.item_description,
        item_reference: item.item_reference,
        region: item.region,
        quantity: Number(item.quantity) || 1,
        uom: item.uom,
        unit_price: Number(item.unit_price) || 0,
        specifications: item.specifications,
        supplier_id: item.supplier_id || (finalSupplierId ? Number(finalSupplierId) : undefined),
      })),
    }));

  // The "one combined order for everything" mode does not exist for consolidating departments.
  useEffect(() => {
    if (consolidatedRequired && orderMode !== 'SEPARATE_DEFAULT') {
      setOrderMode('SEPARATE_DEFAULT');
    }
  }, [consolidatedRequired, orderMode]);

  // Live preview of the consolidated orders the server will issue for the current form.
  useEffect(() => {
    if (!consolidatedRequired || !prId) {
      setConsolidationPreview(null);
      setPreviewError(null);
      return;
    }
    const finalSupplierId = supplierId || effectiveSupplierId;
    const groups = resolvedGroups.filter((g) => g.items.length > 0);
    if (groups.length === 0) {
      setConsolidationPreview([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      previewConsolidatedPurchaseOrdersApi({
        purchase_request_id: prId,
        supplier_id: finalSupplierId ? Number(finalSupplierId) : undefined,
        one_time_supplier_name: oneTimeSupplierName.trim() || undefined,
        groups: buildGroupsPayload(groups, finalSupplierId),
      })
        .then((orders) => {
          if (cancelled) return;
          setConsolidationPreview(orders);
          setPreviewError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setConsolidationPreview(null);
          setPreviewError(parseApiError(err).message);
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consolidatedRequired, prId, resolvedGroups, supplierId, effectiveSupplierId, oneTimeSupplierName]);

  const consolidatedOrderCount = consolidationPreview?.length ?? 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prId) {
      setError('لا يوجد طلب شراء معتمد محدد. يمكنك اختيار أمر شراء مباشر.');
      return;
    }
    const finalSupplierId = supplierId || effectiveSupplierId;
    if (!finalSupplierId && !oneTimeSupplierName.trim()) {
      setError('يرجى اختيار المورد من القائمة أو إدخال اسم مورد لعملية واحدة');
      return;
    }
    if (poItems.some(item => !item.item_reference.trim() || !item.region.trim())) {
      setError('رقم قطعة الأرض والمنطقة مطلوبان لكل بند قبل إصدار أمر الشراء.');
      return;
    }

    const itemsWithQtyChange = poItems.filter(item => item.quantity !== item.original_quantity);
    if (itemsWithQtyChange.length > 0 && !notes) {
      setError('تم تغيير كمية الاصناف عن طلب الشراء الاصلي. يرجى تدوين سبب تعديل الكمية في خانة الملاحظات.');
      return;
    }

    const finalGroups = resolvedGroups.filter((g) => g.items.length > 0);
    if (finalGroups.length === 0) {
      setError('لا توجد بنود متاحة لإصدار أمر شراء (ربما تم إصدار أوامر شراء لجميع البنود مسبقاً).');
      return;
    }

    if (consolidatedRequired) {
      if (previewError) {
        setError(previewError);
        return;
      }
      if (previewLoading || !consolidationPreview || consolidationPreview.length === 0) {
        setError('جاري تجهيز معاينة أوامر الشراء المجمعة، انتظر لحظة ثم أعد المحاولة.');
        return;
      }
    }

    setError(null);
    setIsConfirmModalOpen(true);
  };

  const executeCreateOrders = async () => {
    setIsConfirmModalOpen(false);
    setLoading(true);
    setError(null);

    const finalSupplierId = supplierId || effectiveSupplierId;
    const finalGroups = resolvedGroups.filter((g) => g.items.length > 0);

    try {
      if (consolidatedRequired) {
        issueKeyRef.current ??= typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `po-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

        const result = await createConsolidatedPurchaseOrdersApi({
          purchase_request_id: prId,
          supplier_id: finalSupplierId ? Number(finalSupplierId) : undefined,
          one_time_supplier_name: oneTimeSupplierName.trim() || undefined,
          payment_terms: paymentTerms || undefined,
          delivery_date: deliveryDate || undefined,
          budget_code: budgetCode || undefined,
          notes: notes || undefined,
          groups: buildGroupsPayload(finalGroups, finalSupplierId),
          idempotency_key: issueKeyRef.current,
        });
        issueKeyRef.current = null;

        const numbers = result.orders.map((po) => `#${po.po_number}`).join('، ');
        const returnUrl = searchParams.get('returnUrl') || (location.state as { returnTo?: string })?.returnTo || '/procurement';
        navigate(returnUrl, {
          state: {
            successMessage: result.replayed
              ? `أوامر الشراء المجمعة لهذا الطلب صادرة بالفعل: ${numbers}.`
              : `تم إصدار ${result.orders.length} أمر شراء مجمع (أمر لكل مورد): ${numbers}.`,
          },
        });
        return;
      }

      if (finalGroups.length === 1 && orderMode === 'COMBINED_SINGLE') {
        const po = await createPurchaseOrderApi({
          purchase_request_id: prId,
          supplier_id: finalSupplierId ? Number(finalSupplierId) : undefined,
          one_time_supplier_name: oneTimeSupplierName.trim() || undefined,
          payment_terms: paymentTerms || undefined,
          delivery_date: deliveryDate || undefined,
          budget_code: budgetCode || undefined,
          notes: notes || undefined,
          items: finalGroups[0].items.map((item) => ({
            pr_item_id: item.pr_item_id,
            item_id: item.item_id,
            item_description: item.item_description,
            item_reference: item.item_reference,
            region: item.region,
            quantity: Number(item.quantity) || 1,
            uom: item.uom,
            unit_price: Number(item.unit_price) || 0,
            specifications: item.specifications,
            supplier_id: item.supplier_id || (finalSupplierId ? Number(finalSupplierId) : undefined),
          })),
        });

        if (po?.status === 'PO_DRAFT' || po?.status === 'RETURNED_TO_PROCUREMENT') {
          await submitPurchaseOrderApi(po.id);
        }

        const returnUrl = searchParams.get('returnUrl') || (location.state as { returnTo?: string })?.returnTo || '/procurement';
        navigate(returnUrl, {
          state: {
            successMessage: `تم إصدار أمر الشراء ${po?.po_number ? `#${po.po_number}` : ''} بنجاح.`,
          },
        });
      } else {
        const groupsPayload = buildGroupsPayload(finalGroups, finalSupplierId);

        await createBatchPurchaseOrdersApi({
          purchase_request_id: prId,
          supplier_id: finalSupplierId ? Number(finalSupplierId) : undefined,
          one_time_supplier_name: oneTimeSupplierName.trim() || undefined,
          delivery_date: deliveryDate || undefined,
          notes: notes || undefined,
          groups: groupsPayload,
        });

        const returnUrl = searchParams.get('returnUrl') || (location.state as { returnTo?: string })?.returnTo || '/procurement';
        navigate(returnUrl, {
          state: {
            successMessage: `تم بنجاح إصدار ${finalGroups.length} أمر شراء مستقل/مدمج وفق التوزيع المحدد وإرسالها للحسابات.`,
          },
        });
      }
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
    } finally {
      setLoading(false);
    }
  };



  const combinedPrintData: CombinedPrintData = useMemo(() => {
    return {
      prId: pr?.id,
      prNumber: pr?.request_number || '—',
      prDate: pr?.created_at || null,
      requesterName: pr?.requester?.name || 'م. كامل',
      reviewerName: pr?.assigned_reviewer?.name || (pr?.department as any)?.manager?.name || 'م. كريم',
      qualityReviewerName: 'م. أحمد جودة',
      procurementReviewerName: 'م. أحمد بدوي',
      executiveApproverName: pr?.approval_history?.find((h) => h.action?.includes('APPROVE') || h.action?.includes('EXECUTIVE'))?.actor?.name || 'م. كريم',
      accountantName: 'أ. حسن',
      projectOrParcel: poItems[0]?.item_reference || pr?.items?.[0]?.item_reference || 'مشروع إشبيلية',
      region: poItems[0]?.region || pr?.items?.[0]?.region || '',
      dateNeeded: pr?.date_needed || '—',
      prNotes: pr?.notes || pr?.justification || '',

      poNumber: pr ? `PO-PREVIEW-${pr.request_number}` : 'PO-PREVIEW',
      poDate: getLocalDateIso(),
      supplierName: supplierDisplayName,
      supplierPhone: selectedSupplier?.phone || undefined,
      supplierTaxNumber: selectedSupplier?.tax_number || undefined,
      paymentTerms: paymentTerms || undefined,
      deliveryTerms: undefined,
      deliveryDate: deliveryDate || undefined,
      poNotes: notes || undefined,
      items: poItems.map((item) => ({
        id: item.pr_item_id,
        item_description: item.item_description,
        item_reference: item.item_reference,
        region: item.region,
        quantity: item.quantity,
        uom: item.uom,
        unit_price: item.unit_price,
        specifications: item.specifications,
      })),
      grandTotal: calculateGrandTotal(),
    };
  }, [pr, supplierDisplayName, selectedSupplier, paymentTerms, deliveryDate, notes, poItems]);

  const handleDirectWhatsAppShare = () => {
    const totalAmount = calculateGrandTotal();
    const textLines = [
      '🏢 *شركة إشبيلية للتطوير العقاري والمقاولات*',
      '📄 *بيانات أمر الشراء وطلب الشراء المعتمد*',
      '─────────────────────────',
      `📝 *طلب الشراء:* ${pr?.request_number || '—'}`,
      `📑 *أمر الشراء:* قيد الإصدار`,
      `🏬 *المورد:* ${supplierDisplayName}`,
      `📍 *المشروع / القطعة:* ${poItems[0]?.item_reference || '—'} ${poItems[0]?.region ? `(${poItems[0]?.region})` : ''}`,
      `💰 *إجمالي أمر الشراء:* ${formatCleanNumber(totalAmount)} ج.م`,
      `💳 *شروط الدفع:* ${paymentTerms || 'دفع عند الاستلام'}`,
      `🚚 *تاريخ التوريد:* ${deliveryDate || '—'}`,
      '─────────────────────────',
      '📌 *أصناف التوريد المعتمدة:*',
      ...poItems.map((item, idx) => `  ${idx + 1}. ${item.item_description} | ك: ${item.quantity} ${getUnitLabel(item.uom)} | س: ${formatCleanNumber(item.unit_price)} ج.م`),
      '─────────────────────────',
      '✅ *المستند معتمد إدارياً وفنياً للتنفيذ.*',
    ];
    const url = `https://wa.me/?text=${encodeURIComponent(textLines.join('\n'))}`;
    window.open(url, '_blank');
  };

  const directPrSuppliers = useMemo(() => {
    if (pr?.procurement_route !== 'DIRECT' || !pr?.items) return [];
    const map = new Map<number, { id: number; company_name: string; code?: string | null }>();
    for (const item of pr.items) {
      const sId = item.supplier_id || pr.direct_supplier_id;
      if (sId) {
        const found = suppliers.find((s) => s.id === sId) || item.supplier || (pr.direct_supplier?.id === sId ? pr.direct_supplier : null);
        map.set(sId, {
          id: sId,
          company_name: found?.company_name || `مورد #${sId}`,
          code: found?.code || null,
        });
      }
    }
    return Array.from(map.values());
  }, [pr, suppliers]);

  const hasMultipleDirectSuppliers = directPrSuppliers.length > 1;

  const supplierOptions = useMemo(() => {
    if (pr?.procurement_route === 'DIRECT' && hasMultipleDirectSuppliers) {
      return directPrSuppliers.map((s) => ({
        value: s.id,
        label: s.company_name,
        badge: s.code || `SUP-${s.id}`,
        searchTerms: [s.company_name, s.code || ''].filter(Boolean),
      }));
    }
    return suppliers.map((s) => ({
      value: s.id,
      label: s.company_name,
      subLabel: s.phone ? `هاتف: ${s.phone}` : undefined,
      badge: s.code || `SUP-${s.id}`,
      searchTerms: [s.contact_person || '', s.email || '', s.tax_number || '', s.commercial_register || ''].filter(Boolean),
    }));
  }, [suppliers, pr?.procurement_route, hasMultipleDirectSuppliers, directPrSuppliers]);

  const handleSupplierSelect = (val: string) => {
    setSupplierId(val);
    if (pr) {
      syncPoItemsForSupplier(val, pr);
    }
  };

  if (fetching) {
    return <LoadingSpinner message="جاري تجهيز بيانيات إنشاء أمر الشراء..." />;
  }

  return (
    <div className="procurement-reference-page space-y-6 animate-fade-in" dir="rtl">
      {/* العنوان والرجوع في هيدر التخطيط؛ هنا بس اختصار أمر الشراء المباشر */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setIsDirectPoModalOpen(true)}
          className="text-xs font-bold text-cyan-400 hover:text-cyan-300 underline-offset-4 hover:underline transition-colors cursor-pointer"
        >
          + أمر شراء مباشر
        </button>
      </div>

      {successMessage && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-950/40 px-4 py-3 text-xs text-emerald-200">
          <span>{successMessage}</span>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="text-emerald-400 hover:text-emerald-200"
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className="space-y-3">
          <ErrorMessage error={error} />
          {error.includes('يوجد أمر شراء مصدر بالفعل') && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-amber-200">
                <span>⚠️ تم إصدار أمر شراء لهذا الطلب سابقاً. يمكنك متابعة واعتماد أو تعديل أمر الشراء من قائمة أوامر الشراء.</span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={() => navigate('/procurement/purchase-orders')}>
                  <span>📑</span> الانتقال لأوامر الشراء
                </Button>
                <Button size="sm" variant="secondary" onClick={() => navigate('/procurement/approved-requests')}>
                  <span>📋</span> الطلبات المعتمدة
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        
        {/* SUPPLEMENT NOTICE BANNER */}
        {pendingSupplement && (
          <div className="rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-950/40 via-slate-900 to-amber-950/30 p-4 flex flex-wrap items-center justify-between gap-4 shadow-lg shadow-amber-900/10">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-amber-300 font-black text-sm">
                <span className="text-xl">⚡</span>
                <span>طلب كمالة معتمد (دفعة #{pendingSupplement.batch_number}) على هذا الطلب</span>
              </div>
              <p className="text-xs text-slate-300">
                معتمد من رئيس القسم: <strong className="text-emerald-300">{pendingSupplement.reviewer?.name || pr?.assigned_reviewer?.name || 'م. مصطفى (رئيس قسم التراخيص)'}</strong>.
                {pr?.purchase_orders && pr.purchase_orders.length > 0 ? ' تم إصدار أمر شراء سابق للبنود الأصلية، والبنود الموضحة أدناه تخص ملحق الكمالة فقط.' : ''}
              </p>
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black whitespace-nowrap shadow-md shadow-amber-600/20"
              onClick={() => setIsSupplementModalOpen(true)}
            >
              ⚡ إصدار أمر شراء سريع للكمالة
            </Button>
          </div>
        )}

        {/* SECTION 1: REFERENCE PURCHASE REQUEST (READ ONLY) */}
        {pr && (
          <Card className="space-y-3 border-slate-800 bg-slate-900/90">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-bold text-slate-400">الطلب الأصلي</h2>
              <span dir="ltr" className="font-mono text-sm font-black text-cyan-300 break-all">
                {pr.request_number}
              </span>
            </div>

            <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2.5 text-xs">
              <div className="min-w-0">
                <dt className="text-[10px] text-slate-500">القسم</dt>
                <dd className="font-bold text-slate-200 break-words">{pr.department?.name || '-'}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] text-slate-500">صاحب الطلب</dt>
                <dd className="font-bold text-slate-200 break-words">{pr.requester?.name || '-'}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] text-slate-500">اعتمده</dt>
                <dd className="font-bold text-emerald-300 break-words">{pr.assigned_reviewer?.name || 'غير محدد'}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] text-slate-500">مطلوب يوم</dt>
                <dd dir="ltr" className="font-mono text-right text-slate-200">{pr.date_needed || '-'}</dd>
              </div>
            </dl>

            <details className="group rounded-xl border border-slate-800 bg-slate-950/50">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-xs font-bold text-slate-300 hover:text-slate-100 [&::-webkit-details-marker]:hidden">
                <span>عرض بنود الطلب ({pr.items?.length || 0})</span>
                <span aria-hidden="true" className="text-slate-500 transition-transform group-open:rotate-180">⌄</span>
              </summary>
              <div className="border-t border-slate-800 p-3">
              <div className="overflow-x-auto hidden md:block">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="p-2.5">#</th>
                      <th className="p-2.5">رقم قطعة الأرض</th>
                      <th className="p-2.5">المنطقة</th>
                      <th className="p-2.5">الصنف</th>
                      <th className="p-2.5">الوحدة</th>
                      <th className="p-2.5">الكمية المطلوبة</th>
                      <th className="p-2.5">المواصفات الفنية</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {pr.items?.map((item, idx) => (
                      <tr key={item.id} className="hover:bg-slate-800/30">
                        <td className="p-2.5 text-slate-500 font-mono">{idx + 1}</td>
                        <td className="p-2.5 font-mono text-cyan-300 font-bold">{item.item_reference || '-'}</td>
                        <td className="p-2.5 text-slate-300">{item.region || '-'}</td>
                        <td className="p-2.5 font-bold text-slate-100">{item.item_description || '-'}</td>
                        <td className="p-2.5 text-slate-400">{getUnitLabel(item.uom)}</td>
                        <td className="p-2.5 font-mono text-cyan-400 font-bold">{item.quantity}</td>
                        <td className="p-2.5 text-slate-400 max-w-xs truncate">{item.specifications || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile items preview */}
              <div className="space-y-3 md:hidden">
                {pr.items?.map((item, idx) => (
                  <article
                    key={`mobile-pr-item-${item.id}`}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2 border-b border-slate-800/80 pb-2">
                      <div>
                        <span className="text-[10px] font-mono text-cyan-300">بند {idx + 1}</span>
                        <h4 className="font-bold text-slate-100 mt-0.5">{item.item_description || '-'}</h4>
                      </div>
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-300">
                        {getUnitLabel(item.uom)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <span className="text-slate-400 block text-[10px]">القطعة:</span>
                        <strong className="font-mono text-cyan-300">{item.item_reference || '-'}</strong>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px]">المنطقة:</span>
                        <strong className="text-slate-200">{item.region || '-'}</strong>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px]">الكمية:</span>
                        <strong className="font-mono text-cyan-300">{item.quantity}</strong>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px]">المواصفات:</span>
                        <span className="text-slate-300 truncate block">{item.specifications || '-'}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              </div>
            </details>

            <UnifiedNotesCard request={pr} />
          </Card>
        )}

        {/* SECTION 2: PURCHASE ORDER COMMERCIAL DATA (EDITABLE) */}
        <Card className="space-y-5 bg-slate-950 border-slate-800">
          <h2 className="text-sm font-bold text-slate-100">بيانات أمر الشراء</h2>

          {/* المورد and Header Options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <SupplierSelectWithQuickAdd
                suppliers={suppliers}
                selectedSupplierId={supplierId || effectiveSupplierId}
                onSelectSupplierId={handleSupplierSelect}
                oneTimeSupplierName={oneTimeSupplierName}
                onChangeOneTimeSupplierName={(name) => setOneTimeSupplierName(name)}
                onSupplierCreated={(newSup) => {
                  setSuppliers((prev) => [...prev, newSup]);
                  handleSupplierSelect(String(newSup.id));
                }}
                disabled={false}
                label="اختر المورد المعتمد"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">تاريخ التوريد المتوقع</label>
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono min-h-10"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">ملاحظات وشروط خاصة للمورد</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="ملاحظات توريد أو شروط استلام..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 min-h-10"
              />
            </div>
          </div>

          {/* Multi-supplier Direct Purchase Helper Banner */}
          {hasMultipleDirectSuppliers && pr && (
            <div className="rounded-xl border border-violet-500/40 bg-violet-950/25 p-3.5 text-xs text-violet-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-base">ℹ️</span>
                <div>
                  <p className="font-bold text-violet-100">
                    طلب شراء مباشر يضم موردين متعددين ({directPrSuppliers.length} موردين)
                  </p>
                  <p className="text-[11px] text-violet-300/80">
                    يتم إصدار أمر شراء موحد وإذن استلام موحد يضم جميع البنود ({poItems.length} بند) مع إسناد كل بند لمورده المحدد في الجدول أدناه.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Workflow & Item Separation/Grouping Controls */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="min-w-0">
                <h3 className="text-xs font-bold text-slate-100">تجميع البنود</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">كل بند بيتصدر لوحده، إلا لو جمّعته.</p>
              </div>

              {/* Mode switch (not offered when the department's orders are consolidated by the server) */}
              {consolidatedRequired ? (
                <span
                  data-testid="consolidated-po-badge"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-950/60 border border-emerald-700/60 px-3 py-1.5 text-xs font-bold text-emerald-300 max-w-full"
                >
                  🧾 أمر شراء مجمع إلزامي لهذا القسم (أمر لكل مورد)
                </span>
              ) : (
              <div className="inline-flex rounded-xl bg-slate-950 p-1 border border-slate-800 text-xs shrink-0">
                <button
                  type="button"
                  onClick={() => setOrderMode('SEPARATE_DEFAULT')}
                  className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                    orderMode === 'SEPARATE_DEFAULT'
                      ? 'bg-cyan-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  كل بند لوحده
                </button>
                <button
                  type="button"
                  onClick={() => setOrderMode('COMBINED_SINGLE')}
                  className={`px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer ${
                    orderMode === 'COMBINED_SINGLE'
                      ? 'bg-cyan-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  📦 أمر شراء مجمع للكل
                </button>
              </div>
              )}
            </div>

            {orderMode === 'SEPARATE_DEFAULT' && (
              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-300">
                    المحدد: <strong className="text-cyan-400 font-mono">{poItems.filter(i => i.selected && !i.is_already_ordered).length}</strong> بند
                  </span>
                  <button
                    type="button"
                    onClick={handleGroupAsShipment}
                    disabled={poItems.filter(i => i.selected && !i.is_already_ordered).length < 2}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 px-3.5 py-1.5 text-xs font-bold transition-all disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                    title="تجميع بنود المواد المختلفة لتوريدها معاً كشحنة واحدة على نفس السيارة/النقلة"
                  >
                    <span>🚚</span> دمج كشحنة واحدة
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGroupAsSteelWeighing(false)}
                    disabled={poItems.filter(i => i.selected && !i.is_already_ordered).length < 1}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 px-3.5 py-1.5 text-xs font-bold transition-all disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                    title="تجميع بنود حديد التسليح في وزنة ميزان بسكول واحدة"
                  >
                    <span>⚖️</span> تجميع وزنة حديد
                  </button>
                  <button
                    type="button"
                    onClick={handleUngroupSelectedItems}
                    disabled={!poItems.some(i => i.selected && i.group_id)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                    title="إلغاء دمج البنود المحددة وإرجاعها كبنود مستقلة"
                  >
                    <span>✂️</span> فك الدمج
                  </button>
                  {hasMultipleSteelItems && (
                    <button
                      type="button"
                      onClick={() => handleGroupAsSteelWeighing(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-700/60 px-3 py-1.5 text-xs font-bold transition-all cursor-pointer"
                      title="تجميع كافة بنود حديد التسليح تلقائياً في وزنة بسكول واحدة"
                    >
                      <span>🏗️</span> تجميع الحديد تلقائياً
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleResetAllSeparations}
                    className="text-xs text-slate-400 hover:text-rose-300 underline underline-offset-4 transition-colors cursor-pointer"
                  >
                    إعادة تعيين
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Commercial Line Items */}
          <div className="space-y-3 pt-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-slate-200">البنود والأسعار <span className="font-normal text-slate-500">(بالجنيه)</span></h3>
              {poItems.some((i) => i.is_rebar_converted) && (
                <span className="rounded-lg bg-emerald-950/80 border border-emerald-700/60 px-2.5 py-1 text-[11px] font-bold text-emerald-300 flex items-center gap-1.5 shadow-sm">
                  <span>🔄</span>
                  <span>الحديد اتحوّل من طرد لطن</span>
                </span>
              )}
            </div>

            {/* Desktop Table */}
            <div className="hidden min-w-0 md:block overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
              <table className="w-full text-right text-xs text-slate-200 border-collapse">
                <thead className="bg-slate-950 text-slate-400 font-semibold border-b border-slate-800">
                  <tr>
                    {orderMode === 'SEPARATE_DEFAULT' && (
                      <th className="p-3 w-10 text-center">
                        <input
                          type="checkbox"
                          aria-label="تحديد كافة البنود"
                          checked={activeItems.length > 0 && activeItems.every((i) => i.selected)}
                          onChange={(e) => handleSelectAllActive(e.target.checked)}
                          className="rounded border-slate-700 text-cyan-500 focus:ring-0 cursor-pointer"
                        />
                      </th>
                    )}
                    <th className="p-3">#</th>
                    <th className="p-3">التجميع</th>
                    <th className="p-3">القطعة</th>
                    <th className="p-3">المنطقة</th>
                    <th className="p-3">الصنف</th>
                    <th className="p-3">المورد</th>
                    <th className="p-3">الوحدة</th>
                    <th className="p-3">الكمية المطلوبة</th>
                    <th className="p-3">كمية الأمر</th>
                    <th className="p-3">الفرق</th>
                    <th className="p-3">سعر الوحدة</th>
                    <th className="p-3">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {poItems.map((item, index) => {
                    const lineTotal = (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
                    const diff = (Number(item.quantity) || 0) - item.original_quantity;
                    const isQtyChanged = diff !== 0;

                    return (
                      <tr key={index} className={`hover:bg-slate-800/40 transition-colors ${item.selected ? 'bg-cyan-950/30' : ''}`}>
                        {orderMode === 'SEPARATE_DEFAULT' && (
                          <td className="p-3 text-center">
                            <input
                              type="checkbox"
                              checked={Boolean(item.selected)}
                              disabled={Boolean(item.is_already_ordered)}
                              onChange={() => handleToggleSelectItem(index)}
                              className="rounded border-slate-700 text-cyan-500 focus:ring-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                            />
                          </td>
                        )}
                        <td className="p-3 font-mono text-slate-400">{index + 1}</td>
                        <td className="p-3 whitespace-nowrap">
                          {item.is_already_ordered ? (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-950/80 border border-emerald-700/70 px-2 py-0.5 text-[10.5px] font-bold text-emerald-300">
                              ✅ تم إصداره مسبقاً
                            </span>
                          ) : item.group_type === 'STEEL_WEIGHING' ? (
                            <span className="inline-flex items-center gap-1 rounded bg-indigo-950/80 border border-indigo-600/70 px-2 py-0.5 text-[10.5px] font-bold text-indigo-300">
                              ⚖️ {item.group_name || 'وزنة حديد'}
                            </span>
                          ) : item.group_id ? (
                            <span className="inline-flex items-center gap-1 rounded bg-amber-950/80 border border-amber-600/70 px-2 py-0.5 text-[10.5px] font-bold text-amber-300">
                              🚚 {item.group_name || 'شحنة مشتركة'}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-slate-800 border border-slate-700 px-2 py-0.5 text-[10.5px] font-bold text-cyan-300">
                              📦 أمر شراء مستقل
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          <input
                            type="text"
                            required
                            value={item.item_reference}
                            onChange={(e) => handleItemTextChange(index, 'item_reference', e.target.value)}
                            placeholder="رقم قطعة الأرض"
                            dir="ltr"
                            className="w-32 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-cyan-500 focus:outline-none"
                          />
                        </td>
                        <td className="p-3">
                          <input
                            type="text"
                            required
                            value={item.region}
                            onChange={(e) => handleItemTextChange(index, 'region', e.target.value)}
                            placeholder="المنطقة"
                            className="w-32 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                          />
                        </td>
                        <td className="p-3 font-bold text-slate-100">
                          {item.item_description}
                          {item.specifications && (
                            <div className="text-[10px] text-slate-400 font-normal mt-0.5">
                              المواصفات: {item.specifications}
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          <select
                            value={item.supplier_id || ''}
                            onChange={(e) => handleItemSupplierChange(index, e.target.value ? Number(e.target.value) : null)}
                            className="w-40 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                          >
                            <option value="">{(supplierId || effectiveSupplierId) ? '(المورد الرئيسي)' : 'اختر المورد'}</option>
                            {suppliers.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.company_name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="p-3 text-slate-300 font-bold whitespace-nowrap">
                          <select
                            value={item.uom || ''}
                            onChange={(e) => handleItemUomChange(index, e.target.value)}
                            className="w-28 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none cursor-pointer"
                            title="تعديل وحدة القياس"
                          >
                            {item.uom && !DEFAULT_PR_UNIT_CODES.includes(item.uom) && (
                              <option value={item.uom}>{getUnitLabel(item.uom)}</option>
                            )}
                            {UNIT_OPTIONS.map((u) => (
                              <option key={u.value} value={u.value}>
                                {u.label}
                              </option>
                            ))}
                          </select>
                          {item.is_rebar_converted && (
                            <span className="text-[10px] text-emerald-400 block font-normal">(محوّل لطن)</span>
                          )}
                        </td>
                        <td className="p-3 font-mono font-semibold text-slate-400">
                          {item.is_rebar_converted ? (
                            <div>
                              <span className="text-slate-200 font-bold">{item.raw_pr_quantity} {getUnitLabel(item.raw_pr_uom)}</span>
                              <div className="text-[10px] text-cyan-400 font-bold">≈ {item.original_quantity} طن</div>
                            </div>
                          ) : (
                            item.original_quantity.toLocaleString()
                          )}
                        </td>
                        <td className="p-3">
                          <input
                            type="number"
                            step="0.001"
                            min="0.001"
                            required
                            value={item.quantity ?? ''}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => handleItemQuantityChange(index, e.target.value)}
                            className="w-24 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:border-cyan-500 focus:outline-none"
                          />
                        </td>
                        <td className="p-3 font-mono font-bold text-xs">
                          {isQtyChanged ? (
                            <span className={diff > 0 ? 'text-amber-400' : 'text-rose-400'}>
                              {diff > 0 ? `+${formatCleanNumber(diff)}` : formatCleanNumber(diff)}
                            </span>
                          ) : (
                            <span className="text-slate-500">0</span>
                          )}
                        </td>
                        <td className="p-3">
                          <input
                            type="number"
                            step="any"
                            min="0"
                            required
                            value={item.unit_price ?? ''}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => handleItemPriceChange(index, e.target.value)}
                            placeholder={item.uom === 'TON' ? 'سعر الطن...' : '0.00'}
                            title={item.uom === 'TON' ? 'سعر الطن بالجنيه المصري' : 'سعر الوحدة'}
                            className="w-32 bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-emerald-400 font-mono font-bold focus:border-cyan-500 focus:outline-none"
                          />
                        </td>
                        <td className="p-3">
                          <CurrencyDisplay
                            amount={lineTotal}
                            amountClassName="font-mono text-emerald-400 font-bold"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>


            {/* Mobile Commercial Cards */}
            <div className="space-y-4 md:hidden">
              {poItems.map((item, index) => {
                const lineTotal = (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
                const diff = (Number(item.quantity) || 0) - item.original_quantity;
                const isQtyChanged = diff !== 0;

                return (
                  <article key={`mobile-po-item-${item.pr_item_id || index}`} className={`rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-3 ${item.selected ? 'ring-1 ring-cyan-500' : ''}`}>
                    <div className="flex items-start gap-2.5 border-b border-slate-800 pb-2.5">
                      {orderMode === 'SEPARATE_DEFAULT' && (
                        <input
                          type="checkbox"
                          aria-label={`تحديد البند ${index + 1}`}
                          checked={Boolean(item.selected)}
                          disabled={Boolean(item.is_already_ordered)}
                          onChange={() => handleToggleSelectItem(index)}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-700 text-cyan-500 focus:ring-0 cursor-pointer disabled:opacity-30"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-bold text-slate-100">{item.item_description}</span>
                        {item.is_already_ordered ? (
                          <span className="mt-1 inline-flex items-center gap-1 rounded bg-emerald-950/80 border border-emerald-700/70 px-2 py-0.5 text-[10.5px] font-bold text-emerald-300">
                            ✅ اتصدر قبل كده
                          </span>
                        ) : item.group_id ? (
                          <span className="mt-1 inline-flex max-w-full items-center gap-1 rounded bg-amber-950/80 border border-amber-600/70 px-2 py-0.5 text-[10.5px] font-bold text-amber-300">
                            <span className="truncate">{item.group_type === 'STEEL_WEIGHING' ? '⚖️' : '🚚'} {item.group_name || 'مجمّع'}</span>
                          </span>
                        ) : null}
                      </div>
                      <span className="shrink-0 font-mono text-[11px] font-bold text-slate-500">
                        {index + 1}
                      </span>
                    </div>

                    <div className="text-xs">
                      <label className="block text-[10px] text-slate-400 font-semibold mb-1">المورد</label>
                      <select
                        value={item.supplier_id || ''}
                        onChange={(e) => handleItemSupplierChange(index, e.target.value ? Number(e.target.value) : null)}
                        className="h-10 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                      >
                        <option value="">{(supplierId || effectiveSupplierId) ? '(المورد الرئيسي)' : 'اختر المورد'}</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.company_name}
                          </option>
                        ))}
                      </select>
                    </div>


                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <label className="block text-[10px] text-slate-400 font-semibold mb-1">القطعة *</label>
                        <input
                          type="text"
                          required
                          value={item.item_reference}
                          onChange={(e) => handleItemTextChange(index, 'item_reference', e.target.value)}
                          placeholder="القطعة"
                          dir="ltr"
                          className="h-10 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 text-xs text-slate-100 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-400 font-semibold mb-1">المنطقة *</label>
                        <input
                          type="text"
                          required
                          value={item.region}
                          onChange={(e) => handleItemTextChange(index, 'region', e.target.value)}
                          placeholder="المنطقة"
                          className="h-10 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 text-xs text-slate-100"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <label className="text-[10px] text-slate-400 font-semibold">
                            الكمية
                          </label>
                          <span className="truncate text-[10px] text-slate-500">
                            {item.is_rebar_converted
                              ? `${item.raw_pr_quantity} طرد`
                              : `المطلوب ${item.original_quantity}`}
                            {isQtyChanged && (
                              <span className={`mr-1 font-mono font-bold ${diff > 0 ? 'text-amber-400' : 'text-rose-400'}`}>
                                ({diff > 0 ? `+${formatCleanNumber(diff)}` : formatCleanNumber(diff)})
                              </span>
                            )}
                          </span>
                        </div>
                        <input
                          type="number"
                          step="0.001"
                          min="0.001"
                          required
                          value={item.quantity ?? ''}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => handleItemQuantityChange(index, e.target.value)}
                          className="h-10 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 text-xs text-slate-100 font-mono font-bold"
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="text-[10px] text-slate-400 font-semibold block mb-1">
                          الوحدة
                        </label>
                        <select
                          value={item.uom || ''}
                          onChange={(e) => handleItemUomChange(index, e.target.value)}
                          className="h-10 w-full bg-slate-950 border border-slate-700 rounded-lg px-1 text-xs text-slate-100"
                        >
                          {item.uom && !DEFAULT_PR_UNIT_CODES.includes(item.uom) && (
                            <option value={item.uom}>{getUnitLabel(item.uom)}</option>
                          )}
                          {UNIT_OPTIONS.map((u) => (
                            <option key={u.value} value={u.value}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-slate-400 font-semibold block mb-1">
                          {item.uom === 'TON' ? 'سعر الطن (ج.م)' : 'سعر الوحدة (ج.م)'}
                        </label>
                        <input
                          type="number"
                          step="any"
                          min="0"
                          required
                          value={item.unit_price ?? ''}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => handleItemPriceChange(index, e.target.value)}
                          placeholder={item.uom === 'TON' ? 'سعر الطن...' : '0.00'}
                          className="h-10 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 text-xs text-emerald-400 font-mono font-bold"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 bg-slate-950/80 rounded-xl px-3 py-2 border border-slate-800/80">
                      <span className="text-[11px] text-slate-400 font-semibold">إجمالي البند</span>
                      <CurrencyDisplay
                        amount={lineTotal}
                        amountClassName="font-mono text-emerald-400 font-black text-sm"
                      />
                    </div>
                  </article>
                );
              })}
            </div>

            {/* Grand Total Summary Box (EGP) with Arabic Tafqeet */}
            <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-200">
                  إجمالي أمر الشراء
                </span>
                <CurrencyDisplay
                  amount={calculateGrandTotal()}
                  amountClassName="text-xl font-mono font-black text-emerald-400"
                />
              </div>
              <p className="text-xs font-bold leading-5 text-emerald-300/90 border-t border-emerald-900/40 pt-2">
                {tafqeetCurrency(calculateGrandTotal())}
              </p>
            </div>

            {consolidatedRequired && (
              <div data-testid="consolidated-po-preview" className="rounded-xl border border-emerald-800/60 bg-slate-900/90 p-4 space-y-2.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
                    <span>🧾</span>
                    <span>أوامر الشراء المجمعة التي سيصدرها النظام (أمر لكل مورد وقطعة/منطقة):</span>
                  </div>
                  <span className="text-xs font-mono font-black text-emerald-300 bg-emerald-950 border border-emerald-800 px-2.5 py-0.5 rounded-full">
                    {previewLoading ? 'جاري الحساب...' : `إجمالي: ${consolidatedOrderCount} أمر شراء مجمع`}
                  </span>
                </div>
                {previewError ? (
                  <p role="alert" className="text-xs font-bold text-rose-300 bg-rose-950/40 border border-rose-800/60 rounded-lg p-2.5">
                    {previewError}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 text-xs">
                    {(consolidationPreview ?? []).map((order, oIdx) => (
                      <div key={`${order.supplier_id}-${order.item_reference}-${order.region}-${oIdx}`} data-testid="consolidated-po-card" className="rounded-lg border border-slate-800 bg-slate-950 p-2.5 space-y-1.5 text-slate-200">
                        <div className="flex items-center justify-between gap-2 font-bold text-[11px]">
                          <span>أمر {oIdx + 1}: {order.supplier_name || `مورد #${order.supplier_id}`}</span>
                          <span className="text-slate-400 font-normal">{order.item_reference} — {order.region}</span>
                        </div>
                        <ul className="space-y-0.5">
                          {order.lines.map((line, lIdx) => (
                            <li key={lIdx} className="flex items-center justify-between gap-2">
                              <span>
                                {line.item_description}
                                {line.source_pr_item_ids.length > 1 && (
                                  <span className="mr-1 text-emerald-400">(مجمع من {line.source_pr_item_ids.length} بنود)</span>
                                )}
                              </span>
                              <span className="font-mono text-slate-300">
                                {formatCleanQty(line.quantity)} {getUnitLabel(line.uom)} × {formatCleanNumber(line.unit_price)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <div className="flex items-center justify-between border-t border-slate-800 pt-1.5 font-bold">
                          <span className="text-slate-400">إجمالي الأمر قبل الخصم والضريبة</span>
                          <span className="font-mono text-emerald-300">{formatCleanNumber(order.subtotal)} ج.م</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Purchase Orders Batch Issuance Summary */}
            {!consolidatedRequired && resolvedGroups.length > 1 && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 space-y-2.5">
              <div className="text-xs font-bold text-slate-200">
                هيتصدر {resolvedGroups.length} أوامر شراء
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
                {resolvedGroups.map((g, gIdx) => (
                  <div
                    key={g.id}
                    className={`rounded-lg border p-2.5 space-y-1 ${
                      g.isCustomGroup
                        ? 'bg-amber-950/20 border-amber-600/40 text-amber-200'
                        : 'bg-slate-950 border-slate-800 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 font-bold text-[11px]">
                      <span className="truncate">{gIdx + 1}. {g.name}</span>
                      <span className="font-mono text-[10px] opacity-80 shrink-0">({g.items.length} بنود)</span>
                    </div>
                    <p className="text-[10px] text-slate-400 line-clamp-2">
                      {g.items.map((it) => it.item_description).join(' + ')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            )}
          </div>

          {/* Form الإجراءات */}
          <div className="flex flex-col gap-3 pt-4 border-t border-slate-800 sm:flex-row-reverse sm:items-center sm:justify-between">
            <button
              type="submit"
              disabled={loading || !hasSupplier || !prId || (consolidatedRequired && (previewLoading || Boolean(previewError)))}
              className="w-full sm:w-auto bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm px-6 py-3 rounded-xl font-black shadow-lg shadow-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-all"
              title={!hasSupplier ? 'يرجى تحديد المورد المعتمد لتفعيل زر الإصدار' : undefined}
            >
              {loading ? 'جاري إصدار وإرسال أوامر الشراء...' : consolidatedRequired ? `إصدار وإرسال (${consolidatedOrderCount}) أمر شراء مجمع للاستلام ←` : resolvedGroups.length > 1 ? `إصدار وإرسال (${resolvedGroups.length}) أمر شراء للاستلام ←` : 'إصدار وإرسال أمر الشراء للاستلام ←'}
            </button>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowCombinedPrintModal(true)}
                disabled={!prId || poItems.length === 0}
                className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs px-3.5 py-2.5 rounded-lg font-bold transition-all disabled:opacity-50 cursor-pointer"
                title="طباعة طلب الشراء وأمر الشراء في ملف واحد (من غير إذن استلام)"
              >
                <span>🖨️</span> طباعة
              </button>
              <button
                type="button"
                onClick={handleDirectWhatsAppShare}
                disabled={!prId || poItems.length === 0}
                className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 text-xs px-3.5 py-2.5 rounded-lg font-bold transition-all disabled:opacity-50 cursor-pointer"
              >
                <span>📱</span> واتساب
              </button>
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="px-2 py-2.5 text-xs font-bold text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </div>
        </Card>
      </form>

      {/* Combined PR + PO Print & Share Modal (Strictly without GRN) */}
      <CombinedPoPrPrintModal
        isOpen={showCombinedPrintModal}
        onClose={() => setShowCombinedPrintModal(false)}
        data={combinedPrintData}
      />

      {/* Direct purchase request modal */}
      <DirectPoModal
        isOpen={isDirectPoModalOpen}
        onClose={() => setIsDirectPoModalOpen(false)}
        onSuccess={(_newPoId) => {
          setIsDirectPoModalOpen(false);
          setSuccessMessage('✅ تم إنشاء أمر الشراء المباشر بنجاح.');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      {/* Procurement Supplement Process Modal */}
      {isSupplementModalOpen && pr && pendingSupplement && (
        <ProcurementSupplementProcessModal
          isOpen={isSupplementModalOpen}
          request={pr}
          supplement={pendingSupplement as any}
          onClose={() => setIsSupplementModalOpen(false)}
          onSuccess={() => {
            setIsSupplementModalOpen(false);
            setSuccessMessage('✅ تمت معالجة وتعميد ملحق طلب الشراء بنجاح.');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            if (prId) {
              void getApprovedPurchaseRequestApi(prId).then(setPr);
            }
          }}
        />
      )}

      {/* Sovereign Action Confirmation Modal */}
      <ActionConfirmationModal
        isOpen={isConfirmModalOpen}
        onClose={() => setIsConfirmModalOpen(false)}
        onConfirm={executeCreateOrders}
        isLoading={loading}
        title="مراجعة وتأكيد إصدار أمر الشراء"
        subtitle={`طلب شراء رقم ${confirmationData.documentCode}`}
        confirmLabel={consolidatedRequired ? `حسناً، إصدار (${consolidatedOrderCount}) أمر شراء مجمع` : resolvedGroups.length > 1 ? `حسناً، إصدار (${resolvedGroups.length}) أوامر شراء` : 'حسناً، إصدار أمر الشراء'}
        cancelLabel="رجوع للتعديل"
        confirmVariant="primary"
        documentType="PURCHASE_ORDER"
        documentCode={confirmationData.documentCode}
        department={confirmationData.department}
        projectSite={confirmationData.projectSite}
        supplierName={confirmationData.supplierName}
        totalAmount={confirmationData.totalAmount}
        tafqeetText={confirmationData.tafqeetText}
        itemsCount={confirmationData.itemsCount}
        alerts={confirmationData.alerts}
        promptQuestion="أنت على وشك إصدار وتعميد أمر الشراء النهائي ونقله لمرحلة التوريد والاستلام بالموقع، هل ترغب في الاستمرار؟"
      />
    </div>
  );
};

export default CreatePurchaseOrderPage;
