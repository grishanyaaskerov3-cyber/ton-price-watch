# ton-price-watch

GitHub Actions watcher for jetton prices in a TON wallet. It **never trades** and never reads a wallet mnemonic. It only posts an alert webhook when a watched coin moves enough versus a rolling reference price.

## Rules

- Poll [tonapi](https://tonapi.io) about once a minute (each workflow run loops for ~4.5 minutes; the workflow itself is scheduled every 5 minutes).
- Holdings are read from the wallet automatically. Zero/dust balances and stablecoins (USDT and similar) are ignored. STORM, CHERRY, and SP are always tracked as a fallback.
- A newly seen coin gets `ref = current price` and does **not** alert on first sight.
- `drop` alert: price ≤ ref × 0.95 (cumulative −5% from the reference).
- `pump` alert: price ≥ ref × 1.20 (cumulative +20% from the reference).
- After a successful alert (HTTP 2xx), that coin’s reference is reset to the price at alert time.
- Caps: at most 1 alert per coin per 20 minutes, and 12 alerts per Kyiv calendar day.
- `state.json` in this repo holds references, peaks, entries, and daily counters. The workflow commits it when it changes.

## Secrets

Set these repository secrets (Actions → Secrets). The values are never written to logs.

- `TON_ALERT_WEBHOOK_URL`
- `TON_ALERT_WEBHOOK_KEY` (sent as `Authorization: Bearer …`)

## Manual run

Actions → watch → Run workflow. A local dry run (no webhook):

```bash
WATCH_DRY=1 WATCH_ONCE=1 node watch.mjs
```
