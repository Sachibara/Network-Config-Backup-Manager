# Network Config Backup Manager

A portfolio-grade network engineering configuration backup and change-control platform.

This project is designed for Network Engineer, NOC, IT Infrastructure, and Network Operations roles. It demonstrates device inventory, SSH-based configuration collection, backup versioning, change detection, scheduling, auditability, and configuration comparison.

## Operating Modes

- **Portfolio Demo Mode** — public deployment with realistic simulated routers, switches, configuration versions, diffs, schedules, and audit history.
- **Live Backend Mode** — local FastAPI + SQLite backend using Netmiko to connect only to explicitly configured, authorized network devices.

## Core Features

- Router and switch inventory
- Cisco IOS / IOS XE-oriented SSH backup workflow
- Running-config and startup-config collection
- Safe staged restore-candidate workflow for controlled rollback review
- Manual backups
- Scheduled backups
- Backup version history
- SHA-256 change detection
- Side-by-side configuration diff
- Downloadable configuration snapshots
- Side-by-side change review before rollback decisions
- Device groups, sites, and tags
- Backup success / failure logs
- Local encrypted credential storage
- Retention settings
- Audit history
- REST API
- SQLite persistence
- Responsive change-control console

## Live Mode

Install dependencies:

```powershell
python -m pip install -r backend/requirements.txt
```

Start the backend:

```powershell
python backend/config_backup_api.py
```

Then open:

```text
http://127.0.0.1:8800
```

## Security

The live backend is intentionally local-first:

- binds to localhost by default
- stores network credentials only in the local runtime database
- encrypts passwords with a locally generated key
- excludes the database and encryption key from Git
- only connects to devices explicitly configured by the operator
- public demo mode never connects to real infrastructure

Use only on networks and devices you own or are explicitly authorized to administer.

## Developer

**Jim Rodmark Camus**  
BSIT — Network Technology  
GitHub: [@Sachibara](https://github.com/Sachibara)
