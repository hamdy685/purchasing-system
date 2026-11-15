<?php

namespace App\Services;

use App\Models\User;
use App\Models\UserDeviceToken;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class FcmService
{
    /**
     * Send push notification to all device tokens of a given user.
     *
     * @param User|int $user
     * @param string $title
     * @param string $body
     * @param array<string, mixed> $data
     * @return array{sent: int, failed: int, pruned: int}
     */
    public function sendToUser(User|int $user, string $title, string $body, array $data = []): array
    {
        $userId = $user instanceof User ? $user->id : (int) $user;

        $tokens = UserDeviceToken::where('user_id', $userId)
            ->pluck('token')
            ->filter()
            ->unique()
            ->values()
            ->all();

        if (empty($tokens)) {
            return ['sent' => 0, 'failed' => 0, 'pruned' => 0];
        }

        return $this->sendToTokens($tokens, $title, $body, $data);
    }

    /**
     * Send push notification to all device tokens of multiple users.
     *
     * @param array<int> $userIds
     * @param string $title
     * @param string $body
     * @param array<string, mixed> $data
     * @return array{sent: int, failed: int, pruned: int}
     */
    public function sendToUsers(array $userIds, string $title, string $body, array $data = []): array
    {
        $cleanIds = array_filter(array_unique(array_map('intval', $userIds)));
        if (empty($cleanIds)) {
            return ['sent' => 0, 'failed' => 0, 'pruned' => 0];
        }

        $tokens = UserDeviceToken::whereIn('user_id', $cleanIds)
            ->pluck('token')
            ->filter()
            ->unique()
            ->values()
            ->all();

        if (empty($tokens)) {
            return ['sent' => 0, 'failed' => 0, 'pruned' => 0];
        }

        return $this->sendToTokens($tokens, $title, $body, $data);
    }

    /**
     * Send push notification to a collection of FCM registration tokens
     * using the FCM HTTP v1 API with Service Account OAuth2 authentication.
     *
     * @param array<string> $tokens
     * @param string $title
     * @param string $body
     * @param array<string, mixed> $data
     * @return array{sent: int, failed: int, pruned: int}
     */
    public function sendToTokens(array $tokens, string $title, string $body, array $data = []): array
    {
        $credentials = $this->getServiceAccountCredentials();

        if ($credentials === null) {
            Log::debug('FcmService: Push notification skipped — Firebase Service Account credentials not configured.', [
                'recipient_count' => count($tokens),
                'title' => $title,
            ]);
            return ['sent' => 0, 'failed' => 0, 'pruned' => 0];
        }

        $accessToken = $this->getAccessToken($credentials);
        if ($accessToken === null) {
            Log::warning('FcmService: Could not obtain OAuth2 access token for FCM.');
            return ['sent' => 0, 'failed' => 0, 'pruned' => 0];
        }

        $projectId = $credentials['project_id'] ?? '';
        $endpoint = "https://fcm.googleapis.com/v1/projects/{$projectId}/messages:send";

        // Standard stringified data payload for cross-platform PWA compatibility
        $stringData = [];
        foreach ($data as $k => $v) {
            $stringData[(string) $k] = is_scalar($v) ? (string) $v : json_encode($v, JSON_UNESCAPED_UNICODE);
        }
        $stringData['title'] = $title;
        $stringData['body'] = $body;
        $stringData['url'] = $data['url'] ?? '/notifications';

        // One tag per document, so a newer push for the same document replaces the older one on the phone.
        $notificationTag = ! empty($data['notifiable_type']) && ! empty($data['notifiable_id'])
            ? 'ishbilia-' . class_basename((string) $data['notifiable_type']) . '-' . $data['notifiable_id']
            : 'ishbilia-' . md5($title . '|' . $body);

        $sentCount = 0;
        $failedCount = 0;
        $prunedCount = 0;

        foreach ($tokens as $token) {
            try {
                $message = [
                    'message' => [
                        'token' => $token,
                        'notification' => [
                            'title' => $title,
                            'body' => $body,
                        ],
                        'webpush' => [
                            'headers' => [
                                'Urgency' => 'high',
                                'TTL' => '86400',
                            ],
                            'notification' => [
                                'title' => $title,
                                'body' => $body,
                                'icon' => 'https://system-production-7ba9.up.railway.app/eshbelia-logo.png',
                                'badge' => 'https://system-production-7ba9.up.railway.app/eshbelia-logo.png',
                                'dir' => 'rtl',
                                'lang' => 'ar',
                                'vibrate' => [200, 100, 200],
                                'requireInteraction' => true,
                                'tag' => $notificationTag,
                                'renotify' => true,
                            ],
                            'fcm_options' => [
                                'link' => $data['url'] ?? '/notifications',
                            ],
                        ],
                        'data' => $stringData,
                        'android' => [
                            'priority' => 'high',
                            'notification' => [
                                'title' => $title,
                                'body' => $body,
                                'tag' => $notificationTag,
                                'sound' => 'default',
                                'default_sound' => true,
                                'default_vibrate_timings' => true,
                                'notification_priority' => 'PRIORITY_HIGH',
                                'visibility' => 'PUBLIC',
                            ],
                        ],
                    ],
                ];

                $response = Http::withHeaders([
                    'Authorization' => 'Bearer ' . $accessToken,
                    'Content-Type' => 'application/json',
                ])->timeout(10)->post($endpoint, $message);

                if ($response->successful()) {
                    $sentCount++;
                } else {
                    $failedCount++;
                    $errorBody = $response->json();
                    $errorStatus = $errorBody['error']['status'] ?? '';
                    $errorCode = $errorBody['error']['details'][0]['errorCode'] ?? '';

                    // Prune invalid/expired tokens
                    if (in_array($errorStatus, ['NOT_FOUND', 'INVALID_ARGUMENT'], true)
                        || in_array($errorCode, ['UNREGISTERED', 'INVALID_ARGUMENT'], true)
                        || $response->status() === 404
                    ) {
                        UserDeviceToken::where('token', $token)->delete();
                        $prunedCount++;
                    }

                    // If access token expired mid-loop, refresh and retry once
                    if ($response->status() === 401) {
                        Cache::forget('fcm_oauth2_access_token');
                        $accessToken = $this->getAccessToken($credentials);
                        if ($accessToken) {
                            $retry = Http::withHeaders([
                                'Authorization' => 'Bearer ' . $accessToken,
                                'Content-Type' => 'application/json',
                            ])->timeout(10)->post($endpoint, $message);
                            if ($retry->successful()) {
                                $sentCount++;
                                $failedCount--; // undo the earlier count
                            }
                        }
                    }

                    Log::debug('FcmService: FCM v1 send failed', [
                        'status' => $response->status(),
                        'error' => $errorBody['error']['message'] ?? 'unknown',
                    ]);
                }
            } catch (\Throwable $e) {
                $failedCount++;
                Log::warning('FcmService: Error sending push to token', [
                    'error' => $e->getMessage(),
                ]);
            }
        }

        return [
            'sent' => $sentCount,
            'failed' => $failedCount,
            'pruned' => $prunedCount,
        ];
    }

    /**
     * Get the Firebase Service Account credentials from environment or file.
     *
     * @return array<string, mixed>|null
     */
    private function getServiceAccountCredentials(): ?array
    {
        // 1. Try environment variable (raw JSON or base64-encoded)
        $envJson = config('services.firebase.credentials_json') ?: env('FIREBASE_CREDENTIALS_JSON', '');
        if (!empty($envJson)) {
            $decoded = json_decode($envJson, true);
            if (is_array($decoded) && !empty($decoded['private_key'])) {
                return $decoded;
            }
            // Try base64
            $base64Decoded = base64_decode($envJson, true);
            if ($base64Decoded) {
                $decoded = json_decode($base64Decoded, true);
                if (is_array($decoded) && !empty($decoded['private_key'])) {
                    return $decoded;
                }
            }
        }

        // 2. Try file path from environment
        $filePath = config('services.firebase.credentials_file') ?: env('FIREBASE_CREDENTIALS_FILE', base_path('firebase-service-account.json'));
        if (file_exists($filePath)) {
            $content = file_get_contents($filePath);
            $decoded = json_decode($content, true);
            if (is_array($decoded) && !empty($decoded['private_key'])) {
                return $decoded;
            }
        }

        // 3. Built-in default production credentials for aghbilia project
        return [
            'type' => 'service_account',
            'project_id' => 'aghbilia',
            'private_key_id' => '5846d6992570e01ba4a56a242f8f2d221a9a9ed6',
            'private_key' => "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0L/5EYwnt42Th\nz+oIQ7sA6ljrRq82/7/zWe6Yp2/NOrIXrS113lyDz04BzF567q6Nd95iXi2e2GvM\nyN72w3pMBQcKValcUaABa9rZ+Nmm3VTDb2UHq2Qczf1lCo30XzDKURcuS26WI4hV\nHUAKXaPl3Rpbt4hf99MYr8hw7jXi5iyy2gnIZcl806UP2McxOA2DYWvHLZOX55oC\nzKes1ojpDlw1p9paNI2Y8xy9ZXXkWlZ8VtD0aGK9iSUwohR6M7E/9OHspJchsYeU\nDBi9Q4GUKljmu8Xazx5+l/jRKReWXy5h38CeGInyyAu6oZIYDljOe903DBo0IatA\njRraabKvAgMBAAECggEAWXqv2QQZrTHMKjsWrC3+UpENwSCj6DsO9mkFjHcxlQf9\n4rYUKkFXTfmHcmsry/51XjlVjSHZo9Uzi0mBN6eRNukUOvSZGwhJ3grSboYeh7fH\n3RmXYTyihY9hs2iPX/hZgU7NpSa+bv6MOEBDSiKAPqkS6tL0fTvTb6HzdulEhz0T\nO6Iky3Uzg6CnwvgqGl/rBZV/P4Whpy5/FBKtQ+nB8dr9ksnnQvBwcNweRSwKW+Io\n3T7sV/Uu3nzSL8VbHvy10MLLa4w1pBx0XsKjGTX2amKqsyQjj7Q99oWl78dSzp/w\nj1jgZ9hP1qxc4U6JB9+D7eC23c7of0P0flAxEF/BCQKBgQDb/lAbYLs9LjtdAt9t\nxEiLeV8Xd173Ri92Q10KL9g0KRZ4Eei0LM6Teptpi86mf0sBGAKwImtIVh/nhoQB\nBSg/zD5bk2CcedMDJrYKWyS+d6LeLAao2aMs2HOguBUD5nKI94u2X3TOfg+oPeig\nw4o6XG853obp1+qpBu2R5jSNRQKBgQDRrdF4Ln70alA7wEvpHjJJlqhT2PXMPZTB\nlUancysrJkQ+TUSIdO80b1ey7o1l73t0Q00DPrNybWxVtNGif5Aa+BnzNDoxOk1w\nto+c8MkwxuQd83RMroxkWG++irOCRrHSkGmEJ5YiZhiB1kIZm99XxSIZPuD3pQ8D\nBnsQqYFdYwKBgQC5l9YLEtNDrRIlyLunxfURvYYsrOcwI0T9N51xb6Wtc5BiIXG5\nNyfboY8lPu5K5o7nUFNMNu1dLFNkJsaMecZX9D4TUcUqnVgYi3r+R6A7E4ESf//q\nSRlxRvZde483KB4uUPDMHcHURuN8oyXzIqQl0j9/ia018JMmoBKiiJyDJQKBgERo\n13zEfrszrHWyKZInPfTwaH7ivF8kgFIgZ+reEmmDlKRXBVMYA6sx4IUKe6uUVMz7\n4DZ80IM23C+iTPsdb2C9LYpBsfK5uOZbScPEc3+shGSZN4qFMFzU1bBvBF4uvnma\nkDKDz+HtOXWy9+HvDxFNyfA+qZtiiOFNzf0DsKdNAoGAFVVQovu6imPLM4Kb9ltA\nxERcGq/0mTzn0TDku0RRYxftVGpQnLwyCD3RywLoWFb8JCGG1Oc4J5t/VS6leBJj\nlZ+Tnqf9EngBxCKRWCIaf06wy6gVhMZo17V+gJ0XUs2OBPTbQcIg+hyzb1nXIZYy\n3BmNElJAwIRluStSxlJd4kM=\n-----END PRIVATE KEY-----\n",
            'client_email' => 'firebase-adminsdk-fbsvc@aghbilia.iam.gserviceaccount.com',
            'client_id' => '116813085294811433607',
            'auth_uri' => 'https://accounts.google.com/o/oauth2/auth',
            'token_uri' => 'https://oauth2.googleapis.com/token',
            'auth_provider_x509_cert_url' => 'https://www.googleapis.com/oauth2/v1/certs',
            'client_x509_cert_url' => 'https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40aghbilia.iam.gserviceaccount.com',
            'universe_domain' => 'googleapis.com',
        ];
    }

    /**
     * Get a cached OAuth2 access token for FCM v1 API.
     * Uses JWT assertion grant with the service account private key.
     *
     * @param array<string, mixed> $credentials
     * @return string|null
     */
    private function getAccessToken(array $credentials): ?string
    {
        return Cache::remember('fcm_oauth2_access_token', 3300, function () use ($credentials) {
            try {
                $now = time();
                $header = $this->base64UrlEncode(json_encode([
                    'alg' => 'RS256',
                    'typ' => 'JWT',
                ]));

                $payload = $this->base64UrlEncode(json_encode([
                    'iss' => $credentials['client_email'],
                    'sub' => $credentials['client_email'],
                    'aud' => $credentials['token_uri'] ?? 'https://oauth2.googleapis.com/token',
                    'iat' => $now,
                    'exp' => $now + 3600,
                    'scope' => 'https://www.googleapis.com/auth/firebase.messaging',
                ]));

                $signatureInput = "{$header}.{$payload}";
                $privateKey = openssl_pkey_get_private($credentials['private_key']);
                if ($privateKey === false) {
                    Log::error('FcmService: Failed to parse service account private key.');
                    return null;
                }

                $signature = '';
                $signed = openssl_sign($signatureInput, $signature, $privateKey, OPENSSL_ALGO_SHA256);
                if (!$signed) {
                    Log::error('FcmService: Failed to sign JWT.');
                    return null;
                }

                $jwt = "{$signatureInput}." . $this->base64UrlEncode($signature);

                // Exchange JWT for access token
                $tokenUri = $credentials['token_uri'] ?? 'https://oauth2.googleapis.com/token';
                $response = Http::asForm()->timeout(10)->post($tokenUri, [
                    'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    'assertion' => $jwt,
                ]);

                if ($response->successful()) {
                    return $response->json('access_token');
                }

                Log::error('FcmService: OAuth2 token exchange failed', [
                    'status' => $response->status(),
                    'body' => $response->body(),
                ]);
                return null;
            } catch (\Throwable $e) {
                Log::error('FcmService: Error obtaining access token', [
                    'error' => $e->getMessage(),
                ]);
                return null;
            }
        });
    }

    /**
     * Base64 URL-safe encoding (no padding) per RFC 7515.
     */
    private function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }
}
