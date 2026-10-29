<?php

namespace App\Services;

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

class StorageService
{
    /**
     * Determine the active storage disk (prefers Cloudflare R2 if configured).
     */
    public static function disk(): string
    {
        if (config('filesystems.default') === 'r2' || config('filesystems.default') === 's3') {
            return config('filesystems.default');
        }

        if (config('filesystems.disks.r2.key') && config('filesystems.disks.r2.bucket')) {
            return 'r2';
        }

        if (config('filesystems.disks.s3.key') && config('filesystems.disks.s3.bucket')) {
            return 's3';
        }

        return 'public';
    }

    /**
     * Store an uploaded file.
     * Google Drive is the primary permanent cloud storage for procurement receipts and invoices.
     *
     * @throws \RuntimeException If cloud upload fails in production
     */
    public static function storeUploadedFile(UploadedFile $file, string $directory = 'attachments', ?string $customName = null): array
    {
        $extension = $file->getClientOriginalExtension() ?: 'bin';
        if ($customName) {
            $fileName = DocumentNamingService::sanitizeFileName($customName, $extension);
        } else {
            $fileName = Str::slug(pathinfo($file->getClientOriginalName(), PATHINFO_FILENAME)) . '_' . time() . '_' . Str::random(6) . '.' . $extension;
        }
        $mimeType = $file->getClientMimeType() ?: $file->getMimeType();

        $isGoogleDriveCandidate = ($directory === 'receipts' || $directory === 'invoices' || $directory === 'quotes' || GoogleDriveService::isConfigured())
            && config('google_drive.enabled', true);

        // 1. Upload to Google Drive
        if ($isGoogleDriveCandidate) {
            try {
                $content = $file->getContent();
                if ($directory === 'invoices') {
                    $driveData = GoogleDriveService::uploadInvoice($content, $fileName, $mimeType);
                } elseif ($directory === 'quotes') {
                    $driveData = GoogleDriveService::uploadQuote($content, $fileName, $mimeType);
                } elseif ($directory === 'receipts') {
                    $driveData = GoogleDriveService::uploadReceipt($content, $fileName, $mimeType);
                } else {
                    $driveData = GoogleDriveService::upload($content, $fileName, $mimeType);
                }

                if (! empty($driveData['path']) && ! empty($driveData['id'])) {
                    // Cache a temporary local copy if possible, but Google Drive is the source of truth
                    try {
                        Storage::disk('public')->put(rtrim($directory, '/') . '/' . $fileName, $content);
                    } catch (\Throwable) {}

                    return [
                        'disk' => 'google_drive',
                        'path' => $driveData['path'],
                        'drive_id' => $driveData['id'],
                        'name' => $customName ? $fileName : $file->getClientOriginalName(),
                        'size' => $file->getSize(),
                        'mime_type' => $mimeType,
                        'url' => $driveData['url'],
                        'download_url' => $driveData['download_url'] ?? null,
                    ];
                }
            } catch (\Throwable $e) {
                Log::error('Google Drive file upload failed: ' . $e->getMessage());

                // Prevent silent local fallback in production or when Google Drive is configured
                if (app()->environment('production') || GoogleDriveService::isConfigured()) {
                    throw new \RuntimeException('تعذر رفع المرفق إلى Google Drive: ' . $e->getMessage() . '. تم إيقاف العملية لحماية المرفقات من الفقدان بعد إعادة النشر.');
                }
            }
        }

        // 2. Fallback to configured active disk only for local dev/testing
        $disk = self::disk();
        $path = $file->storeAs($directory, $fileName, $disk);

        return [
            'disk' => $disk,
            'path' => $path,
            'drive_id' => null,
            'name' => $customName ? $fileName : $file->getClientOriginalName(),
            'size' => $file->getSize(),
            'mime_type' => $mimeType,
            'url' => self::url($path, $disk),
        ];
    }

