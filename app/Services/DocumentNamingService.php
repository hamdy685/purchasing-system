<?php

namespace App\Services;

use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderItem;
use App\Models\PurchaseRequest;
use App\Models\PurchaseRequestItem;
use App\Models\Supplier;
use App\Models\WeighingGroup;
use Carbon\Carbon;
use Illuminate\Support\Collection;

class DocumentNamingService
{
    /**
     * Clean and sanitize a single segment of a file name.
     * Preserves Arabic letters, Latin letters, numbers, dashes, and underscores.
     * Replaces slashes, colons, stars, quotes, pipes, brackets, and whitespace with single dashes.
     */
    public static function sanitizeSegment(?string $value, int $maxLength = 40): string
    {
        if ($value === null || trim($value) === '') {
            return '';
        }

        $clean = trim($value);

        // Normalize Arabic letters if needed (e.g., standardizing spaces or non-breaking spaces)
        $clean = str_replace(["\xc2\xa0", "\r", "\n", "\t"], ' ', $clean);

        // Remove illegal filesystem/URL characters
        $clean = preg_replace('/[\\\\\/:\*\?"<>\|\(\)\[\]\{\}#%&+=~`!@$^\.,;]+/u', '-', $clean);

        // Preserve all Unicode letters, Unicode numbers, underscores, and dashes
        $clean = preg_replace('/[^\p{L}\p{N}_\-]+/u', '-', $clean);

        // Collapse multiple dashes or underscores
        $clean = preg_replace('/-+/', '-', $clean);
        $clean = preg_replace('/_+/', '_', $clean);
        $clean = trim($clean, '-_');

        if (mb_strlen($clean) > $maxLength) {
            $clean = mb_substr($clean, 0, $maxLength);
            $clean = trim($clean, '-_');
        }

        return $clean;
    }

    /**
     * Format the plot/piece segment.
     * e.g. '148' -> 'قطعة-148', 'قطعة 148' -> 'قطعة-148', multiple -> 'متعدد-القطع', empty -> 'غير-محدد'
     */
    public static function formatPlotSegment(?string $plot): string
    {
        if (empty($plot) || trim($plot) === '') {
            return 'غير-محدد';
        }

        $clean = trim($plot);
        if ($clean === 'متعدد-القطع' || $clean === 'متعدد') {
            return 'متعدد-القطع';
        }

        // Remove leading "قطعة" or "plot" if already in string to prevent "قطعة-قطعة-148"
        $stripped = preg_replace('/^(قطعة|قطعه|plot|piece)[\s\-_]*/ui', '', $clean);
        $sanitized = self::sanitizeSegment($stripped ?: $clean, 30);

        return $sanitized !== '' ? 'قطعة-' . $sanitized : 'غير-محدد';
    }

    /**
     * Format the region/area segment.
     * e.g. 'التجمع' -> 'منطقة-التجمع', multiple -> 'متعدد-المناطق', empty -> 'غير-محدد'
     */
    public static function formatRegionSegment(?string $region): string
    {
        if (empty($region) || trim($region) === '') {
            return 'غير-محدد';
        }

        $clean = trim($region);
        if ($clean === 'متعدد-المناطق' || $clean === 'متعدد') {
            return 'متعدد-المناطق';
        }

        // Remove leading "منطقة" or "area" / "region" if already present
        $stripped = preg_replace('/^(منطقة|منطقه|area|region)[\s\-_]*/ui', '', $clean);
        $sanitized = self::sanitizeSegment($stripped ?: $clean, 30);

        return $sanitized !== '' ? 'منطقة-' . $sanitized : 'غير-محدد';
    }

    /**
     * Format the item/material segment.
     * e.g. 'حديد تسليح 12 مم' -> 'حديد-تسليح-12-مم', multiple -> 'متعدد-البنود', empty -> 'غير-محدد'
     */
    public static function formatItemSegment(?string $item): string
    {
        if (empty($item) || trim($item) === '') {
            return 'غير-محدد';
        }

        $clean = trim($item);
        if ($clean === 'متعدد-البنود' || $clean === 'متعدد') {
            return 'متعدد-البنود';
        }

        $sanitized = self::sanitizeSegment($clean, 35);
        return $sanitized !== '' ? $sanitized : 'غير-محدد';
    }

