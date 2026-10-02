# Gunthe Session Delete

A conservative permanent-delete plugin for Gunthe / DeepSeek Harness `0.2.0-rc.2`.

## Safety model

- Uses the official sidebar menu slot and the exact Session ID; it never guesses by title.
- A Session must already be archived.
- Refuses deletion while the Session has activity, a live Session/Agent, a writer, pending creation, or any open persistence handle.
- Resolves the current artifact through SessionPersistence and verifies its stored identity and path boundary before deletion.
- Coalesces concurrent requests for the same Session.
- Writes an atomic durable tombstone recording file, projection, and workspace cleanup. Partial cleanup is reported and remains diagnosable/retryable.
- Requires explicit `DELETE` confirmation in the UI.
- Registers no Agent deletion tool.
- Uses a custom request header and origin validation for its Host route.

Because Harness 0.2 has no public online persistence-delete API, the plugin intentionally accepts only cold archived Sessions. In practice: archive the Session, restart Gunthe, and delete it before reopening it. This is less convenient but prevents a live writer or open read handle racing the purge.

## Install

```sh
dsh plugin --profile web add github:DankwielClaw/dsh-plugin-session-delete
```

Restart the web profile after installation.

## Development

```sh
npm test
```

The test suite covers traversal rejection, archive admission, activity and persistence-handle gates, identity mismatch, request coalescing, complete cleanup, and durable partial-failure reporting.
