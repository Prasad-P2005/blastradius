/**
 * slice: a small pizza-delivery company, written by hand. FULLY SYNTHETIC.
 *
 * acme and globex are built from real git history, which is realistic but
 * needs a microservices background to follow. Slice is the "easy example" for
 * the demo: eleven services anyone understands (the app, the menu, orders,
 * payments, the kitchen screen, drivers), six engineers, and a story per
 * incident that fits in one sentence.
 *
 * Every node carries `synthetic: true`. People, PRs, URLs (`slice.example`,
 * a reserved domain) and prose are invented; nothing here is a real person.
 *
 * The data is designed so each demo scenario has ONE clear answer:
 *   - suspect: the newest human PR on the alerting service or its dependencies
 *     (suspect_changes sorts newest first), so the three suspects are the three
 *     newest PRs on those chains, and older history sits > 30 days back
 *   - expert: the engineer with by far the most PRs on that service
 *   - past incident: one earlier incident AFFECTED that same service
 */
import { createHash } from "node:crypto";
import { uid, type Json, type Scenario, type Snapshot, type SnapshotEdge, type SnapshotNode } from "@blastradius/shared";
import { DAY, isoDate, mondaysBetween } from "../time.ts";

const TENANT = "slice" as const;
const ms = (iso: string) => Date.parse(iso);

/* ── Services ─────────────────────────────────────────────────────────────
 * tier 1 = customers notice at once; 3 = nice to have. */
interface ServiceDef {
  slug: string;
  name: string;
  language: string;
  kind: "frontend" | "proxy" | "service" | "datastore" | "queue";
  tier: 1 | 2 | 3;
  repoPath: string;
  description: string;
  files: string[];
}

const SERVICES: ServiceDef[] = [
  { slug: "mobile-app", name: "mobile-app", language: "typescript", kind: "frontend", tier: 1, repoPath: "apps/mobile",
    description: "The customer app for iOS and Android: browse the menu, order, pay and watch the driver on a map.",
    files: ["apps/mobile/src/screens/Menu.tsx", "apps/mobile/src/screens/Checkout.tsx", "apps/mobile/src/screens/TrackOrder.tsx", "apps/mobile/package.json"] },
  { slug: "website", name: "website", language: "typescript", kind: "frontend", tier: 1, repoPath: "apps/web",
    description: "The ordering website. Same features as the app, in the browser.",
    files: ["apps/web/src/pages/menu.tsx", "apps/web/src/pages/checkout.tsx", "apps/web/package.json"] },
  { slug: "api-gateway", name: "api-gateway", language: "go", kind: "proxy", tier: 1, repoPath: "services/api-gateway",
    description: "The single front door for the app and the website: checks the login and routes each request to the right service.",
    files: ["services/api-gateway/routes.go", "services/api-gateway/auth.go", "services/api-gateway/config.yaml"] },
  { slug: "menu", name: "menu", language: "python", kind: "service", tier: 1, repoPath: "services/menu",
    description: "Pizzas, sizes, toppings and prices, plus what each store has in stock today.",
    files: ["services/menu/app.py", "services/menu/pricing.py", "services/menu/toppings.py", "services/menu/cache.py"] },
  { slug: "orders", name: "orders", language: "go", kind: "service", tier: 1, repoPath: "services/orders",
    description: "Takes the order: checks the cart against the menu, asks payments to charge the card, saves the order and puts it on the order queue.",
    files: ["services/orders/place_order.go", "services/orders/cart.go", "services/orders/publish.go", "services/orders/db.go"] },
  { slug: "payments", name: "payments", language: "java", kind: "service", tier: 1, repoPath: "services/payments",
    description: "Charges cards through the card processor and issues refunds for cancelled orders.",
    files: ["services/payments/src/main/java/slice/payments/ChargeService.java", "services/payments/src/main/java/slice/payments/ProcessorClient.java", "services/payments/src/main/java/slice/payments/Refunds.java", "services/payments/pom.xml"] },
  { slug: "kitchen", name: "kitchen", language: "typescript", kind: "service", tier: 2, repoPath: "services/kitchen",
    description: "The screen in each store's kitchen: shows new orders and lets the cook mark a pizza as ready.",
    files: ["services/kitchen/src/screen.ts", "services/kitchen/src/consumer.ts", "services/kitchen/package.json"] },
  { slug: "delivery", name: "delivery", language: "go", kind: "service", tier: 2, repoPath: "services/delivery",
    description: "Assigns the nearest free driver and shares the driver's live location with the customer.",
    files: ["services/delivery/assign.go", "services/delivery/location.go", "services/delivery/consumer.go"] },
  { slug: "notifications", name: "notifications", language: "python", kind: "service", tier: 3, repoPath: "services/notifications",
    description: "Sends the texts and push messages: 'order received', 'in the oven', 'out for delivery'.",
    files: ["services/notifications/sender.py", "services/notifications/templates.py", "services/notifications/consumer.py"] },
  { slug: "order-queue", name: "order-queue", language: "yaml", kind: "queue", tier: 2, repoPath: "",
    description: "Kafka topic every new order is published to. The kitchen, delivery and notifications each read from it.",
    files: [] },
  { slug: "orders-db", name: "orders-db", language: "sql", kind: "datastore", tier: 1, repoPath: "",
    description: "PostgreSQL database holding every order and its status.",
    files: [] },
];

