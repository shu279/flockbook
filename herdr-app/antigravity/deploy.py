#!/usr/bin/env python3
"""Back up and install the bridge through an already-connected Herdr machine."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess

# stdin carries file contents, never shell commands or credentials. The remote
# settings are read only: keep every permission, model and authentication choice.
INSTALL = r'''
import datetime, hashlib, json, os, pathlib, shutil, sys, tempfile
payload = json.load(sys.stdin)
base = pathlib.Path.home() / ".gemini/antigravity-cli"
settings = json.loads((base / "settings.json").read_text())
command = settings.get("statusLine", {}).get("command")
if command not in ("~/.gemini/antigravity-cli/statusline.sh", str(base / "statusline.sh")):
    raise SystemExit("Existing statusLine.command differs; review it before installing.")
target = base / "statusline.sh"
digest = hashlib.sha256(target.read_bytes()).hexdigest()
if digest != payload["expected_sha256"]:
    raise SystemExit("Existing statusline.sh changed; compare it before installing.")
backup = base / "flockbook-status-backups" / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
backup.mkdir(mode=0o700, parents=True)
for name in ("statusline.sh", "statusline_bridge.py", "statusline_usage.py", "settings.json"):
    old = base / name
    if old.exists():
        shutil.copy2(old, backup / name)
for name in ("statusline_usage.py", "statusline_bridge.py", "statusline.sh"):
    fd, temporary = tempfile.mkstemp(prefix=".flockbook-install-", dir=base)
    try:
        os.fchmod(fd, 0o700)
        with os.fdopen(fd, "w") as out:
            out.write(payload["files"][name])
        os.replace(temporary, base / name)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
print(json.dumps({"directory":str(base), "backup":str(backup), "settings_changed":False,
                  "previous_sha256":digest, "installed_sha256":hashlib.sha256(target.read_bytes()).hexdigest()}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--machine", required=True, help="existing name from hc machine ls")
    parser.add_argument("--expected-sha256", required=True, help="hash of the remote script you reviewed")
    args = parser.parse_args()
    cli = shutil.which("hc") or shutil.which("herdr-core") or str(Path.home() / ".local/bin/herdr-core")
    here = Path(__file__).resolve().parent
    payload = {"expected_sha256": args.expected_sha256,
               "files": {name: (here / name).read_text() for name in ("statusline.sh", "statusline_bridge.py", "statusline_usage.py")}}
    subprocess.run([cli, "exec", "--on", args.machine, "-i", "python3", "-c", INSTALL],
                   input=json.dumps(payload), text=True, check=True)


if __name__ == "__main__":
    main()
