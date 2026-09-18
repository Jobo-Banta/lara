# Session keys for the engineering deployment

The default SESSION_SECRET_REF=local-file reads SESSION_SECRET from ignored local configuration. A managed deployment can use file:/run/secrets/lara-session for a mounted secret-manager value, or env:VARIABLE for a value injected by its secret manager. There is no vendor-specific cloud secret-manager deployment in the local baseline.

For a coordinated rolling rotation:

1. Generate a new random key of at least 32 characters in the operator's secret store.
2. During rollout, configure each instance with its signing key and the other key as SESSION_PREVIOUS_SECRET (or SESSION_PREVIOUS_SECRET_REF). Set SESSION_PREVIOUS_SECRET_EXPIRES_AT to an explicit UTC timestamp covering rollout and the desired login overlap. During the rollout old instances must also trust the new key.
3. Switch all web/API instances to the new current key. New cookies and BFF signatures use only the current key; old browser and consent cookies and old in-flight API signatures are verified against the previous key until the deadline.
4. Remove the previous key after the deadline. Expired sessions must sign in again. Compromised keys require immediate removal, without overlap.

Keep current and previous values out of logs, Git and browser JavaScript. Invalid references, short keys or overlap without a deadline fail closed. File references are resolved per request so mounted value rotation does not require embedding secrets in builds.

Verification: tests/session-rotation.test.mjs covers old/new sessions, BFF signatures, expiry, tampering and mounted-file/environment references. This test does not rotate the user's real key or invalidate their current login.