/** caller → callee. `source` says where a real team would read this from. */
const DEPENDS_ON: [from: string, to: string, protocol: string][] = [
  ["mobile-app", "api-gateway", "http"],
  ["website", "api-gateway", "http"],
  ["api-gateway", "menu", "http"],
  ["api-gateway", "orders", "grpc"],
  ["api-gateway", "delivery", "grpc"],
  ["orders", "menu", "grpc"],
  ["orders", "payments", "grpc"],
  ["orders", "orders-db", "postgres"],
  ["orders", "order-queue", "kafka"],
  ["kitchen", "order-queue", "kafka"],
  ["kitchen", "orders", "http"],
  ["delivery", "order-queue", "kafka"],
  ["delivery", "orders", "grpc"],
  ["notifications", "order-queue", "kafka"],
];

/* ── Teams and people ──────────────────────────────────────────────────── */

const TEAMS = [
  { slug: "checkout", name: "Checkout", slack: "#team-checkout", owns: ["orders", "payments", "orders-db"] },
  { slug: "menu-apps", name: "Menu & Apps", slack: "#team-menu-apps", owns: ["menu", "website", "mobile-app", "api-gateway"] },
  { slug: "kitchen-delivery", name: "Kitchen & Delivery", slack: "#team-kitchen-delivery", owns: ["kitchen", "delivery", "notifications", "order-queue"] },
];

/** Engineers who write the code (they author PRs). */
const ENGINEERS = [
  { name: "Maya Patel", team: "checkout" }, //        payments
  { name: "Aisha Khan", team: "checkout" }, //        orders, api-gateway
  { name: "Leo Martins", team: "menu-apps" }, //      menu
  { name: "Sofia Rossi", team: "menu-apps" }, //      mobile-app, website
  { name: "Tom Becker", team: "kitchen-delivery" }, // delivery, notifications
  { name: "Ken Watanabe", team: "kitchen-delivery" }, // kitchen
];

/**
 * Personas: the people on call, answering incidents and posting in chat.
 * The contract keeps those acts on persona nodes (validate.ts PERSONA_ONLY_EDGES).
 * The first two of each team share that team's weekly on-call rotation.
 */
