# Build tracker service correction — 18 September 2026

The reported URL was http://127.0.0.1:8765/build-status.html. Nothing was listening on port 8765. The offline HTML and generated snapshots were valid; no recorded phase progress was lost.

Restored the loopback service and added pnpm status:serve. pnpm dev starts the service automatically and reuses an already-running LARA tracker. The server exposes only tracker assets, generated read-only view data, specifications and branding; environment files, Git metadata and arbitrary workspace paths return 404.

Verified in Chromium at the reported address: live refresh, 26 release increments, P00 shipped, search, expansion, clear filters and manual refresh. No JavaScript errors or failed resource requests. The standalone offline snapshot also rendered correctly. The server regression test covers assets/data, private-path denial and allowed HTTP methods.

This is an operational startup improvement. Existing ticket ownership, blockers and release attestations are preserved; it does not reopen or re-attest the delivered v0.0.1 artifact.
