# Legacy control-plane snapshot — 2026-09-06

This directory preserves the byte-for-byte control-plane inputs that existed
before the schema-v2 recovery migration. The files are diagnostic history, not
the active source of truth. They remain available so a reviewer can compare
the pre-migration records without confusing the old custom vocabulary with the
canonical `engineering-framework` v2 contract.

The migration keeps the stable task, verification, gate and evidence meaning
where it can be recovered. It does not infer an independent critic approval,
clinical policy approval, hospital authority, production readiness or release
permission. Conditional local evidence remains conditional in the active state
and gate records.

Pre-migration SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `.agent/state.json` | `abf41a31e361dd1fc9ef1ad0dd206b9100aa0b9ce93c83fd1460ab63278494b7` |
| `.agent/backlog.json` | `2636d1024bbcaa1038950f1615f6136bf2cc0f8ebba3a87c468618b9ab681ec2` |
| `.agent/execution-log.jsonl` | `998693f1a66e885cb817f3297ec0810034d8e74457e53bc3abfe8b288f067566` |
| `.agent/verification.jsonl` | `78e98a6714c7d962a732ef5a482f21c2e701dc8cb7b329eb4ece30352c8806cd` |
| `.agent/gates/implementation-ready-v4-contract.json` | `6485f3f010d3b9659ee659745d99b9254064376fe575fea7c81340f2eded162d` |
| `.agent/gates/implementation-ready-v4-data.json` | `e206f435ca01e79dcd79a3c2e0f9e50991284f8dc509ab0b38d2d4aea7676dba` |
| `.agent/gates/implementation-ready-v4.json` | `6f24990ac511cb00a71db8b45e6c3acc12954ed668f882548b1b3b8322d11a67` |
| `.agent/gates/v2-laboratory-conditional.json` | `74fbb0c1e194eedf37fefd23d2aec932a46c58e61234271b913a1a20425419d5` |
| `.agent/gates/verified-v4-final.json` | `2157529489d6ced23a71fafe5a33731afc70a9a0f105e5d1c43a48be7db3825a` |
| `.gauntlet/state.md` | `7f5b228aa19599303c8bf3014259e83773dba6ff13964c72fa29dfe31514b417` |
| `.gauntlet/progress.md` | `22497e18ecabec9636abc17ad22625631e317b139c792d859f0a6fa522888169` |

The active canonical files are the sibling `.agent/state.json`,
`.agent/backlog.json`, `.agent/execution-log.jsonl`, `.agent/verification.jsonl`
and `.agent/gates/*.json`. The next recovery event and the migration decision
are recorded there.
