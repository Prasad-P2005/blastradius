/**
 * Hand-curated service dependencies: (caller)-[:DEPENDS_ON {protocol, source}]->(callee).
 *
 * Real (curated): every edge was read from the repo at the pinned snapshot
 * commit; `source` names the file it came from. We do NOT parse these files
 * automatically: compose `depends_on` mixes "starts after" with "calls", so a
 * human picked the edges that are real runtime calls.
 *
 * What we leave out, on purpose:
 *   - service → otel-collector (every service exports telemetry; that is not
 *     a request-path dependency and would connect everything to everything);
 *   - service → flagd / opamp-server (control plane: services fall back to
 *     flag defaults / keep running if these are down). flagd changes still
 *     reach a service through PRs that touch both, e.g. a PR adding a
 *     cart failure flag touches src/cart and src/flagd.
 *   - frontend-proxy → load-generator (the proxy only serves Locust's UI;
 *     the real traffic goes the other way: load-generator → frontend-proxy).
 *
 * acme sources (opentelemetry-demo @ 1fbf2a8d):
 *   compose.yaml               core services; *_ADDR env vars + depends_on
 *   compose.full.yaml          kafka, accounting, fraud-detection
 *   compose.agent.yaml         agent, mcp, chatbot
 *   compose.observability.yaml jaeger, grafana, prometheus, opensearch
 *   .env                       which *_ADDR are http:// (email, quote, shipping)
 * globex sources (microservices-demo @ 912468a8):
 *   kubernetes-manifests/*.yaml  env `*_SERVICE_ADDR`, `REDIS_ADDR`, `FRONTEND_ADDR`
 *   kustomize/components/shopping-assistant/  AlloyDB for the assistant
 */
import type { SeedPack as Tenant } from "@blastradius/shared";

export interface DepDef {
  from: string;
  to: string;
  protocol: "grpc" | "http" | "redis" | "kafka" | "postgres" | "tcp";
  source: string;
}

