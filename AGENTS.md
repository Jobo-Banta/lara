# LARA implementation workflow

- Read `docs/development/README.md` and the applicable phase specification before implementation. The development release plan supersedes legacy BRD phase numbers.
- Follow `docs/development/12-design-and-assets.md`: use `docs/DCP_UI_STYLE_GUIDE.md` and the current Ledger-L kit under `images/branding/ledger-l/`. Preserve source assets; the dated concepts are superseded.
- Maintain `build-status.html` through `scripts/build_status.py` as described in `docs/development/13-build-tracking.md`. At each implementation work-session handoff, update affected tickets, ownership, blockers and verification evidence. Do not mark documentation readiness as completed implementation.
- Use `sync` after release-plan/backlog changes and `check` before handoff. Commit source status and generated dashboard data with the work. Do not hand-edit generated status snapshots or overwrite other contributors' recorded progress; run one updater at a time.
- Mark a release shipped only after actual deployment/artifact delivery and the applicable gates pass. Record the tag and gate evidence. Phase 1 remains a synthetic-data prototype; subsequent modules have individual production activation boundaries.
