import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api } from "../src/api";

describe("documentação OpenAPI", () => {
  it("documenta todas as rotas da API, com esquemas que existem", async () => {
    const spec = await (await SELF.fetch("https://cloud.test/v1/openapi.json")).json<any>();
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods as object).map((m) => `${m.toUpperCase()} ${path}`)),
    );
    const routes = api.routes
      .filter((r) => r.path.startsWith("/v1/") && r.method !== "ALL" && !r.path.includes("*"))
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`);
    const missing = [...new Set(routes)].filter((r) => !documented.has(r));
    expect(missing).toEqual([]);

    // Toda referência $ref aponta para um esquema definido.
    const refs = [...JSON.stringify(spec).matchAll(/"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
    const undefinedRefs = [...new Set(refs)].filter((name) => !spec.components.schemas[name]);
    expect(undefinedRefs).toEqual([]);
  });
});