const ACME: DepDef[] = [
  // Edge: browsers, the mobile app and the load generator come in through Envoy.
  { from: "frontend-proxy", to: "frontend", protocol: "http", source: "compose.yaml (frontend-proxy: FRONTEND_HOST, depends_on frontend)" },
  { from: "frontend-proxy", to: "image-provider", protocol: "http", source: "compose.yaml (frontend-proxy: IMAGE_PROVIDER_HOST)" },
  { from: "frontend-proxy", to: "flagd-ui", protocol: "http", source: "compose.yaml (frontend-proxy: FLAGD_UI_HOST, depends_on flagd-ui)" },
  { from: "frontend-proxy", to: "flagd", protocol: "http", source: "compose.yaml (frontend-proxy: FLAGD_HOST; OFREP route for the browser)" },
  { from: "frontend-proxy", to: "telemetry-docs", protocol: "http", source: "compose.yaml (frontend-proxy: TELEMETRY_DOCS_HOST)" },
  { from: "frontend-proxy", to: "grafana", protocol: "http", source: "compose.observability.yaml (frontend-proxy depends_on grafana; GRAFANA_HOST)" },
  { from: "frontend-proxy", to: "jaeger", protocol: "http", source: "compose.observability.yaml (frontend-proxy depends_on jaeger; JAEGER_HOST)" },
  { from: "frontend-proxy", to: "chatbot", protocol: "http", source: "compose.agent.yaml (frontend-proxy depends_on chatbot; CHATBOT_HOST)" },
  { from: "react-native-app", to: "frontend-proxy", protocol: "http", source: "src/react-native-app/utils/Settings.ts (frontend_proxy_url)" },
  { from: "load-generator", to: "frontend-proxy", protocol: "http", source: ".env (LOCUST_HOST=http://${FRONTEND_PROXY_ADDR})" },
  { from: "load-generator", to: "agent", protocol: "http", source: "compose.agent.yaml (load-generator: AGENT_ENDPOINT, depends_on agent)" },
  // The storefront fans out to the backends (compose.yaml frontend.environment).
  { from: "frontend", to: "ad", protocol: "grpc", source: "compose.yaml (frontend: AD_ADDR)" },
  { from: "frontend", to: "cart", protocol: "grpc", source: "compose.yaml (frontend: CART_ADDR)" },
  { from: "frontend", to: "checkout", protocol: "grpc", source: "compose.yaml (frontend: CHECKOUT_ADDR)" },
  { from: "frontend", to: "currency", protocol: "grpc", source: "compose.yaml (frontend: CURRENCY_ADDR)" },
  { from: "frontend", to: "product-catalog", protocol: "grpc", source: "compose.yaml (frontend: PRODUCT_CATALOG_ADDR)" },
  { from: "frontend", to: "recommendation", protocol: "grpc", source: "compose.yaml (frontend: RECOMMENDATION_ADDR)" },
  { from: "frontend", to: "shipping", protocol: "http", source: "compose.yaml (frontend: SHIPPING_ADDR); .env SHIPPING_ADDR=http://shipping" },
  // Checkout orchestrates the order (compose.yaml checkout.environment, compose.full.yaml).
  { from: "checkout", to: "cart", protocol: "grpc", source: "compose.yaml (checkout: CART_ADDR)" },
  { from: "checkout", to: "currency", protocol: "grpc", source: "compose.yaml (checkout: CURRENCY_ADDR)" },
  { from: "checkout", to: "email", protocol: "http", source: "compose.yaml (checkout: EMAIL_ADDR); .env EMAIL_ADDR=http://email" },
  { from: "checkout", to: "payment", protocol: "grpc", source: "compose.yaml (checkout: PAYMENT_ADDR)" },
  { from: "checkout", to: "product-catalog", protocol: "grpc", source: "compose.yaml (checkout: PRODUCT_CATALOG_ADDR)" },
  { from: "checkout", to: "shipping", protocol: "http", source: "compose.yaml (checkout: SHIPPING_ADDR)" },
  { from: "checkout", to: "kafka", protocol: "kafka", source: "compose.full.yaml (checkout patch: KAFKA_ADDR, depends_on kafka)" },
  // Leaf calls and datastores.
  { from: "cart", to: "valkey-cart", protocol: "redis", source: "compose.yaml (cart: VALKEY_ADDR, depends_on valkey-cart)" },
  { from: "shipping", to: "quote", protocol: "http", source: "compose.yaml (shipping: QUOTE_ADDR); .env QUOTE_ADDR=http://quote" },
  { from: "recommendation", to: "product-catalog", protocol: "grpc", source: "compose.yaml (recommendation: PRODUCT_CATALOG_ADDR)" },
  { from: "product-catalog", to: "astronomy-db", protocol: "postgres", source: "compose.yaml (product-catalog: DB_CONNECTION_STRING, depends_on astronomy-db)" },
  { from: "accounting", to: "kafka", protocol: "kafka", source: "compose.full.yaml (accounting: KAFKA_ADDR, depends_on kafka)" },
  { from: "accounting", to: "astronomy-db", protocol: "postgres", source: "compose.full.yaml (accounting: DB_CONNECTION_STRING)" },
  { from: "fraud-detection", to: "kafka", protocol: "kafka", source: "compose.full.yaml (fraud-detection: KAFKA_ADDR, depends_on kafka)" },
  { from: "flagd-ui", to: "flagd", protocol: "http", source: "compose.yaml (flagd-ui depends_on flagd)" },
  // LLM agent layer.
  { from: "chatbot", to: "agent", protocol: "http", source: "compose.agent.yaml (chatbot: AGENT_ENDPOINT, depends_on agent)" },
  { from: "agent", to: "mcp", protocol: "http", source: "compose.agent.yaml (agent: MCP_ENDPOINT, depends_on mcp)" },
  { from: "agent", to: "product-catalog", protocol: "grpc", source: "compose.agent.yaml (agent depends_on product-catalog)" },
  { from: "mcp", to: "frontend", protocol: "http", source: "compose.agent.yaml (mcp: APPLICATION_ENDPOINT, depends_on frontend)" },
  // Observability: the collector scrapes datastores and ships to the backends.
  { from: "otel-collector", to: "valkey-cart", protocol: "redis", source: "src/otel-collector/otelcol-config.yml (receivers.redis endpoint valkey-cart:6379)" },
  { from: "otel-collector", to: "astronomy-db", protocol: "postgres", source: "src/otel-collector/otelcol-config.yml (receivers.postgresql endpoint POSTGRES_HOST)" },
  { from: "otel-collector", to: "jaeger", protocol: "grpc", source: "compose.observability.yaml (otel-collector depends_on jaeger)" },
  { from: "otel-collector", to: "opensearch", protocol: "http", source: "compose.observability.yaml (otel-collector depends_on opensearch)" },
  { from: "grafana", to: "prometheus", protocol: "http", source: "src/grafana/provisioning/datasources/default.yaml" },
  { from: "grafana", to: "jaeger", protocol: "http", source: "src/grafana/provisioning/datasources/jaeger.yaml" },
  { from: "grafana", to: "opensearch", protocol: "http", source: "src/grafana/provisioning/datasources/opensearch.yaml" },
];

