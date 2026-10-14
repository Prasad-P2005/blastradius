/**
 * acme (opentelemetry-demo): hand-written SYNTHETIC content.
 *
 * Every incident, ADR, ticket and thread below is fiction written for the
 * demo, but each one is anchored to REAL PRs, people and services through
 * {{placeholders}} (see synth/text.ts). The real facts we lean on:
 *   - #1619 really replaced Redis with Valkey for the cart (2024-06);
 *   - #2859 / #3153 really moved the product catalogue into PostgreSQL;
 *   - #3564 really replaced Locust with k6, and #3873 really reverted it;
 *   - #3504 really fixed duplicate orders on Kafka redelivery;
 *   - #3844 really fixed "payment service not starting" after #3486.
 * Reasons, quotes, timelines and impact numbers are invented.
 */
import type { TenantContent } from "../synth/types.ts";

export const ACME_CONTENT: TenantContent = {
  issuePrefix: "ACME",
  templatedIssues: 16,
  templatedThreads: 9,

  teams: [
    { slug: "storefront", name: "Storefront", slack: "#team-storefront", anchors: ["frontend", "frontend-proxy", "react-native-app", "image-provider", "ad", "recommendation"] },
    { slug: "checkout-payments", name: "Checkout & Payments", slack: "#team-checkout", anchors: ["checkout", "payment", "shipping", "quote", "currency", "email"] },
    { slug: "cart-catalog", name: "Cart & Catalog", slack: "#team-cart-catalog", anchors: ["cart", "valkey-cart", "product-catalog", "astronomy-db"] },
    { slug: "orders-data", name: "Orders Data", slack: "#team-orders-data", anchors: ["kafka", "accounting", "fraud-detection"] },
    { slug: "platform", name: "Platform & Observability", slack: "#team-platform", anchors: ["otel-collector", "flagd", "flagd-ui", "load-generator", "grafana", "jaeger", "prometheus", "opensearch", "opamp-server", "telemetry-docs"] },
  ],

  incidents: [
    {
      key: "INC-2026-031",
      service: "cart",
      neighbors: ["valkey-cart"],
      causedBy: 3487,
      severity: "SEV2",
      title: "cart restart loop: new health check fails while valkey-cart warms up",
      summary:
        "After {{pr:3487}} added container health checks, cart was marked unhealthy and restarted whenever valkey-cart took more than a few seconds to accept connections. The storefront's cart page returned 503 for 38 minutes; checkout could not read carts.",
      rootCause:
        "The new cart health check calls Valkey synchronously with a 2 s timeout and no start period. During a valkey-cart restart the check failed three times in a row, the orchestrator killed cart, and the restarts kept valkey-cart's connection backlog high.",
      alert: { title: "cart availability below SLO", metric: "cart_grpc_server_errors_ratio", value: "0.31", message: "cart GetCart/AddItem error ratio 31% over 5m (SLO 1%)" },
      runbook: {
        slug: "rb-cart-restart-loop",
        title: "cart restart loop / unhealthy",
        steps: [
          "Check restarts and the last state: `kubectl get pods -l app.kubernetes.io/component=cart` (compose: `docker compose ps cart`).",
          "Check valkey-cart first: `kubectl exec deploy/valkey-cart -- valkey-cli ping` must return PONG.",
          "If valkey-cart is healthy but cart keeps restarting, relax the cart healthcheck (start_period 20s, timeout 5s) in compose.yaml / the Helm values and redeploy.",
          "Restart in order: valkey-cart, then cart: `kubectl rollout restart deployment/cart`.",
          "Verify in Grafana (Demo dashboard, cart panel) that GetCart errors are back under 1% and checkout PlaceOrder recovers.",
        ],
      },
    },
    {
      key: "INC-2026-033",
      service: "payment",
      neighbors: ["checkout"],
      causedBy: 3486,
      severity: "SEV1",
      title: "payment fails to start after switching to zero-code instrumentation",
      summary:
        "{{pr:3486}} moved payment to zero-code JS instrumentation loaded through NODE_OPTIONS. New payment pods crashed on start, so every checkout charge failed for 22 minutes until the deployment was rolled back. The permanent fix landed later in {{pr:3844}}.",
      rootCause:
        "NODE_OPTIONS required the auto-instrumentation register module from a path that did not exist in the slimmed production image, so `node` exited before opening the gRPC port; the health check never passed.",
      alert: { title: "checkout charge failures", metric: "payment_charge_errors_ratio", value: "1.00", message: "payment Charge error ratio 100% for 3m; checkout PlaceOrder failing" },
      runbook: {
        slug: "rb-payment-crashloop",
        title: "payment crash-loops on start",
        steps: [
          "Read the first log lines of a new pod: `kubectl logs deploy/payment --previous`; a `Cannot find module` error means the NODE_OPTIONS --require path is wrong.",
          "Roll back immediately: `kubectl rollout undo deployment/payment`; confirm checkout PlaceOrder succeeds.",
          "To keep payment up while debugging, unset NODE_OPTIONS on the deployment; telemetry is lost but charges work.",
          "Check the paymentFailure and paymentUnreachable flags are off in flagd-ui so they do not mask the real cause.",
          "Before re-rolling, build the image locally and run `node --require <path> index.js` to prove the module resolves.",
        ],
      },
    },
    {
      key: "INC-2026-034",
      service: "shipping",
      neighbors: ["checkout"],
      causedBy: 3572,
      severity: "SEV3",
      title: "shipping OOM-killed after stdout log layer doubled log volume",
      summary:
        "{{pr:3572}} added a stdout log layer to shipping. Under the load test shipping wrote every span event to stdout, hit its 20 MiB memory limit and was OOM-killed every few minutes. checkout saw intermittent GetQuote/ShipOrder errors for about an hour.",
      rootCause:
        "The stdout layer buffered formatted events in memory before flushing; with debug-level filtering left on, the buffer grew faster than it drained inside the 20 MiB container limit.",
      alert: { title: "shipping restarts", metric: "kube_pod_container_status_restarts_total", value: "7", message: "shipping restarted 7 times in 30m (OOMKilled)" },
      runbook: {
        slug: "rb-shipping-oom",
        title: "shipping OOMKilled",
        steps: [
          "Confirm the reason: `kubectl describe pod -l app.kubernetes.io/component=shipping` shows `OOMKilled`.",
          "Lower log volume: set RUST_LOG=info on deployment/shipping and restart.",
          "If still OOM, roll back shipping: `kubectl rollout undo deployment/shipping`.",
          "Check checkout's shipping errors drop on the Demo dashboard; quote should be unaffected.",
        ],
      },
    },
    {
      key: "INC-2026-035",
      service: "product-catalog",
      neighbors: ["astronomy-db"],
      causedBy: 3577,
      severity: "SEV2",
      title: "product-catalog p99 latency 2.4s after SQLCommenter instrumentation",
      summary:
        "After {{pr:3577}} enabled otelsql SQLCommenter in product-catalog, ListProducts p99 rose from 40 ms to 2.4 s. The home page and recommendations slowed down for 70 minutes; checkout's product lookups timed out occasionally.",
      rootCause:
        "SQLCommenter appends the trace context to every query, so each statement text became unique. astronomy-db stopped reusing prepared plans and pg_stat_statements churned through entries; under load the catalog queries queued behind planning.",
      alert: { title: "product-catalog latency", metric: "rpc_server_duration_p99_ms{service=product-catalog}", value: "2400", message: "product-catalog ListProducts p99 2.4s (SLO 300ms)" },
      runbook: {
        slug: "rb-product-catalog-slow-queries",
        title: "product-catalog slow / astronomy-db saturated",
        steps: [
          "Look at astronomy-db: `SELECT calls, mean_exec_time, query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;` (connect as monitoring_user).",
          "Check `pg_stat_activity` for waiting queries and locks on the catalog schema; the productCatalogLockContention flag must be off.",
          "If query texts differ only by a trailing comment, disable SQLCommenter on deployment/product-catalog and restart it.",
          "Watch the PostgreSQL dashboard in Grafana until mean_exec_time is back to baseline.",
          "If astronomy-db stays saturated, restart product-catalog pods one by one to drop their connection pools.",
        ],
      },
    },
    {
      key: "INC-2026-036",
      service: "accounting",
      neighbors: ["kafka"],
      causedBy: 3608,
      severity: "SEV3",
      title: "accounting consumer lag 40k on orders after hosted-service change",
      summary:
        "After {{pr:3608}} ran the accounting consumer as a hosted service, the consumer stopped committing offsets on shutdown. Each deploy replayed the orders topic from the last commit; lag peaked at 40k messages and duplicate rows appeared in accounting.order until the dedupe from {{pr:3504}} caught up.",
      rootCause:
        "Offsets were committed only on a timer; the hosted service's StopAsync did not commit before disposing the consumer, so restarts re-delivered several minutes of orders.",
      alert: { title: "accounting consumer lag", metric: "kafka_consumergroup_lag{group=accounting}", value: "40213", message: "accounting lag on topic orders above 10k for 10m" },
      runbook: {
        slug: "rb-accounting-consumer-lag",
        title: "accounting consumer lag on orders",
        steps: [
          "Describe the group: `kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group accounting`.",
          "Make sure the kafkaQueueProblems and kafkaConsumerDead flags are off in flagd-ui.",
          "Restart accounting once (`kubectl rollout restart deployment/accounting`) and watch lag drain.",
          "Check astronomy-db for duplicates: `SELECT order_id, count(*) FROM accounting.\"order\" GROUP BY 1 HAVING count(*) > 1;`.",
        ],
      },
    },
    {
      key: "INC-2026-037",
      service: "checkout",
      neighbors: ["frontend"],
      causedBy: 3618,
      severity: "SEV2",
      title: "checkout OOM-killed after OTLP exporter migration to http/protobuf",
      summary:
        "{{pr:3618}} moved checkout's OTLP exporters from gRPC to http/protobuf. Under the Saturday load test checkout (20 MiB limit) was OOM-killed repeatedly and frontend showed PlaceOrder errors for 9% of orders over 50 minutes.",
      rootCause:
        "The http exporter keeps a larger retry queue and serialises batches into fresh buffers; with GOMEMLIMIT unset the Go runtime let the heap grow past the container's 20 MiB limit during export bursts.",
      alert: { title: "checkout 5xx", metric: "http_server_errors_ratio{service=checkout}", value: "0.09", message: "checkout PlaceOrder error ratio 9% over 5m" },
      runbook: {
        slug: "rb-checkout-oom",
        title: "checkout OOMKilled / PlaceOrder errors",
        steps: [
          "Check restarts: `kubectl get pods -l app.kubernetes.io/component=checkout`; `describe` shows OOMKilled.",
          "Roll back: `kubectl rollout undo deployment/checkout` and confirm PlaceOrder errors drop.",
          "Mitigate: set GOMEMLIMIT=16MiB and raise the memory limit to 40M for checkout in compose.yaml / Helm values.",
          "Check the downstream calls are healthy: cart, payment, shipping, currency, email and the kafka orders topic.",
          "Verify on the Demo dashboard that checkout's p99 and error rate are back to baseline.",
        ],
      },
    },
    {
      key: "INC-2026-038",
      service: "frontend",
      neighbors: ["image-provider"],
      causedBy: 3582,
      severity: "SEV3",
      title: "product images missing in the mobile app after image loader change",
      summary:
        "{{pr:3582}} made the frontend image loader always return a relative URL. Browsers were fine behind frontend-proxy, but react-native-app clients resolved the URLs against the wrong host and showed no product images for half a day.",
      rootCause:
        "The mobile app builds absolute image URLs from the API response; a relative `/images/...` path resolved against the app bundle origin instead of frontend-proxy.",
      alert: { title: "image 404s", metric: "envoy_http_downstream_rq_4xx{route=images}", value: "1830", message: "frontend-proxy /images 404s spiking" },
      runbook: {
        slug: "rb-frontend-images-missing",
        title: "product images missing",
        steps: [
          "Request an image through the proxy: `curl -I http://frontend-proxy:8080/images/products/<file>`; 200 means image-provider is fine.",
          "Check image-provider nginx status: `curl http://image-provider:8081/status`; the imageSlowLoad flag must be off.",
          "If only clients are affected, roll back frontend: `kubectl rollout undo deployment/frontend`.",
        ],
      },
    },
    {
      key: "INC-2026-040",
      service: "cart",
      causedBy: 3625,
      severity: "SEV3",
      title: "cart EmptyCart failures at 10% after cartFailure became a rate",
      summary:
        "{{pr:3625}} turned the cartFailure flag from an on/off toggle into a failure rate. The default variant in demo.flagd.json shipped as a 10% rate instead of 0, so EmptyCart failed for one in ten checkouts for three hours.",
      rootCause: "The new flag variant map had the 10% variant as defaultVariant; nobody noticed because the old boolean flag defaulted to off.",
      alert: { title: "cart errors", metric: "cart_grpc_server_errors_ratio", value: "0.10", message: "cart EmptyCart error ratio 10% for 15m" },
      runbook: {
        slug: "rb-cart-failure-flag",
        title: "cart errors caused by the cartFailure flag",
        steps: [
          "Open flagd-ui (/feature via frontend-proxy) and check cartFailure; set it to the `off` variant.",
          "Make the change permanent in src/flagd/demo.flagd.json (defaultVariant: off) and redeploy flagd.",
          "Confirm cart error rate falls to zero within a minute; valkey-cart needs no action.",
        ],
      },
    },
    {
      key: "INC-2026-042",
      service: "currency",
      causedBy: 3741,
      severity: "SEV2",
      title: "currency unreachable on IPv4-only clusters after IPV6_ENABLED fix",
      summary:
        "After {{pr:3741}} corrected the IPV6_ENABLED comparison, currency bound only to the IPv6 wildcard on an IPv4-only staging cluster. frontend and checkout could not convert prices for 35 minutes.",
      rootCause: "The fix flipped the default branch: with IPV6_ENABLED unset the server listened on [::] without dual-stack, which the IPv4-only CNI did not route.",
      alert: { title: "currency unavailable", metric: "grpc_client_errors{target=currency}", value: "1.00", message: "frontend → currency Convert UNAVAILABLE" },
      runbook: {
        slug: "rb-currency-unreachable",
        title: "currency unreachable",
        steps: [
          "Check what currency listens on: `kubectl exec deploy/currency -- ss -ltn`.",
          "Set IPV6_ENABLED=false explicitly on deployment/currency and restart.",
          "Verify frontend price rendering and checkout PlaceOrder recover.",
        ],
      },
    },
  ],

  decisions: [
    {
      key: "ADR-001",
      docSlug: "adr-001-cart-store-valkey",
      title: "Move the cart store from Redis to Valkey",
      status: "accepted",
      context:
        "The cart service keeps every shopping cart in a Redis container (redis-cart). In March 2024 Redis changed its licence from BSD to a dual source-available licence (RSALv2/SSPL). We only want to ship OSI-licensed components, and the Linux Foundation fork Valkey is wire-compatible with Redis 7.2.",
      decision:
        "Replace Redis with Valkey for the cart store. Rename the container to valkey-cart, rename RedisCartStore to ValkeyCartStore in cart, and keep the StackExchange.Redis client, which works unchanged against Valkey. Done in {{pr:1619}} by {{author:1619}}.",
      consequences:
        "No change to the cart's data model or client library. The collector's redis receiver keeps scraping valkey-cart. Operators must use valkey-cli instead of redis-cli. Carts are still not persisted: losing valkey-cart loses carts, which is acceptable for the shop (see the follow-up ticket on persistence).",
      justifies: [1619],
      about: ["cart", "valkey-cart"],
    },
    {
      key: "ADR-002",
      docSlug: "adr-002-catalog-in-postgresql",
      title: "Serve the product catalogue from PostgreSQL (astronomy-db)",
      status: "accepted",
      context:
        "product-catalog used to read products from a JSON file baked into the image. That made the catalogue impossible to change at runtime and gave us no realistic database telemetry or database failure modes to demonstrate.",
      decision:
        "Store products in the `catalog` schema of astronomy-db (PostgreSQL) and query them from product-catalog ({{pr:2859}}), with dedicated application and monitoring users ({{pr:3153}}). Instrument the queries with otelsql ({{pr:3577}}).",
      consequences:
        "product-catalog now depends on astronomy-db; a slow database slows the home page, recommendations and checkout. Query telemetry must not break plan reuse (see {{inc:INC-2026-035}}). Monitoring runs as monitoring_user with pg_monitor.",
      justifies: [2859, 3153, 3577],
      about: ["product-catalog", "astronomy-db"],
    },
    {
      key: "ADR-003",
      docSlug: "adr-003-k6-load-generation",
      title: "Replace Locust with k6 for load generation",
      status: "superseded",
      context: "The Locust-based load-generator needed gevent workarounds and a separate Playwright path for browser traffic. k6 offered one tool for protocol and browser load with good OpenTelemetry output.",
      decision: "Rewrite load-generator scenarios in k6 and route its UI through frontend-proxy ({{pr:3564}}).",
      consequences: "Superseded by {{adr:ADR-004}}: the switch was reverted six weeks later.",
      justifies: [3564],
      about: ["load-generator"],
    },
    {
      key: "ADR-004",
      docSlug: "adr-004-return-to-locust",
      title: "Go back to Locust for load generation (revert k6)",
      status: "accepted",
      context:
        "After {{adr:ADR-003}} moved load generation to k6, we lost features people relied on: the Locust web UI for changing users live during demos, the flood-homepage and browser-traffic scenarios wired to flagd, and the Python span attributes our dashboards query. Re-implementing them in k6 would take longer than fixing Locust.",
      decision:
        "Revert load-generator to Locust ({{pr:3873}}, {{author:3873}}) and fix the gevent/gRPC greenlet crash that was the main reason to leave ({{pr:4022}}). Keep the k6 scripts out of the tree.",
      consequences:
        "Demo operators keep the familiar Locust UI behind frontend-proxy. The loadGeneratorFloodHomepage flag works again. We still carry the gevent compatibility flag and must test Locust upgrades carefully.",
      justifies: [3873, 4022],
      about: ["load-generator"],
    },
    {
      key: "ADR-005",
      docSlug: "adr-005-orders-on-kafka",
      title: "Publish orders to Kafka and make every consumer idempotent",
      status: "accepted",
      context:
        "checkout publishes each placed order to the Kafka `orders` topic; accounting and fraud-detection consume it. Kafka gives at-least-once delivery, so restarts and rebalances redeliver messages.",
      decision:
        "Keep Kafka as the only channel from checkout to back-office consumers, configured through KAFKA_ADDR / KAFKA_TOPIC ({{pr:3219}}, {{pr:3665}}). Consumers must be idempotent: accounting deduplicates by order id ({{pr:3504}}).",
      consequences: "checkout's PlaceOrder does not wait for accounting. Consumer lag is the main health signal for orders-data (see {{inc:INC-2026-036}}).",
      justifies: [3219, 3504, 3665],
      about: ["kafka", "accounting", "fraud-detection", "checkout"],
    },
    {
      key: "ADR-006",
      docSlug: "adr-006-failures-via-flagd",
      title: "Inject demo failures through flagd feature flags, not code branches",
      status: "accepted",
      context: "The shop exists to demonstrate incidents. Failure modes used to be hard-coded or required redeploys.",
      decision:
        "Every failure scenario is a flagd flag in src/flagd/demo.flagd.json with a generated OpenFeature client ({{pr:3305}}): cart readiness ({{pr:2830}}), cart failure rate ({{pr:3625}}), product-catalog lock contention ({{pr:3931}}). Defaults are always off.",
      consequences: "Anyone can trigger or stop a scenario from flagd-ui. A wrong default ships an outage (see {{inc:INC-2026-040}}), so flag defaults get a second reviewer.",
      justifies: [2830, 3305, 3625, 3931],
      about: ["flagd", "cart", "product-catalog"],
    },
    {
      key: "ADR-007",
      docSlug: "adr-007-read-only-rootfs",
      title: "Run checkout, product-catalog and shipping with a read-only root filesystem",
      status: "accepted",
      context: "The Go and Rust services never need to write to their image filesystem; a writable root makes container escapes and accidental state easier.",
      decision: "Set read_only: true with a tmpfs for /tmp on checkout, product-catalog and shipping ({{pr:3658}}).",
      consequences: "Anything that writes outside /tmp now fails fast at startup; new services should adopt the same setting.",
      justifies: [3658],
      about: ["checkout", "product-catalog", "shipping"],
    },
    {
      key: "ADR-008",
      docSlug: "adr-008-otlp-http-protobuf",
      title: "Export OTLP over http/protobuf from checkout and shipping",
      status: "accepted",
      context: "gRPC exporters pulled a large dependency tree into small services and were harder to route through proxies.",
      decision: "Switch checkout ({{pr:3618}}) and shipping ({{pr:3619}}) to the http/protobuf OTLP exporter.",
      consequences: "Smaller binaries, but the http exporter's buffers need memory headroom; checkout's 20 MiB limit was too tight ({{inc:INC-2026-037}}). Set GOMEMLIMIT on Go services.",
      justifies: [3618, 3619],
      about: ["checkout", "shipping"],
    },
  ],

  issues: [
    {
      title: "valkey-cart has no persistence: carts are lost on restart",
      body: "Since {{adr:ADR-001}} moved the cart to Valkey ({{prn:1619}}) we still run valkey-cart without AOF or RDB. {{inc:INC-2026-031}} wiped every open cart. Decide whether to enable appendonly or accept the loss and document it.",
      status: "open", priority: "P3", about: ["valkey-cart", "cart"], when: { incident: "INC-2026-031", offsetHours: 30 },
    },
    {
      title: "checkout memory limit (20M) is too tight for the http exporter",
      body: "Action item from {{inc:INC-2026-037}}. {{pr:3618}} needs more headroom; set GOMEMLIMIT and raise the limit. See {{adr:ADR-008}}.",
      status: "done", priority: "P1", about: ["checkout"], when: { incident: "INC-2026-037", offsetHours: 20 }, resolvedAfterDays: 3,
    },
    {
      title: "Split repo-wide lockfile regenerations into per-service PRs",
      body: "{{pr:4059}} regenerated lock files for payment, email, frontend, recommendation and others in one PR. If one of those services breaks we cannot roll back just that service. {{author:4059}}, could the next regeneration be split per service?",
      status: "open", priority: "P3", about: ["payment", "email", "frontend"], when: { pr: 4059, offsetDays: 2 },
    },
    {
      title: "payment: make sure PII redaction never touches card fields",
      body: "{{pr:3869}} added the emitRawPii flag and layered redaction across checkout and payment. Add a test that the redaction processor only rewrites telemetry, never the charge request itself.",
      status: "in_progress", priority: "P2", about: ["payment", "checkout"], when: { pr: 3869, offsetDays: 4 },
    },
    {
      title: "astronomy-db: review monitoring_user grants for lock impact",
      body: "{{pr:4019}} granted schema access to monitoring_user. The collector's postgresql receiver now runs heavier catalog queries; check they cannot block product-catalog reads (remember {{inc:INC-2026-035}}).",
      status: "open", priority: "P2", about: ["astronomy-db", "product-catalog"], when: { pr: 4019, offsetDays: 3 },
    },
    {
      title: "Alert on accounting consumer lag per partition",
      body: "From {{inc:INC-2026-036}}: we only alert on total lag. Alert per partition and link the runbook. Consumers must stay idempotent ({{adr:ADR-005}}).",
      status: "done", priority: "P2", about: ["accounting", "kafka"], when: { incident: "INC-2026-036", offsetHours: 48 }, resolvedAfterDays: 6,
    },
    {
      title: "Port the browser-traffic scenario back after the k6 revert",
      body: "{{pr:3873}} brought Locust back ({{adr:ADR-004}}). The k6 browser journey from {{prn:3564}} has no Locust equivalent yet.",
      status: "done", priority: "P3", about: ["load-generator"], when: { pr: 3873, offsetDays: 2 }, resolvedAfterDays: 10,
    },
    {
      title: "Document every flagd flag's default and blast radius",
      body: "{{inc:INC-2026-040}} shipped a non-zero default for cartFailure ({{prn:3625}}). Per {{adr:ADR-006}}, list each flag, its default and which services it hurts.",
      status: "in_progress", priority: "P3", about: ["flagd", "cart"], when: { incident: "INC-2026-040", offsetHours: 40 },
    },
  ],

  threads: [
    // t-0001: answer for "why did we move cart to Valkey?"
    {
      channel: "#team-cart-catalog",
      title: "Why is the cart on Valkey and not Redis?",
      about: ["cart", "valkey-cart"],
      when: { daysAgo: 21 },
      lines: [
        ["{{person:diogo-pacheco}}", "New-ish question: why did we move the cart cache from Redis to Valkey? Was it performance?"],
        ["{{author:1619}}", "Not performance. Redis changed its licence in 2024 to a source-available one, and we only ship OSI-licensed components. Valkey is the Linux Foundation fork and speaks the same protocol, so {{pr:1619}} was basically an image swap plus renaming RedisCartStore to ValkeyCartStore."],
        ["{{expert:cart}}", "And the cart code didn't change: StackExchange.Redis talks to Valkey fine. It's written up in {{adr:ADR-001}}."],
        ["{{person:diogo-pacheco}}", "So the move to Valkey was about the licence. Is valkey-cart persisted?"],
        ["{{author:1619}}", "No, still in-memory only; there's a ticket about persistence after {{inc:INC-2026-031}}."],
      ],
    },
    // t-0002: answer for "why are we back on Locust?"
    {
      channel: "#team-platform",
      title: "k6 vs Locust: why did we revert the load generator?",
      about: ["load-generator"],
      when: { pr: 3873, offsetDays: -2 },
      lines: [
        ["{{author:3564}}", "Proposing to revert the load generator from k6 back to Locust. We lost the Locust web UI, the flood-homepage flag and the Python span attributes the dashboards use."],
        ["{{person:cijo-thomas}}", "Wasn't the whole reason for k6 the gevent greenlet crashes in Locust?"],
        ["{{person:diogo-pacheco}}", "I can fix that with a gRPC/gevent compatibility flag; that's cheaper than rebuilding every scenario in k6."],
        ["{{author:3564}}", "Then let's go back to Locust. Writing {{adr:ADR-004}} to supersede {{adr:ADR-003}}; the revert is {{prn:3873}}."],
      ],
    },
    {
      channel: "#team-cart-catalog",
      title: "Do we keep SQLCommenter on product-catalog?",
      about: ["product-catalog", "astronomy-db"],
      when: { incident: "INC-2026-035", offsetHours: 26 },
      lines: [
        ["{{author:3577}}", "Postmortem for {{inc:INC-2026-035}}: SQLCommenter made every query text unique. I'd like to keep the trace links, though."],
        ["{{expert:product-catalog}}", "Keep it off by default and only enable it when the flag is on. {{adr:ADR-002}} says telemetry must not break plan reuse."],
        ["{{person:diogo-pacheco}}", "Agreed. I'll add a PostgreSQL dashboard panel so we see plan churn before customers do."],
      ],
    },
    {
      channel: "#team-orders-data",
      title: "Exactly-once vs idempotent consumers for orders",
      about: ["kafka", "accounting", "fraud-detection"],
      when: { pr: 3504, offsetDays: -1 },
      lines: [
        ["{{author:3504}}", "We're seeing duplicate orders in accounting after Kafka redeliveries. Should we turn on transactions / exactly-once?"],
        ["{{person:cijo-thomas}}", "Exactly-once across Kafka and Postgres is a lot of machinery for a demo shop. Dedupe on order id is simpler."],
        ["{{author:3504}}", "OK: idempotent consumers it is. Writing it down in {{adr:ADR-005}}; fix is {{prn:3504}}."],
      ],
    },
    {
      channel: "#team-checkout",
      title: "Should checkout keep a 20M memory limit?",
      about: ["checkout"],
      when: { incident: "INC-2026-037", offsetHours: 6 },
      lines: [
        ["{{author:3618}}", "{{inc:INC-2026-037}} was my exporter change, {{prn:3618}}. The http exporter needs more buffer than 20M allows."],
        ["{{expert:checkout}}", "I'd rather set GOMEMLIMIT than double the limit; the small limit is part of the demo's story."],
        ["{{author:3618}}", "Both, then: GOMEMLIMIT=16MiB and 40M limit. Recording it under {{adr:ADR-008}}."],
      ],
    },
    {
      channel: "#engineering",
      title: "Who knows the flagd failure scenarios?",
      about: ["flagd", "flagd-ui"],
      when: { daysAgo: 12 },
      lines: [
        ["{{person:adii}}", "Who knows how the flagd failure scenarios are wired? I want to add one for payment."],
        ["{{expert:flagd}}", "Add the flag to src/flagd/demo.flagd.json, default off, and generate the OpenFeature client. See {{adr:ADR-006}}."],
        ["{{author:3931}}", "{{prn:3931}} is a good example: productCatalogLockContention touches flagd, product-catalog and astronomy-db."],
      ],
    },
  ],

  scenarios: [
    {
      id: "acme-checkout-5xx",
      mode: "incident",
      title: "Checkout 5xx at 12%",
      question: "checkout 5xx at 12% since 14:05",
      alert: { service: "checkout", metric: "http_server_errors_ratio", value: "0.12", message: "checkout PlaceOrder 5xx at 12% since 14:05" },
      suspectPr: 4059,
      pastIncident: "INC-2026-037",
      presenterNote:
        "Blast radius walks frontend → frontend-proxy → load-generator/mobile. The suspect is a real lockfile regeneration (#4059) that touched payment and email, both checkout dependencies. Recall pulls up INC-2026-037, the last time checkout fell over.",
    },
    {
      id: "acme-payment-failures",
      mode: "incident",
      title: "Payment charge failures",
      question: "payment Charge failing for 8% of orders since 09:40",
      alert: { service: "payment", metric: "payment_charge_errors_ratio", value: "0.08", message: "payment Charge error ratio 8% since 09:40" },
      suspectPr: 4059,
      pastIncident: "INC-2026-033",
      presenterNote:
        "The newest human change on payment is #4059, a repo-wide lockfile regeneration that rewrote src/payment/package-lock.json six days earlier: a classic dependency-drift suspect. #3869 (PII redaction in checkout and payment) is the runner-up. Recall brings INC-2026-033, the last payment outage, with its rollback runbook.",
    },
    {
      id: "acme-product-catalog-latency",
      mode: "incident",
      title: "Product catalog p99 latency",
      question: "product-catalog p99 latency at 1.8s, home page slow",
      alert: { service: "product-catalog", metric: "rpc_server_duration_p99_ms", value: "1800", message: "product-catalog ListProducts p99 1.8s (SLO 300ms)" },
      suspectPr: 4019,
      pastIncident: "INC-2026-035",
      presenterNote:
        "The suspect is on a dependency, not the service: #4019 changed astronomy-db grants. Blast radius is wide (checkout, frontend, recommendation, agent…). The decision trace from INC-2026-035 leads to ADR-002.",
    },
    {
      id: "acme-cart-errors",
      mode: "incident",
      title: "Cart errors (try add-prs after)",
      question: "cart GetCart errors at 6%, carts not loading",
      alert: { service: "cart", metric: "cart_grpc_server_errors_ratio", value: "0.06", message: "cart GetCart error ratio 6% over 10m" },
      suspectPr: 3988,
      pastIncident: "INC-2026-040",
      expert: "piotr-kielkowicz",
      presenterNote:
        "Recall surfaces INC-2026-040 (cartFailure flag shipped at 10%) and its flagd runbook. Before `add-prs`, the top suspect is #3988. Run `pnpm --filter @blastradius/ingest add-prs --tenant acme` and ask again: #4087 (a new cart-service demo flag in ValkeyCartStore) appears on top. That is incremental re-ingest.",
    },
    {
      id: "acme-ask-valkey",
      mode: "ask",
      title: "Why did we move cart to Valkey?",
      question: "Why did we move the cart cache from Redis to Valkey?",
      sources: ["Decision:ADR-001", "Doc:adr-001-cart-store-valkey", "Thread:t-0001"],
      presenterNote: "Answer cites ADR-001 (licence change), the real PR #1619 and the team thread.",
    },
    {
      id: "acme-ask-locust",
      mode: "ask",
      title: "Why are we back on Locust?",
      question: "Why did we go back to Locust instead of k6 for load generation?",
      sources: ["Decision:ADR-004", "Doc:adr-004-return-to-locust", "Thread:t-0002", "Decision:ADR-003"],
      presenterNote: "Decision tracing: ADR-003 (k6, superseded) → ADR-004 (back to Locust), real PRs #3564 and #3873.",
    },
  ],
};
