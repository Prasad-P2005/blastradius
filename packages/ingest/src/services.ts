/**
 * Service catalog + the alias table that maps repo paths to services.
 *
 * Real (curated): the services exist in the repos under these paths, with
 * these languages; descriptions paraphrase each repo's own docs. `tier` is our
 * judgement (1 = customer-facing request path, 2 = supporting, 3 = tooling),
 * informed by acme's own `service.criticality` attributes in compose.yaml.
 *
 * The alias table is the ONLY way a file becomes part of a service: a file
 * whose path starts with one of a service's `paths` is a File node that is
 * PART_OF that service. Files that match no service (docs, CI, helm charts,
 * root configs) are dropped — PRs keep their totals, but get no MODIFIES edge.
 *
 * acme renamed its dirs in Dec 2024/Jan 2025 (src/cartservice → src/cart,
 * PRs #1858–#1867); the old names stay in `paths` so older PRs (e.g. the
 * #1619 Valkey move) still map to the right service.
 *
 * Slugs are short and identical across tenants where the role is the same
 * (`cart`, `checkout`, `product-catalog`…), so the demo reads the same on both.
 * globex's k8s deployment names (`cartservice`…) are kept in `deployment`.
 */
import type { SeedPack as Tenant } from "@blastradius/shared";

export type ServiceKind = "service" | "frontend" | "datastore" | "queue" | "proxy" | "external" | "tool";

export interface ServiceDef {
  slug: string;
  name: string;
  kind: ServiceKind;
  language: string;
  tier: 1 | 2 | 3;
  /** Primary repo path ("" when the component has no source dir, e.g. a stock image). */
  repoPath: string;
  /** Path prefixes that map to this service (each ends with "/"). */
  paths: string[];
  description: string;
  /** k8s / compose deployment name, when it differs from the slug */
  deployment?: string;
}

