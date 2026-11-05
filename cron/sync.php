<?php
require dirname(__DIR__).'/config.php';
require __DIR__.'/sync-lib.php';
try { $n=run_sync(); echo "Sync complete. Markets processed: {$n}\n"; }
catch(Throwable $e) { fwrite(STDERR, "Sync failed: ".$e->getMessage()."\n"); exit(1); }
