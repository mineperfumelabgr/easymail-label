# Shopify API version

Runtime Admin GraphQL requests and GraphQL code generation share
`app/shopify-api-version.js` (`2026-10`). Production and development app TOML
webhook versions use the same stable release. The installed Shopify client
accepts the explicit version string, so no SDK major upgrade is needed.

Deploying `main` to Render updates Admin API calls. Publishing the production
`shopify.app.toml` with Shopify CLI also updates the app's webhook payload version;
a GitHub push alone does not publish that Shopify configuration.

Compatibility checks for this update:

- 33 distinct GraphQL operation templates validated locally using the official
  public `2026-10` introspection schema. Contact-field placeholders were expanded
  and dynamic metafield keys replaced with valid string literals for validation.
- Existing order filtering already excludes `FULFILLMENT_NOT_REQUIRED` from
  Unfulfilled and displays its readable label under All.
- Shipment operations do not modify order shipping addresses, inventory
  quantities, customer marketing consent, or ShopifyQL reports, so the relevant
  2026 breaking changes do not affect those flows.
- Both configured webhook topics (`app/uninstalled`, `app/scopes_update`) retain
  the fields read by the handlers.
- The installed Shopify transport was tested with a mock response to confirm
  requests target `/admin/api/2026-10/graphql.json`.

Run the focused transport/configuration check with:

```sh
node --test tests/shopify-api-version.test.mjs
```
