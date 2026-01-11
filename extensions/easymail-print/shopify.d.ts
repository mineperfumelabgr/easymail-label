import '@shopify/ui-extensions';

// @ts-expect-error shopify types provided at runtime

declare module './src/ActionExtension.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
