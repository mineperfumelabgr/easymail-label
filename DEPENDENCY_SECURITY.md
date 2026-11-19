# Dependency security review — 19 November 2026

Production audit command: `npm audit --omit=dev`.

Updated the dependency lock and constrained the patched transitive versions of
`body-parser` (1.20.9), `qs` (6.16.1), and `deepmerge-ts` (8.0.2 under
`@prisma/config`). Vite remains on the 6.x line, with a minimum of 6.4.6.
Prisma and Prisma Client remain at 6.19.3; the schema and migrations are unchanged.

The Prisma override is scoped to its configuration package, which uses the
`deepmerge` export. Validate and generate the Prisma schema after changing it.

The final production audit reports **zero high or critical vulnerabilities** and
two moderate entries for the same remaining minimatch advisory:
`GHSA-g3hv-75wg-m249`, reported for minimatch and its parent
`@react-router/fs-routes`.

This app uses fs-routes while loading its build-time route configuration. Its
patterns come from the repository (`flatRoutes()` with no custom patterns), not
HTTP requests or order fields. Do not override minimatch to 11: fs-routes 7.18.1
uses `makeRe`, which minimatch 11 removed, and the production build fails.
Reassess when fs-routes supplies a compatible remediation. These findings remain
visible in npm audit and are not suppressed. This is not a claim that the full
development dependency audit is clean.

References:

- https://github.com/advisories/GHSA-27r3-jxmh-p828
- https://github.com/advisories/GHSA-6pq8-jhm2-2vcw
- https://github.com/advisories/GHSA-ggr8-5vv4-36mx
- https://github.com/advisories/GHSA-g3hv-75wg-m249
- https://github.com/advisories/GHSA-9jrq-w75r-8gcw
