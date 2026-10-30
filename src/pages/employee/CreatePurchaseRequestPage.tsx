import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { saveFavoriteRequest, FavoriteRequest } from '../../utils/favoriteRequestsStorage';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import ApproveRequestDialog from '../../components/reviewer/ApproveRequestDialog';
import { FormField, Input, Select, Textarea } from '../../components/ui/FormField';
import {
  createPurchaseRequestApi,
  getPurchaseRequestDepartmentOptionsApi,
  getSiteEngineerReceiverOptionsApi,
  submitPurchaseRequestApi,
  updatePurchaseRequestApi,
} from '../../api/purchaseRequests';
import { getCatalogItemsApi } from '../../api/catalog';
import { getLandParcelsApi, LandParcel } from '../../api/supplierFinance';
import {
  CatalogItem,
  CreatePurchaseRequestPayload,
  DepartmentOption,
  PurchaseRequestItemFormInput,
  PurchaseRequestPriority,
  PurchaseRequestType,
  SiteEngineerReceiverOption,
  PR_TYPE_LABELS,
} from '../../types/purchaseRequest';
import { DEFAULT_PR_UNIT_CODES, getUnitLabel, getUnitOptions } from '../../utils/units';
import { parseApiError } from '../../utils/apiError';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning';
import { useAuth } from '../../context/AuthContext';
import { emitAppDataUpdated } from '../../hooks/useRealtimeRefresh';
import { SearchableSelect } from '../../components/ui/FormField';
import { toast } from '../../utils/toast';
import { isRebarUnit, getRebarType, calculateRebarTons } from '../../utils/rebar';
import { formatCleanNumber, formatCleanQty } from '../../utils/numberFormat';

const UNIT_OPTIONS = getUnitOptions(DEFAULT_PR_UNIT_CODES);

const getTodayDateInputValue = (): string => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const DRAFT_STORAGE_KEY = 'ashbiliya.purchase-request.draft.v1';

const emptyItem = (): PurchaseRequestItemFormInput => ({
  item_description: '',
  item_reference: '',
  region: '',
  quantity: 1,
  uom: 'PCS',
  specifications: '',
  notes: '',
});

const getInitialData = (defaultType: PurchaseRequestType = 'PROJECT'): CreatePurchaseRequestPayload => ({
  request_type: defaultType,
  parcel_reference: '',
  region: '',
  land_parcel_id: undefined,
  target_department_id: undefined,
  priority: 'NORMAL',
  reviewer_user_id: undefined,
  site_engineer_user_id: undefined,
  date_needed: getTodayDateInputValue(),
  notes: '',
  items: [emptyItem()],
});

type ItemErrors = Record<number, {
  description?: string;
  quantity?: string;
}>;

type ValidationResult = {
  targetDepartment?: string;
  targetManager?: string;
  targetSiteEngineer?: string;
  dateNeeded?: string;
  parcelReference?: string;
  region?: string;
  notes?: string;
  emptyItems?: string;
  items: ItemErrors;
};

const validateRequest = (
  data: CreatePurchaseRequestPayload,
  departmentOptions: DepartmentOption[] = [],
  isGeneralManager = false,
): ValidationResult => {
  const itemErrors: ItemErrors = {};
  const isOffice = (data.request_type || 'PROJECT') === 'OFFICE_SUPPLIES';
  const isComplementary = data.request_type === 'COMPLEMENTARY';
  const safeItems = Array.isArray(data.items) ? data.items : [];

  safeItems.forEach((item, index) => {
    const errors: ItemErrors[number] = {};
    if (!item.item_description?.trim()) errors.description = 'اكتب وصف الصنف المطلوب.';
    const qty = Number(item.quantity);
    if (qty <= 0 || Number.isNaN(qty)) {
      errors.quantity = 'الكمية مطلوبة (أدخل كمية أكبر من صفر).';
    } else {
      const uom = (item.uom || '').toUpperCase();
      const isIntegerOnlyUnit = ['PCS', 'EA', 'NO', 'قطعة', 'قطع', 'عدد'].includes(uom);
      if (isIntegerOnlyUnit && !Number.isInteger(qty)) {
        errors.quantity = 'لا يمكن إدخال كمية كسرية لوحدة (قطعة). أدخل رقماً صحيحاً.';
      }
    }
    if (Object.keys(errors).length) itemErrors[index] = errors;
  });

  const safeDeptOptions = Array.isArray(departmentOptions) ? departmentOptions : [];
  const targetDepartment = safeDeptOptions.find((department) => department.id === data.target_department_id);
  const today = getTodayDateInputValue();
  return {
    targetDepartment: data.target_department_id ? undefined : 'اختر القسم الذي سيعالج الطلب.',
    targetManager: !isGeneralManager && data.target_department_id && targetDepartment && !targetDepartment.manager && !['EXECUTION', 'BUILDINGS', 'FINISHING', 'LICENSES', 'BUFFET', 'DEVELOPMENT', 'MARKETING', 'SALES'].includes(targetDepartment?.code || '')
      ? 'القسم المستهدف لا يوجد له مدير قسم معين. اطلب من مدير النظام تعيين مدير للقسم أولًا.'
      : undefined,
    targetSiteEngineer: isGeneralManager && !isOffice && !data.site_engineer_user_id
      ? 'طالما أن الطلب صادر من المدير التنفيذي ولا يمر على مراجع، يجب تحديد مهندس الموقع أو مسؤول الاستلام.'
      : undefined,
    dateNeeded: !data.date_needed
      ? 'حدد تاريخ الاحتياج.'
      : data.date_needed < today
        ? 'تاريخ الاحتياج لا يمكن أن يكون في الماضي. اختر اليوم أو تاريخًا قادمًا.'
        : undefined,
    parcelReference: !isOffice && !isComplementary && !data.parcel_reference?.trim()
      ? 'رقم قطعة الأرض مطلوب للطلب.'
      : undefined,
    region: !isOffice && !isComplementary && !data.region?.trim()
      ? 'المنطقة مطلوبة للطلب.'
      : undefined,
    notes: !data.notes?.trim()
      ? 'ملاحظات / الغرض من الشراء حقل إلزامي. يرجى توضيح الغرض من الشراء.'
      : undefined,
    emptyItems: data.items.length === 0 ? 'يجب إضافة صنف واحد على الأقل لطلب الشراء.' : undefined,
    items: itemErrors,
  };
};

const hasValidationErrors = (validation: ValidationResult): boolean =>
  Boolean(
    validation.targetDepartment ||
    validation.targetManager ||
    validation.targetSiteEngineer ||
    validation.dateNeeded ||
    validation.parcelReference ||
    validation.region ||
    validation.notes ||
    validation.emptyItems ||
    Object.keys(validation.items).length
  );

