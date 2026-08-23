"""Python-SDK equivalent of the dsh sensor plugin: poll, detect change, dispatch, capture."""

import hashlib
import json
import os
import time
import urllib.request

from deepseek_harness import DeepSeekHarness

URL = os.environ["SENSOR_URL"]
FIELDS = [
    "ok",
    "db",
    "version",
    "worker_lag_seconds",
    "latency_p95_ms",
    "watchlist_size",
]
OUT = os.environ["SENSOR_OUT"]
INTERVAL = float(os.environ.get("SENSOR_INTERVAL_MS", "10000")) / 1000
MAX_RUNS = int(os.environ.get("SENSOR_MAX_RUNS", "2"))


def watched() -> str:
    with urllib.request.urlopen(URL, timeout=10) as response:
        body = json.load(response)
    return json.dumps({f: body.get(f) for f in FIELDS})


def main() -> None:
    previous: str | None = None
    previous_hash: str | None = None
    runs = 0
    with DeepSeekHarness(
        provider="deepseek-official", model="deepseek-v4-flash"
    ) as harness:
        session = harness.start_session()
        while runs < MAX_RUNS:
            current = watched()
            digest = hashlib.sha256(current.encode()).hexdigest()[:12]
            if digest != previous_hash:
                trigger = "first-observation" if previous_hash is None else "change"
                started = time.time()
                result = session.run(
                    f"Previous health JSON: {previous or '(none - this is the first observation)'}\n"
                    f"Current health JSON: {current}\n"
                    "Summarize what changed and whether it looks operationally concerning, in 5 lines. "
                    "Answer from the JSON alone; do not use any tools."
                )
                with open(OUT, "a") as handle:
                    handle.write(
                        json.dumps(
                            {
                                "timestamp": time.strftime(
                                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                                ),
                                "trigger": trigger,
                                "hash": digest,
                                "latencyMs": int((time.time() - started) * 1000),
                                "sessionId": result.session_id,
                                "finishReason": result.finish_reason,
                                "finalText": result.final_response,
                            }
                        )
                        + "\n"
                    )
                previous, previous_hash = current, digest
                runs += 1
            time.sleep(INTERVAL)


main()