const GLOBEX: DepDef[] = [
  { from: "load-generator", to: "frontend", protocol: "http", source: "kubernetes-manifests/loadgenerator.yaml (FRONTEND_ADDR=frontend:80)" },
  { from: "frontend", to: "product-catalog", protocol: "grpc", source: "kubernetes-manifests/frontend.yaml (PRODUCT_CATALOG_SERVICE_ADDR)" },
  { from: "frontend", to: "currency", protocol: "grpc", source: "kubernetes-manifests/frontend.yaml (CURRENCY_SERVICE_ADDR)" },
  { from: "frontend", to: "cart", protocol: "grpc", source: "kubernetes-manifests/frontend.yaml (CART_SERVICE_ADDR)" },
  { from: "frontend", to: "recommendation", protocol: "grpc", source: "kubernetes-manifests/frontend.yaml (RECOMMENDATION_SERVICE_ADDR)" },
  { from: "frontend", to: "shipping", protocol: "grpc", source: "kubernetes-manifests/frontend.yaml (SHIPPING_SERVICE_ADDR)" },
  { from: "frontend", to: "checkout", protocol: "grpc", source: "kubernetes-manifests/frontend.yaml (CHECKOUT_SERVICE_ADDR)" },
  { from: "frontend", to: "ad", protocol: "grpc", source: "kubernetes-manifests/frontend.yaml (AD_SERVICE_ADDR)" },
  { from: "frontend", to: "shopping-assistant", protocol: "http", source: "kubernetes-manifests/frontend.yaml (SHOPPING_ASSISTANT_SERVICE_ADDR)" },
  { from: "checkout", to: "product-catalog", protocol: "grpc", source: "kubernetes-manifests/checkoutservice.yaml (PRODUCT_CATALOG_SERVICE_ADDR)" },
  { from: "checkout", to: "shipping", protocol: "grpc", source: "kubernetes-manifests/checkoutservice.yaml (SHIPPING_SERVICE_ADDR)" },
  { from: "checkout", to: "payment", protocol: "grpc", source: "kubernetes-manifests/checkoutservice.yaml (PAYMENT_SERVICE_ADDR)" },
  { from: "checkout", to: "email", protocol: "grpc", source: "kubernetes-manifests/checkoutservice.yaml (EMAIL_SERVICE_ADDR)" },
  { from: "checkout", to: "currency", protocol: "grpc", source: "kubernetes-manifests/checkoutservice.yaml (CURRENCY_SERVICE_ADDR)" },
  { from: "checkout", to: "cart", protocol: "grpc", source: "kubernetes-manifests/checkoutservice.yaml (CART_SERVICE_ADDR)" },
  { from: "recommendation", to: "product-catalog", protocol: "grpc", source: "kubernetes-manifests/recommendationservice.yaml (PRODUCT_CATALOG_SERVICE_ADDR)" },
  { from: "cart", to: "redis-cart", protocol: "redis", source: "kubernetes-manifests/cartservice.yaml (REDIS_ADDR=redis-cart:6379)" },
  { from: "shopping-assistant", to: "alloydb", protocol: "postgres", source: "kustomize/components/shopping-assistant/shoppingassistantservice.yaml (ALLOYDB_* env); src/shoppingassistantservice/shoppingassistantservice.py (AlloyDBVectorStore)" },
];

export const DEPENDENCIES: Record<Tenant, DepDef[]> = { acme: ACME, globex: GLOBEX };
