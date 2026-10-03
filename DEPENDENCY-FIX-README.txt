Courier Labels — source package based on the supplied v9 project

This package fixes the npm ERESOLVE conflict by replacing the stale React Router 7.11 lockfile with a freshly generated, matching dependency set:
- react-router, @react-router/dev, @react-router/node, @react-router/serve: 7.18.4
- @react-router/fs-routes: 7.18.1 (the published compatible version)
- prisma and @prisma/client: 6.19.3

Validation performed on this source copy:
- npm ci: passed
- npm run typecheck: passed
- npm run build: passed

Security audit note:
npm audit --omit=dev still reports 10 high findings in the Prisma configuration/deepmerge-ts chain and the Shopify UI Extensions/ts-morph chain. They are not addressed here because npm's suggested changes downgrade or change major package versions and need a separate compatibility review. Do not run npm audit fix --force blindly.

The package excludes node_modules, build output, local Shopify CLI state, git metadata, assistant MCP settings, and .env files. Keep your existing secrets in your local environment; do not add them to this archive.
