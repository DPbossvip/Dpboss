<?php
declare(strict_types=1);
date_default_timezone_set(getenv('APP_TIMEZONE') ?: 'Asia/Kolkata');

function envv(string $key, string $default = ''): string {
    $v = getenv($key);
    return $v === false ? $default : trim($v);
}
function app_config(): array {
    return [
        'database_url' => envv('DATABASE_URL'),
        'api_url' => envv('SATTA_API_URL', 'https://sattaapi.com/wp-json/satta/v1/results'),
        'api_key' => envv('SATTA_API_KEY'),
        'domain_key' => envv('SATTA_DOMAIN_KEY'),
        'domain' => envv('SATTA_DOMAIN'),
        'sync_token' => envv('SYNC_TOKEN'),
        'timezone' => envv('APP_TIMEZONE', 'Asia/Kolkata'),
        'app_env' => envv('APP_ENV', 'production'),
    ];
}
function db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $url = app_config()['database_url'];
    if ($url === '') throw new RuntimeException('DATABASE_URL is not configured.');
    $p = parse_url($url);
    if (!$p || empty($p['host']) || empty($p['path'])) throw new RuntimeException('DATABASE_URL format is invalid.');
    $dsn = 'pgsql:host='.$p['host'].';port='.($p['port'] ?? 5432).';dbname='.ltrim($p['path'],'/').';sslmode=require';
    $pdo = new PDO($dsn, rawurldecode($p['user'] ?? ''), rawurldecode($p['pass'] ?? ''), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    return $pdo;
}
function h($v): string { return htmlspecialchars((string)$v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function ensure_schema(): void {
    $sql = [
      "CREATE TABLE IF NOT EXISTS markets (id BIGSERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, open_time VARCHAR(40) NOT NULL DEFAULT '', close_time VARCHAR(60) NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
      "CREATE TABLE IF NOT EXISTS market_results (id BIGSERIAL PRIMARY KEY, market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE, result_date DATE NOT NULL, open_panna VARCHAR(3) NOT NULL DEFAULT '', jodi VARCHAR(4) NOT NULL DEFAULT '', close_panna VARCHAR(3) NOT NULL DEFAULT '', raw_result VARCHAR(32) NOT NULL DEFAULT '', api_timestamp VARCHAR(40) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(market_id,result_date))",
      "CREATE INDEX IF NOT EXISTS idx_results_date ON market_results(result_date DESC)",
      "CREATE TABLE IF NOT EXISTS sync_logs (id BIGSERIAL PRIMARY KEY, status VARCHAR(20) NOT NULL, message VARCHAR(500) NOT NULL, fetched_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    ];
    foreach ($sql as $q) db()->exec($q);
}
function api_configured(): bool {
    $c=app_config();
    return $c['api_key']!=='' && $c['domain_key']!=='' && $c['domain']!=='';
}
