# ton-price-watch

GitHub Actions **autonomous seller** for jetton positions in TON wallet `UQDsZEJaCZSx1I2TPf69OSaIZDaeDgJMpyMcUJZaRv4BJLZ2`.
It calls no webhook and wakes no assistant.

## Rules (per position, prices in TON = real STON.fi sell quote for the whole position)
- Hard stop: −12% from entry.
- Once the peak reaches +15% over entry, the stop moves to breakeven. After that it trails 15% below the highest price seen, and it never drops below breakeven. There is no fixed take-profit.
- A stop must be breached on 2 consecutive checks (about 1 minute apart) before selling, which filters single bad quotes.
- On a trigger the whole position is sold to TON via a STON.fi router swap (7% slippage cap).
- From 26 Nov 2026 00:00 Kyiv (after 25 Nov), everything is sold to TON. Then a FINAL line is written to `trades.log` and the workflow disables itself.
- It never buys, never approves tokens, and sends nothing except the STON.fi jetton→TON swap. The swap must target the wallet's own jetton wallet, with at most 0.5 TON gas attached.

## Files
- `state.json`: entries, peaks, stops, status, committed by the workflow.
- `trades.log`: JSONL of every sell sent, confirmed or failed.

## Secret
- `TON_MNEMONIC`: the trading wallet mnemonic. It is never printed, and the script refuses to run if the secret doesn't derive the expected wallet.

## Local dry run
`TRADE_DRY=1 WATCH_ONCE=1 node trader.mjs`