const PERSONAS = [
  { name: "Rita Gomez", role: "Payments engineer", team: "checkout" },
  { name: "Sam Osei", role: "Engineering manager, Checkout", team: "checkout" },
  { name: "Julia Weber", role: "Mobile engineer", team: "menu-apps" },
  { name: "Omar Haddad", role: "Backend engineer, Menu", team: "menu-apps" },
  { name: "Nina Larsen", role: "Delivery engineer", team: "kitchen-delivery" },
  { name: "Raj Iyer", role: "Site reliability engineer", team: "kitchen-delivery" },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const personUid = (name: string) => uid("Person", slug(name));
const personaUid = (name: string) => uid("Person", `persona-${slug(name)}`);

/* ── Pull requests ─────────────────────────────────────────────────────────
 * [number, merged (UTC), author, title, files]. Files are written as
 * `<service>/<file name>` and expanded against SERVICES below.
 * The last three are the demo suspects; everything on their dependency chains
 * before them is older than 30 days. */
type PrDef = [number, string, string, string, string[]];

const PRS: PrDef[] = [
  [101, "2026-02-03T10:12:00Z", "Aisha Khan", "Create orders service with a place-order endpoint", ["orders/place_order.go", "orders/db.go"]],
  [102, "2026-02-05T15:40:00Z", "Aisha Khan", "Add API gateway in front of the app and website", ["api-gateway/routes.go", "api-gateway/config.yaml"]],
  [103, "2026-02-10T09:05:00Z", "Leo Martins", "Menu service: pizzas, sizes and prices", ["menu/app.py", "menu/pricing.py"]],
  [104, "2026-02-12T13:30:00Z", "Maya Patel", "Payments service: charge cards through the processor (v2 API)", ["payments/ChargeService.java", "payments/ProcessorClient.java", "payments/pom.xml"]],
  [105, "2026-02-17T11:20:00Z", "Sofia Rossi", "Mobile app: menu and checkout screens", ["mobile-app/Menu.tsx", "mobile-app/Checkout.tsx", "mobile-app/package.json"]],
  [106, "2026-02-20T16:45:00Z", "Sofia Rossi", "Website: menu and checkout pages", ["website/menu.tsx", "website/checkout.tsx", "website/package.json"]],
  [107, "2026-03-02T08:50:00Z", "Ken Watanabe", "Kitchen screen shows incoming orders", ["kitchen/screen.ts", "kitchen/package.json"]],
  [108, "2026-03-04T14:10:00Z", "Aisha Khan", "Publish new orders to order-queue instead of calling the kitchen directly", ["orders/publish.go", "kitchen/consumer.ts"]],
  [109, "2026-03-09T10:00:00Z", "Tom Becker", "Delivery service: assign the nearest free driver", ["delivery/assign.go", "delivery/consumer.go"]],
  [110, "2026-03-12T12:35:00Z", "Tom Becker", "Notifications: text the customer when the order is out for delivery", ["notifications/sender.py", "notifications/templates.py", "notifications/consumer.py"]],
  [111, "2026-03-18T09:40:00Z", "Leo Martins", "Toppings with per-store stock", ["menu/toppings.py", "menu/app.py"]],
  [112, "2026-03-25T15:15:00Z", "Maya Patel", "Refunds for cancelled orders", ["payments/Refunds.java", "payments/ChargeService.java", "orders/place_order.go"]],
  [113, "2026-04-02T11:00:00Z", "Tom Becker", "Live driver location every 5 seconds", ["delivery/location.go", "mobile-app/TrackOrder.tsx"]],
  [114, "2026-04-08T13:25:00Z", "Sofia Rossi", "Track-order screen with a live map", ["mobile-app/TrackOrder.tsx", "api-gateway/routes.go"]],
  [115, "2026-04-15T10:30:00Z", "Leo Martins", "Cache menu prices for 10 minutes", ["menu/cache.py", "menu/pricing.py"]],
  [116, "2026-04-22T14:00:00Z", "Aisha Khan", "Keep the cart for 30 minutes", ["orders/cart.go"]],
  [117, "2026-05-04T09:55:00Z", "Maya Patel", "Retry a charge once when the processor times out", ["payments/ProcessorClient.java", "payments/ChargeService.java"]],
  [118, "2026-05-12T16:20:00Z", "Ken Watanabe", "Kitchen: mark a pizza ready and tell delivery", ["kitchen/screen.ts", "kitchen/consumer.ts", "delivery/consumer.go"]],
  [119, "2026-05-20T10:10:00Z", "Tom Becker", "Give one driver two nearby orders", ["delivery/assign.go"]],
  [120, "2026-05-28T13:45:00Z", "Maya Patel", "Load the processor certificate from config", ["payments/ProcessorClient.java", "payments/pom.xml"]],
  [121, "2026-06-05T11:30:00Z", "Leo Martins", "Half-price Tuesday promo", ["menu/pricing.py", "website/menu.tsx"]],
  [122, "2026-06-16T15:00:00Z", "Aisha Khan", "Orders DB: connection pool of 20", ["orders/db.go"]],
  [123, "2026-06-24T12:15:00Z", "Tom Becker", "Send driver location over websockets", ["delivery/location.go", "api-gateway/routes.go"]],
  [124, "2026-07-07T10:40:00Z", "Sofia Rossi", "Mobile: Apple Pay button", ["mobile-app/Checkout.tsx", "payments/ChargeService.java"]],
  [125, "2026-07-15T14:30:00Z", "Maya Patel", "Idempotency keys so a retried charge never bills twice", ["payments/ChargeService.java", "orders/place_order.go"]],
  [126, "2026-07-29T09:20:00Z", "Ken Watanabe", "Kitchen screen: bigger text for busy hours", ["kitchen/screen.ts"]],
  [127, "2026-08-06T13:05:00Z", "Leo Martins", "Menu: gluten-free badge", ["menu/app.py", "mobile-app/Menu.tsx"]],
  [128, "2026-08-19T11:45:00Z", "Tom Becker", "Notifications: push messages as well as texts", ["notifications/sender.py", "notifications/consumer.py"]],
  [129, "2026-08-27T15:35:00Z", "Aisha Khan", "Gateway: rate limit of 50 requests per second per user", ["api-gateway/auth.go", "api-gateway/config.yaml"]],
  [130, "2026-09-03T10:25:00Z", "Maya Patel", "Payments: log the processor's response codes", ["payments/ProcessorClient.java"]],
  [131, "2026-09-09T14:50:00Z", "Tom Becker", "Delivery: show the driver's name and photo", ["delivery/assign.go", "mobile-app/TrackOrder.tsx"]],
  // ── within 30 days of the newest PR ──
  [132, "2026-09-22T09:30:00Z", "Sofia Rossi", "Website: new homepage banner", ["website/menu.tsx"]],
  [133, "2026-10-01T12:00:00Z", "Ken Watanabe", "Kitchen: play a sound for new orders", ["kitchen/screen.ts"]],
  // the three demo suspects
  [134, "2026-10-10T16:05:00Z", "Leo Martins", "Half-and-half pizzas: price each half separately", ["menu/pricing.py", "menu/app.py"]],
  [135, "2026-10-13T11:40:00Z", "Maya Patel", "Switch the card processor client to the v3 API", ["payments/ProcessorClient.java", "payments/ChargeService.java", "payments/pom.xml"]],
  [136, "2026-10-16T17:20:00Z", "Tom Becker", "Delivery: only send driver location when the driver moves 20 m", ["delivery/location.go", "delivery/consumer.go"]],
];

/* ── Incidents (past, resolved), each caused by one of the PRs above ─────── */

interface IncidentDef {
  key: string;
  service: string;
  causedBy: number;
  severity: "SEV1" | "SEV2" | "SEV3";
  startedAt: string;
  minutes: number;
  title: string;
  summary: string;
  rootCause: string;
  responders: string[];
  alert: { title: string; metric: string; value: string; message: string };
  runbook: { key: string; title: string; steps: string[] };
}

const INCIDENTS: IncidentDef[] = [
  {
    key: "INC-2026-002", service: "menu", causedBy: 115, severity: "SEV2", startedAt: "2026-04-18T00:02:00Z", minutes: 47,
    title: "Menu would not load after the price cache expired at midnight",
    summary: "After #115 added a 10-minute price cache, every store's cache expired at the same moment at midnight. All requests went to the pricing code at once, the menu service ran out of workers, and the app showed 'Menu unavailable' for 47 minutes.",
    rootCause: "All cache entries had the same expiry time, so they all expired together and the menu service was flooded (a cache stampede).",
    responders: ["Omar Haddad", "Julia Weber"],
    alert: { title: "menu availability below SLO", metric: "menu_http_errors_ratio", value: "0.38", message: "menu GET /menu errors 38% over 5m (SLO 1%)" },
    runbook: { key: "rb-menu-cache", title: "Menu not loading: warm the price cache", steps: [
      "Check menu error rate and worker count on the menu dashboard.",
      "Warm the cache: `kubectl exec deploy/menu -- python -m menu.cache warm`.",
      "If errors continue, roll back the latest menu release: `kubectl rollout undo deployment/menu`.",
      "Confirm the app shows prices again for two stores before closing.",
    ] },
  },
  {
    key: "INC-2026-003", service: "payments", causedBy: 120, severity: "SEV1", startedAt: "2026-06-01T18:55:00Z", minutes: 35,
    title: "Card payments failed after the processor certificate changed",
    summary: "After #120 started loading the card processor's certificate from config, the processor rotated its certificate on a Monday evening. Payments still had the old one, so 60% of card charges failed for 35 minutes during dinner.",
    rootCause: "The certificate was only read at startup, so the rotated certificate was not picked up until payments restarted.",
    responders: ["Rita Gomez", "Sam Osei"],
    alert: { title: "payments charge failures", metric: "payments_charge_errors_ratio", value: "0.60", message: "payments Charge errors 60% over 5m (SLO 0.5%)" },
    runbook: { key: "rb-payments-rollback", title: "Card payments failing: roll back payments", steps: [
      "Look at the processor response codes in the payments logs (added in #130).",
      "If the failures started after a payments release, roll back: `kubectl rollout undo deployment/payments`.",
      "If it is a certificate problem, restart payments to reload it: `kubectl rollout restart deployment/payments`.",
      "Tell support in #support so they can answer customers, then refund double charges with the Refunds tool.",
    ] },
  },
  {
    key: "INC-2026-004", service: "orders", causedBy: 122, severity: "SEV2", startedAt: "2026-06-20T19:10:00Z", minutes: 28,
    title: "Orders failed during the Saturday football rush: orders-db ran out of connections",
    summary: "During a big football final, three times the usual number of people ordered at once. #122 had set the orders database pool to 20 connections, which ran out, and 1 in 4 orders failed for 28 minutes.",
    rootCause: "The connection pool was sized for a normal evening, not a rush.",
    responders: ["Sam Osei", "Rita Gomez"],
    alert: { title: "orders failing", metric: "orders_place_errors_ratio", value: "0.25", message: "orders PlaceOrder errors 25% over 5m" },
    runbook: { key: "rb-orders-db-pool", title: "Orders failing under load: raise the DB pool", steps: [
      "Check active connections on orders-db.",
      "Raise the pool: set `DB_POOL_SIZE=60` on the orders deployment and restart it.",
      "Scale orders to 6 replicas for the rest of the evening.",
    ] },
  },
  {
    key: "INC-2026-005", service: "delivery", causedBy: 123, severity: "SEV3", startedAt: "2026-06-27T18:20:00Z", minutes: 52,
    title: "Driver map froze after the switch to websockets",
    summary: "After #123 moved driver location updates to websockets, the API gateway closed idle connections after 30 seconds. Customers saw the driver stuck on the map, and support got 300 'where is my pizza?' messages.",
    rootCause: "The gateway's idle timeout was shorter than the gap between location updates when a driver was waiting at a red light.",
    responders: ["Nina Larsen", "Raj Iyer"],
    alert: { title: "driver location stale", metric: "delivery_location_age_seconds_p95", value: "240", message: "delivery location age p95 240s (expected under 10s)" },
    runbook: { key: "rb-delivery-location", title: "Driver map stuck: check location updates", steps: [
      "Check the age of the latest location per active driver on the delivery dashboard.",
      "If updates stopped after a delivery release, roll back: `kubectl rollout undo deployment/delivery`.",
      "Check the gateway's websocket idle timeout is longer than 60 s.",
      "Ask support to tell customers their pizza is on its way.",
    ] },
  },
];

/* ── Company brain: decisions (ADRs), threads, tickets ─────────────────── */

const DECISIONS = [
  {
    key: "ADR-001", docSlug: "adr-001-orders-through-a-queue", decidedAt: "2026-03-03T10:00:00Z", prs: [108],
    about: ["orders", "kitchen", "order-queue"], decidedBy: "Sam Osei", team: "checkout",
    title: "Send new orders to the kitchen through a queue",
    context: "At first, orders called the kitchen screen directly. When a store's wifi dropped, the call failed and the customer's order failed too, even though the payment had gone through.",
    decision: "Orders publishes every new order to the order-queue topic. The kitchen, delivery and notifications each read from the queue in their own time.",
    consequences: "An order succeeds even if a kitchen screen is offline; the screen catches up when it reconnects. Adding a new reader (like notifications) needs no change to orders. The kitchen can now be a few seconds behind.",
  },
  {
    key: "ADR-002", docSlug: "adr-002-one-api-gateway", decidedAt: "2026-02-04T10:00:00Z", prs: [102],
    about: ["api-gateway", "mobile-app", "website"], decidedBy: "Julia Weber", team: "menu-apps",
    title: "One API gateway for the app and the website",
    context: "The app and the website were each about to call five backend services, each with its own login check.",
    decision: "Both talk only to api-gateway, which checks the login once and routes each request.",
    consequences: "One place for login and rate limits. The gateway is now tier 1: if it is down, nobody can order.",
  },
  {
    key: "ADR-003", docSlug: "adr-003-menu-price-cache", decidedAt: "2026-04-14T10:00:00Z", prs: [115],
    about: ["menu"], decidedBy: "Omar Haddad", team: "menu-apps",
    title: "Cache menu prices, with random expiry times",
    context: "Working out prices with promos and per-store stock is slow, and the menu is read on every app open.",
    decision: "Cache prices for 10 minutes. After INC-2026-002 each entry gets a random extra 0 to 120 seconds so they never all expire at once.",
    consequences: "The menu is fast. A price change can take up to 12 minutes to show.",
  },
];

const THREADS = [
  {
    key: "t-0001", channel: "#team-checkout", createdAt: "2026-09-30T14:20:00Z", by: "Julia Weber", about: ["orders", "kitchen"],
    mentions: ["Decision:ADR-001", "PR:108"],
    title: "Why do orders go through a queue and not straight to the kitchen?",
    text: "Julia Weber: Quick question from a new joiner: why does orders put new orders on a queue instead of just calling the kitchen screen?\nSam Osei: Because store wifi drops. When orders called the kitchen directly, a wifi blip made the whole order fail after the card was already charged. ADR-001 moved it to order-queue in #108.\nRita Gomez: And it means notifications and delivery read the same queue, so nobody had to change orders to add texts.",
  },
  {
    key: "t-0002", channel: "#team-checkout", createdAt: "2026-10-12T09:15:00Z", by: "Rita Gomez", about: ["payments"],
    mentions: ["PR:135", "Incident:INC-2026-003"],
    title: "Moving payments to the processor's v3 API",
    text: "Rita Gomez: The processor turns off the v2 API in November, so Maya is moving us to v3 (#135).\nSam Osei: Watch the error codes. v3 renamed some of them, and last time payments broke (INC-2026-003) it took a while to see why.",
  },
  {
    key: "t-0003", channel: "#team-kitchen-delivery", createdAt: "2026-10-15T16:40:00Z", by: "Nina Larsen", about: ["delivery"],
    mentions: ["PR:136"],
    title: "Driver app battery drain",
    text: "Nina Larsen: Drivers say the app eats their battery. Tom's #136 only sends a location when the driver has moved 20 m.\nRaj Iyer: Sounds good. Just make sure the map still updates while a driver is stopped at a light, we had that problem before.",
  },
];

const ISSUES = [
  { key: "SLICE-101", status: "in_progress", priority: "P2", createdAt: "2026-10-09T10:00:00Z", by: "Rita Gomez", about: ["payments"], mentions: ["PR:135"],
    title: "Payments v3: handle the renamed decline codes", body: "The v3 card processor API renamed several decline codes. Map them to our error messages so customers see 'card declined' instead of 'something went wrong'." },
  { key: "SLICE-102", status: "open", priority: "P3", createdAt: "2026-10-11T10:00:00Z", by: "Omar Haddad", about: ["menu"], mentions: ["PR:134"],
    title: "Half-and-half pizzas: price is off by one cent", body: "When the two halves have different prices, rounding each half separately makes the total one cent off." },
  { key: "SLICE-103", status: "open", priority: "P2", createdAt: "2026-10-14T10:00:00Z", by: "Nina Larsen", about: ["delivery"], mentions: [],
    title: "Driver app drains the battery", body: "Drivers report the app uses about 30% battery per shift. Most of it is sending the location every 5 seconds." },
  { key: "SLICE-104", status: "done", priority: "P3", createdAt: "2026-05-02T10:00:00Z", by: "Raj Iyer", about: ["kitchen"], mentions: ["Decision:ADR-001"],
    title: "Kitchen screen misses orders after a wifi drop", body: "Fixed by reading from order-queue (ADR-001): the screen catches up on reconnect." },
];

/* ── Demo scenarios ────────────────────────────────────────────────────── */

const SCENARIOS: Scenario[] = [
  {
    id: "slice-payments-failing", tenant: TENANT, mode: "incident", title: "Customers can't pay",
    question: "Card payments failing for 25% of customers since 19:05, Friday dinner rush",
    alert: { service: "payments", metric: "payments_charge_errors_ratio", value: "0.25", message: "payments Charge errors 25% since 19:05" },
    expected: {
      blastRadius: ["Service:orders", "Service:api-gateway", "Service:kitchen", "Service:delivery", "Service:mobile-app", "Service:website"],
      suspectPr: "PR:135", expert: "Person:maya-patel", pastIncident: "Incident:INC-2026-003",
    },
    presenterNote: "The easy one. Payments fails → orders fails → the app and website can't take orders. Suspect #135 moved payments to the processor's v3 API three days ago. Maya Patel wrote most of payments. Last time (INC-2026-003) the fix was rolling back payments.",
  },
  {
    id: "slice-menu-down", tenant: TENANT, mode: "incident", title: "Menu won't load",
    question: "The app shows 'Menu unavailable' for 40% of customers",
    alert: { service: "menu", metric: "menu_http_errors_ratio", value: "0.40", message: "menu GET /menu errors 40% over 5m" },
    expected: {
      blastRadius: ["Service:api-gateway", "Service:orders", "Service:mobile-app", "Service:website", "Service:kitchen", "Service:delivery"],
      suspectPr: "PR:134", expert: "Person:leo-martins", pastIncident: "Incident:INC-2026-002",
    },
    presenterNote: "Suspect #134 (half-and-half pizza pricing, six days ago) by Leo Martins, who owns most of the menu code. Recall brings INC-2026-002, the midnight cache stampede, and its runbook.",
  },
  {
    id: "slice-driver-map", tenant: TENANT, mode: "incident", title: "Driver stuck on the map",
    question: "Customers see their driver frozen on the map since 18:30",
    alert: { service: "delivery", metric: "delivery_location_age_seconds_p95", value: "180", message: "delivery location age p95 180s (expected under 10s)" },
    expected: {
      blastRadius: ["Service:api-gateway", "Service:mobile-app", "Service:website"],
      suspectPr: "PR:136", expert: "Person:tom-becker", pastIncident: "Incident:INC-2026-005",
    },
    presenterNote: "Suspect #136 (send location only after 20 m, two days ago) by Tom Becker. Recall brings INC-2026-005, the same symptom after the websocket change. Thread t-0003 even warned about it.",
  },
  {
    id: "slice-ask-queue", tenant: TENANT, mode: "ask", title: "Why a queue for the kitchen?",
    question: "Why do orders go through a queue instead of straight to the kitchen?",
    expected: { sources: ["Decision:ADR-001", "Doc:adr-001-orders-through-a-queue", "Thread:t-0001"] },
    presenterNote: "The answer cites ADR-001, its doc, PR #108 that built it, and the chat thread where a new joiner asked the same question.",
  },
];

/* ── Build the snapshot ─────────────────────────────────────────────────── */

/** Stable fake commit sha: the PR is invented, so is its sha (but it's deterministic). */
const fakeSha = (n: number) => createHash("sha1").update(`slice-pr-${n}`).digest("hex");
const extLanguage: Record<string, string> = { tsx: "typescript", ts: "typescript", json: "json", go: "go", yaml: "yaml", py: "python", java: "java", xml: "xml" };

export function buildSlice(): { snapshot: Snapshot; scenarios: Scenario[] } {
  const nodes: SnapshotNode[] = [];
  const edges: SnapshotEdge[] = [];
  const node = (label: SnapshotNode["label"], key: string | number, props: Record<string, Json>) =>
    nodes.push({ uid: uid(label, key), label, props: { ...props, synthetic: true } });
  const edge = (type: SnapshotEdge["type"], from: string, to: string, props?: Record<string, Json>) =>
    edges.push(props ? { type, from, to, props } : { type, from, to });

  // services and their files
  const fileByShortName = new Map<string, string>(); // "payments/pom.xml" → full path
  for (const s of SERVICES) {
    const { files, ...props } = s;
    node("Service", s.slug, props);
    for (const path of files) {
      fileByShortName.set(`${s.slug}/${path.split("/").pop()}`, path);
      node("File", path, { path, service: s.slug, language: extLanguage[path.split(".").pop() ?? ""] ?? "text" });
      edge("PART_OF", uid("File", path), uid("Service", s.slug));
    }
  }
  for (const [from, to, protocol] of DEPENDS_ON) {
    edge("DEPENDS_ON", uid("Service", from), uid("Service", to), { protocol, source: "services/*/config.yaml (hand-written example)" });
  }

  // teams, engineers, personas
  for (const t of TEAMS) {
    node("Team", t.slug, { name: t.name, slug: t.slug, slack: t.slack });
    for (const s of t.owns) edge("OWNS", uid("Team", t.slug), uid("Service", s));
  }
  for (const e of ENGINEERS) {
    const mine = PRS.filter((p) => p[2] === e.name).map((p) => ms(p[1]));
    node("Person", slug(e.name), {
      name: e.name, slug: slug(e.name), isBot: false, prCount: mine.length,
      firstSeenAt: Math.min(...mine), lastSeenAt: Math.max(...mine),
    });
    edge("MEMBER_OF", personUid(e.name), uid("Team", e.team));
  }
  for (const p of PERSONAS) {
    node("Person", `persona-${slug(p.name)}`, { name: p.name, slug: `persona-${slug(p.name)}`, role: p.role, isBot: false, persona: true });
    edge("MEMBER_OF", personaUid(p.name), uid("Team", p.team));
  }

  // PRs: AUTHORED + MODIFIES (TOUCHES and COLLABORATES_WITH are derived at load)
  for (const [number, merged, author, title, short] of PRS) {
    const files = short.map((f) => {
      const full = fileByShortName.get(f);
      if (!full) throw new Error(`PR #${number}: unknown file ${f}`);
      return full;
    });
    const lines = files.map((_, i) => ({ additions: 12 + ((number * 7 + i * 13) % 140), deletions: (number * 3 + i * 5) % 40 }));
    node("PR", number, {
      number, title, sha: fakeSha(number), mergedAt: ms(merged), authorName: author, isBot: false,
      additions: lines.reduce((a, l) => a + l.additions, 0), deletions: lines.reduce((a, l) => a + l.deletions, 0),
      filesChanged: files.length, url: `https://slice.example/pull/${number}`,
    });
    edge("AUTHORED", personUid(author), uid("PR", number));
    files.forEach((f, i) => edge("MODIFIES", uid("PR", number), uid("File", f), lines[i]!));
  }

  // weekly on-call: each team's two personas alternate, from 12 weeks before
  // the newest PR through 2027 (so "this week" is always covered)
  const newest = Math.max(...PRS.map((p) => ms(p[1])));
  const weeks = mondaysBetween(newest - 12 * 7 * DAY, "2027-12-31");
  for (const t of TEAMS) {
    const rotation = PERSONAS.filter((p) => p.team === t.slug).slice(0, 2);
    weeks.forEach((w, i) => {
      const who = rotation[i % rotation.length]!;
      for (const s of t.owns) edge("ON_CALL_FOR", personaUid(who.name), uid("Service", s), { weekStart: isoDate(w), weekStartTs: w });
    });
  }

  // incidents, with their alert, runbook and responders
  for (const inc of INCIDENTS) {
    const startedAt = ms(inc.startedAt);
    const i = uid("Incident", inc.key);
    node("Incident", inc.key, {
      key: inc.key, title: inc.title, summary: inc.summary, rootCause: inc.rootCause,
      severity: inc.severity, status: "resolved", startedAt, resolvedAt: startedAt + inc.minutes * 60_000,
    });
    const a = uid("Alert", `alert-${inc.key.toLowerCase()}`);
    node("Alert", `alert-${inc.key.toLowerCase()}`, { ...inc.alert, firedAt: startedAt + 60_000 });
    node("Runbook", inc.runbook.key, { title: inc.runbook.title, steps: inc.runbook.steps, createdAt: startedAt + inc.minutes * 60_000 });
    const rb = uid("Runbook", inc.runbook.key);
    edge("AFFECTED", i, uid("Service", inc.service));
    edge("CAUSED_BY", i, uid("PR", inc.causedBy));
    edge("RESOLVED_BY", i, rb);
    edge("APPLIES_TO", rb, uid("Service", inc.service));
    edge("TRIGGERED_BY", i, a);
    edge("FIRED_ON", a, uid("Service", inc.service));
    for (const r of inc.responders) edge("RESPONDED_BY", i, personaUid(r));
  }

  // decisions and their ADR docs
  for (const d of DECISIONS) {
    const dUid = uid("Decision", d.key);
    node("Decision", d.key, {
      key: d.key, title: d.title, status: "accepted", context: d.context, decision: d.decision,
      consequences: d.consequences, decidedAt: ms(d.decidedAt),
    });
    node("Doc", d.docSlug, {
      title: `${d.key}: ${d.title}`, kind: "adr",
      text: `# ${d.key}: ${d.title}\n\nStatus: accepted · Decided: ${d.decidedAt.slice(0, 10)}\n\n## Context\n${d.context}\n\n## Decision\n${d.decision}\n\n## Consequences\n${d.consequences}\n`,
    });
    edge("DOCUMENTED_IN", dUid, uid("Doc", d.docSlug));
    edge("DECIDED_BY", dUid, personaUid(d.decidedBy));
    edge("DECIDED_BY", dUid, uid("Team", d.team));
    for (const pr of d.prs) {
      edge("JUSTIFIES", dUid, uid("PR", pr));
      edge("MENTIONS", dUid, uid("PR", pr));
    }
    for (const s of d.about) {
      edge("ABOUT", dUid, uid("Service", s));
      edge("ABOUT", uid("Doc", d.docSlug), uid("Service", s));
    }
  }

  for (const t of THREADS) {
    node("Thread", t.key, { channel: t.channel, title: t.title, text: t.text, createdAt: ms(t.createdAt) });
    edge("POSTED", personaUid(t.by), uid("Thread", t.key));
    for (const s of t.about) edge("ABOUT", uid("Thread", t.key), uid("Service", s));
    for (const m of t.mentions) edge("MENTIONS", uid("Thread", t.key), m);
  }
  for (const is of ISSUES) {
    const { by, about, mentions, createdAt, ...props } = is;
    node("Issue", is.key, { ...props, createdAt: ms(createdAt) });
    edge("POSTED", personaUid(by), uid("Issue", is.key));
    for (const s of about) edge("ABOUT", uid("Issue", is.key), uid("Service", s));
    for (const m of mentions) edge("MENTIONS", uid("Issue", is.key), m);
  }

  const snapshot: Snapshot = {
    tenant: TENANT,
    generatedAt: new Date(newest).toISOString(),
    seed: 0, // nothing random: every value above is written by hand
    sources: [], // no upstream repo; validate.ts accepts this when every node is synthetic
    nodes,
    edges,
  };
  return { snapshot, scenarios: SCENARIOS };
}