    /**
     * Format PO or PR number.
     * e.g. 'PO-148', 'PR-151'
     */
    public static function formatDocCodeSegment(?string $code, string $defaultPrefix = 'PO'): string
    {
        if (empty($code) || trim($code) === '') {
            return 'بدون-طلب';
        }

        $clean = self::sanitizeSegment($code, 25);
        return $clean !== '' ? $clean : 'بدون-طلب';
    }

    /**
     * Format supplier name segment.
     */
    public static function formatSupplierSegment(?string $supplier): ?string
    {
        if (empty($supplier) || trim($supplier) === '') {
            return null;
        }

        $clean = self::sanitizeSegment($supplier, 35);
        return $clean !== '' ? $clean : null;
    }

    /**
     * Format date in YYYY-MM-DD.
     */
    public static function formatDateSegment(?string $date = null): string
    {
        if (!empty($date)) {
            try {
                return Carbon::parse($date)->format('Y-m-d');
            } catch (\Throwable) {
                // fallback to today
            }
        }

        return now()->format('Y-m-d');
    }

    /**
     * Format sequence number (e.g. 1 -> '01', 2 -> '02').
     */
    public static function formatSequenceSegment(int|string $sequence = 1): string
    {
        $seq = (int) $sequence;
        if ($seq <= 0) {
            $seq = 1;
        }

        return str_pad((string) $seq, 2, '0', STR_PAD_LEFT);
    }

    /**
     * Clean and normalize a full filename while preserving its extension.
     */
    public static function sanitizeFileName(string $fileName, ?string $extension = null): string
    {
        $info = pathinfo($fileName);
        $base = $info['filename'] ?? $fileName;
        $ext = $extension ?: ($info['extension'] ?? '');

        // Sanitize the base name preserving Arabic, letters, numbers, dashes, underscores
        $sanitizedBase = self::sanitizeSegment($base, 150);
        if (empty($sanitizedBase)) {
            $sanitizedBase = 'document_' . time();
        }

        $cleanExt = ltrim(strtolower(self::sanitizeSegment($ext, 10)), '.-');
        return $cleanExt !== '' ? "{$sanitizedBase}.{$cleanExt}" : $sanitizedBase;
    }

    /**
     * Extract Plot, Region, and Item summary from an iterable collection of items.
     * Handles single vs multi-item, single vs multi-plot, single vs multi-region.
     *
     * @param iterable $items Collection/array of items or item attributes
     * @param string|null $fallbackPlot Fallback plot from PO / PR
     * @param string|null $fallbackRegion Fallback region from PO / PR
     * @return array [ 'plot' => string, 'region' => string, 'item' => string ]
     */
    public static function extractMetadataFromItems(
        iterable $items,
        ?string $fallbackPlot = null,
        ?string $fallbackRegion = null
    ): array {
        $plots = collect();
        $regions = collect();
        $itemNames = collect();

        foreach ($items as $item) {
            // Plot extraction
            $plot = null;
            if (is_array($item)) {
                $plot = $item['land_plot_number'] ?? $item['item_reference'] ?? null;
            } elseif (is_object($item)) {
                $plot = $item->land_plot_number ?? $item->item_reference ?? null;
            }
            if (!empty($plot) && trim((string) $plot) !== '') {
                $plots->push(trim((string) $plot));
            }

            // Region extraction
            $region = null;
            if (is_array($item)) {
                $region = $item['region'] ?? null;
            } elseif (is_object($item)) {
                $region = $item->region ?? null;
            }
            if (!empty($region) && trim((string) $region) !== '') {
                $regions->push(trim((string) $region));
            }

            // Item name extraction
            $name = null;
            if (is_array($item)) {
                $name = $item['item_name'] ?? $item['item_description'] ?? null;
            } elseif (is_object($item)) {
                if (isset($item->item) && is_object($item->item) && !empty($item->item->name)) {
                    $name = $item->item->name;
                } else {
                    $name = $item->item_description ?? $item->name ?? null;
                }
            }
            if (!empty($name) && trim((string) $name) !== '') {
                $itemNames->push(trim((string) $name));
            }
        }

        // Plot resolution
        $distinctPlots = $plots->unique()->values();
        if ($distinctPlots->count() === 1) {
            $plotSegment = self::formatPlotSegment($distinctPlots->first());
        } elseif ($distinctPlots->count() > 1) {
            $plotSegment = 'متعدد-القطع';
        } else {
            $plotSegment = self::formatPlotSegment($fallbackPlot);
        }

        // Region resolution
        $distinctRegions = $regions->unique()->values();
        if ($distinctRegions->count() === 1) {
            $regionSegment = self::formatRegionSegment($distinctRegions->first());
        } elseif ($distinctRegions->count() > 1) {
            $regionSegment = 'متعدد-المناطق';
        } else {
            $regionSegment = self::formatRegionSegment($fallbackRegion);
        }

        // Item resolution
        $distinctItemNames = $itemNames->unique()->values();
        if ($distinctItemNames->count() === 1) {
            $itemSegment = self::formatItemSegment($distinctItemNames->first());
        } elseif ($distinctItemNames->count() > 1) {
            $itemSegment = 'متعدد-البنود';
        } else {
            $itemSegment = 'غير-محدد';
        }

        return [
            'plot' => $plotSegment,
            'region' => $regionSegment,
            'item' => $itemSegment,
            'distinct_items_count' => $distinctItemNames->count(),
            'distinct_plots_count' => $distinctPlots->count(),
            'distinct_regions_count' => $distinctRegions->count(),
        ];
    }

