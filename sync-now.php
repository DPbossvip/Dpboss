<?php
require __DIR__.'/config.php';
$token=app_config()['sync_token'];
$given=$_SERVER['HTTP_X_SYNC_TOKEN']??($_GET['token']??'');
if($token==='' || !hash_equals($token,$given)){http_response_code(403);exit('Forbidden');}
require __DIR__.'/cron/sync-lib.php';
try{$n=run_sync();header('Content-Type: application/json');echo json_encode(['ok'=>true,'processed'=>$n]);}
catch(Throwable $e){http_response_code(502);echo json_encode(['ok'=>false,'error'=>'Sync failed. Check server logs and provider configuration.']);}
