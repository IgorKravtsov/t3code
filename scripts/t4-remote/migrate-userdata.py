#!/usr/bin/env python3
"""Copy ~/.t3/userdata into a fresh ~/.t4/userdata for an independent T4 server.

Mirrors scripts/lib/t4-state.ts (copyStateDirectory + prepareIndependentCopy):
the live T3 databases are only opened read-only through SQLite's backup API.
Refuses to run when ~/.t4/userdata already exists. Standalone (Python 3 standard library),
so it runs on a host without this repository or Node. See docs/operations/t4-machines.md.
"""
import json, os, re, shutil, sqlite3, sys, uuid

home = os.path.expanduser("~")
source = os.path.join(home, ".t3", "userdata")
target_home = os.path.join(home, ".t4")
target = os.path.join(target_home, "userdata")
if os.path.exists(target):
    sys.exit(f"{target} already exists; not migrating again.")
staging = target + ".migrating-" + uuid.uuid4().hex[:8]


def snapshot_locked(frm, to):
    """Clone the database and its journals, let SQLite recover the private copy, then back it up."""
    import tempfile
    directory = tempfile.mkdtemp(dir=os.path.dirname(to))
    try:
        copy = os.path.join(directory, "source.sqlite")
        for suffix in ["", "-wal", "-journal"]:
            if os.path.exists(frm + suffix):
                shutil.copyfile(frm + suffix, copy + suffix)
        db = sqlite3.connect(copy)
        try:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                print("skipped corrupt locked database:", frm, flush=True)
                return
            out = sqlite3.connect(to)
            try:
                db.backup(out)
            finally:
                out.close()
        finally:
            db.close()
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def copy_tree(src, dst):
    os.makedirs(dst, mode=0o700, exist_ok=True)
    for entry in os.scandir(src):
        if re.search(r"(-wal|-shm|-journal)$", entry.name) or re.match(r"^(Singleton|LOCK$)", entry.name):
            continue
        frm, to = entry.path, os.path.join(dst, entry.name)
        if entry.is_symlink():
            continue
        if entry.is_dir():
            copy_tree(frm, to)
        elif entry.is_file():
            with open(frm, "rb") as handle:
                header = handle.read(16)
            if header == b"SQLite format 3\x00":
                print("sqlite:", frm, flush=True)
                live = sqlite3.connect(f"file:{frm}?mode=ro", uri=True, timeout=2)
                try:
                    live.execute("SELECT count(*) FROM sqlite_master").fetchone()
                    locked = False
                except sqlite3.OperationalError:
                    # Chromium holds some databases exclusively; Python's backup would retry forever.
                    locked = True
                if not locked:
                    copy = sqlite3.connect(to)
                    try:
                        live.backup(copy)
                    finally:
                        copy.close()
                        live.close()
                else:
                    live.close()
                    snapshot_locked(frm, to)
            else:
                shutil.copy2(frm, to)


try:
    copy_tree(source, staging)
    settings_path = os.path.join(staging, "settings.json")
    settings = json.load(open(settings_path)) if os.path.exists(settings_path) else {}
    # Both servers would otherwise resume the same threads.
    settings["continueThreadsAfterServerUpdate"] = False
    settings["autoResumeLimitedThreads"] = False
    for override in (settings.get("projectSettingsOverrides") or {}).values():
        if isinstance(override, dict):
            override["continueThreadsAfterServerUpdate"] = False
    with open(settings_path, "w") as handle:
        json.dump(settings, handle, indent=2)
        handle.write("\n")
    os.chmod(settings_path, 0o600)
    with open(os.path.join(staging, "environment-id"), "w") as handle:
        handle.write(str(uuid.uuid4()) + "\n")
    for name in ["server-runtime.json"]:
        path = os.path.join(staging, name)
        if os.path.exists(path):
            os.remove(path)
    for secret in [
        "cloud-relay-environment-credential",
        "cloud-link-ed25519-key-pair",
        "server-signing-key",
        "asset-access-signing-key",
    ]:
        path = os.path.join(staging, "secrets", secret + ".bin")
        if os.path.exists(path):
            os.remove(path)
    counts = {}
    for name in ["state.sqlite", "statev2.sqlite"]:
        path = os.path.join(staging, name)
        if not os.path.exists(path):
            continue
        db = sqlite3.connect(path)
        try:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "scheduled_tasks" in tables:
                db.execute("UPDATE scheduled_tasks SET enabled = 0")
            for table in ["orchestration_v2_effect_outbox", "orchestration_effect_outbox"]:
                if table in tables:
                    db.execute(f"UPDATE {table} SET status = 'cancelled' WHERE status IN ('pending', 'running')")
            db.commit()
            if "projection_threads" in tables:
                counts[name] = db.execute("SELECT count(*) FROM projection_threads").fetchone()[0]
        finally:
            db.close()
    os.makedirs(target_home, mode=0o700, exist_ok=True)
    os.rename(staging, target)
    print(json.dumps({"migrated": target, "threads": counts}))
except BaseException:
    shutil.rmtree(staging, ignore_errors=True)
    raise