    /**
     * Generate Receipt filename:
     * Format: إذن_استلام_[رقم الإذن]_[القطعة]_[المنطقة]_[البند]_[PO]_[المورد]_[التاريخ]_[التسلسل].[الامتداد]
     */
    public static function generateReceiptName(
        PurchaseOrder $po,
        ?array $receivedItemsInput = null,
        ?string $receiptNumber = null,
        string $extension = 'jpg',
        ?WeighingGroup $weighingGroup = null,
        int $sequence = 1,
        ?string $receivedAt = null
    ): string {
        $po->loadMissing(['supplier', 'items.item', 'purchaseRequest.landParcel']);

        $fallbackPlot = $po->purchaseRequest?->parcel_reference
            ?: $po->purchaseRequest?->landParcel?->parcel_reference;
        $fallbackRegion = $po->purchaseRequest?->region
            ?: $po->purchaseRequest?->landParcel?->region;

        // If weighing group is linked, prioritize weighing group items
        if ($weighingGroup && $weighingGroup->relationLoaded('items') && $weighingGroup->items->isNotEmpty()) {
            $metadata = self::extractMetadataFromItems($weighingGroup->items, $fallbackPlot, $fallbackRegion);
        } elseif (!empty($receivedItemsInput)) {
            // Filter PO items to only those received in this transaction
            $receivedPoItemIds = collect($receivedItemsInput)
                ->pluck('purchase_order_item_id')
                ->filter()
                ->all();

            $matchingPoItems = $po->items->whereIn('id', $receivedPoItemIds);
            if ($matchingPoItems->isNotEmpty()) {
                $metadata = self::extractMetadataFromItems($matchingPoItems, $fallbackPlot, $fallbackRegion);
            } else {
                $metadata = self::extractMetadataFromItems($po->items, $fallbackPlot, $fallbackRegion);
            }
        } else {
            $metadata = self::extractMetadataFromItems($po->items, $fallbackPlot, $fallbackRegion);
        }

        $segments = [];

        // 1. Doc type & optional receipt number
        if (!empty($receiptNumber)) {
            $segments[] = 'إذن_استلام_' . self::sanitizeSegment($receiptNumber, 25);
        } else {
            $segments[] = 'إذن_استلام';
        }

        // 2. Plot
        $segments[] = $metadata['plot'];

        // 3. Region
        $segments[] = $metadata['region'];

        // 4. Item
        $segments[] = $metadata['item'];

        // 5. PO Code
        $poCode = $po->po_number ?: "PO-{$po->id}";
        $segments[] = self::formatDocCodeSegment($poCode, 'PO');

        // 6. Supplier
        $supplierName = $po->supplier?->company_name ?: ($po->supplier?->name ?: ($weighingGroup?->supplier?->company_name ?: ($weighingGroup?->supplier?->name ?? null)));
        $supplierSegment = self::formatSupplierSegment($supplierName);
        if ($supplierSegment) {
            $segments[] = $supplierSegment;
        }

        // 7. Date
        $segments[] = self::formatDateSegment($receivedAt);

        // 8. Sequence
        $segments[] = self::formatSequenceSegment($sequence);

        $baseName = implode('_', array_filter($segments));
        return self::sanitizeFileName($baseName, $extension);
    }

