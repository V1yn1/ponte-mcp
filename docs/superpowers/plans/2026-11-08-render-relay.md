# Render Relay Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** stable Render endpoint with execution retained on the user's PC.
**Architecture:** bounded HTTP reverse relay, outbound authenticated long polling,
transparent OAuth/JSON transport, no replay after ambiguous failure.
**Tech Stack:** Node.js >=22.12, native HTTP/fetch and node:test.
**Spec:** ../specs/2026-11-08-render-relay-design.md

## Global Constraints
One PC per service. No paid resources, no admin exposure, no secrets in Git.
No core edits. Buffer at most 1 MiB request / 8 MiB result; 16 pending requests.

## Review Focus
- URL normalization / encoded traversal must not reach admin or an arbitrary host.
- Relay secrets must not be confused with client bearer tokens.
- Disconnect after execution must not cause duplicate local calls.
- Agent replacement and relay restarts must not deliver stale results.
- OAuth redirects, WWW-Authenticate and watcher callbacks retain their meaning.

### Task 1: protocol and relay
Create relay/protocol.mjs, relay/server.mjs and relay/tests/relay.test.mjs.
- [ ] Write tests for bounded routes, offline/not_sent, auth and forwarding.
- [ ] Run tests; verify missing feature failure.
- [ ] Implement allowlist, bounded transport, single-agent lease and no replay.
- [ ] Run tests, inspect output.

### Task 2: local outbound agent
Create relay/agent.mjs; expand relay/tests/relay.test.mjs.
- [ ] Test loopback-only local target, origin verification, forwarding and timeout.
- [ ] Implement config reading without reading admin/API tokens, reconnect and workers.
- [ ] Run all relay tests and syntax checks.

### Task 3: deployment and documentation
Create render.yaml, relay/package.json, relay/README.md, docs/RENDER.md.
- [ ] Specify Free plan, generated secret, health check and native Node commands.
- [ ] Document one-time pairing, startup, private state and rollback.
- [ ] Validate config, links and tests; record actual evidence and remaining gaps.
- [ ] Publish non-destructive branch; attempt deployment only through an available
      authenticated Render action. Never claim production success from local tests.