    /**
     * Store base64 data to Google Drive or active disk.
     *
     * @throws \RuntimeException If cloud upload fails in production
     */
    public static function storeBase64(string $base64Data, string $directory = 'receipts', ?string $customName = null): ?array
    {
        $extension = 'jpg';
        $mimeType = 'image/jpeg';
        $data = $base64Data;

        if (str_contains($base64Data, ';base64,')) {
            $parts = explode(';base64,', $base64Data, 2);
            $meta = $parts[0];
            $data = $parts[1] ?? '';

            if (preg_match('/data:image\/([a-zA-Z0-9\+\-]+)/i', $meta, $matches)) {
                $ext = strtolower($matches[1]);
                if ($ext === 'jpeg' || $ext === 'pjpeg') {
                    $extension = 'jpg';
                    $mimeType = 'image/jpeg';
                } elseif ($ext === 'png') {
                    $extension = 'png';
                    $mimeType = 'image/png';
                } elseif ($ext === 'webp') {
                    $extension = 'webp';
                    $mimeType = 'image/webp';
                } else {
                    $extension = $ext;
                    $mimeType = 'image/' . $ext;
                }
            }
        }

        $decoded = base64_decode($data);
        if ($decoded === false || empty($decoded)) {
            return null;
        }

        if ($customName) {
            $fileName = DocumentNamingService::sanitizeFileName($customName, $extension);
        } else {
            $fileName = 'receipt_' . time() . '_' . Str::random(8) . '.' . $extension;
        }

        $isGoogleDriveCandidate = ($directory === 'receipts' || $directory === 'invoices' || $directory === 'quotes' || GoogleDriveService::isConfigured())
            && config('google_drive.enabled', true);

        // 1. Upload to Google Drive
        if ($isGoogleDriveCandidate) {
            try {
                if ($directory === 'invoices') {
                    $driveData = GoogleDriveService::uploadInvoice($decoded, $fileName, $mimeType);
                } elseif ($directory === 'quotes') {
                    $driveData = GoogleDriveService::uploadQuote($decoded, $fileName, $mimeType);
                } elseif ($directory === 'receipts') {
                    $driveData = GoogleDriveService::uploadReceipt($decoded, $fileName, $mimeType);
                } else {
                    $driveData = GoogleDriveService::upload($decoded, $fileName, $mimeType);
                }

                if (! empty($driveData['path']) && ! empty($driveData['id'])) {
                    try {
                        Storage::disk('public')->put(rtrim($directory, '/') . '/' . $fileName, $decoded);
                    } catch (\Throwable) {}

                    return [
                        'disk' => 'google_drive',
                        'path' => $driveData['path'],
                        'drive_id' => $driveData['id'],
                        'name' => $customName ?: $fileName,
                        'size' => strlen($decoded),
                        'mime_type' => $mimeType,
                        'url' => $driveData['url'],
                        'download_url' => $driveData['download_url'] ?? null,
                    ];
                }
            } catch (\Throwable $e) {
                Log::error('Google Drive base64 upload failed: ' . $e->getMessage());

                if (app()->environment('production') || GoogleDriveService::isConfigured()) {
                    throw new \RuntimeException('تعذر رفع المرفق إلى Google Drive: ' . $e->getMessage() . '. تم إيقاف العملية لحماية المرفقات من الفقدان بعد إعادة النشر.');
                }
            }
        }

        // 2. Fallback only in local dev/testing
        $disk = self::disk();
        $path = rtrim($directory, '/') . '/' . $fileName;

        Storage::disk($disk)->put($path, $decoded);

        return [
            'disk' => $disk,
            'path' => $path,
            'drive_id' => null,
            'name' => $customName ?: $fileName,
            'size' => strlen($decoded),
            'mime_type' => $mimeType,
            'url' => self::url($path, $disk),
        ];
    }

    /**
     * Alias for storeBase64.
     */
    public static function storeBase64File(string $base64Data, string $directory = 'receipts', ?string $customName = null): ?array
    {
        return self::storeBase64($base64Data, $directory, $customName);
    }

    /**
     * Get the public URL for a stored file.
     */
    public static function url(?string $path, ?string $disk = null): ?string
    {
        if (! $path) {
            return null;
        }

        if (filter_var($path, FILTER_VALIDATE_URL)) {
            return $path;
        }

        $disk = $disk ?: self::disk();

        if ($disk === 'r2' || $disk === 's3') {
            $r2PublicUrl = config('filesystems.disks.r2.url') ?: config('filesystems.disks.s3.url');
            if ($r2PublicUrl) {
                return rtrim($r2PublicUrl, '/') . '/' . ltrim($path, '/');
            }
            try {
                return Storage::disk($disk)->url($path);
            } catch (\Throwable) {}
        }

        return null;
    }

    /**
     * Whether a stored path really points at a file under the current storage mechanism.
     * Google Drive ids / web URLs are what a successful upload records (uploads throw on failure),
     * so they count as stored; a bare disk path must actually exist on the active or public disk.
     */
    public static function hasStoredFile(?string $path, ?string $driveId = null): bool
    {
        if (! $path) {
            return false;
        }

        if ($driveId || GoogleDriveService::extractFileId($path) || filter_var($path, FILTER_VALIDATE_URL)) {
            return true;
        }

        foreach (array_unique([self::disk(), 'public']) as $disk) {
            try {
                if (Storage::disk($disk)->exists($path)) {
                    return true;
                }
            } catch (\Throwable) {}
        }

        return false;
    }

