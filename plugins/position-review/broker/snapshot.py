"""Read-only broker snapshot: IB (TWS API via ib_async) + Futu (OpenD via futu-api).

Prints one JSON object on stdout. READ-ONLY BY CONSTRUCTION: this file calls
positions / portfolio / account summary / open orders / query methods only. It
never imports or calls placeOrder, cancelOrder, modify_order, place_order or
unlock_trade — and Futu cannot place a real-account order without unlock_trade.

Env: PR_IB_HOST, PR_IB_PORT, PR_IB_CLIENT_ID, PR_FUTU_HOST, PR_FUTU_PORT.
Either broker failing is recorded under `errors`, never raised: "pull failed"
and "flat" must stay distinguishable.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def num(x):
    """IB uses NaN for 'no value'; JSON gets null."""
    return None if x is None or x != x else x


def quote(t) -> dict:
    g = t.modelGreeks
    return {
        "conId": t.contract.conId, "symbol": t.contract.symbol, "secType": t.contract.secType,
        "right": t.contract.right, "strike": t.contract.strike,
        "expiry": t.contract.lastTradeDateOrContractMonth,
        "time": str(t.time) if t.time else None, "marketDataType": t.marketDataType,
        "bid": num(t.bid), "ask": num(t.ask), "last": num(t.last), "close": num(t.close),
        "iv": num(g.impliedVol) if g else None, "delta": num(g.delta) if g else None,
        "undPrice": num(g.undPrice) if g else None,
    }


def ib_snapshot(extra: set) -> dict:
    from ib_async import IB, ContFuture, Contract, Index, Stock

    ib = IB()
    ib.connect(
        os.environ.get("PR_IB_HOST", "127.0.0.1"),
        int(os.environ.get("PR_IB_PORT", "4001")),
        clientId=int(os.environ.get("PR_IB_CLIENT_ID", "87")),
        readonly=True,
        timeout=20,
    )
    try:
        accounts = ib.managedAccounts()
        out = {"fetched_at": now(), "accounts": accounts}
        ib.RequestTimeout = 30  # a hung request must fail, not stall the run
        out["errors"] = {}
        positions = [p for p in ib.reqPositions() if p.position != 0]
        out["positions"] = [
            {"account": p.account, "conId": p.contract.conId, "symbol": p.contract.symbol,
             "secType": p.contract.secType, "right": p.contract.right, "strike": p.contract.strike,
             "expiry": p.contract.lastTradeDateOrContractMonth, "multiplier": p.contract.multiplier,
             "currency": p.contract.currency, "exchange": p.contract.primaryExchange or p.contract.exchange,
             "position": p.position, "avgCost": p.avgCost}
            for p in positions
        ]
        # Frozen data (type 2): outside RTH a quote is the last one IB holds, and the
        # report says so. Model greeks carry IB's implied vol per leg.
        ib.reqMarketDataType(2)
        quoted = [Contract(conId=p.contract.conId) for p in positions if p.contract.secType in {"OPT", "STK"}]
        quoted += [Index("SPX", "CBOE"), Index("VIX", "CBOE")]
        try:
            ib.qualifyContracts(*quoted)
            out["quotes"] = [quote(t) for t in ib.reqTickers(*quoted)]
        except Exception as exc:
            out["errors"]["quotes"] = f"{type(exc).__name__}: {exc}"
        # Underlyings: IB stocks, Futu codes, plus SPX/ES/VIX for the index book.
        stocks = {(p.contract.symbol, p.contract.currency) for p in positions if p.contract.secType == "STK"}
        stocks |= {(sym, "USD") for sym in extra}
        stocks |= {(p.contract.symbol, "USD") for p in positions
                   if p.contract.secType == "OPT" and p.contract.symbol != "SPX"}
        specs = [("SPX", Index("SPX", "CBOE"), "1 Y", "1 day", True),
                 ("ES_30m", ContFuture("ES", "CME"), "20 D", "30 mins", False)]
        specs += [(sym, Stock(sym, "SMART", cur), "1 Y", "1 day", True) for sym, cur in sorted(stocks)]
        out["history"] = {}
        und = []
        for key, contract, duration, size, rth in specs:
            try:
                ib.qualifyContracts(contract)
                if not contract.conId:
                    raise ValueError("contract did not qualify")
                bars = ib.reqHistoricalData(contract, "", duration, size, "TRADES", rth, formatDate=2)
                out["history"][key] = [
                    {"time": str(x.date), "open": x.open, "high": x.high, "low": x.low,
                     "close": x.close, "volume": x.volume} for x in bars
                ]
                if contract.secType == "STK":
                    und.append(contract)
            except Exception as exc:
                out["errors"][f"history:{key}"] = f"{type(exc).__name__}: {exc}"
        try:
            out["underlying_quotes"] = [quote(t) for t in ib.reqTickers(*und)] if und else []
        except Exception as exc:
            out["errors"]["underlying_quotes"] = f"{type(exc).__name__}: {exc}"
        out["account_summary"] = {
            f"{v.account}:{v.tag}": v.value
            for v in ib.accountSummary()
            if v.tag
            in {
                "NetLiquidation",
                "ExcessLiquidity",
                "FullMaintMarginReq",
                "FullInitMarginReq",
                "BuyingPower",
                "TotalCashValue",
            }
        }
        # ALL open orders, including ones placed from TWS / mobile — not just this client's.
        trades = ib.reqAllOpenOrders()
        out["open_orders"] = [
            {
                "orderId": t.order.orderId,
                "permId": t.order.permId,
                "parentId": t.order.parentId,
                "ocaGroup": t.order.ocaGroup,
                "action": t.order.action,
                "orderType": t.order.orderType,
                "totalQuantity": t.order.totalQuantity,
                "lmtPrice": t.order.lmtPrice,
                "auxPrice": t.order.auxPrice,
                "trailStopPrice": t.order.trailStopPrice,
                "trailingPercent": t.order.trailingPercent,
                "tif": t.order.tif,
                "status": t.orderStatus.status,
                "symbol": t.contract.symbol,
                "secType": t.contract.secType,
                "conId": t.contract.conId,
                "comboLegs": [
                    {"conId": c.conId, "ratio": c.ratio, "action": c.action}
                    for c in (t.contract.comboLegs or [])
                ],
                "right": getattr(t.contract, "right", ""),
                "strike": getattr(t.contract, "strike", 0.0),
                "expiry": getattr(t.contract, "lastTradeDateOrContractMonth", ""),
            }
            for t in trades
        ]
        return out
    finally:
        ib.disconnect()


def futu_snapshot() -> dict:
    from futu import RET_OK, OpenSecTradeContext, SecurityFirm, TrdEnv, TrdMarket

    ctx = OpenSecTradeContext(
        filter_trdmarket=TrdMarket.NONE,
        host=os.environ.get("PR_FUTU_HOST", "127.0.0.1"),
        port=int(os.environ.get("PR_FUTU_PORT", "11111")),
        security_firm=SecurityFirm.FUTUSECURITIES,
    )
    try:
        out = {"fetched_at": now(), "accounts": []}
        ret, accs = ctx.get_acc_list()
        if ret != RET_OK:
            raise RuntimeError(f"get_acc_list: {accs}")
        for acc in accs.to_dict("records"):
            if acc.get("trd_env") != TrdEnv.REAL:
                continue
            aid = acc["acc_id"]
            row = {
                "acc_id": aid,
                "acc_type": acc.get("acc_type"),
                "markets": acc.get("trdmarket_auth"),
            }
            for name, call in (
                (
                    "positions",
                    lambda: ctx.position_list_query(trd_env=TrdEnv.REAL, acc_id=aid),
                ),
                (
                    "open_orders",
                    lambda: ctx.order_list_query(trd_env=TrdEnv.REAL, acc_id=aid),
                ),
                ("account", lambda: ctx.accinfo_query(trd_env=TrdEnv.REAL, acc_id=aid)),
            ):
                ret, data = call()
                row[name] = (
                    data.to_dict("records") if ret == RET_OK else {"error": str(data)}
                )
            out["accounts"].append(row)
        return out
    finally:
        ctx.close()


if __name__ == "__main__":
    which = sys.argv[1:] or ["ib", "futu"]
    # futu-api logs to stdout; keep stdout for the one JSON line.
    out_stream, sys.stdout = sys.stdout, sys.stderr
    result: dict = {"errors": {}}
    extra: set = set()
    if "futu" in which:
        try:
            result["futu"] = futu_snapshot()
            for acc in result["futu"]["accounts"]:
                for pos in acc["positions"] if isinstance(acc["positions"], list) else []:
                    m = re.match(r"^US\.([A-Z.]+?)(\d{6}[CP]\d+)?$", pos["code"])
                    if m:
                        extra.add(m.group(1))
        except Exception as exc:  # recorded, never raised: failed != flat
            result["errors"]["futu"] = f"{type(exc).__name__}: {exc}"
    if "ib" in which:
        try:
            result["ib"] = ib_snapshot(extra)
        except Exception as exc:
            result["errors"]["ib"] = f"{type(exc).__name__}: {exc}"
    out_stream.write(json.dumps(result, default=str) + "\n")