const normalizeRequestData = (data: CreatePurchaseRequestPayload): CreatePurchaseRequestPayload => {
  const isOffice = (data.request_type || 'PROJECT') === 'OFFICE_SUPPLIES';
  const isComplementary = data.request_type === 'COMPLEMENTARY';
  const defaultParcel = isOffice ? 'مقر الشركة' : (data.parcel_reference?.trim() || (isComplementary ? 'طلب كمالة مستقل' : ''));
  const defaultRegion = isOffice ? 'إداري / المقر الرئيسي' : (data.region?.trim() || (isComplementary ? 'موقع العمل / المستودع' : ''));

  // Format clean YYYY-MM-DD date without timestamps or corrupted formatting
  const rawDate = (data.date_needed || data.required_date || getTodayDateInputValue()).trim();
  const cleanDate = rawDate.includes('T') ? rawDate.split('T')[0] : (rawDate || getTodayDateInputValue());

  return {
    ...data,
    request_type: data.request_type || 'PROJECT',
    parcel_reference: defaultParcel,
    parcel: defaultParcel,
    region: defaultRegion,
    land_parcel_id: isOffice ? undefined : (data.land_parcel_id ? Number(data.land_parcel_id) : undefined),
    site_engineer_user_id: isOffice ? undefined : (data.site_engineer_user_id ? Number(data.site_engineer_user_id) : undefined),
    target_department_id: data.target_department_id ? Number(data.target_department_id) : undefined,
    department_id: data.target_department_id ? Number(data.target_department_id) : undefined,
    date_needed: cleanDate,
    required_date: cleanDate,
    notes: data.notes?.trim(),
    items: data.items.map((item) => {
      let quantity = Number(item.quantity) || 0;
      let uom = item.uom;
      let specifications = item.specifications?.trim();

      if (isRebarUnit(item.uom)) {
        const spec = getRebarType(item.uom)!;
        const barCount = quantity;
        const tons = calculateRebarTons(barCount, item.uom);
        quantity = tons;
        uom = 'TON';
        const rebarNote = `${formatCleanQty(barCount)} سيخ ${spec.linia}`;
        specifications = specifications ? `${rebarNote} — ${specifications}` : rebarNote;
      }

      return {
        ...item,
        item_id: item.item_id ? Number(item.item_id) : null,
        quantity,
        uom,
        item_description: item.item_description.trim(),
        item_reference: defaultParcel,
        region: defaultRegion,
        specifications,
      };
    }),
  };
};

interface CreatePurchaseRequestPageProps {
  initialRequestType?: PurchaseRequestType;
}