    /**
     * Stream or download a file from any configured disk or Google Drive.
     */
    public static function streamResponse(
        string $path,
        ?string $fileName = null,
        ?string $mimeType = null,
        bool $download = false
    ): Response {
        $fileName = $fileName ?: basename($path);
        $mimeType = $mimeType ?: 'application/octet-stream';

        // 1. Google Drive streaming check
        $driveId = GoogleDriveService::extractFileId($path);
        if ($driveId && GoogleDriveService::isConfigured()) {
            try {
                return GoogleDriveService::streamFile($driveId, $fileName, $mimeType, $download);
            } catch (\Throwable $e) {
                Log::warning("Drive streaming fallback for {$driveId}: " . $e->getMessage());
                if (filter_var($path, FILTER_VALIDATE_URL)) {
                    return redirect()->away($path);
                }
            }
        }

        // 2. If it's a direct web URL, redirect
        if (filter_var($path, FILTER_VALIDATE_URL)) {
            return redirect()->away($path);
        }

        // 3. Check storage disks (R2, S3, Public, Local)
        $disksToCheck = ['r2', 's3', 'public', 'local'];

        foreach ($disksToCheck as $disk) {
            try {
                if (Storage::disk($disk)->exists($path)) {
                    if (($disk === 'r2' || $disk === 's3') && ! $download) {
                        $publicUrl = config('filesystems.disks.r2.url') ?: config('filesystems.disks.s3.url');
                        if ($publicUrl) {
                            return redirect()->away(rtrim($publicUrl, '/') . '/' . ltrim($path, '/'));
                        }
                    }

                    if ($download) {
                        return Storage::disk($disk)->download($path, $fileName, [
                            'Content-Type' => $mimeType,
                        ]);
                    }

                    return Storage::disk($disk)->response($path, $fileName, [
                        'Content-Type' => $mimeType,
                        'Content-Disposition' => 'inline; filename="' . $fileName . '"',
                    ]);
                }
            } catch (\Throwable) {
                continue;
            }
        }

        // 4. Local filesystem fallback checks
        $baseName = basename($path);
        $fileBaseName = basename($fileName);
        $localPaths = [
            storage_path('app/public/' . $path),
            storage_path('app/private/' . $path),
            storage_path('app/' . $path),
            public_path('storage/' . $path),
            public_path($path),
            public_path('demo-assets/quotes/' . $baseName),
            public_path('demo-assets/quotes/' . $fileBaseName),
            public_path('storage/quotes/' . $baseName),
            public_path('storage/quotes/' . $fileBaseName),
            storage_path('app/public/quotes/' . $baseName),
            storage_path('app/public/quotes/' . $fileBaseName),
            base_path($path),
            base_path($baseName),
            base_path($fileBaseName),
        ];

        foreach ($localPaths as $localPath) {
            if (file_exists($localPath) && ! is_dir($localPath)) {
                $resolvedMime = $mimeType;
                if (! $resolvedMime || $resolvedMime === 'application/octet-stream') {
                    $ext = strtolower(pathinfo($localPath, PATHINFO_EXTENSION));
                    $resolvedMime = match ($ext) {
                        'png' => 'image/png',
                        'jpg', 'jpeg' => 'image/jpeg',
                        'webp' => 'image/webp',
                        'gif' => 'image/gif',
                        'pdf' => 'application/pdf',
                        'html', 'htm' => 'text/html',
                        default => 'application/pdf',
                    };
                }
                return response()->file($localPath, [
                    'Content-Type' => $resolvedMime,
                    'Content-Disposition' => ($download ? 'attachment' : 'inline') . '; filename="' . $fileName . '"',
                ]);
            }
        }

        abort(404, 'الملف المطلوب غير موجود على الخادم أو التخزين السحابي.');
    }

    /**
     * Delete a file from all storage disks.
     */
    public static function delete(?string $path, ?string $disk = null): bool
    {
        if (! $path) {
            return false;
        }

        $deleted = false;
        $disks = $disk ? [$disk] : ['r2', 's3', 'public', 'local'];

        foreach ($disks as $d) {
            try {
                if (Storage::disk($d)->exists($path)) {
                    Storage::disk($d)->delete($path);
                    $deleted = true;
                }
            } catch (\Throwable) {
                continue;
            }
        }

        return $deleted;
    }
}
