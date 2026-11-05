<?php
function run_sync(): int {
    ensure_schema();
    $c=app_config();
    if($c['api_key']===''||$c['domain_key']===''||$c['domain']==='') throw new RuntimeException('API credentials/domain not configured.');
    if(!function_exists('curl_init')) throw new RuntimeException('PHP cURL extension is unavailable.');
    $payload=json_encode(['api_key'=>$c['api_key'],'domain_key'=>$c['domain_key'],'domain'=>$c['domain']],JSON_UNESCAPED_SLASHES);
    $ch=curl_init($c['api_url']);
    curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$payload,CURLOPT_HTTPHEADER=>['Content-Type: application/json','Accept: application/json'],CURLOPT_CONNECTTIMEOUT=>12,CURLOPT_TIMEOUT=>30]);
    $body=curl_exec($ch);$err=curl_error($ch);$code=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);
    if($body===false||$code<200||$code>=300) throw new RuntimeException('Provider request failed: '.($err?:'HTTP '.$code));
    $json=json_decode($body,true);$rows=$json['results']['data']??null;
    if(!is_array($rows)||empty($json['results']['status'])) throw new RuntimeException('Provider returned an unexpected response or status=false.');
    $pdo=db();$pdo->beginTransaction();$saved=0;
    try{
      $market=$pdo->prepare("INSERT INTO markets(name,open_time,close_time,sort_order,updated_at) VALUES(?,?,?,?,NOW()) ON CONFLICT(name) DO UPDATE SET open_time=EXCLUDED.open_time,close_time=EXCLUDED.close_time,updated_at=NOW() RETURNING id");
      $result=$pdo->prepare("INSERT INTO market_results(market_id,result_date,open_panna,jodi,close_panna,raw_result,api_timestamp) VALUES(?,?,?,?,?,?,?) ON CONFLICT(market_id,result_date) DO UPDATE SET open_panna=EXCLUDED.open_panna,jodi=EXCLUDED.jodi,close_panna=EXCLUDED.close_panna,raw_result=EXCLUDED.raw_result,api_timestamp=EXCLUDED.api_timestamp");
      foreach($rows as $r){
        $name=trim((string)($r['name']??''));if($name==='')continue;
        $market->execute([$name,(string)($r['open_time']??''),(string)($r['close_time']??''),$saved]);
        $mid=$market->fetchColumn();$market->closeCursor();
        $rawDate=(string)($r['date']??'');$day=preg_match('/^\d{4}-\d{2}-\d{2}/',$rawDate)?substr($rawDate,0,10):date('Y-m-d');
        // All number-like fields stay strings to preserve leading zeroes.
        $result->execute([(int)$mid,$day,(string)($r['open']??''),(string)($r['jodi']??''),(string)($r['close']??''),(string)($r['result']??''),$rawDate]);
        $saved++;
      }
      $pdo->prepare("INSERT INTO sync_logs(status,message,fetched_count) VALUES('success',?,?)")->execute(['API sync completed',$saved]);
      $pdo->commit();return $saved;
    }catch(Throwable $e){$pdo->rollBack();throw $e;}
}
