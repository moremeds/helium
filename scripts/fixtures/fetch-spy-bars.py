"""Freeze two ET sessions of real SPY 1m RTH bars plus the surrounding 1d rows.

Run ON the mini (the lake is not on the laptop). The 1m file is EXTENDED HOURS
and keyed in Asia/Hong_Kong, so one ET session spans two HKT dates: everything
here converts to America/New_York first and keeps 09:30-16:00 only. Selecting
by HKT date is the bug this script exists to make impossible.
"""
import duckdb, json

LAKE = "/Users/moremeds/market-warehouse/data-lake/bronze/asset_class=equity/symbol=SPY"
SESSIONS = ("2026-09-02", "2026-09-03")
DAILY_FROM, DAILY_TO = "2026-08-26", "2026-09-03"

d = duckdb.connect()
minute = d.execute(f"""
    SELECT strftime(bar_timestamp AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS t,
           open, high, low, close, volume
      FROM read_parquet('{LAKE}/1m.parquet')
     WHERE (bar_timestamp AT TIME ZONE 'America/New_York')::date
           IN (DATE '{SESSIONS[0]}', DATE '{SESSIONS[1]}')
       AND (bar_timestamp AT TIME ZONE 'America/New_York')::time >= TIME '09:30'
       AND (bar_timestamp AT TIME ZONE 'America/New_York')::time <  TIME '16:00'
     ORDER BY bar_timestamp
""").fetchall()
daily = d.execute(f"""
    SELECT strftime(trade_date, '%Y-%m-%d') AS t, open, high, low, close, volume
      FROM read_parquet('{LAKE}/1d.parquet')
     WHERE trade_date BETWEEN DATE '{DAILY_FROM}' AND DATE '{DAILY_TO}'
     ORDER BY trade_date
""").fetchall()

def row(r):
    return {"time": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]}

print(json.dumps({
    "asOf": "2026-09-06",
    "source": ("livewire lake on macmini: "
               "~/market-warehouse/data-lake/bronze/asset_class=equity/symbol=SPY/{1m,1d}.parquet. "
               "1m bar_timestamp is TIMESTAMPTZ in Asia/Hong_Kong, extended hours, ~850 bars per HKT "
               "date; filtered to 09:30-16:00 America/New_York and normalised to UTC here. "
               "1d keys on trade_date (a DATE, no clock)."),
    "symbol": "SPY",
    "sessionsEt": list(SESSIONS),
    "bars1m": [row(r) for r in minute],
    "bars1d": [row(r) for r in daily],
}, indent=1))