    /**
     * Generate Scale Ticket filename:
     * Format: تذكرة_ميزان_[رقم التذكرة]_[القطعة]_[المنطقة]_[البند]_[PO]_[المورد]_[التاريخ]_[التسلسل].[الامتداد]
     */
    public static function generateScaleTicketName(
        WeighingGroup $group,
        ?string $ticketNumber = null,
        string $extension = 'jpg',
        int $sequence = 1,
        ?string $receivedAt = null
    ): string {
        $group->loadMissing(['items', 'purchaseOrder.supplier', 'purchaseOrder.purchaseRequest.landParcel', 'supplier']);

        $fallbackPlot = $group->purchaseOrder?->purchaseRequest?->parcel_reference
            ?: $group->purchaseOrder?->purchaseRequest?->landParcel?->parcel_reference;
        $fallbackRegion = $group->purchaseOrder?->purchaseRequest?->region
            ?: $group->purchaseOrder?->purchaseRequest?->landParcel?->region;

        $metadata = self::extractMetadataFromItems($group->items, $fallbackPlot, $fallbackRegion);

        $segments = [];

        // 1. Doc type & ticket / group number
        $refNum = $ticketNumber ?: $group->group_number;
        if (!empty($refNum)) {
            $segments[] = 'تذكرة_ميزان_' . self::sanitizeSegment($refNum, 25);
        } else {
            $segments[] = 'تذكرة_ميزان';
        }

        // 2. Plot
        $segments[] = $metadata['plot'];

        // 3. Region
        $segments[] = $metadata['region'];

        // 4. Item
        $segments[] = $metadata['item'];

        // 5. PO Code
        $poCode = $group->purchaseOrder?->po_number ?: ($group->purchase_order_id ? "PO-{$group->purchase_order_id}" : null);
        $segments[] = self::formatDocCodeSegment($poCode, 'PO');

        // 6. Supplier (if available)
        $supplierName = $group->supplier?->company_name ?: ($group->supplier?->name ?: ($group->purchaseOrder?->supplier?->company_name ?: ($group->purchaseOrder?->supplier?->name ?? null)));
        $supplierSegment = self::formatSupplierSegment($supplierName);
        if ($supplierSegment) {
            $segments[] = $supplierSegment;
        }

        // 7. Date
        $date = $receivedAt ?: ($group->received_at ? $group->received_at->toDateString() : null);
        $segments[] = self::formatDateSegment($date);

        // 8. Sequence
        $segments[] = self::formatSequenceSegment($sequence);

        $baseName = implode('_', array_filter($segments));
        return self::sanitizeFileName($baseName, $extension);
    }

    /**
     * Generate Invoice filename:
     * Format: فاتورة_[رقم الفاتورة]_[القطعة]_[المنطقة]_[البند]_[PO]_[المورد]_[التاريخ]_[التسلسل].[الامتداد]
     */
    public static function generateInvoiceName(
        PurchaseOrder $po,
        ?string $invoiceNumber = null,
        string $extension = 'pdf',
        int $sequence = 1,
        ?string $invoiceDate = null
    ): string {
        $po->loadMissing(['supplier', 'items.item', 'purchaseRequest.landParcel']);

        $fallbackPlot = $po->purchaseRequest?->parcel_reference
            ?: $po->purchaseRequest?->landParcel?->parcel_reference;
        $fallbackRegion = $po->purchaseRequest?->region
            ?: $po->purchaseRequest?->landParcel?->region;

        $metadata = self::extractMetadataFromItems($po->items, $fallbackPlot, $fallbackRegion);

        $segments = [];

        // 1. Doc type & optional invoice number
        if (!empty($invoiceNumber)) {
            $segments[] = 'فاتورة_' . self::sanitizeSegment($invoiceNumber, 25);
        } else {
            $segments[] = 'فاتورة';
        }

        // 2. Plot
        $segments[] = $metadata['plot'];

        // 3. Region
        $segments[] = $metadata['region'];

        // 4. Item
        $segments[] = $metadata['item'];

        // 5. PO Code
        $poCode = $po->po_number ?: "PO-{$po->id}";
        $segments[] = self::formatDocCodeSegment($poCode, 'PO');

        // 6. Supplier
        $supplierSegment = self::formatSupplierSegment($po->supplier?->company_name ?: ($po->supplier?->name ?? null));
        if ($supplierSegment) {
            $segments[] = $supplierSegment;
        }

        // 7. Date
        $segments[] = self::formatDateSegment($invoiceDate);

        // 8. Sequence
        $segments[] = self::formatSequenceSegment($sequence);

        $baseName = implode('_', array_filter($segments));
        return self::sanitizeFileName($baseName, $extension);
    }

