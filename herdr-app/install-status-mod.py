#!/usr/bin/env python3
"""Install the status footer beside an existing, unmodified Flockbook mod."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

BASE_SHA256 = {
    "chat.js": "472de392ea62d2a0509b7b233a48b4a4d3757688949cb3830c19095ec417feac",
    "composer.js": "71f79aec7eb671f7937b70a047b835f6dafae08c2e6d051880604ccba1e0d929",
    "estimate.js": "cfd222dbf59947fcfc24da56c33ed5fc45b8d72c21258552454f14695136dc26",
}
MODULES = (*BASE_SHA256, "chatstatus.js", "activity.js", "queueparse.js", "queueview.js")


def atomic_json(path, value, expected):
    """Replace only a file whose contents are still the version we inspected."""
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".status-install-", delete=False) as tmp:
        json.dump(value, tmp, indent=2)
        tmp.write("\n")
        temporary = Path(tmp.name)
    if path.read_text() != expected:
        temporary.unlink()
        raise RuntimeError(f"{path} changed during install; leaving it unchanged")
    temporary.replace(path)


def replace_mod(value, name):
    if isinstance(value, dict):
        return {key: name if key == "mod" and item == "flockbook" else replace_mod(item, name) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_mod(item, name) for item in value]
    return value


def retarget_keys(keys, name):
    """Only this layout's mod commands change; all existing user shortcuts survive."""
    return {key: name + value[len("flockbook"):] if isinstance(value, str) and value.startswith("flockbook.") else value
            for key, value in keys.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home() / ".config/herdr-app")
    parser.add_argument("--name", default="flockbook-status")
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]+", args.name) or args.name == "flockbook":
        parser.error("choose a new layout/mod name (lowercase letters, numbers, hyphens)")
    home = args.home.expanduser().resolve()
    source = Path(__file__).resolve().parent / "mods/flockbook"
    original = home / "mods/flockbook"
    destination = home / "mods" / args.name
    layout_path = home / "layouts" / (args.name + ".json")
    keys_path = home / "keys.json"
    for required in (*(source / name for name in MODULES), *(original / name for name in BASE_SHA256),
                     original / "state.js", home / "layouts/flockbook.json", keys_path, home / "settings.json"):
        if not required.is_file():
            parser.error(f"required file is missing: {required}; no files changed")
    keys = json.loads(keys_path.read_text())
    section = "layout:" + args.name
    if destination.exists() or layout_path.exists() or (home / "layouts/.state" / (args.name + ".json")).exists() or section in keys:
        parser.error("destination already exists; use a new --name instead of overwriting it")
    for name, expected in BASE_SHA256.items():
        if hashlib.sha256((original / name).read_bytes()).hexdigest() != expected:
            parser.error(f"installed {name} differs from the supported base; review/merge it first")
    cli = shutil.which("herdr-app") or str(Path.home() / ".local/bin/herdr-app")
    env = dict(os.environ, HERDR_APP_HOME=str(home))
    before = json.loads(subprocess.check_output([cli, "status"], text=True, env=env))
    previous_layout = before.get("layout")
    if not previous_layout:
        raise RuntimeError("Herdr did not report its current layout; no files changed")
    backup = home / "flockbook-status-backups" / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(keys_path, backup / "keys.json")
    shutil.copy2(home / "layouts/flockbook.json", backup / "flockbook.json")
    (backup / "before.json").write_text(json.dumps(before, indent=2) + "\n")
    shutil.copy2(home / "settings.json", backup / "settings.json")
    subprocess.run([cli, "do", "mod.clone", json.dumps({"name": "flockbook", "as": args.name})], check=True, env=env)
    # Only the changed modules replace files in the clone. Markdown rendering,
    # approval handling, helper binary/config and every user setting stay in place.
    for filename in MODULES:
        shutil.copy2(source / filename, destination / filename)
    state = destination / "state.js"
    state.write_text(state.read_text().replace("/layouts/.state/flockbook.json", "/layouts/.state/" + args.name + ".json"))
    subprocess.run([cli, "check", str(destination)], check=True, env=env)

    # Native cloning copies the saved click state (theme/sidebar/sizing).
    # A plain JSON copy silently loses those preferences.
    # Herdr owns layouts/.state: never rewrite those files ourselves.
    cloned = False
    finished = False
    try:
        subprocess.run([cli, "do", "layout.clone", json.dumps({"name": "flockbook", "as": args.name})], check=True, env=env)
        cloned = True  # layout.clone also switches to the new layout.
        original_layout = layout_path.read_text()
        atomic_json(layout_path, replace_mod(json.loads(original_layout), args.name), original_layout)
        original_keys = keys_path.read_text()
        keys = json.loads(original_keys)
        # Some Herdr versions copy the key section; 0.1.16 leaves it absent.
        # Retarget the generated copy when present, else copy the user's current
        # original section. Other sections are never replaced from a backup.
        keys[section] = retarget_keys(keys.get(section, keys.get("layout:flockbook", {})), args.name)
        atomic_json(keys_path, keys, original_keys)
        finished = True
    finally:
        if cloned and (not args.activate or not finished):
            subprocess.run([cli, "do", "layout.switch", json.dumps({"name": previous_layout})], check=True, env=env)
    print(json.dumps({"layout": args.name, "mod": str(destination), "backup": str(backup),
                      "rollback": [cli, "do", "layout.switch", '{"name":"flockbook"}']}, indent=2))


if __name__ == "__main__":
    main()
