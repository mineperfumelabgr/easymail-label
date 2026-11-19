import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createAdminApiClient} from "@shopify/admin-api-client";
import {SHOPIFY_API_VERSION} from "../app/shopify-api-version.js";

test("the installed Shopify transport requests the configured stable version", async () => {
  let requestedUrl;
  const client=createAdminApiClient({
    storeDomain:"courier-version-check.myshopify.com",
    accessToken:"test-only-placeholder",
    apiVersion:SHOPIFY_API_VERSION,
    customFetchApi:async url=>{
      requestedUrl=String(url);
      return new Response(JSON.stringify({data:{shop:{id:"gid://shopify/Shop/1"}}}),{
        headers:{"Content-Type":"application/json","X-Shopify-API-Version":SHOPIFY_API_VERSION},
      });
    },
  });
  const result=await client.request("query {shop{id}}");
  assert.equal(new URL(requestedUrl).pathname,`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
  assert.equal(result.data.shop.id,"gid://shopify/Shop/1");
  assert.equal(result.headers.get("X-Shopify-API-Version"),SHOPIFY_API_VERSION);
});

test("production and development webhook configs match runtime and code generation", async () => {
  for(const config of ["shopify.app.toml","shopify.app.test.toml"]){
    const content=await readFile(new URL(`../${config}`,import.meta.url),"utf8");
    assert.equal(content.match(/\[webhooks\]\s*api_version\s*=\s*"([^"]+)"/)?.[1],SHOPIFY_API_VERSION,config);
  }
  const {default:graphqlConfig}=await import("../.graphqlrc.js");
  assert.equal(graphqlConfig.projects.default.schema,`https://shopify.dev/admin-graphql-direct-proxy/${SHOPIFY_API_VERSION}`);
});
