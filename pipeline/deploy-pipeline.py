#!/usr/bin/env python3
"""
Safe deploy for the morning-briefing-pipeline worker.

Uses the Cloudflare Workers API directly (wrangler deploy has a config
resolution issue with this project layout). CRITICAL: always reads the
current worker settings FIRST and preserves all existing bindings,
secrets, and cron triggers. Never deploy with a partial config.

Usage: ./deploy-pipeline.py
"""
import json
import subprocess
import sys
import urllib.request

ACCOUNT_ID = "52095379a0c3ce8a6e113a6f4e8a84db"
SCRIPT_NAME = "morning-briefing-pipeline"
COMPATIBILITY_DATE = "2026-10-11"

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}"
ALLOWED_HOSTS = ("api.cloudflare.com",)
CRED_NAME = "custom.cloudflare"


def api(method, path, data=None, content_type="application/json"):
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": content_type},
    )
    add_surrogate_to_request(req, CRED_NAME, allowed_hosts=ALLOWED_HOSTS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return read_json_response(r)


def main():
    # 1. Read current settings — NEVER deploy blind
    print("Reading current worker settings...")
    settings = api("GET", "/settings")
    if not settings.get("success"):
        print("FATAL: could not read current settings, aborting")
        sys.exit(1)

    bindings = settings["result"].get("bindings", [])
    # Filter to non-secret bindings (secrets are preserved server-side on script upload)
    keep_bindings = []
    for b in bindings:
        if b["type"] == "secret_text":
            continue  # secrets persist automatically
        keep_bindings.append(b)

    print(f"  Preserving {len(keep_bindings)} bindings: {[b['type'] + ':' + b.get('name', '?') for b in keep_bindings]}")

    # 2. Read current cron triggers
    sched_resp = api("GET", "/schedules")
    schedules = sched_resp.get("result", {}).get("schedules", [])
    crons = [s["cron"] for s in schedules if s.get("cron")]
    print(f"  Preserving {len(crons)} cron triggers: {crons}")

    # 3. Build the bundle
    print("Building worker bundle...")
    r = subprocess.run(
        ["npx", "--yes", "esbuild", "worker.js", "--bundle", "--format=esm",
         "--outfile=/tmp/worker-bundle.mjs", "--log-level=error"],
        cwd="/home/hatch/workspace/morning-briefing/pipeline",
        capture_output=True, timeout=120,
    )
    if r.returncode != 0:
        print(f"FATAL: esbuild failed: {r.stderr.decode()[:500]}")
        sys.exit(1)

    with open("/tmp/worker-bundle.mjs", "rb") as f:
        bundle = f.read()
    print(f"  Bundle: {len(bundle) // 1024}KB")

    # 4. Upload with ALL existing bindings preserved
    print("Uploading...")
    import uuid
    boundary = f"----{uuid.uuid4().hex}"
    metadata = json.dumps({
        "main_module": "worker.mjs",
        "compatibility_date": COMPATIBILITY_DATE,
        "bindings": keep_bindings,
    })
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="metadata"\r\n'
        f"Content-Type: application/json\r\n\r\n"
        f"{metadata}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\n'
        f"Content-Type: application/javascript+module\r\n\r\n"
    ).encode() + bundle + f"\r\n--{boundary}--\r\n".encode()

    result = api("PUT", "", data=body, content_type=f"multipart/form-data; boundary={boundary}")
    if not result.get("success"):
        print(f"FATAL: upload failed: {json.dumps(result.get('errors', []))[:500]}")
        sys.exit(1)
    print("  Upload successful")

    # 5. Restore cron triggers (script upload can clear them)
    if crons:
        print("Restoring cron triggers...")
        cron_body = json.dumps([{"cron": c} for c in crons]).encode()
        result = api("PUT", "/schedules", data=cron_body)
        if not result.get("success"):
            print(f"WARNING: cron restore failed: {json.dumps(result.get('errors', []))[:300]}")
        else:
            print("  Cron triggers restored")

    # 6. Verify
    print("Verifying...")
    settings = api("GET", "/settings")
    final_bindings = settings["result"].get("bindings", [])
    types = {}
    for b in final_bindings:
        types[b["type"]] = types.get(b["type"], 0) + 1
    print(f"  Final bindings: {types}")
    sched_resp = api("GET", "/schedules")
    final_crons = [s.get("cron") for s in sched_resp.get("result", {}).get("schedules", [])]
    print(f"  Final crons: {final_crons}")

    # Sanity checks
    missing = [b["type"] for b in keep_bindings if b["type"] not in types]
    if missing:
        print(f"FATAL: bindings lost in deploy: {missing}")
        sys.exit(1)
    if set(crons) != set(final_crons):
        print(f"FATAL: cron triggers changed: {crons} -> {final_crons}")
        sys.exit(1)

    print("\nDeploy complete and verified.")


if __name__ == "__main__":
    main()
