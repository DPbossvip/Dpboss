<?php
require __DIR__.'/config.php';
$error=''; $markets=[];
try { ensure_schema(); $q=db()->query("SELECT m.name,m.open_time,m.close_time,r.open_panna,r.jodi,r.close_panna,r.result_date FROM markets m LEFT JOIN market_results r ON r.market_id=m.id AND r.result_date=(SELECT MAX(x.result_date) FROM market_results x WHERE x.market_id=m.id) WHERE m.is_active=TRUE ORDER BY m.sort_order,m.name"); $markets=$q->fetchAll(); }
catch(Throwable $e) { $error='The database is not connected yet. Complete the Render setup in README.md.'; }
$last=null;
if(!$error){try{$last=db()->query("SELECT status,message,created_at,fetched_count FROM sync_logs ORDER BY id DESC LIMIT 1")->fetch();}catch(Throwable $e){}}
?><!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#10131b"><title>Daily Market Results | Result Hub</title><link rel="stylesheet" href="style.css"></head><body>
<header class="mast"><div class="wrap mastin"><a class="brand" href="/"><span class="mark">R</span><span><b>RESULT HUB</b><small>DAILY MARKET RESULTS</small></span></a><nav><a href="/">HOME</a><a href="#markets">ALL MARKETS</a><a href="/history.php">RESULT HISTORY</a></nav><span class="date"><?=h(date('D, d M Y'))?></span></div></header>
<main class="wrap">
<section class="hero"><div><p class="eyebrow">RESULTS & ARCHIVE</p><h1>Market Results</h1><p class="sub">Published market results and previous records in one place.</p></div><div class="today"><span>INDIA / IST</span><b><?=h(date('d M'))?></b><small><?=h(date('l'))?></small></div></section>
<div class="strip"><span><i></i> RESULT FEED</span><span>OPEN <b>—</b> JODI <b>—</b> CLOSE</span><span>TIME ZONE <b>IST</b></span></div>
<section class="heading" id="markets"><div><p class="eyebrow">MARKET BOARD</p><h2>Today's Results</h2></div><a class="outline" href="/history.php">VIEW HISTORY ↗</a></section>
<?php if($error): ?><div class="notice"><?=h($error)?></div><?php elseif(!$markets): ?><div class="notice">No market data has been synchronized yet. Once the API is configured, market names and results will be imported automatically.</div><?php else: ?>
<div class="grid"><?php foreach($markets as $m): ?><article class="tile"><div class="tilehead"><h3><?=h($m['name'])?></h3><span class="dot">●</span></div><div class="numbers"><span><?=h($m['open_panna']!==''?$m['open_panna']:'***')?></span><em>—</em><strong><?=h($m['jodi']!==''?$m['jodi']:'**')?></strong><em>—</em><span><?=h($m['close_panna']!==''?$m['close_panna']:'***')?></span></div><div class="times"><span>OPEN <b><?=h($m['open_time'] ?: '—')?></b></span><span>CLOSE <b><?=h($m['close_time'] ?: '—')?></b></span></div><a class="tilelink" href="/history.php?market=<?=urlencode($m['name'])?>">VIEW RESULT HISTORY <span>→</span></a></article><?php endforeach; ?></div><?php endif; ?>
<?php if($last): ?><p class="sync">Last sync: <?=h($last['created_at'])?> · <?=h($last['status'])?> · <?=h($last['fetched_count'])?> records processed</p><?php endif; ?>
<section class="footnote"><b>Information portal</b><p>This site displays published result data and historical records only. It does not offer betting, wagering, deposits, withdrawals, wallets, or predictions.</p></section>
</main><footer><div class="wrap">RESULT HUB <span>·</span> Data shown as received from the configured provider.</div></footer></body></html>