    /**
     * Generate Quotation filename:
     * Format: عرض_سعر_[القطعة]_[المنطقة]_[البند]_[PR]_[المورد]_[التاريخ]_[التسلسل].[الامتداد]
     */
    public static function generateQuotationName(
        PurchaseRequest $pr,
        ?Supplier $supplier = null,
        ?array $quoteItems = null,
        string $extension = 'pdf',
        int $sequence = 1
    ): string {
        $pr->loadMissing(['items.item', 'landParcel']);

        $fallbackPlot = $pr->parcel_reference ?: $pr->landParcel?->parcel_reference;
        $fallbackRegion = $pr->region ?: $pr->landParcel?->region;

        $itemsSource = !empty($quoteItems) ? $quoteItems : $pr->items;
        $metadata = self::extractMetadataFromItems($itemsSource, $fallbackPlot, $fallbackRegion);

        $segments = [];

        // 1. Doc type
        $segments[] = 'عرض_سعر';

        // 2. Plot
        $segments[] = $metadata['plot'];

        // 3. Region
        $segments[] = $metadata['region'];

        // 4. Item
        $segments[] = $metadata['item'];

        // 5. PR Code
        $prCode = $pr->request_number ?: ($pr->pr_number ?: "PR-{$pr->id}");
        $segments[] = self::formatDocCodeSegment($prCode, 'PR');

        // 6. Supplier
        $supplierSegment = self::formatSupplierSegment($supplier?->company_name ?: ($supplier?->name ?? null));
        if ($supplierSegment) {
            $segments[] = $supplierSegment;
        }

        // 7. Date
        $segments[] = self::formatDateSegment();

        // 8. Sequence
        $segments[] = self::formatSequenceSegment($sequence);

        $baseName = implode('_', array_filter($segments));
        return self::sanitizeFileName($baseName, $extension);
    }

    /**
     * Generate General Attachment filename:
     * Format: مرفق_[القطعة]_[المنطقة]_[البند]_[PR أو PO]_[الاسم_الأصلي]_[التاريخ]_[التسلسل].[الامتداد]
     */
    public static function generateAttachmentName(
        PurchaseRequest|PurchaseOrder $entity,
        string $originalFileName,
        ?string $extension = null,
        int $sequence = 1
    ): string {
        $entity->loadMissing(['items.item']);

        if ($entity instanceof PurchaseRequest) {
            $entity->loadMissing('landParcel');
            $fallbackPlot = $entity->parcel_reference ?: $entity->landParcel?->parcel_reference;
            $fallbackRegion = $entity->region ?: $entity->landParcel?->region;
            $docCode = $entity->pr_number ?: "PR-{$entity->id}";
            $codePrefix = 'PR';
        } else {
            $entity->loadMissing(['purchaseRequest.landParcel']);
            $fallbackPlot = $entity->purchaseRequest?->parcel_reference
                ?: $entity->purchaseRequest?->landParcel?->parcel_reference;
            $fallbackRegion = $entity->purchaseRequest?->region
                ?: $entity->purchaseRequest?->landParcel?->region;
            $docCode = $entity->po_number ?: "PO-{$entity->id}";
            $codePrefix = 'PO';
        }

        $metadata = self::extractMetadataFromItems($entity->items, $fallbackPlot, $fallbackRegion);

        $info = pathinfo($originalFileName);
        $originalTitle = self::sanitizeSegment($info['filename'] ?? 'attachment', 25);
        $ext = $extension ?: ($info['extension'] ?? 'pdf');

        $segments = [
            'مرفق',
            $metadata['plot'],
            $metadata['region'],
            $metadata['item'],
            self::formatDocCodeSegment($docCode, $codePrefix),
            $originalTitle,
            self::formatDateSegment(),
            self::formatSequenceSegment($sequence),
        ];

        $baseName = implode('_', array_filter($segments));
        return self::sanitizeFileName($baseName, $ext);
    }
}