const ACME: ServiceDef[] = [
  { slug: "frontend-proxy", name: "frontend-proxy", kind: "proxy", language: "envoy", tier: 1, repoPath: "src/frontend-proxy", paths: ["src/frontend-proxy/", "src/frontendproxy/"], description: "Envoy edge proxy: routes browser, mobile and load-generator traffic to the frontend and the internal UIs (Grafana, Jaeger, flagd-ui)." },
  { slug: "frontend", name: "frontend", kind: "frontend", language: "typescript", tier: 1, repoPath: "src/frontend", paths: ["src/frontend/"], description: "Next.js web storefront: renders the shop and calls the backend gRPC/HTTP services for products, cart, checkout, ads and recommendations." },
  { slug: "checkout", name: "checkout", kind: "service", language: "go", tier: 1, repoPath: "src/checkout", paths: ["src/checkout/", "src/checkoutservice/"], description: "Go service that places orders: reads the cart, prices it in the user's currency, charges payment, books shipping, emails a confirmation and publishes the order to Kafka." },
  { slug: "cart", name: "cart", kind: "service", language: "csharp", tier: 1, repoPath: "src/cart", paths: ["src/cart/", "src/cartservice/"], description: ".NET service that stores shopping carts in Valkey (valkey-cart)." },
  { slug: "payment", name: "payment", kind: "service", language: "javascript", tier: 1, repoPath: "src/payment", paths: ["src/payment/", "src/paymentservice/"], description: "Node.js service that validates and charges credit cards (mock) for checkout." },
  { slug: "product-catalog", name: "product-catalog", kind: "service", language: "go", tier: 1, repoPath: "src/product-catalog", paths: ["src/product-catalog/", "src/productcatalogservice/"], description: "Go service that lists, searches and returns products; reads them from PostgreSQL (astronomy-db)." },
  { slug: "currency", name: "currency", kind: "service", language: "cpp", tier: 2, repoPath: "src/currency", paths: ["src/currency/", "src/currencyservice/"], description: "C++ service that converts money amounts between currencies." },
  { slug: "shipping", name: "shipping", kind: "service", language: "rust", tier: 2, repoPath: "src/shipping", paths: ["src/shipping/", "src/shippingservice/"], description: "Rust service that quotes and ships orders; asks quote for the price." },
  { slug: "quote", name: "quote", kind: "service", language: "php", tier: 3, repoPath: "src/quote", paths: ["src/quote/", "src/quoteservice/"], description: "PHP service that calculates shipping costs from the number of items." },
  { slug: "email", name: "email", kind: "service", language: "ruby", tier: 2, repoPath: "src/email", paths: ["src/email/", "src/emailservice/"], description: "Ruby (Sinatra) service that sends order confirmation emails (mock)." },
  { slug: "ad", name: "ad", kind: "service", language: "java", tier: 2, repoPath: "src/ad", paths: ["src/ad/", "src/adservice/"], description: "Java service that serves contextual text ads." },
  { slug: "recommendation", name: "recommendation", kind: "service", language: "python", tier: 2, repoPath: "src/recommendation", paths: ["src/recommendation/", "src/recommendationservice/"], description: "Service that recommends products based on what is in the cart; calls product-catalog." },
  { slug: "accounting", name: "accounting", kind: "service", language: "csharp", tier: 3, repoPath: "src/accounting", paths: ["src/accounting/", "src/accountingservice/"], description: ".NET Kafka consumer that records every order in PostgreSQL." },
  { slug: "fraud-detection", name: "fraud-detection", kind: "service", language: "kotlin", tier: 3, repoPath: "src/fraud-detection", paths: ["src/fraud-detection/", "src/frauddetectionservice/"], description: "Kotlin Kafka consumer that inspects orders for fraud." },
  { slug: "image-provider", name: "image-provider", kind: "service", language: "nginx", tier: 2, repoPath: "src/image-provider", paths: ["src/image-provider/", "src/imageprovider/"], description: "nginx server for product images." },
  { slug: "kafka", name: "kafka", kind: "queue", language: "java", tier: 2, repoPath: "src/kafka", paths: ["src/kafka/"], description: "Kafka broker carrying the `orders` topic from checkout to accounting and fraud-detection." },
  { slug: "valkey-cart", name: "valkey-cart", kind: "datastore", language: "valkey", tier: 1, repoPath: "", paths: [], description: "Valkey (Redis-compatible) key-value store holding carts. Stock image, no source dir." },
  { slug: "astronomy-db", name: "astronomy-db", kind: "datastore", language: "sql", tier: 1, repoPath: "src/postgresql", paths: ["src/postgresql/"], description: "PostgreSQL database `astronomy_db` with the product catalogue and accounting orders; init.sql lives in src/postgresql." },
  { slug: "flagd", name: "flagd", kind: "external", language: "json", tier: 2, repoPath: "src/flagd", paths: ["src/flagd/"], description: "OpenFeature flagd server; src/flagd/demo.flagd.json holds the demo's failure-injection feature flags." },
  { slug: "flagd-ui", name: "flagd-ui", kind: "tool", language: "elixir", tier: 3, repoPath: "src/flagd-ui", paths: ["src/flagd-ui/"], description: "Phoenix web UI to toggle flagd feature flags and schedule failure scenarios." },
  { slug: "load-generator", name: "load-generator", kind: "tool", language: "python", tier: 3, repoPath: "src/load-generator", paths: ["src/load-generator/", "src/loadgenerator/"], description: "Locust load generator that simulates shoppers through frontend-proxy." },
  { slug: "otel-collector", name: "otel-collector", kind: "tool", language: "yaml", tier: 2, repoPath: "src/otel-collector", paths: ["src/otel-collector/", "src/otelcollector/"], description: "OpenTelemetry Collector: receives all telemetry and scrapes valkey-cart and PostgreSQL." },
  { slug: "grafana", name: "grafana", kind: "tool", language: "json", tier: 3, repoPath: "src/grafana", paths: ["src/grafana/"], description: "Grafana with the demo dashboards." },
  { slug: "jaeger", name: "jaeger", kind: "tool", language: "yaml", tier: 3, repoPath: "src/jaeger", paths: ["src/jaeger/"], description: "Jaeger trace storage and UI." },
  { slug: "prometheus", name: "prometheus", kind: "tool", language: "yaml", tier: 3, repoPath: "src/prometheus", paths: ["src/prometheus/"], description: "Prometheus metrics storage." },
  { slug: "opensearch", name: "opensearch", kind: "tool", language: "yaml", tier: 3, repoPath: "src/opensearch", paths: ["src/opensearch/"], description: "OpenSearch log storage." },
  { slug: "opamp-server", name: "opamp-server", kind: "tool", language: "go", tier: 3, repoPath: "src/opamp-server", paths: ["src/opamp-server/"], description: "OpAMP server that services and the collector report their status to." },
  { slug: "telemetry-docs", name: "telemetry-docs", kind: "tool", language: "python", tier: 3, repoPath: "src/telemetry-docs", paths: ["src/telemetry-docs/"], description: "Generated documentation site for the demo's telemetry schema." },
  { slug: "agent", name: "agent", kind: "service", language: "python", tier: 3, repoPath: "src/agent", paths: ["src/agent/"], description: "LLM shopping agent that answers product questions using product-catalog and the MCP server." },
  { slug: "mcp", name: "mcp", kind: "service", language: "python", tier: 3, repoPath: "src/mcp", paths: ["src/mcp/"], description: "MCP server exposing the shop's APIs as tools for the agent." },
  { slug: "chatbot", name: "chatbot", kind: "frontend", language: "python", tier: 3, repoPath: "src/chatbot", paths: ["src/chatbot/"], description: "Chat UI in front of the shopping agent." },
  { slug: "react-native-app", name: "react-native-app", kind: "frontend", language: "typescript", tier: 2, repoPath: "src/react-native-app", paths: ["src/react-native-app/"], description: "React Native mobile shop app; talks to frontend-proxy." },
];

