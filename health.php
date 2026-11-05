<?php
require __DIR__.'/config.php';
header('Content-Type: application/json; charset=utf-8');
try { ensure_schema(); db()->query('SELECT 1'); http_response_code(200); echo json_encode(['ok'=>true,'database'=>'connected']); }
catch(Throwable $e) { http_response_code(503); echo json_encode(['ok'=>false,'database'=>'unavailable']); }
