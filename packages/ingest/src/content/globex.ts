/**
 * globex (microservices-demo / Online Boutique): hand-written SYNTHETIC content.
 *
 * Fiction anchored to REAL history via {{placeholders}}. People in the
 * fiction are fictional personas (PERSONAS below); real git authors only
 * carry real facts (their PRs) and are never named in prose. Real facts we lean on:
 *   - #1109 really added Spanner as a cart backend, #1578 really added AlloyDB;
 *   - #1102 / #1837 really removed the grpc-health-probe binary in favour of
 *     native Kubernetes gRPC probes;
 *   - #2466 really added the Gemini ShoppingAssistant with AlloyDB;
 *   - #2512 really moved four Go services to `scratch` base images;
 *   - #2518 really commented out Cloud Profiler in adservice.
 * Reasons, quotes, timelines and impact numbers are invented.
 * k8s deployment names (cartservice, adservice…) are the repo's real ones.
 */
import type { TenantContent } from "../synth/types.ts";

export const GLOBEX_CONTENT: TenantContent = {
  issuePrefix: "GLOBEX",
  templatedIssues: 16,
  templatedThreads: 9,

  personas: [
    { slug: "lena-fischer", name: "Lena Fischer", role: "SRE", team: "storefront" },
    { slug: "mateo-ruiz", name: "Mateo Ruiz", role: "Frontend engineer", team: "storefront" },
    { slug: "ines-duarte", name: "Ines Duarte", role: "Product manager", team: "storefront" },
    { slug: "kofi-osei", name: "Kofi Osei", role: "SRE", team: "checkout" },
    { slug: "yuki-tanabe", name: "Yuki Tanabe", role: "Backend engineer", team: "checkout" },
    { slug: "clara-novak", name: "Clara Novak", role: "Engineering manager", team: "checkout" },
    { slug: "arjun-mehta", name: "Arjun Mehta", role: "SRE", team: "cart-catalog" },
    { slug: "freya-lund", name: "Freya Lund", role: "Backend engineer", team: "cart-catalog" },
    { slug: "zara-haddad", name: "Zara Haddad", role: "Platform engineer", team: "cart-catalog" },
    { slug: "noah-petrov", name: "Noah Petrov", role: "Support lead", team: "storefront" },
  ],

  teams: [
    { slug: "storefront", name: "Storefront", slack: "#gx-storefront", anchors: ["frontend", "ad", "shopping-assistant", "alloydb", "load-generator"] },
    { slug: "checkout", name: "Checkout", slack: "#gx-checkout", anchors: ["checkout", "payment", "currency", "email", "shipping"] },
    { slug: "cart-catalog", name: "Cart & Catalog", slack: "#gx-cart-catalog", anchors: ["cart", "redis-cart", "product-catalog", "recommendation"] },
  ],

  incidents: [
    {
      key: "INC-2023-004",
      service: "cart",
      neighbors: ["redis-cart"],
      causedBy: 1578,
      severity: "SEV2",
      title: "cartservice ignored redis-cart after AlloyDB backend option",
      summary:
        "{{pr:1578}} added AlloyDB as a cart backend. On clusters where the ALLOYDB_PRIMARY_IP variable was left empty in a shared ConfigMap, cartservice tried the AlloyDB code path instead of redis-cart and failed AddItem/GetCart for 40 minutes.",
      rootCause: "Backend selection checked for the presence of the AlloyDB variable rather than a non-empty value, so an empty string selected AlloyDB.",
      alert: { title: "cartservice errors", metric: "grpc_server_errors_ratio{service=cartservice}", value: "0.62", message: "cartservice GetCart error ratio 62% for 5m" },
      runbook: {
        slug: "rb-cartservice-backend",
        title: "cartservice using the wrong storage backend",
        steps: [
          "Check which store cartservice picked: `kubectl logs deploy/cartservice | grep -i -E 'redis|spanner|alloydb'`.",
          "Confirm redis-cart is up: `kubectl exec deploy/redis-cart -- redis-cli ping`.",
          "Remove empty ALLOYDB_* / SPANNER_* variables from the cartservice deployment so REDIS_ADDR=redis-cart:6379 wins.",
          "`kubectl rollout restart deployment/cartservice` and watch GetCart errors drop.",
        ],
      },
    },
    {
      key: "INC-2023-007",
      service: "email",
      neighbors: ["checkout"],
      causedBy: 1803,
      severity: "SEV3",
      title: "emailservice crash-loop after OpenTelemetry 1.18 bump",
      summary: "After {{pr:1803}}, emailservice failed on import and crash-looped. checkout's order confirmation calls failed (orders still placed) for 55 minutes.",
      rootCause: "The new opentelemetry-instrumentation-grpc pin required a newer grpcio than requirements.txt allowed; pip resolved an incompatible pair at image build time.",
      alert: { title: "emailservice restarts", metric: "kube_pod_container_status_restarts_total{container=server,pod=~emailservice.*}", value: "9", message: "emailservice CrashLoopBackOff" },
      runbook: {
        slug: "rb-emailservice-crashloop",
        title: "emailservice crash-loop",
        steps: [
          "`kubectl logs deploy/emailservice --previous` and look for ImportError.",
          "Roll back: `kubectl rollout undo deployment/emailservice`.",
          "Re-run pip-compile for src/emailservice/requirements.in and rebuild before re-rolling.",
          "checkout keeps placing orders while email is down; confirm PlaceOrder success stays normal.",
        ],
      },
    },
    {
      key: "INC-2023-008",
      service: "ad",
      neighbors: ["frontend"],
      causedBy: 1837,
      severity: "SEV3",
      title: "adservice never became ready after switching to native gRPC probes",
      summary:
        "{{pr:1837}} replaced the grpc-health-probe binary with native Kubernetes gRPC probes. adservice's JVM took longer to start than the probe's initial delay, so pods were killed before becoming ready and the storefront showed no ads for an hour.",
      rootCause: "The native readinessProbe/livenessProbe on port 9555 kept the old 15s initial delay; the Java service needs ~40s on small nodes, so the liveness probe restarted it in a loop.",
      alert: { title: "adservice unavailable", metric: "kube_deployment_status_replicas_available{deployment=adservice}", value: "0", message: "adservice has 0 available replicas" },
      runbook: {
        slug: "rb-adservice-not-ready",
        title: "adservice not ready / restarting",
        steps: [
          "`kubectl describe pod -l app=adservice`: look for `Liveness probe failed` on grpc port 9555.",
          "Raise initialDelaySeconds / add a startupProbe for adservice in kubernetes-manifests/adservice.yaml and apply.",
          "Check JVM memory: the container limit is 300Mi; OOM looks similar.",
          "frontend tolerates missing ads; verify product pages still render while fixing.",
        ],
      },
    },
    {
      key: "INC-2023-010",
      service: "checkout",
      neighbors: ["payment"],
      causedBy: 1945,
      severity: "SEV2",
      title: "checkout → payment DEADLINE_EXCEEDED after grpc-go bump",
      summary: "After {{pr:1945}} bumped google.golang.org/grpc in the Go services, checkout's calls to paymentservice timed out for 6% of orders over 45 minutes.",
      rootCause: "The new grpc-go version enforced keepalive pings more strictly; checkout's client keepalive was more aggressive than the Node payment server allowed, so connections were closed with GOAWAY under load.",
      alert: { title: "checkout errors", metric: "grpc_server_errors_ratio{service=checkoutservice}", value: "0.06", message: "checkoutservice PlaceOrder errors 6%" },
      runbook: {
        slug: "rb-checkout-payment-timeouts",
        title: "checkout → payment timeouts",
        steps: [
          "Check checkoutservice logs for `DEADLINE_EXCEEDED` or `GOAWAY` from paymentservice:50051.",
          "Roll back checkoutservice: `kubectl rollout undo deployment/checkoutservice`.",
          "Align keepalive settings between the Go client and the Node server before redeploying.",
        ],
      },
    },
    {
      key: "INC-2023-012",
      service: "product-catalog",
      neighbors: ["frontend"],
      causedBy: 2013,
      severity: "SEV2",
      title: "productcatalogservice returned an empty catalogue after protobuf API cleanup",
      summary:
        "{{pr:2013}} replaced deprecated protobuf/JSON methods in productcatalogservice. A parsing difference made products.json load as an empty list on one replica set; the home page showed no products and recommendations failed for 35 minutes.",
      rootCause: "The new unmarshalling rejected an unknown field in products.json and the error path returned an empty catalogue instead of failing the readiness probe.",
      alert: { title: "empty catalogue", metric: "productcatalog_products_loaded", value: "0", message: "productcatalogservice ListProducts returning 0 items" },
      runbook: {
        slug: "rb-productcatalog-empty",
        title: "productcatalogservice returns no products",
        steps: [
          "`kubectl logs deploy/productcatalogservice | grep -i catalog` for parse errors.",
          "Roll back: `kubectl rollout undo deployment/productcatalogservice`.",
          "Validate src/productcatalogservice/products.json with the new parser locally before re-rolling.",
          "Check frontend and recommendationservice recover (both call productcatalogservice:3550).",
        ],
      },
    },
    {
      key: "INC-2023-014",
      service: "cart",
      neighbors: ["redis-cart"],
      causedBy: 2102,
      severity: "SEV1",
      title: "cartservice stopped listening on 7070 after .NET 8 upgrade",
      summary: "After {{pr:2102}} moved cartservice to .NET 8, new pods listened on port 8080. frontend and checkout could not reach cartservice:7070; the shop was unusable for 25 minutes until rollback.",
      rootCause: ".NET 8 container images set ASPNETCORE_HTTP_PORTS=8080 by default, which overrode the Kestrel port the service used to bind.",
      alert: { title: "cartservice unreachable", metric: "grpc_client_errors{target=cartservice}", value: "1.00", message: "frontend → cartservice UNAVAILABLE" },
      runbook: {
        slug: "rb-cartservice-port",
        title: "cartservice unreachable after runtime upgrade",
        steps: [
          "`kubectl logs deploy/cartservice | grep 'Now listening'` to see the bound port.",
          "Set ASPNETCORE_HTTP_PORTS=7070 (or the PORT env) on deployment/cartservice and restart.",
          "Verify with `grpc_health_probe -addr=cartservice:7070` from a debug pod, then check redis-cart connectivity.",
        ],
      },
    },
    {
      key: "INC-2023-017",
      service: "currency",
      neighbors: ["frontend"],
      causedBy: 2263,
      severity: "SEV3",
      title: "currencyservice p99 latency up 4x after switching to pino",
      summary: "{{pr:2263}} replaced console.log with pino in currency and payment. currencyservice, the highest-QPS service, logged every conversion synchronously and p99 rose from 8 ms to 35 ms; storefront pages slowed.",
      rootCause: "pino was configured with a synchronous destination and info-level logging of each request.",
      alert: { title: "currency latency", metric: "grpc_server_duration_p99_ms{service=currencyservice}", value: "35", message: "currencyservice Convert p99 35ms (SLO 15ms)" },
      runbook: {
        slug: "rb-currency-latency",
        title: "currencyservice latency",
        steps: [
          "Check log volume: `kubectl logs deploy/currencyservice --since=1m | wc -l`.",
          "Set the log level to warn on deployment/currencyservice and restart.",
          "If latency stays high, roll back: `kubectl rollout undo deployment/currencyservice`.",
        ],
      },
    },
    {
      key: "INC-2024-003",
      service: "frontend",
      neighbors: ["checkout"],
      causedBy: 2438,
      severity: "SEV2",
      title: "frontend rejected valid checkout forms after input validation",
      summary: "{{pr:2438}} added server-side validation for form values in frontend. Postal codes with letters and some country names failed validation, and 18% of checkout attempts got HTTP 422 for two hours.",
      rootCause: "The zip code rule only accepted digits; the loadgenerator only sent US-style codes, so tests passed.",
      alert: { title: "frontend 4xx on /cart/checkout", metric: "http_requests_4xx_ratio{path=/cart/checkout}", value: "0.18", message: "frontend /cart/checkout 4xx ratio 18%" },
      runbook: {
        slug: "rb-frontend-validation",
        title: "frontend rejects valid requests",
        steps: [
          "Grep frontend logs for validation errors: `kubectl logs deploy/frontend | grep -i validat`.",
          "Roll back: `kubectl rollout undo deployment/frontend`.",
          "Fix the rule in src/frontend/validator/validator.go and add the failing input to validator_test.go.",
        ],
      },
    },
    {
      key: "INC-2024-005",
      service: "shopping-assistant",
      neighbors: ["alloydb"],
      causedBy: 2466,
      severity: "SEV3",
      title: "shopping assistant timeouts: AlloyDB connection pool exhausted",
      summary: "A week after {{pr:2466}} launched the ShoppingAssistant, a traffic spike exhausted its AlloyDB connection pool. /assistant requests from the frontend returned 504 for 50 minutes.",
      rootCause: "Each request created a new AlloyDBEngine connection for the vector store instead of reusing a pooled engine; idle connections were not released fast enough.",
      alert: { title: "assistant 5xx", metric: "http_server_errors_ratio{service=shoppingassistantservice}", value: "0.41", message: "shoppingassistantservice 5xx 41%" },
      runbook: {
        slug: "rb-shopping-assistant-alloydb",
        title: "shopping assistant timeouts / AlloyDB",
        steps: [
          "Check AlloyDB connections in the Cloud console (instance from ALLOYDB_INSTANCE_NAME).",
          "`kubectl rollout restart deployment/shoppingassistantservice` to drop leaked connections.",
          "Verify GOOGLE_API_KEY quota is not the real cause (Gemini 429s look similar).",
          "The frontend hides the assistant on errors; confirm the rest of the shop is unaffected.",
        ],
      },
    },
  ],

  decisions: [
    {
      key: "ADR-001",
      docSlug: "adr-001-cart-storage-backends",
      title: "Keep Redis as the default cart store; Spanner and AlloyDB as opt-in backends",
      status: "accepted",
      context:
        "cartservice stores carts in an in-cluster Redis (redis-cart). Platform teams demoing Online Boutique on Google Cloud asked to show managed databases, but the default install must stay self-contained and free.",
      decision:
        "Redis stays the default cart store. Spanner ({{pr:1109}}) and AlloyDB ({{pr:1578}}) are optional backends selected by environment variables and shipped as Kustomize components, not in the default manifests.",
      consequences:
        "cartservice carries three store implementations and must pick exactly one at startup (see {{inc:INC-2023-004}}). The default install needs no cloud account. Each backend needs its own docs and tests.",
      justifies: [1109, 1578],
      about: ["cart", "redis-cart"],
      decidedBy: ["freya-lund", "arjun-mehta"],
    },
    {
      key: "ADR-002",
      docSlug: "adr-002-native-grpc-probes",
      title: "Use native Kubernetes gRPC probes instead of the grpc-health-probe binary",
      status: "accepted",
      context: "Every gRPC service image bundled the grpc-health-probe binary just for liveness and readiness checks, which added CVE noise and image size. Kubernetes 1.24+ supports gRPC probes natively.",
      decision: "Offer a Kustomize variation without the binary ({{pr:1102}}), then remove it everywhere ({{pr:1837}}) and from the Helm chart ({{pr:1840}}).",
      consequences: "Smaller images, fewer CVEs; requires Kubernetes 1.24+. Probe timings must be tuned per service: the JVM adservice needs a longer start ({{inc:INC-2023-008}}).",
      justifies: [1102, 1837, 1840],
      about: ["ad", "cart", "checkout", "product-catalog"],
      decidedBy: ["zara-haddad", "kofi-osei"],
    },
    {
      key: "ADR-003",
      docSlug: "adr-003-minimal-base-images",
      title: "Ship minimal container base images (digest-pinned, scratch for Go)",
      status: "accepted",
      context: "Base images were pulled by tag and carried shells and package managers we never use, so vulnerability scanners flagged every release.",
      decision: "Pin base images by digest ({{pr:1312}}) and build the Go services checkout, frontend, productcatalog and shipping FROM scratch ({{pr:2512}}).",
      consequences: "Much smaller attack surface; no shell for debugging (use ephemeral debug containers). Anything the binary needs at runtime (CA certificates, timezone data) must be copied in explicitly.",
      justifies: [1312, 2512],
      about: ["checkout", "frontend", "product-catalog", "shipping"],
      decidedBy: ["zara-haddad", "clara-novak"],
    },
    {
      key: "ADR-004",
      docSlug: "adr-004-shopping-assistant-alloydb",
      title: "Add a Gemini shopping assistant backed by an AlloyDB vector store",
      status: "accepted",
      context: "We wanted a generative-AI feature in the demo that recommends products from a photo of a room, using retrieval over the real catalogue.",
      decision:
        "Build shoppingassistantservice in Python with LangChain: Gemini for generation, AlloyDB for PostgreSQL with pgvector for product embeddings ({{pr:2466}}). It is an optional Kustomize component; dependencies are refreshed regularly ({{pr:2490}}).",
      consequences: "The assistant needs a Google API key and an AlloyDB instance, so it is off by default. Connection pooling to AlloyDB matters ({{inc:INC-2024-005}}).",
      justifies: [2466, 2490],
      about: ["shopping-assistant", "alloydb", "frontend"],
      decidedBy: ["mateo-ruiz", "ines-duarte"],
    },
    {
      key: "ADR-005",
      docSlug: "adr-005-opentelemetry-collector",
      title: "Route traces and metrics through an OpenTelemetry Collector",
      status: "accepted",
      context: "Services exported directly to Cloud Trace with vendor libraries, so tracing only worked on Google Cloud.",
      decision: "Add an OpenTelemetry Collector ({{pr:1167}}) and instrument the services with OpenTelemetry for distributed tracing ({{pr:1180}}).",
      consequences: "Vendor-neutral telemetry; one more component to run. Services must propagate trace context on every call.",
      justifies: [1167, 1180],
      about: ["frontend", "checkout"],
      decidedBy: ["kofi-osei", "lena-fischer"],
    },
    {
      key: "ADR-006",
      docSlug: "adr-006-adservice-profiler-off",
      title: "Turn off Cloud Profiler in adservice by default",
      status: "accepted",
      context: "The Cloud Profiler agent in adservice failed outside Google Cloud and added startup time to an already slow JVM service.",
      decision: "Comment out the profiler agent in the adservice image ({{pr:2518}}); re-enable it per environment when needed.",
      consequences: "Faster, more portable adservice startup; no continuous profiling by default.",
      justifies: [2518],
      about: ["ad"],
      decidedBy: ["lena-fischer"],
    },
    {
      key: "ADR-007",
      docSlug: "adr-007-cartservice-dotnet-8",
      title: "Move cartservice to .NET 8",
      status: "accepted",
      context: ".NET 7 support ended in May 2024; .NET 8 is the long-term support release.",
      decision: "Upgrade cartservice to .NET 8 previews ({{pr:2102}}) and to the GA release ({{pr:2264}}).",
      consequences: "LTS runtime; container defaults changed (the default HTTP port is now 8080, see {{inc:INC-2023-014}}).",
      justifies: [2102, 2264],
      about: ["cart"],
      decidedBy: ["freya-lund"],
    },
  ],

  issues: [
    {
      title: "Spanner/AlloyDB cart backends: add a startup log line with the chosen store",
      body: "After {{inc:INC-2023-004}} it took 20 minutes to see that cartservice had picked AlloyDB. Log the selected backend at startup. Context: {{adr:ADR-001}}.",
      status: "done", priority: "P2", about: ["cart"], when: { incident: "INC-2023-004", offsetHours: 30 }, resolvedAfterDays: 4,
    },
    {
      title: "adservice: add a startupProbe for the JVM",
      body: "Follow-up from {{inc:INC-2023-008}} and {{adr:ADR-002}}: native probes need a startupProbe for adservice.",
      status: "done", priority: "P2", about: ["ad"], when: { incident: "INC-2023-008", offsetHours: 20 }, resolvedAfterDays: 2,
    },
    {
      title: "scratch images: check CA certificates and tzdata are copied in",
      body: "{{pr:2512}} moved checkout, frontend, productcatalog and shipping to scratch ({{adr:ADR-003}}). Verify outbound TLS and time zones still work in all four.",
      status: "open", priority: "P2", about: ["checkout", "frontend", "product-catalog", "shipping"], when: { pr: 2512, offsetDays: 3 },
    },
    {
      title: "adservice: confirm nothing depended on the profiler",
      body: "{{pr:2518}} turned the profiler off ({{adr:ADR-006}}). Check dashboards and the Helm chart for leftover profiler settings.",
      status: "open", priority: "P3", about: ["ad"], when: { pr: 2518, offsetDays: 2 },
    },
    {
      title: "Shopping assistant: reuse one AlloyDB engine per process",
      body: "Root cause of {{inc:INC-2024-005}}: a new engine per request. See {{adr:ADR-004}}.",
      status: "in_progress", priority: "P1", about: ["shopping-assistant", "alloydb"], when: { incident: "INC-2024-005", offsetHours: 24 },
    },
    {
      title: "Shopping assistant: pin LangChain and Gemini SDK versions",
      body: "{{pr:2490}} bumped the assistant's dependencies. Pin exact versions and add a smoke test that calls the vector store.",
      status: "open", priority: "P3", about: ["shopping-assistant"], when: { pr: 2490, offsetDays: 1 },
    },
    {
      title: "Set ASPNETCORE_HTTP_PORTS explicitly in cartservice manifests",
      body: "From {{inc:INC-2023-014}} ({{adr:ADR-007}}): never rely on the image's default port.",
      status: "done", priority: "P1", about: ["cart"], when: { incident: "INC-2023-014", offsetHours: 6 }, resolvedAfterDays: 1,
    },
    {
      title: "frontend validation: test non-US addresses",
      body: "{{inc:INC-2024-003}} rejected valid postal codes. Extend the loadgenerator and validator tests with international addresses ({{prn:2438}}).",
      status: "done", priority: "P2", about: ["frontend", "load-generator"], when: { incident: "INC-2024-003", offsetHours: 28 }, resolvedAfterDays: 5,
    },
  ],

  threads: [
    // t-0001: answer for "why does cart support Spanner and AlloyDB?"
    {
      channel: "#gx-cart-catalog",
      title: "Why does cartservice support Spanner and AlloyDB if Redis is the default?",
      about: ["cart", "redis-cart"],
      when: { daysAgo: 30 },
      lines: [
        ["{{persona:zara-haddad}}", "Why does cartservice have Spanner and AlloyDB stores at all? Redis is the default and that's what everyone runs."],
        ["{{persona:freya-lund}}", "Because people demo Online Boutique on Google Cloud and want to show managed databases. Spanner came in {{pr:1109}}, AlloyDB in {{pr:1578}}."],
        ["{{persona:arjun-mehta}}", "But the default install must stay self-contained, so Redis (redis-cart) stays the default and the other stores are opt-in Kustomize components. It's {{adr:ADR-001}}."],
        ["{{persona:zara-haddad}}", "Got it: Spanner and AlloyDB are optional cart backends; Redis is the default cart store."],
      ],
    },
    // t-0002: answer for "who knows the shopping assistant / why AlloyDB?"
    {
      channel: "#gx-storefront",
      title: "Who knows the shopping assistant, and why does it need AlloyDB?",
      about: ["shopping-assistant", "alloydb"],
      when: { pr: 2490, offsetDays: 2 },
      lines: [
        ["{{persona:ines-duarte}}", "Who knows the shopping assistant? And why does it need AlloyDB instead of the products.json the catalog uses?"],
        ["{{persona:mateo-ruiz}}", "I own it on our side. It does retrieval: since {{pr:2466}}, product descriptions are embedded and stored in AlloyDB with pgvector, then Gemini answers using the closest products. For the code history, ask who_knows about shopping-assistant."],
        ["{{persona:lena-fischer}}", "products.json has no vector search, so the assistant needs a vector store; AlloyDB was the managed option. Written up in {{adr:ADR-004}}."],
        ["{{persona:ines-duarte}}", "Thanks. So the assistant needs AlloyDB for vector search and is off by default."],
      ],
    },
    {
      channel: "#gx-checkout",
      title: "scratch base images: how do we debug now?",
      about: ["checkout", "shipping"],
      when: { pr: 2512, offsetDays: 1 },
      lines: [
        ["{{persona:yuki-tanabe}}", "With {{prn:2512}} there's no shell in checkoutservice any more. How do we debug in prod?"],
        ["{{persona:kofi-osei}}", "kubectl debug with an ephemeral container. The smaller attack surface is worth it; see {{adr:ADR-003}}."],
        ["{{persona:yuki-tanabe}}", "OK, but let's double-check CA certificates are copied in, or outbound TLS breaks."],
      ],
    },
    {
      channel: "#gx-storefront",
      title: "Native gRPC probes and the slow JVM",
      about: ["ad"],
      when: { incident: "INC-2023-008", offsetHours: 4 },
      lines: [
        ["{{persona:lena-fischer}}", "{{inc:INC-2023-008}} started with the probe change in {{prn:1837}}. adservice needs ~40s before it answers health checks."],
        ["{{persona:mateo-ruiz}}", "Add a startupProbe rather than a huge initialDelaySeconds. {{adr:ADR-002}} still holds."],
      ],
    },
    {
      channel: "#support",
      title: "Shoppers can't add items to the cart",
      about: ["cart"],
      when: { incident: "INC-2023-014", offsetHours: 0 },
      lines: [
        ["{{persona:noah-petrov}}", "Lots of reports that Add to cart does nothing. Is cart down?"],
        ["{{persona:arjun-mehta}}", "Yes, {{inc:INC-2023-014}}: after the .NET 8 move in {{prn:2102}} cartservice listens on the wrong port. Rolling back now."],
        ["{{persona:clara-novak}}", "I'll keep stakeholders posted; next update in 15 minutes."],
      ],
    },
  ],

  scenarios: [
    {
      id: "globex-ad-errors",
      mode: "incident",
      title: "adservice errors",
      question: "adservice GetAds error rate 15% since 10:20, no ads on product pages",
      alert: { service: "ad", metric: "grpc_server_errors_ratio", value: "0.15", message: "adservice GetAds errors 15% since 10:20" },
      suspectPr: 2518,
      pastIncident: "INC-2023-008",
      presenterNote: "Suspect #2518 changed the adservice image (profiler off) eight days earlier. Recall brings INC-2023-008 and its startupProbe runbook. Decision trace: ADR-006.",
    },
    {
      id: "globex-catalog-errors",
      mode: "incident",
      title: "Product catalog failures",
      question: "productcatalogservice ListProducts failing at 9%, home page partially empty",
      alert: { service: "product-catalog", metric: "grpc_server_errors_ratio", value: "0.09", message: "productcatalogservice ListProducts errors 9%" },
      suspectPr: 2512,
      pastIncident: "INC-2023-012",
      expert: "olivier-bourgeois", // who_knows #1: ties mathieu-benoit on PRs, wins on co-authorship PageRank
      presenterNote: "#2512 moved productcatalog to a scratch base image 11 days earlier; blast radius covers checkout, frontend and recommendation. ADR-003 explains why.",
    },
    {
      id: "globex-assistant-timeouts",
      mode: "incident",
      title: "Shopping assistant timeouts",
      question: "shopping assistant returning 504s for 30% of requests",
      alert: { service: "shopping-assistant", metric: "http_server_errors_ratio", value: "0.30", message: "shoppingassistantservice 504s at 30%" },
      suspectPr: 2490,
      pastIncident: "INC-2024-005",
      presenterNote: "A dependency bump (#2490) three weeks after launch; INC-2024-005 is the same service's AlloyDB pool exhaustion.",
    },
    {
      id: "globex-ask-cart-backends",
      mode: "ask",
      title: "Why Spanner and AlloyDB for cart?",
      question: "Why does cartservice support Spanner and AlloyDB if Redis is the default?",
      sources: ["Decision:ADR-001", "Doc:adr-001-cart-storage-backends", "Thread:t-0001"],
      presenterNote: "ADR-001 grounded in real PRs #1109 (Spanner) and #1578 (AlloyDB).",
    },
    {
      id: "globex-ask-assistant",
      mode: "ask",
      title: "Shopping assistant and AlloyDB",
      question: "Who knows the shopping assistant and why does it need AlloyDB?",
      sources: ["Decision:ADR-004", "Doc:adr-004-shopping-assistant-alloydb", "Thread:t-0002"],
      presenterNote: "ADR-004 plus the thread; who_knows points at the author of #2466.",
    },
  ],
};
