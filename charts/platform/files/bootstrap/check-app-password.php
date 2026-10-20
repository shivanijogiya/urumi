<?php
// Exit 0 if the Application Password in the mounted API Secret still authenticates against the
// WooCommerce REST API (GET /wp-json/wc/v3/orders -> 200), else 1.
// Prints only the HTTP status, never the credentials.
//   php check-app-password.php <secret dir>
$dir = $argv[1] ?? '/existing';
$user = @file_get_contents("$dir/WOO_USER");
$pass = @file_get_contents("$dir/WOO_APP_PASSWORD");
if (!$user || !$pass) {
    echo "no existing API Secret\n";
    exit(1);
}

$headers = ['Authorization: Basic ' . base64_encode(trim($user) . ':' . trim($pass))];
// Without `local`, WordPress only accepts Application Passwords over HTTPS; the official image's
// wp-config.php turns this header into $_SERVER['HTTPS'] = 'on'.
if (getenv('WP_ENVIRONMENT_TYPE') !== 'local') {
    $headers[] = 'X-Forwarded-Proto: https';
}
$url = rtrim((string) getenv('WOO_URL'), '/') . '/wp-json/wc/v3/orders?per_page=1';
$ctx = stream_context_create(['http' => [
    'method' => 'GET',
    'header' => implode("\r\n", $headers),
    'timeout' => 15,
    'ignore_errors' => true,
    'follow_location' => 0,
]]);
@file_get_contents($url, false, $ctx);
$status = 0;
if (isset($http_response_header[0]) && preg_match('#^HTTP/\S+\s+(\d{3})#', $http_response_header[0], $m)) {
    $status = (int) $m[1];
}
echo "existing Application Password: HTTP $status\n";
exit($status === 200 ? 0 : 1);