const GLOBEX: ServiceDef[] = [
  { slug: "frontend", name: "frontend", kind: "frontend", language: "go", tier: 1, repoPath: "src/frontend", paths: ["src/frontend/"], description: "Go HTTP server that renders the Online Boutique storefront and calls every backend over gRPC.", deployment: "frontend" },
  { slug: "checkout", name: "checkout", kind: "service", language: "go", tier: 1, repoPath: "src/checkoutservice", paths: ["src/checkoutservice/"], description: "Go service that places orders: gets the cart, prices it, charges payment, ships it and emails the user.", deployment: "checkoutservice" },
  { slug: "cart", name: "cart", kind: "service", language: "csharp", tier: 1, repoPath: "src/cartservice", paths: ["src/cartservice/"], description: ".NET service that stores carts in Redis (redis-cart); Spanner and AlloyDB are optional backends.", deployment: "cartservice" },
  { slug: "product-catalog", name: "product-catalog", kind: "service", language: "go", tier: 1, repoPath: "src/productcatalogservice", paths: ["src/productcatalogservice/"], description: "Go service that lists and searches products from products.json (AlloyDB optional).", deployment: "productcatalogservice" },
  { slug: "currency", name: "currency", kind: "service", language: "javascript", tier: 2, repoPath: "src/currencyservice", paths: ["src/currencyservice/"], description: "Node.js service converting money between currencies using ECB rates. Highest-QPS service.", deployment: "currencyservice" },
  { slug: "payment", name: "payment", kind: "service", language: "javascript", tier: 1, repoPath: "src/paymentservice", paths: ["src/paymentservice/"], description: "Node.js service that charges credit cards (mock) and returns a transaction id.", deployment: "paymentservice" },
  { slug: "shipping", name: "shipping", kind: "service", language: "go", tier: 2, repoPath: "src/shippingservice", paths: ["src/shippingservice/"], description: "Go service that quotes shipping costs and ships orders (mock).", deployment: "shippingservice" },
  { slug: "email", name: "email", kind: "service", language: "python", tier: 2, repoPath: "src/emailservice", paths: ["src/emailservice/"], description: "Python service that sends order confirmation emails (mock).", deployment: "emailservice" },
  { slug: "recommendation", name: "recommendation", kind: "service", language: "python", tier: 2, repoPath: "src/recommendationservice", paths: ["src/recommendationservice/"], description: "Python service recommending products based on the cart; calls product-catalog.", deployment: "recommendationservice" },
  { slug: "ad", name: "ad", kind: "service", language: "java", tier: 2, repoPath: "src/adservice", paths: ["src/adservice/"], description: "Java service serving text ads for given context words.", deployment: "adservice" },
  { slug: "shopping-assistant", name: "shopping-assistant", kind: "service", language: "python", tier: 3, repoPath: "src/shoppingassistantservice", paths: ["src/shoppingassistantservice/"], description: "Gemini-powered shopping assistant (RAG over an AlloyDB vector store), new in April 2024.", deployment: "shoppingassistantservice" },
  { slug: "load-generator", name: "load-generator", kind: "tool", language: "python", tier: 3, repoPath: "src/loadgenerator", paths: ["src/loadgenerator/"], description: "Locust load generator simulating shoppers against the frontend.", deployment: "loadgenerator" },
  { slug: "redis-cart", name: "redis-cart", kind: "datastore", language: "redis", tier: 1, repoPath: "", paths: [], description: "Redis (redis:alpine) holding carts for cartservice. Stock image, defined in kubernetes-manifests/cartservice.yaml.", deployment: "redis-cart" },
  { slug: "alloydb", name: "alloydb", kind: "datastore", language: "sql", tier: 3, repoPath: "", paths: [], description: "AlloyDB for PostgreSQL vector store used by the shopping assistant (kustomize/components/shopping-assistant).", deployment: "alloydb" },
];

export const SERVICES: Record<Tenant, ServiceDef[]> = { acme: ACME, globex: GLOBEX };

/** Longest-prefix match of a repo path to a service slug, or null. */
export function serviceForPath(tenant: Tenant, path: string): string | null {
  let best: { slug: string; len: number } | null = null;
  for (const s of SERVICES[tenant]) {
    for (const p of s.paths) {
      if (path.startsWith(p) && (!best || p.length > best.len)) best = { slug: s.slug, len: p.length };
    }
  }
  return best?.slug ?? null;
}

const EXT_LANG: Record<string, string> = {
  go: "go", cs: "csharp", csproj: "csharp", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", java: "java", kt: "kotlin", kts: "kotlin", rs: "rust", php: "php", cpp: "cpp", cc: "cpp", h: "cpp", hpp: "cpp",
  ex: "elixir", exs: "elixir", heex: "elixir", proto: "protobuf", sql: "sql", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", html: "html", css: "css", scss: "css", sh: "shell", gradle: "gradle", lua: "lua", conf: "config", template: "config",
};

/** Language of a file from its name (Dockerfile → docker, else by extension). */
export function languageForPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (/^Dockerfile/i.test(base) || base.endsWith(".Dockerfile")) return "docker";
  if (base === "Makefile") return "make";
  if (/^(Gemfile|Rakefile)/.test(base)) return "ruby";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? (ext || "other");
}
