# Security Policy

## Supported versions

The latest published version of `dsh-lark-channel` receives fixes. Older versions are not patched retroactively.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/omdsh-dev/dsh-lark/security/advisories/new) rather than a public issue, and include the version, deployment shape (`web` profile or standalone), and reproduction steps. You should hear back within a week.

## Scope worth knowing

This plugin puts an agent that can run shell commands behind a chat surface. The intended controls are the platform's own app visibility scope, the `senderAllowlist` / `groupAllowlist` / `approvers` narrowing, and approval cards for host-gated actions — a report that shows any of these being bypassed is in scope. Lark app credentials persist through the host settings service; the model key resolves through the host credential store and is never written into unit files.