export const CreatePurchaseRequestPage: React.FC<CreatePurchaseRequestPageProps> = ({ initialRequestType }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const isComplementaryRoute = initialRequestType === 'COMPLEMENTARY' ||
    location.pathname.includes('complementary') ||
    searchParams.get('type') === 'COMPLEMENTARY';

  const effectiveInitialType: PurchaseRequestType = isComplementaryRoute ? 'COMPLEMENTARY' : 'PROJECT';
  const draftStorageKey = isComplementaryRoute ? 'ashbiliya.purchase-request.draft.complementary.v1' : DRAFT_STORAGE_KEY;

  const { hasRole, user } = useAuth();
  const isGeneralManager = hasRole('general_manager') || hasRole('execution_manager');
  // Procurement and the financial manager skip the reviewer, so they choose the receiver and warehouse route like one.
  const isReviewer = !isGeneralManager && (hasRole('reviewer') || hasRole('procurement_manager') || hasRole('accountant'));
  const [isReviewerModalOpen, setIsReviewerModalOpen] = useState(false);
  const [pendingSaveToFavorites, setPendingSaveToFavorites] = useState(false);
  const [data, setData] = useState<CreatePurchaseRequestPayload>(() => getInitialData(effectiveInitialType));
  const [landParcels, setLandParcels] = useState<LandParcel[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOption[]>([]);
  const [departmentLoading, setDepartmentLoading] = useState(true);
  const [siteEngineers, setSiteEngineers] = useState<SiteEngineerReceiverOption[]>([]);
  const [otherUsers, setOtherUsers] = useState<SiteEngineerReceiverOption[]>([]);
  const [isLoadingReceivers, setIsLoadingReceivers] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMissingNotesModal, setShowMissingNotesModal] = useState<boolean>(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [serverDraftId, setServerDraftId] = useState<number | null>(null);
  const [loadedFavoriteInfo, setLoadedFavoriteInfo] = useState<{ title: string; count: number } | null>(null);
  const initialDataSnapshot = useMemo(() => getInitialData(), []);
  const isDirty = useMemo(() => JSON.stringify(data) !== JSON.stringify(initialDataSnapshot), [data, initialDataSnapshot]);
  useUnsavedChangesWarning(isDirty && !isSubmitting);

  // Restore local draft or favorite template
  useEffect(() => {
    const locState = location.state as { fromFavorite?: boolean; favoriteTemplate?: FavoriteRequest } | undefined;
    if (locState?.fromFavorite && locState.favoriteTemplate) {
      const fav = locState.favoriteTemplate;
      const todayStr = getTodayDateInputValue();
      setData({
        ...getInitialData(),
        target_department_id: fav.target_department_id,
        request_type: fav.request_type || 'PROJECT',
        priority: fav.priority || 'NORMAL',
        notes: fav.notes || '',
        date_needed: todayStr,
        // Reset and require parcel and region:
        region: '',
        parcel_reference: '',
        land_parcel_id: undefined,
        items: fav.items && fav.items.length > 0 ? fav.items.map((it) => ({
          ...emptyItem(),
          item_description: it.item_description,
          uom: it.uom || it.unit || 'قطعة',
          quantity: Number(it.quantity) || 1,
          specifications: it.specifications || '',
          notes: it.notes || '',
        })) : [emptyItem()],
      });
      setLoadedFavoriteInfo({
        title: fav.title,
        count: fav.items.length,
      });
      setShowValidation(true);
      setDraftReady(true);
      setTimeout(() => {
        const parcelEl = document.getElementById('pr-parcel-reference');
        if (parcelEl) parcelEl.focus();
      }, 250);
      return;
    }

    try {
      const todayStr = getTodayDateInputValue();
      const savedDraft = window.localStorage.getItem(draftStorageKey);
      if (savedDraft) {
        const parsed = JSON.parse(savedDraft) as Partial<CreatePurchaseRequestPayload>;
        const validDateNeeded = !parsed.date_needed || parsed.date_needed < todayStr ? todayStr : parsed.date_needed;
        const validItems = Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed.items : [emptyItem()];
        setData({
          ...getInitialData(effectiveInitialType),
          ...parsed,
          request_type: isComplementaryRoute ? 'COMPLEMENTARY' : (parsed.request_type || 'PROJECT'),
          date_needed: validDateNeeded,
          items: validItems,
        });
      } else if (isComplementaryRoute) {
        setData((prev) => ({ ...prev, request_type: 'COMPLEMENTARY' }));
      }
    } catch {
      // Ignore corrupted draft
    } finally {
      setDraftReady(true);
    }
  }, [location.state, draftStorageKey, isComplementaryRoute, effectiveInitialType]);

  // Auto-save local draft silently in the background
  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftStorageKey, JSON.stringify(data));
      } catch {
        // Ignore storage errors
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [data, draftReady, draftStorageKey]);

  // Load department options & catalog items
  useEffect(() => {
    let cancelled = false;
    getPurchaseRequestDepartmentOptionsApi()
      .then((options) => {
        const arr = Array.isArray(options) ? options : (options as any)?.data;
        if (!cancelled) setDepartmentOptions(Array.isArray(arr) ? arr : []);
      })
      .catch(() => {
        if (!cancelled) setDepartmentOptions([]);
      })
      .finally(() => {
        if (!cancelled) setDepartmentLoading(false);
      });

    getCatalogItemsApi()
      .then((items) => {
        if (!cancelled) setCatalogItems(items);
      })
      .catch(() => {});

    getLandParcelsApi()
      .then((parcels) => {
        if (!cancelled && Array.isArray(parcels)) {
          setLandParcels(parcels.filter((p) => p.is_active));
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  // Load receiver options for General Manager / Executive Director
  useEffect(() => {
    if (isGeneralManager) {
      setIsLoadingReceivers(true);
      getSiteEngineerReceiverOptionsApi()
        .then((res) => {
          setSiteEngineers(res.site_engineers || []);
          setOtherUsers(res.other_users || []);
        })
        .catch(() => {})
        .finally(() => setIsLoadingReceivers(false));
    }
  }, [isGeneralManager]);

  const departmentSelectOptions = useMemo(() => {
    const list = Array.isArray(departmentOptions) ? departmentOptions : [];
    return list.map((d) => ({
      value: d.id,
      label: d.name,
      subLabel: d.code || undefined,
      searchTerms: [d.code || '', d.manager?.name || '', d.site_engineer?.name || ''].filter(Boolean),
    }));
  }, [departmentOptions]);

  const catalogSelectOptions = useMemo(() => {
    const list = Array.isArray(catalogItems) ? catalogItems : [];
    return list.map((c) => ({
      value: c.id,
      label: c.name,
      subLabel: c.sku ? `كود: ${c.sku} | ${getUnitLabel(c.uom)}` : getUnitLabel(c.uom),
      searchTerms: [c.sku || '', c.category?.name || ''].filter(Boolean),
    }));
  }, [catalogItems]);

  const validation = useMemo(
    () => validateRequest(data, departmentOptions, isGeneralManager),
    [data, departmentOptions, isGeneralManager],
  );
  const requestHasErrors = hasValidationErrors(validation);
  const isOffice = (data.request_type || 'PROJECT') === 'OFFICE_SUPPLIES';
  const targetDepartment = (Array.isArray(departmentOptions) ? departmentOptions : []).find(
    (department) => department.id === data.target_department_id
  );

  // Item Management Helpers
  const updateItem = (index: number, partial: Partial<PurchaseRequestItemFormInput>) => {
    const updated = data.items.map((item, i) => (i === index ? { ...item, ...partial } : item));
    setData({ ...data, items: updated });
  };

  const addItem = () => {
    setData({ ...data, items: [...data.items, emptyItem()] });
  };

  const duplicateItem = (index: number) => {
    const itemToClone = data.items[index];
    if (!itemToClone) return;
    const cloned: PurchaseRequestItemFormInput = {
      ...itemToClone,
      quantity: 1,
    };
    const newItems = [...data.items];
    newItems.splice(index + 1, 0, cloned);
    setData({ ...data, items: newItems });
  };

  const removeItem = (index: number) => {
    if (data.items.length <= 1) return;
    setData({ ...data, items: data.items.filter((_, i) => i !== index) });
  };

  const handleCatalogSelect = (index: number, catalogId: string | number) => {
    if (!catalogId) {
      updateItem(index, { item_id: null });
      return;
    }
    const cat = catalogItems.find((c) => c.id === Number(catalogId));
    if (cat) {
      updateItem(index, {
        item_id: cat.id,
        item_description: cat.name,
        uom: cat.uom || 'PCS',
      });
    }
  };

  const ensureServerDraft = async (): Promise<{ id: number }> => {
    const normalizedData = normalizeRequestData(data);
    if (serverDraftId) {
      const updated = await updatePurchaseRequestApi(serverDraftId, normalizedData);
      return { id: updated.id };
    }

    const created = await createPurchaseRequestApi(normalizedData);
    setServerDraftId(created.id);
    return { id: created.id };
  };

  const handleSaveDraft = async () => {
    if (isSubmitting || isSavingDraft) return;
    setError(null);
    setIsSavingDraft(true);
    try {
      const draft = await ensureServerDraft();
      setDraftMessage('تم حفظ المسودة بنجاح.');
      toast.success('تم حفظ المسودة بنجاح.');
      emitAppDataUpdated();
      setTimeout(() => setDraftMessage(null), 4000);
    } catch (err) {
      const apiErr = parseApiError(err);
      const msg = apiErr.message;
      const fieldErrors = apiErr.errors ? Object.values(apiErr.errors).flat().join(' • ') : '';
      const fullError = fieldErrors && fieldErrors !== msg ? `${msg} (${fieldErrors})` : msg;
      setError(fullError);
      toast.error(fullError || 'حدث خطأ أثناء حفظ المسودة');
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleSubmit = async (saveToFavorites = false) => {
    if (isSubmitting || isSavingDraft) return;
    setShowValidation(true);
    if (data.items.length === 0) {
      setError('يجب إضافة صنف واحد على الأقل لطلب الشراء.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (!data.notes?.trim()) {
      setShowMissingNotesModal(true);
      setError('ملاحظات / الغرض من الشراء حقل إلزامي. يرجى توضيح الغرض من الشراء للمتابعة.');
      setTimeout(() => {
        const el = document.getElementById('pr-notes');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();
        }
      }, 100);
      return;
    }
    if (requestHasErrors) {
      setError(validation.emptyItems || validation.notes || 'يرجى تصحيح الأخطاء المحددة في النموذج وإدخال الحقول الإلزامية أولاً.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    // إذا كان مقدم الطلب مراجعاً ولم يكن طلباً مكتبياً: افتح نافذة اعتماد المراجع وتحديد مسؤول الاستلام ومسار المخزن
    if (isReviewer && !isOffice) {
      setPendingSaveToFavorites(saveToFavorites);
      setIsReviewerModalOpen(true);
      return;
    }

    await executeSubmission(saveToFavorites);
  };

  const executeSubmission = async (
    saveToFavorites = false,
    reviewerReceiverId?: number | null,
    reviewerRequiresWhReceipt?: boolean,
    reviewerComment?: string
  ) => {
    setError(null);
    setIsSubmitting(true);
    try {
      if (saveToFavorites) {
        const firstItem = data.items[0]?.item_description?.trim() || 'بنود طلب شراء';
        const locRef = data.parcel_reference ? ` (${data.parcel_reference})` : '';
        const favTitle = `طلب ${firstItem}${locRef}`;
        saveFavoriteRequest(
          {
            title: favTitle,
            target_department_id: data.target_department_id,
            request_type: data.request_type,
            priority: data.priority,
            notes: data.notes,
            items: data.items.map((it) => ({
              item_description: it.item_description,
              uom: it.uom || 'قطعة',
              unit: it.uom || 'قطعة',
              quantity: Number(it.quantity) || 1,
              specifications: it.specifications,
              notes: it.notes,
            })),
          },
          user?.id
        );
      }

      const draft = await ensureServerDraft();
      const effectiveReceiverId = reviewerReceiverId !== undefined ? reviewerReceiverId : (data.site_engineer_user_id || undefined);
      await submitPurchaseRequestApi(draft.id, {
        site_engineer_user_id: effectiveReceiverId,
        requires_warehouse_receipt: reviewerRequiresWhReceipt,
        comment: reviewerComment,
      });
      window.localStorage.removeItem(draftStorageKey);
      emitAppDataUpdated();
      const successMsg = saveToFavorites
        ? 'تم إرسال طلب الشراء وحفظه في الطلبات المفضلة بنجاح! ⭐'
        : data.request_type === 'COMPLEMENTARY'
          ? 'تم إرسال طلب الكمالة المستقل بنجاح! سيعتمده رئيس القسم وينتقل مباشرة إلى إدارة المشتريات (مسار سريع) ⚡'
          : isReviewer
            ? 'تم اعتماد طلب الشراء وتحديد مسار الاستلام وإرساله إلى المدير التنفيذي بنجاح.'
            : isGeneralManager
              ? 'تم إرسال طلب الشراء مباشرة إلى مدير المشتريات بنجاح بعد تحديد مسؤول الاستلام.'
              : 'تم إرسال طلب الشراء للمراجعة بنجاح.';
      toast.success(successMsg);
      setIsReviewerModalOpen(false);
      navigate(`/requests/${draft.id}`, {
        state: {
          message: successMsg,
        },
      });
    } catch (err) {
      const apiErr = parseApiError(err);
      const msg = apiErr.message;
      const fieldErrors = apiErr.errors ? Object.values(apiErr.errors).flat().join(' • ') : '';
      const fullError = fieldErrors && fieldErrors !== msg ? `${msg} (${fieldErrors})` : msg;
      setError(fullError);
      toast.error(fullError || 'حدث خطأ أثناء إرسال طلب الشراء');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClearDraft = () => {
    window.localStorage.removeItem(draftStorageKey);
    setData(getInitialData(effectiveInitialType));
    setServerDraftId(null);
    setLoadedFavoriteInfo(null);
    setDraftMessage('تم مسح المسودة والبدء من جديد.');
    setTimeout(() => setDraftMessage(null), 3000);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-2.5 sm:space-y-3 pb-28 sm:pb-24 px-1 sm:px-0" dir="rtl">
      {/* Top Header - Static on Mobile to free vertical viewport, Sticky on Desktop */}
      <div className="static sm:sticky sm:top-2 z-40 rounded-xl sm:rounded-2xl border border-slate-700/80 bg-slate-950/90 p-2.5 sm:p-3 shadow-xl backdrop-blur-md transition-all">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/30 border border-cyan-500/40 text-base sm:text-lg shadow-inner shrink-0">
              ✍️
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs sm:text-sm font-black text-slate-100 truncate">
                  {data.request_type === 'COMPLEMENTARY'
                    ? '⚡ إنشاء طلب كمالة مستقل (مسار سريع)'
                    : isReviewer
                      ? 'إنشاء واعتماد طلب شراء (كمراجع)'
                      : isGeneralManager
                        ? 'طلب شراء تنفيذي جديد'
                        : 'إنشاء وإرسال طلب شراء'}
                </span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold bg-slate-900 border border-slate-700 text-slate-300 shrink-0">
                  <span className={`h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full ${requestHasErrors ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'}`} />
                  {requestHasErrors ? 'استكمال الحقول' : 'جاهز للإرسال'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link to="/requests/favorites">
              <Button type="button" variant="secondary" size="sm" className="text-[11px] sm:text-xs px-2.5 py-1 sm:px-3 text-amber-300 border-amber-500/30 hover:border-amber-400 bg-amber-950/20">
                ⭐ <span className="hidden sm:inline">الطلبات</span> المفضلة
              </Button>
            </Link>
            <Link to="/requests">
              <Button type="button" variant="secondary" size="sm" className="text-[11px] sm:text-xs px-2.5 py-1 sm:px-3">
                ← <span className="hidden sm:inline">أرشيف</span> طلباتي
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Banner when loaded from Favorite Template */}
      {loadedFavoriteInfo && (
        <div className="rounded-xl border border-amber-500/60 bg-gradient-to-r from-amber-950/70 via-slate-900 to-amber-950/50 p-3 sm:p-4 text-xs shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start sm:items-center gap-3">
            <span className="text-2xl shrink-0">⭐</span>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-black text-amber-300 text-xs sm:text-sm">تم استدعاء البنود من القالب المفضل:</span>
                <span className="font-bold text-slate-100 bg-amber-500/20 px-2 py-0.5 rounded border border-amber-500/30">
                  {loadedFavoriteInfo.title}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-mono text-[10px] font-bold border border-cyan-500/30">
                  {loadedFavoriteInfo.count} أصناف
                </span>
              </div>
              <p className="text-[11px] text-amber-200/90 mt-1 font-semibold flex items-center gap-1.5">
                <span className="text-amber-400">⚠️</span>
                <span>تنبيه إلزامي: تم تفريغ المنطقة ورقم القطعة. يجب إدخال رقم القطعة والمنطقة الخاصة بالموقع الجديد لإتمام الإرسال.</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLoadedFavoriteInfo(null)}
            className="text-slate-400 hover:text-slate-200 text-xs shrink-0 self-end sm:self-auto px-2.5 py-1 bg-slate-800/80 hover:bg-slate-700/80 rounded-lg border border-slate-700 transition-colors"
          >
            ✕ إخفاء التنبيه
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-800/80 bg-rose-950/40 p-2.5 sm:p-3 text-xs font-bold text-rose-200 shadow-lg" role="alert">
          ⚠️ {error}
        </div>
      )}

      {/* Request Type Segmented Bar — the highlighted tab is the only place the type is shown */}
      <div className="rounded-xl sm:rounded-2xl border border-slate-800 bg-slate-900/95 p-2 sm:p-3 shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-2.5">
        <span className="hidden sm:inline text-xs font-bold text-slate-300">نوع الطلب:</span>

        <div role="group" aria-label="نوع الطلب" className="grid grid-cols-3 gap-1 sm:flex sm:items-center sm:gap-2 bg-slate-950/80 p-1 rounded-xl border border-slate-800/80">
          <button
            type="button"
            onClick={() => setData({ ...data, request_type: 'PROJECT' })}
            className={`flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${
              data.request_type === 'PROJECT'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <span>🏗️</span>
            <span className="truncate">مشروعات</span>
          </button>

          <button
            type="button"
            onClick={() => setData({ ...data, request_type: 'OFFICE_SUPPLIES' })}
            className={`flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${
              data.request_type === 'OFFICE_SUPPLIES'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
            }`}
          >
            <span>🏢</span>
            <span className="truncate">مكتبية</span>
          </button>

          <button
            type="button"
            onClick={() => setData({ ...data, request_type: 'COMPLEMENTARY' })}
            className={`flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer ${
              data.request_type === 'COMPLEMENTARY'
                ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-slate-950 shadow-md shadow-amber-500/30 ring-1 ring-amber-300'
                : 'text-amber-400/80 hover:text-amber-300 hover:bg-slate-900'
            }`}
          >
            <span>⚡</span>
            <span className="truncate">طلب كمالة</span>
          </button>
        </div>
      </div>

      {/* Banner for Standalone Complementary Request */}
      {data.request_type === 'COMPLEMENTARY' && (
        <div className="rounded-xl border border-amber-500/60 bg-gradient-to-r from-amber-950/80 via-slate-900 to-amber-950/50 p-3 sm:p-4 text-xs shadow-xl flex items-start sm:items-center gap-3">
          <span className="text-2xl sm:text-3xl shrink-0">⚡</span>
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-black text-amber-300 text-xs sm:text-sm">طلب كمالة مستقل بذاته (Standalone Entity) — مسار سريع</span>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 font-mono text-[10px] font-black border border-amber-500/40">
                تخطي الاعتماد المالي والتنفيذي 🚀
              </span>
            </div>
            <p className="text-[11px] text-amber-100/90 leading-5">
              هذا الطلب منفرد تماماً ويبدأ من الصفر بدون أي ربط إجباري بطلب أو أمر شراء سابق. بعد مراجعة رئيس القسم، سيتخطى الطلب تلقائياً الاعتماد المالي وموافقة المدير التنفيذي، وينتقل مباشرة إلى إدارة المشتريات لإصدار أمر الشراء فوراً وإكمال دورته التشغيلية.
            </p>
          </div>
        </div>
      )}

      {/* Card 1: Basic Request Info */}
      <Card className="space-y-3.5 border-slate-800 bg-slate-900/90 p-3.5 sm:p-4 shadow-xl">
        <div className="border-b border-slate-800 pb-2.5 flex items-center justify-between">
          <h2 className="text-xs sm:text-sm font-black text-slate-100 flex items-center gap-2">
            <span className="text-cyan-400">📋</span> 1. بيانات الطلب والجهة المعالجة
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="القسم المستهدف" required error={showValidation ? validation.targetDepartment : undefined}>
            <Select
              id="pr-target-department"
              value={data.target_department_id || ''}
              onChange={(e) => {
                const deptId = e.target.value ? Number(e.target.value) : undefined;
                const selectedDept = (Array.isArray(departmentOptions) ? departmentOptions : []).find((d) => d.id === deptId);
                setData({
                  ...data,
                  target_department_id: deptId,
                  reviewer_user_id: undefined,
                  site_engineer_user_id:
                    isGeneralManager && !isOffice && !data.site_engineer_user_id && selectedDept?.site_engineer?.id
                      ? selectedDept.site_engineer.id
                      : data.site_engineer_user_id,
                });
              }}
              disabled={departmentLoading || (Array.isArray(departmentOptions) ? departmentOptions.length : 0) === 0}
              error={Boolean(showValidation && validation.targetDepartment)}
              className="font-bold text-slate-100 bg-slate-950 border-slate-700"
            >
              <option value="" disabled>-- اختر القسم المستهدف --</option>
              {(Array.isArray(departmentOptions) ? departmentOptions : []).map((dept) => {
                const icon =
                  dept.code === 'EXECUTION' ? '🏗️' :
                  dept.code === 'BUILDINGS' ? '🏢' :
                  dept.code === 'FINISHING' ? '🎨' :
                  dept.code === 'LICENSES' ? '📜' :
                  dept.code === 'BUFFET' ? '☕' :
                  dept.code === 'DEVELOPMENT' ? '💻' :
                  dept.code === 'MARKETING' ? '📢' :
                  dept.code === 'SALES' ? '💼' : '🏢';
                const managerName =
                  dept.manager?.name ||
                  (dept.code === 'EXECUTION' ? 'م. أيمن ماهر' :
                   dept.code === 'BUILDINGS' ? 'المهندس حاتم' :
                   dept.code === 'FINISHING' ? 'المهندس مصطفى الخشن' :
                   dept.code === 'LICENSES' ? 'م. مصطفى' :
                   dept.code === 'BUFFET' ? 'أ. عمرو' :
                   dept.code === 'DEVELOPMENT' ? 'المهندس محمود' :
                   dept.code === 'MARKETING' ? 'المهندس كريم أحمد' :
                   dept.code === 'SALES' ? 'المهندس عمرو بيومي' : '');
                return (
                  <option key={dept.id} value={dept.id}>
                    {icon} {dept.name} {managerName ? `— (المراجع: ${managerName})` : ''}
                  </option>
                );
              })}
            </Select>
          </FormField>

          <FormField label="تاريخ الاحتياج" required error={showValidation ? validation.dateNeeded : undefined}>
            <Input
              type="date"
              id="pr-date-needed"
              min={getTodayDateInputValue()}
              max="2099-12-31"
              value={data.date_needed || ''}
              onChange={(event) => setData({ ...data, date_needed: event.target.value })}
              error={Boolean(showValidation && validation.dateNeeded)}
            />
          </FormField>
        </div>

        {/* Site Engineer Selector for General Manager Direct Path */}
        {isGeneralManager && !isOffice && (
          <div className="rounded-xl border border-emerald-700/60 bg-emerald-950/30 p-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="text-emerald-400 font-black flex items-center gap-1.5 text-xs">
                <span>👷</span> مهندس الموقع / مسؤول الاستلام <span className="text-rose-400">*</span>
              </span>
              <span className="text-[10px] text-emerald-300 font-bold bg-emerald-950/90 px-2 py-0.5 rounded border border-emerald-600/50">
                بديل خطوة المراجع
              </span>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              الطلب ده مش هيعدّي على مراجع قسم، فاختار مين هيفحص ويستلم المواد قبل الإرسال للمشتريات.
            </p>
            {isLoadingReceivers ? (
              <div className="text-xs text-slate-400 py-1 font-bold">جاري تحميل قائمة المهندسين والمستلمين...</div>
            ) : (
              <Select
                id="pr-site-engineer"
                value={data.site_engineer_user_id || ''}
                onChange={(e) =>
                  setData({
                    ...data,
                    site_engineer_user_id: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                className="font-bold text-slate-100 bg-slate-900 border-emerald-600/70 focus:border-emerald-400"
              >
                <option value="" disabled>-- اختر مهندس الموقع أو مسؤول الاستلام المعتمد --</option>
                {siteEngineers.length > 0 && (
                  <optgroup label="👷 مهندسو الموقع الأساسيون">
                    {siteEngineers.map((eng) => (
                      <option key={`gm-se-${eng.id}`} value={eng.id}>
                        {eng.name} {eng.department_name ? `(${eng.department_name})` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {otherUsers.length > 0 && (
                  <optgroup label="👥 مستخدمو النظام الآخرون (تفويض أي دور)">
                    {otherUsers.map((u) => (
                      <option key={`gm-oth-${u.id}`} value={u.id}>
                        {u.name} — {u.role_name || 'مستخدم'} {u.department_name ? `(${u.department_name})` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            )}
            {showValidation && validation.targetSiteEngineer && (
              <p className="text-[11px] font-bold text-rose-300 mt-1">⚠️ {validation.targetSiteEngineer}</p>
            )}
          </div>
        )}

        {/* Project Land Parcel & Region Selection (Single per PR) */}
        {!isOffice && (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-3 space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-amber-800/40 pb-2">
              <div className="flex items-center gap-2">
                <span className="text-base">🏗️</span>
                <div>
                  <h3 className="text-xs sm:text-sm font-black text-amber-300">
                    تحديد قطعة الأرض والمنطقة للطلب
                  </h3>
                </div>
              </div>
              {landParcels.length > 0 && (
                <span className="text-[10px] bg-amber-950 px-2 py-0.5 rounded-full border border-amber-700/60 text-amber-300 font-bold self-start sm:self-auto">
                  {landParcels.length} قطعة أرض مسجلة متاحة
                </span>
              )}
            </div>

            {/* Quick Select from Registered Land Parcels */}
            {landParcels.length > 0 && (
              <FormField label="اختيار سريع من قطع الأراضي المسجلة (اختياري)">
                <Select
                  value={data.land_parcel_id || ''}
                  onChange={(e) => {
                    const selectedId = Number(e.target.value);
                    const selectedParcel = landParcels.find((p) => p.id === selectedId);
                    if (selectedParcel) {
                      setData({
                        ...data,
                        land_parcel_id: selectedParcel.id,
                        parcel_reference: selectedParcel.parcel_reference,
                        region: selectedParcel.region,
                      });
                    } else {
                      setData({
                        ...data,
                        land_parcel_id: undefined,
                      });
                    }
                  }}
                  className="bg-slate-950 border-amber-800/60 text-slate-100 font-semibold"
                >
                  <option value="">-- اختر قطعة مسجلة للتعبئة الفورية أو أدخل يدويًا أدناه --</option>
                  {landParcels.map((parcel) => (
                    <option key={parcel.id} value={parcel.id}>
                      🏷️ {parcel.parcel_reference} — {parcel.region}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                label="رقم قطعة الأرض"
                required
                error={showValidation ? validation.parcelReference : undefined}
              >
                <Input
                  id="pr-parcel-reference"
                  type="text"
                  value={data.parcel_reference || ''}
                  onChange={(e) =>
                    setData({
                      ...data,
                      parcel_reference: e.target.value,
                      land_parcel_id:
                        landParcels.find(
                          (p) => p.id === data.land_parcel_id && p.parcel_reference === e.target.value
                        )?.id || undefined,
                    })
                  }
                  placeholder="مثال: قطعة 256 أو A-14"
                  error={Boolean(showValidation && validation.parcelReference)}
                  className="font-mono font-bold text-amber-200"
                />
              </FormField>

              <FormField
                label="المنطقة"
                required
                error={showValidation ? validation.region : undefined}
              >
                <Input
                  id="pr-region"
                  type="text"
                  value={data.region || ''}
                  onChange={(e) =>
                    setData({
                      ...data,
                      region: e.target.value,
                    })
                  }
                  placeholder="مثال: المنطقة السابعة أو التجمع الخامس"
                  error={Boolean(showValidation && validation.region)}
                  className="font-bold text-slate-100"
                />
              </FormField>
            </div>
          </div>
        )}

        <div>
          <FormField
            label="ملاحظات / الغرض من الشراء"
            required
            error={showValidation ? validation.notes : undefined}
          >
            <Textarea
              id="pr-notes"
              rows={2}
              value={data.notes || ''}
              onChange={(event) => setData({ ...data, notes: event.target.value })}
              placeholder="اكتب أي ملاحظات أو توضيحات خاصة بالطلب (إلزامي)..."
              error={Boolean(showValidation && validation.notes)}
              className="font-medium text-slate-100"
            />
          </FormField>
        </div>
      </Card>

      {/* Card 2: Items List */}
      <Card className="space-y-3 border-slate-800 bg-slate-900/90 p-3.5 sm:p-4 shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-xs sm:text-sm font-black text-slate-100 flex items-center gap-2">
              <span className="text-cyan-400">📦</span> 2. بنود ومواد الطلب
            </h2>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-800/60 text-cyan-300">
              {data.items.length} {data.items.length === 1 ? 'بند' : 'بنود'}
            </span>
          </div>

          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={addItem}
            className="text-xs bg-cyan-600 hover:bg-cyan-500 border-cyan-500 font-bold px-3 py-1 flex items-center gap-1.5 shadow-md shadow-cyan-950/40"
          >
            <span>+</span> إضافة صنف جديد
          </Button>
        </div>

        {/* ========================================================= */}
        {/* 1. MOBILE VIEW (Touch-Friendly Responsive Cards)          */}
        {/* ========================================================= */}
        <div className="block md:hidden space-y-2.5">
          {data.items.map((item, index) => {
            const itemErr = validation.items[index];
            const hasItemError = Boolean(itemErr && (itemErr.description || itemErr.quantity));

            return (
              <div
                key={index}
                id={`pr-item-card-mobile-${index}`}
                className={`rounded-xl border p-3 space-y-2 shadow-sm transition-all ${
                  hasItemError && showValidation
                    ? 'bg-rose-950/30 border-rose-500/80 shadow-rose-950/40'
                    : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                }`}
              >
                {/* Header: Index & Quick Actions */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 font-mono font-black text-xs">
                      #{index + 1}
                    </span>
                    <span className="text-xs font-black text-slate-100">
                      البند رقم {index + 1}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => duplicateItem(index)}
                      className="px-2 py-0.5 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg flex items-center gap-1 cursor-pointer transition select-none shadow-xs"
                      title="نسخ وتكرار هذا البند بنفس البيانات"
                    >
                      <span>📋</span>
                      <span className="text-[10px] font-bold">نسخ</span>
                    </button>
                    {data.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(index)}
                        className="px-2 py-0.5 text-xs text-rose-300 bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/80 rounded-lg flex items-center gap-1 cursor-pointer transition select-none shadow-xs"
                        title="حذف هذا البند"
                      >
                        <span>🗑️</span>
                        <span className="text-[10px] font-bold">حذف</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-300 flex items-center justify-between">
                    <span>وصف الصنف / المادة: <span className="text-rose-400">*</span></span>
                  </label>
                  <input
                    type="text"
                    value={item.item_description}
                    onChange={(e) => updateItem(index, { item_description: e.target.value })}
                    placeholder={isOffice ? 'مثال: ورق A4 80جم، حبر HP...' : 'مثال: حديد تسليح 16 مم، خرسانة...'}
                    className={`w-full rounded-lg bg-slate-950 border px-2.5 py-1.5 text-xs sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 ${
                      itemErr?.description && (showValidation || item.item_description.length > 0)
                        ? 'border-rose-500 focus:ring-rose-500'
                        : 'border-slate-700 focus:border-cyan-400 focus:ring-cyan-500/30'
                    }`}
                  />
                  {itemErr?.description && showValidation && (
                    <span className="text-[10px] text-rose-400 block font-semibold">
                      ⚠️ {itemErr.description}
                    </span>
                  )}
                </div>

                {/* Quantity & Unit Row */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold text-slate-300">
                      الكمية: <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="number"
                      min="0.01"
                      step="any"
                      value={item.quantity === 0 ? '' : (item.quantity ?? '')}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => updateItem(index, { quantity: e.target.value === '' ? ('' as any) : Number(e.target.value) })}
                      placeholder="الكمية..."
                      className={`w-full rounded-lg bg-slate-950 border px-2.5 py-1.5 text-xs sm:text-sm font-mono font-bold text-amber-300 placeholder-slate-500 focus:outline-none focus:ring-1 ${
                        itemErr?.quantity && showValidation
                          ? 'border-rose-500 focus:ring-rose-500'
                          : 'border-slate-700 focus:border-cyan-400 focus:ring-cyan-500/30'
                      }`}
                    />
                    {itemErr?.quantity && showValidation && (
                      <span className="text-[10px] text-rose-400 block font-semibold">
                        ⚠️ {itemErr.quantity}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-bold text-slate-300">الوحدة:</label>
                    <select
                      value={item.uom}
                      onChange={(e) => updateItem(index, { uom: e.target.value })}
                      className="w-full h-[34px] rounded-lg bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-400"
                    >
                      {UNIT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Rebar live weight calculation badge */}
                {isRebarUnit(item.uom) && Number(item.quantity) > 0 && (
                  <div className="rounded-lg bg-amber-950/40 border border-amber-600/40 p-2 text-xs flex items-center justify-between text-amber-200">
                    <span className="font-bold flex items-center gap-1.5">
                      <span>⚖️</span> الوزن المحسوب:{' '}
                      <strong className="font-mono text-emerald-300 text-sm">
                        {formatCleanNumber(calculateRebarTons(item.quantity, item.uom), 3)} طن
                      </strong>
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      ({formatCleanQty(item.quantity)} سيخ × {getRebarType(item.uom)?.weightKg} كجم ÷ 1000)
                    </span>
                  </div>
                )}

                {/* Technical Specifications */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-400">
                    المواصفات الفنية (اختياري):
                  </label>
                  <input
                    type="text"
                    value={item.specifications || ''}
                    onChange={(e) => updateItem(index, { specifications: e.target.value })}
                    placeholder="ماركة، دقة، عيار، أبعاد..."
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* ========================================================= */}
        {/* 2. DESKTOP / TABLET VIEW (Spreadsheet Table)              */}
        {/* ========================================================= */}
        <div className="hidden md:block overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60 shadow-inner">
          <table className="w-full min-w-[780px] text-right text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/90 text-slate-400 text-[11px] font-bold">
                <th className="p-3 w-12 text-center whitespace-nowrap">م</th>
                <th className="p-3 min-w-[280px] whitespace-nowrap">
                  وصف الصنف / المادة <span className="text-rose-400">*</span>
                </th>
                <th className="p-3 w-28 whitespace-nowrap">
                  الكمية <span className="text-rose-400">*</span>
                </th>
                <th className="p-3 w-32 whitespace-nowrap">الوحدة</th>
                <th className="p-3 min-w-[200px] whitespace-nowrap">المواصفات الفنية</th>
                <th className="p-3 w-24 text-center whitespace-nowrap">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data.items.map((item, index) => {
                const itemErr = validation.items[index];
                const hasItemError = Boolean(itemErr && (itemErr.description || itemErr.quantity));

                return (
                  <tr
                    key={index}
                    id={`pr-item-card-${index}`}
                    className={`transition-colors hover:bg-slate-900/50 ${
                      hasItemError && showValidation ? 'bg-rose-950/20' : index % 2 === 0 ? 'bg-slate-950/30' : 'bg-slate-900/20'
                    }`}
                  >
                    {/* Index */}
                    <td className="p-2.5 text-center font-mono font-bold text-slate-400">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-slate-900 border border-slate-800 text-[11px] text-cyan-300">
                        {index + 1}
                      </span>
                    </td>

                    {/* Item Description */}
                    <td className="p-2.5 align-top">
                      <div className="space-y-1">
                        <input
                          type="text"
                          value={item.item_description}
                          onChange={(e) => updateItem(index, { item_description: e.target.value })}
                          placeholder={isOffice ? 'مثال: ورق A4 80جم، حبر HP...' : 'مثال: حديد تسليح، خرسانة...'}
                          className={`w-full rounded-lg bg-slate-900 border px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 ${
                            itemErr?.description && (showValidation || item.item_description.length > 0)
                              ? 'border-rose-500/80 focus:ring-rose-500'
                              : 'border-slate-800 focus:border-cyan-500 focus:ring-cyan-500/40'
                          }`}
                        />
                        {itemErr?.description && showValidation && (
                          <span className="text-[10px] text-rose-400 block font-semibold leading-tight">
                            ⚠️ {itemErr.description}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Quantity */}
                    <td className="p-2.5 align-top">
                      <div className="space-y-1">
                        <input
                          type="number"
                          min="0.01"
                          step="any"
                          value={item.quantity === 0 ? '' : (item.quantity ?? '')}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => updateItem(index, { quantity: e.target.value === '' ? ('' as any) : Number(e.target.value) })}
                          placeholder="1"
                          className={`w-full text-center font-mono font-bold rounded-lg bg-slate-900 border px-2 py-1.5 text-xs text-amber-300 placeholder-slate-500 focus:outline-none focus:ring-1 ${
                            itemErr?.quantity && showValidation
                              ? 'border-rose-500/80 focus:ring-rose-500'
                              : 'border-slate-800 focus:border-cyan-500 focus:ring-cyan-500/40'
                          }`}
                        />
                        {itemErr?.quantity && showValidation && (
                          <span className="text-[10px] text-rose-400 block font-semibold text-center leading-tight">
                            ⚠️ {itemErr.quantity}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Unit */}
                    <td className="p-2.5 align-top">
                      <select
                        value={item.uom}
                        onChange={(e) => updateItem(index, { uom: e.target.value })}
                        className="w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                      >
                        {UNIT_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      {isRebarUnit(item.uom) && Number(item.quantity) > 0 && (
                        <div className="mt-1 text-[11px] font-bold text-amber-300 bg-amber-950/60 border border-amber-600/40 rounded px-2 py-1 text-center shadow-sm">
                          ⚖️ {formatCleanNumber(calculateRebarTons(item.quantity, item.uom), 3)} طن
                          <span className="block text-[9px] text-slate-400 font-mono font-normal">
                            ({formatCleanQty(item.quantity)} سيخ × {getRebarType(item.uom)?.weightKg} كجم)
                          </span>
                        </div>
                      )}
                    </td>

                    {/* Specifications */}
                    <td className="p-2.5 align-top">
                      <input
                        type="text"
                        value={item.specifications || ''}
                        onChange={(e) => updateItem(index, { specifications: e.target.value })}
                        placeholder="ماركة، دقة، أبعاد..."
                        className="w-full rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                      />
                    </td>

                    {/* Actions */}
                    <td className="p-2.5 align-top text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => duplicateItem(index)}
                          className="p-1.5 text-slate-400 hover:text-cyan-300 hover:bg-slate-800/80 rounded-lg transition-colors"
                          title="نسخ وتكرار هذا البند بنفس البيانات"
                        >
                          📋
                        </button>
                        {data.items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 rounded-lg transition-colors"
                            title="حذف هذا البند"
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Quick add bottom bar */}
        <div className="flex items-center justify-between pt-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addItem}
            className="text-xs border-dashed border-slate-700 hover:border-cyan-500/70 hover:text-cyan-300 px-4 py-2"
          >
            + إضافة سطر صنف آخر (Add Row)
          </Button>

        </div>
      </Card>

      {/* Bottom Submit & Action Bar - Streamlined, Compact Mobile Floating Dock */}
      <div className="sticky bottom-2 sm:bottom-3 z-30 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 rounded-xl sm:rounded-2xl border border-slate-700/80 bg-slate-950/95 p-2 sm:p-4 shadow-2xl backdrop-blur-md">
        {/* Mobile Mini Meta Bar */}
        <div className="flex sm:hidden items-center justify-between text-[11px] px-1 text-slate-400 font-semibold">
          <div className="flex items-center gap-2">
            <span>📦 الأصناف: <strong className="text-cyan-300 font-mono">{data.items.length}</strong></span>
          </div>
          {draftMessage ? (
            <span className="text-emerald-400 font-bold text-[10px]">✓ {draftMessage}</span>
          ) : isDirty ? (
            <button
              type="button"
              onClick={handleClearDraft}
              className="text-slate-400 hover:text-rose-300 underline text-[10px]"
            >
              مسح المسودة
            </button>
          ) : null}
        </div>

        {/* Desktop Full Info Bar */}
        <div className="hidden sm:flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-3 bg-slate-900/90 border border-slate-800 px-3 py-1.5 rounded-xl">
            <span className="text-slate-400 font-bold">إجمالي الأصناف:</span>
            <span className="font-mono font-black text-cyan-300 text-sm">{data.items.length}</span>
          </div>

          {draftMessage && (
            <span className="text-xs font-bold text-emerald-400 bg-emerald-950/80 border border-emerald-800/60 px-2 py-0.5 rounded-md">
              ✓ {draftMessage}
            </span>
          )}
          {isDirty && (
            <button
              type="button"
              onClick={handleClearDraft}
              className="text-[11px] font-bold text-slate-400 hover:text-rose-300 underline underline-offset-4 transition-colors cursor-pointer"
            >
              مسح المسودة والبدء من جديد
            </button>
          )}
        </div>

        {/* Action Buttons: Unified Row on Mobile & Desktop */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleSaveDraft}
            disabled={isSubmitting || isSavingDraft}
            isLoading={isSavingDraft}
            className="text-xs shrink-0 py-2 sm:py-2.5 px-3"
          >
            <span className="sm:hidden">💾 مسودة</span>
            <span className="hidden sm:inline">💾 حفظ كمسودة</span>
          </Button>

          <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={() => void handleSubmit(true)}
            disabled={isSubmitting || isSavingDraft}
            isLoading={isSubmitting}
            className="py-2 sm:py-2.5 px-3 sm:px-4 text-xs sm:text-sm font-bold border-amber-500/60 bg-amber-950/40 text-amber-300 hover:bg-amber-900/60 hover:border-amber-400 shrink-0 shadow-md shadow-amber-950/40"
            title="إرسال الطلب وحفظ بنوده في قائمتك المفضلة لاستخدامها لاحقاً"
          >
            <span>⭐</span>
            <span className="hidden sm:inline">إرسال وحفظ في المفضلة</span>
            <span className="sm:hidden">إرسال ومفضلة ⭐</span>
          </Button>

          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={() => void handleSubmit(false)}
            disabled={isSubmitting || isSavingDraft}
            isLoading={isSubmitting}
            className="flex-1 sm:flex-initial px-4 sm:px-6 py-2.5 shadow-lg shadow-cyan-600/30 text-xs sm:text-sm font-bold justify-center"
          >
            🚀 {isReviewer
              ? 'اعتماد وإرسال للمدير التنفيذي'
              : isGeneralManager
                ? 'إرسال مباشر للمشتريات'
                : 'إرسال طلب الشراء فوراً'}
          </Button>
        </div>
      </div>

      {/* نافذة اعتماد المراجع وتحديد مسؤول الاستلام ومسار المخزن */}
      {isReviewer && (
        <ApproveRequestDialog
          isOpen={isReviewerModalOpen}
          requestNumber="طلب شراء جديد"
          title="اعتماد طلب الشراء وتحديد مسؤول الاستلام ومسار المخزن"
          subtitle="طلب شراء جديد — سيتم الاعتماد والإرسال مباشرةً إلى المدير التنفيذي"
          promptText="حدد المسؤول عن فحص واستلام المواد (مهندس الموقع أو أمين المخزن أو استلام المواد بنفسك) وما إذا كان الطلب سيمر على عم سلامة في المخزن:"
          confirmButtonText="اعتماد وإرسال إلى المدير التنفيذي 🚀"
          initialSiteEngineerId={data.site_engineer_user_id || user?.id || null}
          initialRequiresWarehouseReceipt={true}
          isApproving={isSubmitting}
          onConfirm={(comment, siteEngineerUserId, requiresWarehouseReceipt) => {
            void executeSubmission(pendingSaveToFavorites, siteEngineerUserId, requiresWarehouseReceipt, comment);
          }}
          onCancel={() => setIsReviewerModalOpen(false)}
        />
      )}

      {/* مربع تنبيه إلزامي: الغرض من الشراء */}
      {showMissingNotesModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
          dir="rtl"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border-2 border-amber-500/80 bg-slate-900 p-6 shadow-2xl shadow-amber-500/10 text-center space-y-4">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/30 text-3xl">
              ⚠️
            </div>
            <div className="space-y-2">
              <h3 className="text-base sm:text-lg font-black text-slate-100">
                تنبيه: حقل إلزامي مطلوب
              </h3>
              <p className="text-sm font-semibold text-amber-200 leading-relaxed">
                حقل <span className="text-white font-black underline decoration-amber-400">«ملاحظات / الغرض من الشراء»</span> إلزامي ولا يمكن إرسال طلب الشراء بدونه.
              </p>
              <p className="text-xs text-slate-400">
                يرجى توضيح الغرض من الشراء (مثل: خرسانة القواعد، أعمدة الدور، تشطيبات، صيانة، إلخ) للمتابعة.
              </p>
            </div>
            <div className="pt-2">
              <Button
                type="button"
                variant="primary"
                className="w-full bg-amber-600 hover:bg-amber-500 text-slate-950 font-black py-2.5 rounded-xl shadow-lg shadow-amber-600/30 cursor-pointer"
                onClick={() => {
                  setShowMissingNotesModal(false);
                  setTimeout(() => {
                    const el = document.getElementById('pr-notes');
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      el.focus();
                    }
                  }, 100);
                }}
              >
                ✏️ حسناً، سأكتب الغرض الآن
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CreatePurchaseRequestPage;
