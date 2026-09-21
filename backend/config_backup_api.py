from __future__ import annotations

import difflib
import hashlib
import ipaddress
import json
import os
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from netmiko import ConnectHandler
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
DB_PATH = DATA_DIR / "config_backup.db"
KEY_PATH = DATA_DIR / "secret.key"
DB_LOCK = threading.RLock()
STOP_EVENT = threading.Event()
SCHEDULER_THREAD: threading.Thread | None = None

PLATFORM_LABELS = {
    "cisco_ios": "Cisco IOS / IOS XE",
    "cisco_nxos": "Cisco NX-OS",
    "arista_eos": "Arista EOS",
}

CONFIG_COMMANDS = {
    "cisco_ios": {
        "running-config": "show running-config",
        "startup-config": "show startup-config",
    },
    "cisco_nxos": {
        "running-config": "show running-config",
        "startup-config": "show startup-config",
    },
    "arista_eos": {
        "running-config": "show running-config",
        "startup-config": "show startup-config",
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def cipher() -> Fernet:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not KEY_PATH.exists():
        KEY_PATH.write_bytes(Fernet.generate_key())
    return Fernet(KEY_PATH.read_bytes())


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    return cipher().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str | None) -> str:
    if not value:
        return ""
    try:
        return cipher().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise RuntimeError("Credential decryption failed. The local encryption key may have changed.") from exc


def init_db() -> None:
    with DB_LOCK, db() as conn:
        conn.executescript(
            """
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS devices(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hostname TEXT NOT NULL UNIQUE,
                ip TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL,
                site TEXT NOT NULL,
                platform TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                interval_minutes INTEGER NOT NULL DEFAULT 0,
                retention INTEGER NOT NULL DEFAULT 15,
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT NOT NULL DEFAULT '',
                password_enc TEXT NOT NULL DEFAULT '',
                secret_enc TEXT NOT NULL DEFAULT '',
                last_backup_at TEXT,
                last_status TEXT NOT NULL DEFAULT 'never',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS backups(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER NOT NULL,
                version INTEGER NOT NULL,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                changed INTEGER NOT NULL DEFAULT 0,
                hash TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                config TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS audit(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                detail TEXT NOT NULL,
                device_id INTEGER,
                FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_backups_device_time ON backups(device_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(at);
            """
        )
        seed_demo_lab(conn)
        conn.commit()


def seed_demo_lab(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT 1 FROM devices LIMIT 1").fetchone():
        return

    now = utc_now()
    rows = [
        ("CORE-RTR-01","192.168.10.1","Core Router","HQ","cisco_ios",["core","wan"],360,20),
        ("CORE-SW-01","192.168.10.2","Core Switch","HQ","cisco_ios",["core","campus"],360,20),
        ("DIST-SW-F2","192.168.20.2","Distribution Switch","HQ","cisco_ios",["distribution","floor2"],720,15),
    ]
    for hostname, ip, role, site, platform_name, tags, interval, retention in rows:
        conn.execute(
            """
            INSERT INTO devices(
                hostname,ip,role,site,platform,tags_json,interval_minutes,retention,
                port,username,password_enc,secret_enc,last_status,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,22,'','','','never',?,?)
            """,
            (hostname,ip,role,site,platform_name,json.dumps(tags),interval,retention,now,now),
        )
    conn.execute(
        "INSERT INTO audit(at,actor,action,detail,device_id) VALUES(?,?,?,?,NULL)",
        (now,"System","Inventory initialized","Sample device inventory created. Add credentials before live backups."),
    )


def log_audit(conn: sqlite3.Connection, action: str, detail: str, device_id: int | None = None, actor: str = "Jim Camus") -> None:
    conn.execute(
        "INSERT INTO audit(at,actor,action,detail,device_id) VALUES(?,?,?,?,?)",
        (utc_now(),actor,action,detail,device_id),
    )


def row_to_device(row: sqlite3.Row) -> dict[str, Any]:
    try:
        tags = json.loads(row["tags_json"] or "[]")
    except json.JSONDecodeError:
        tags = []
    return {
        "id": row["id"],
        "hostname": row["hostname"],
        "ip": row["ip"],
        "role": row["role"],
        "site": row["site"],
        "platform": row["platform"],
        "platform_label": PLATFORM_LABELS.get(row["platform"], row["platform"]),
        "tags": tags,
        "interval_minutes": row["interval_minutes"],
        "retention": row["retention"],
        "port": row["port"],
        "username": row["username"],
        "credentials_configured": bool(row["username"] and row["password_enc"]),
        "last_backup_at": row["last_backup_at"],
        "last_status": row["last_status"],
    }


def row_to_backup(row: sqlite3.Row, device_name: str) -> dict[str, Any]:
    return {
        "id": row["id"],
        "device_id": row["device_id"],
        "device": device_name,
        "version": row["version"],
        "source": row["source"],
        "status": row["status"],
        "changed": bool(row["changed"]),
        "hash": row["hash"] or "—",
        "size": row["size"],
        "created_at": row["created_at"],
        "config": row["config"],
        "error": row["error"],
    }


def bootstrap() -> dict[str, Any]:
    with DB_LOCK, db() as conn:
        device_rows = conn.execute("SELECT * FROM devices ORDER BY site,hostname").fetchall()
        devices = [row_to_device(row) for row in device_rows]
        names = {row["id"]: row["hostname"] for row in device_rows}
        backups = [
            row_to_backup(row, names.get(row["device_id"], f"Device {row['device_id']}"))
            for row in conn.execute("SELECT * FROM backups ORDER BY created_at DESC,id DESC LIMIT 1000").fetchall()
        ]
        audit = [dict(row) for row in conn.execute("SELECT * FROM audit ORDER BY at DESC,id DESC LIMIT 500").fetchall()]
    return {"generated_at": utc_now(), "devices": devices, "backups": backups, "audit": audit}


def validate_ip(value: str) -> str:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError as exc:
        raise ValueError("Management IP must be a valid IPv4 or IPv6 address.") from exc


def next_version(conn: sqlite3.Connection, device_id: int) -> int:
    row = conn.execute("SELECT MAX(version) AS v FROM backups WHERE device_id=? AND status='success'", (device_id,)).fetchone()
    return int(row["v"] or 0) + 1


def latest_successful_hash(conn: sqlite3.Connection, device_id: int) -> str:
    row = conn.execute(
        "SELECT hash FROM backups WHERE device_id=? AND status='success' ORDER BY created_at DESC,id DESC LIMIT 1",
        (device_id,),
    ).fetchone()
    return row["hash"] if row else ""


def enforce_retention(conn: sqlite3.Connection, device_id: int, retention: int) -> None:
    keep = max(1, min(int(retention), 100))
    stale = conn.execute(
        """
        SELECT id FROM backups
        WHERE device_id=? AND status='success'
        ORDER BY created_at DESC,id DESC
        LIMIT -1 OFFSET ?
        """,
        (device_id, keep),
    ).fetchall()
    if stale:
        conn.executemany("DELETE FROM backups WHERE id=?", [(row["id"],) for row in stale])


def collect_config(device: sqlite3.Row, source: str) -> str:
    platform_name = device["platform"]
    commands = CONFIG_COMMANDS.get(platform_name)
    if not commands:
        raise RuntimeError(f"Unsupported platform: {platform_name}")
    command = commands.get(source)
    if not command:
        raise RuntimeError(f"Unsupported configuration source: {source}")

    username = device["username"]
    password = decrypt_secret(device["password_enc"])
    secret = decrypt_secret(device["secret_enc"])
    if not username or not password:
        raise RuntimeError("SSH credentials are not configured for this device.")

    params = {
        "device_type": platform_name,
        "host": device["ip"],
        "username": username,
        "password": password,
        "port": int(device["port"] or 22),
        "conn_timeout": 8,
        "auth_timeout": 10,
        "banner_timeout": 8,
        "fast_cli": False,
    }
    if secret:
        params["secret"] = secret

    connection = ConnectHandler(**params)
    try:
        if secret:
            connection.enable()
        output = connection.send_command(command, read_timeout=25)
        if not output.strip():
            raise RuntimeError("Device returned an empty configuration.")
        return output.replace("\r\n", "\n").strip() + "\n"
    finally:
        connection.disconnect()


def run_backup(device_id: int, source: str = "running-config", actor: str = "Backup Engine") -> dict[str, Any]:
    if source not in {"running-config", "startup-config"}:
        raise ValueError("Backup source must be running-config or startup-config.")

    with DB_LOCK, db() as conn:
        device = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        if not device:
            raise KeyError(device_id)
        version = next_version(conn, device_id)

    started = utc_now()
    try:
        config = collect_config(device, source)
        digest = hashlib.sha256(config.encode("utf-8")).hexdigest()
        with DB_LOCK, db() as conn:
            previous_hash = latest_successful_hash(conn, device_id)
            changed = bool(previous_hash and previous_hash != digest)
            cur = conn.execute(
                """
                INSERT INTO backups(
                    device_id,version,source,status,changed,hash,size,config,error,created_at
                ) VALUES(?,?,?,'success',?,?,?,?, '',?)
                """,
                (device_id,version,source,int(changed),digest,len(config.encode("utf-8")),config,started),
            )
            conn.execute(
                "UPDATE devices SET last_backup_at=?,last_status='success',updated_at=? WHERE id=?",
                (started,started,device_id),
            )
            enforce_retention(conn, device_id, int(device["retention"]))
            detail = f"{device['hostname']} version {version} stored" + ("; configuration change detected." if changed else "; no change detected.")
            log_audit(conn,"Backup completed",detail,device_id,actor)
            conn.commit()
            backup_id = int(cur.lastrowid)
            row = conn.execute("SELECT * FROM backups WHERE id=?", (backup_id,)).fetchone()
            return row_to_backup(row, device["hostname"])
    except Exception as exc:
        error = str(exc)[:1000]
        with DB_LOCK, db() as conn:
            conn.execute(
                """
                INSERT INTO backups(
                    device_id,version,source,status,changed,hash,size,config,error,created_at
                ) VALUES(?,?,?,'failed',0,'',0,'',?,?)
                """,
                (device_id,version,source,error,started),
            )
            conn.execute(
                "UPDATE devices SET last_backup_at=?,last_status='failed',updated_at=? WHERE id=?",
                (started,started,device_id),
            )
            log_audit(conn,"Backup failed",f"{device['hostname']}: {error}",device_id,actor)
            conn.commit()
        raise RuntimeError(error) from exc


def scheduler_cycle() -> None:
    now = time.time()
    due: list[int] = []
    with DB_LOCK, db() as conn:
        rows = conn.execute("SELECT * FROM devices WHERE interval_minutes>0").fetchall()
        for row in rows:
            if not row["username"] or not row["password_enc"]:
                continue
            last = row["last_backup_at"]
            if not last:
                due.append(row["id"])
                continue
            try:
                elapsed = now - datetime.fromisoformat(last).timestamp()
            except ValueError:
                elapsed = float("inf")
            if elapsed >= int(row["interval_minutes"]) * 60:
                due.append(row["id"])

    for device_id in due:
        if STOP_EVENT.is_set():
            return
        try:
            run_backup(device_id, actor="Scheduler")
        except Exception:
            pass


def scheduler_loop() -> None:
    while not STOP_EVENT.is_set():
        try:
            scheduler_cycle()
        except Exception as exc:
            print(f"[ConfigVault] Scheduler error: {exc}")
        STOP_EVENT.wait(60)


class DeviceCreate(BaseModel):
    hostname: str = Field(min_length=1,max_length=120)
    ip: str = Field(min_length=1,max_length=64)
    role: str = Field(min_length=1,max_length=100)
    site: str = Field(min_length=1,max_length=100)
    platform: str = "cisco_ios"
    tags: list[str] = Field(default_factory=list)
    interval_minutes: int = Field(default=720,ge=0,le=43200)
    retention: int = Field(default=15,ge=1,le=100)
    port: int = Field(default=22,ge=1,le=65535)
    username: str = Field(default="",max_length=120)
    password: str = Field(default="",max_length=500)
    secret: str = Field(default="",max_length=500)


class DeviceUpdate(DeviceCreate):
    pass


class BackupRequest(BaseModel):
    source: str = "running-config"


@asynccontextmanager
async def lifespan(_: FastAPI):
    global SCHEDULER_THREAD
    init_db()
    STOP_EVENT.clear()
    SCHEDULER_THREAD = threading.Thread(target=scheduler_loop,daemon=True,name="config-backup-scheduler")
    SCHEDULER_THREAD.start()
    yield
    STOP_EVENT.set()
    if SCHEDULER_THREAD and SCHEDULER_THREAD.is_alive():
        SCHEDULER_THREAD.join(timeout=2)


app = FastAPI(
    title="Network Config Backup Manager API",
    version="1.0.0",
    description="Local network configuration backup, scheduling, versioning, and diff engine.",
    lifespan=lifespan,
)

allowed_origins = [
    "http://127.0.0.1:8800",
    "http://localhost:8800",
    "https://sachibara.github.io",
]
for origin in os.environ.get("CONFIG_BACKUP_ALLOWED_ORIGINS","").split(","):
    origin = origin.strip()
    if origin:
        allowed_origins.append(origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET","POST","PUT"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health")
def api_health():
    return {"ok":True,"service":"Network Config Backup Manager","database":str(DB_PATH)}


@app.get("/api/bootstrap")
def api_bootstrap():
    return bootstrap()


@app.post("/api/devices")
def api_create_device(request: DeviceCreate):
    if request.platform not in PLATFORM_LABELS:
        raise HTTPException(status_code=400,detail="Unsupported platform.")
    try:
        ip = validate_ip(request.ip)
    except ValueError as exc:
        raise HTTPException(status_code=400,detail=str(exc)) from exc

    now = utc_now()
    with DB_LOCK, db() as conn:
        if conn.execute("SELECT 1 FROM devices WHERE hostname=? OR ip=?", (request.hostname.strip(),ip)).fetchone():
            raise HTTPException(status_code=409,detail="Hostname or management IP already exists.")
        cur = conn.execute(
            """
            INSERT INTO devices(
                hostname,ip,role,site,platform,tags_json,interval_minutes,retention,
                port,username,password_enc,secret_enc,last_status,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'never',?,?)
            """,
            (
                request.hostname.strip(),ip,request.role.strip(),request.site.strip(),request.platform,
                json.dumps(request.tags),request.interval_minutes,request.retention,request.port,
                request.username.strip(),encrypt_secret(request.password),encrypt_secret(request.secret),now,now,
            ),
        )
        device_id = int(cur.lastrowid)
        log_audit(conn,"Device enrolled",f"{request.hostname.strip()} added to authorized device inventory.",device_id)
        conn.commit()
        row = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        return row_to_device(row)


@app.put("/api/devices/{device_id}")
def api_update_device(device_id: int, request: DeviceUpdate):
    if request.platform not in PLATFORM_LABELS:
        raise HTTPException(status_code=400,detail="Unsupported platform.")
    try:
        ip = validate_ip(request.ip)
    except ValueError as exc:
        raise HTTPException(status_code=400,detail=str(exc)) from exc

    with DB_LOCK, db() as conn:
        current = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404,detail="Device not found.")
        duplicate = conn.execute(
            "SELECT 1 FROM devices WHERE (hostname=? OR ip=?) AND id<>?",
            (request.hostname.strip(),ip,device_id),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=409,detail="Hostname or management IP already exists.")

        password_enc = encrypt_secret(request.password) if request.password else current["password_enc"]
        secret_enc = encrypt_secret(request.secret) if request.secret else current["secret_enc"]
        username = request.username.strip() or current["username"]

        conn.execute(
            """
            UPDATE devices SET
                hostname=?,ip=?,role=?,site=?,platform=?,tags_json=?,interval_minutes=?,
                retention=?,port=?,username=?,password_enc=?,secret_enc=?,updated_at=?
            WHERE id=?
            """,
            (
                request.hostname.strip(),ip,request.role.strip(),request.site.strip(),request.platform,
                json.dumps(request.tags),request.interval_minutes,request.retention,request.port,
                username,password_enc,secret_enc,utc_now(),device_id,
            ),
        )
        log_audit(conn,"Device updated",f"{request.hostname.strip()} inventory, schedule, or credential profile updated.",device_id)
        conn.commit()
        row = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        return row_to_device(row)


@app.post("/api/devices/{device_id}/backup")
def api_backup_device(device_id: int, request: BackupRequest):
    try:
        return run_backup(device_id, request.source, actor="Jim Camus")
    except KeyError as exc:
        raise HTTPException(status_code=404,detail="Device not found.") from exc
    except (ValueError,RuntimeError) as exc:
        raise HTTPException(status_code=400,detail=str(exc)) from exc


@app.post("/api/backups/run-all")
def api_backup_all():
    with DB_LOCK, db() as conn:
        ids = [row["id"] for row in conn.execute("SELECT id FROM devices ORDER BY id").fetchall()]
    success = 0
    failed = 0
    results = []
    for device_id in ids:
        try:
            results.append(run_backup(device_id, actor="Jim Camus"))
            success += 1
        except Exception as exc:
            failed += 1
            results.append({"device_id":device_id,"status":"failed","error":str(exc)})
    return {"success":success,"failed":failed,"results":results}


@app.get("/api/compare")
def api_compare(base_id: int = Query(...,ge=1), target_id: int = Query(...,ge=1)):
    if base_id == target_id:
        raise HTTPException(status_code=400,detail="Select two different backups.")
    with DB_LOCK, db() as conn:
        base_row = conn.execute(
            "SELECT b.*,d.hostname AS device FROM backups b JOIN devices d ON d.id=b.device_id WHERE b.id=? AND b.status='success'",
            (base_id,),
        ).fetchone()
        target_row = conn.execute(
            "SELECT b.*,d.hostname AS device FROM backups b JOIN devices d ON d.id=b.device_id WHERE b.id=? AND b.status='success'",
            (target_id,),
        ).fetchone()
        if not base_row or not target_row:
            raise HTTPException(status_code=404,detail="One or both backup versions were not found.")
        if base_row["device_id"] != target_row["device_id"]:
            raise HTTPException(status_code=400,detail="Backups must belong to the same device.")

        base = row_to_backup(base_row,base_row["device"])
        target = row_to_backup(target_row,target_row["device"])

    base_lines = base["config"].splitlines()
    target_lines = target["config"].splitlines()
    base_set = set(base_lines)
    target_set = set(target_lines)
    removed = [line for line in base_lines if line not in target_set]
    added = [line for line in target_lines if line not in base_set]
    unified = list(difflib.unified_diff(base_lines,target_lines,fromfile=f"v{base['version']}",tofile=f"v{target['version']}",lineterm=""))
    return {"base":base,"target":target,"added":added,"removed":removed,"unified":unified}



@app.post("/api/backups/{backup_id}/stage-restore")
def api_stage_restore(backup_id: int):
    with DB_LOCK, db() as conn:
        row = conn.execute(
            "SELECT b.*,d.hostname AS device FROM backups b JOIN devices d ON d.id=b.device_id WHERE b.id=? AND b.status='success'",
            (backup_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404,detail="Backup not found.")
        detail = f"{row['device']} version {row['version']} staged as a restore candidate for controlled rollback review."
        log_audit(conn,"Restore candidate staged",detail,row["device_id"])
        conn.commit()
    return {
        "ok": True,
        "backup_id": backup_id,
        "device": row["device"],
        "version": row["version"],
        "message": detail,
    }


@app.get("/api/backups/{backup_id}/download")
def api_download_backup(backup_id: int):
    with DB_LOCK, db() as conn:
        row = conn.execute(
            "SELECT b.*,d.hostname AS device FROM backups b JOIN devices d ON d.id=b.device_id WHERE b.id=? AND b.status='success'",
            (backup_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404,detail="Backup not found.")
        filename = f"{row['device']}_v{row['version']}.cfg"
        content = row["config"]
        log_audit(conn,"Configuration downloaded",f"{filename} downloaded.",row["device_id"])
        conn.commit()
    return Response(
        content=content,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition":f'attachment; filename="{filename}"'},
    )


@app.get("/")
def ui():
    return FileResponse(ROOT / "index.html")


@app.get("/styles.css")
def styles():
    return FileResponse(ROOT / "styles.css",media_type="text/css")


@app.get("/demo-data.js")
def demo_data():
    return FileResponse(ROOT / "demo-data.js",media_type="application/javascript")


@app.get("/app.js")
def script():
    return FileResponse(ROOT / "app.js",media_type="application/javascript")


def main() -> None:
    import uvicorn
    bind = os.environ.get("CONFIG_BACKUP_BIND","127.0.0.1")
    port = int(os.environ.get("CONFIG_BACKUP_PORT","8800"))
    print(f"Network Config Backup Manager: http://{bind}:{port}")
    uvicorn.run(app,host=bind,port=port,log_level="info")


if __name__ == "__main__":
    main()
