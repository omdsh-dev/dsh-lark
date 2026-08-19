# Contributor Notes

- Preserve the function-plugin named exports: `name`, `inject`, `Config`, and `apply`; do not add a default export.
- Keep Loader metadata in `src/index.ts`, schema/defaults in `src/config.ts`, and host boundaries plus activation in `src/runtime.ts`.
- Keep all registrations scoped to the plugin fiber and test disposal.
- Keep host-provided runtime APIs as peer dependencies and resolve development imports from this repository's declared dependencies.
- Do not add source, configuration, documentation, project-reference, `link:`, or `file:` paths that leave this repository.
- Describe repository files with project-root paths; never use parent-directory navigation in documentation.
- Update `README.md`（中文，默认展示）、`README.en.md`, configuration JSDoc, tests, and `cordis.patch.yml` together when behavior changes.
- Run `pnpm run typecheck`, `pnpm test`, `pnpm run build`, and `pnpm run prepare` before publishing changes.
