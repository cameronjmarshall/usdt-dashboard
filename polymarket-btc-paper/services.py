"""Shared research jobs and consistent SQLite backups."""
from contextlib import closing
from datetime import datetime, timezone
import gzip
import json
import logging
from pathlib import Path
import shutil
import sqlite3
import threading
import time

from research import parameters, run_replay

JOB_LOCK = threading.Lock()
BACKUP_LOCK = threading.Lock()


def initialize(path):
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        db.executescript('''CREATE TABLE IF NOT EXISTS research_runs(
            id INTEGER PRIMARY KEY, created REAL NOT NULL, status TEXT NOT NULL,
            parameters TEXT NOT NULL, result TEXT, error TEXT);
            CREATE TABLE IF NOT EXISTS resolution_checks(slug TEXT PRIMARY KEY, checked REAL NOT NULL);
        ''')
        db.execute("UPDATE research_runs SET status='failed',error='Server restarted; rerun this experiment.' WHERE status='running'")


def start_job(path, data):
    data = parameters(data)
    if not JOB_LOCK.acquire(blocking=False):
        raise ValueError('Another replay is running. Wait for it to finish.')
    try:
        with closing(sqlite3.connect(path, timeout=10)) as db, db:
            job_id = db.execute("INSERT INTO research_runs(created,status,parameters) VALUES(?,'running',?)",
                                (time.time(), json.dumps(data))).lastrowid
    except Exception:
        JOB_LOCK.release()
        raise
    def worker():
        try:
            result = run_replay(path, data)
            with closing(sqlite3.connect(path, timeout=10)) as db, db:
                db.execute("UPDATE research_runs SET status='complete',result=? WHERE id=?", (json.dumps(result, allow_nan=False),job_id))
        except Exception as exc:
            logging.exception('Replay failed')
            with closing(sqlite3.connect(path, timeout=10)) as db, db:
                db.execute("UPDATE research_runs SET status='failed',error=? WHERE id=?", (str(exc),job_id))
        finally:
            JOB_LOCK.release()
    threading.Thread(target=worker, daemon=True).start()
    return job_id


def runs(path):
    with closing(sqlite3.connect(path, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        result = [dict(row) for row in db.execute('SELECT * FROM research_runs ORDER BY id DESC LIMIT 10')]
    for row in result:
        row['parameters'] = json.loads(row['parameters'])
        row['result'] = json.loads(row['result']) if row['result'] else None
    return result


def backup(path):
    """Online backup API includes committed WAL data; never copy an active DB file."""
    with BACKUP_LOCK:
        directory = Path(path).parent / 'backups'
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        raw = directory / (stamp+'.sqlite')
        target = directory / (stamp+'.sqlite.gz')
        temporary = target.with_suffix('.tmp')
        try:
            with closing(sqlite3.connect(path, timeout=10)) as source, closing(sqlite3.connect(raw)) as dest:
                source.backup(dest, pages=256, sleep=.05)
                if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Backup integrity verification failed')
            with raw.open('rb') as src, gzip.open(temporary,'wb') as dst:
                shutil.copyfileobj(src,dst)
            temporary.replace(target)
            for old in sorted(directory.glob('*.sqlite.gz'))[:-7]:
                old.unlink()
            return target
        finally:
            raw.unlink(missing_ok=True)
            temporary.unlink(missing_ok=True)


def backup_worker(path, stop):
    while not stop.is_set():
        try:
            backup(path)
        except Exception:
            logging.exception('Scheduled backup failed')
        stop.wait(24*60*60)


def backup_status(path):
    files = sorted((Path(path).parent/'backups').glob('*.sqlite.gz'))
    return dict(available=bool(files), latest=files[-1].stat().st_mtime if files else None,
                count=len(files), note='Seven rotating backups on the same disk. Download an off-server copy for disaster recovery.')
