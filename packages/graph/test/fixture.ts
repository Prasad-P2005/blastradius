/**
 * test/fixture.ts — a small, hand-written snapshot for integration tests and
 * for the sample outputs in docs/CYPHER.md. It mirrors the real data model
 * (SPEC §1) on a toy shop:
 *
 *   frontend ─► checkout ─► cart ─► valkey-cart        flagd (isolated: a 2nd WCC component)
 *      │           ├─► payment ─► currency
 *      ├─► cart    ├─► shipping
 *      └─► currency└─► kafka
 *
 * Story: ADR-003 moved cart storage to Valkey (PR 101), which later caused
 * INC-2025-007 (connection exhaustion). Alice recently shrank the Valkey pool
 * again (PR 140, 5 days before the newest PR) — the "suspect" for a cart
 * alert. renovate[bot] merged the newest PR (141), which must NOT outrank
 * humans by default.
 */
import type { Snapshot, SnapshotEdge, SnapshotNode } from "@blastradius/shared";

const DAY = 86_400_000;
/** Newest PR mergedAt = the fixture's "now" for suspect_changes. */
export const NEWEST = Date.UTC(2025, 8, 30, 12, 0, 0); // 2025-09-30T12:00:00Z
const ago = (d: number) => NEWEST - d * DAY;

const nodes: SnapshotNode[] = [];
const edges: SnapshotEdge[] = [];
const n = (label: SnapshotNode["label"], key: string, props: SnapshotNode["props"]) =>
  nodes.push({ label, uid: `${label}:${key}`, props });
const e = (type: SnapshotEdge["type"], from: string, to: string, props?: SnapshotEdge["props"]) =>
  edges.push(props ? { type, from, to, props } : { type, from, to });

// ── Services ────────────────────────────────────────────────────────────────
const services: [string, string, string, number, string][] = [
  ["frontend", "typescript", "frontend", 1, "Next.js storefront"],
  ["checkout", "go", "service", 1, "Places orders: cart, payment, shipping, currency"],
  ["cart", "csharp", "service", 1, "Shopping cart service backed by Valkey"],
  ["valkey-cart", "valkey", "datastore", 2, "Valkey key-value store for cart sessions"],
  ["payment", "javascript", "service", 1, "Charges credit cards"],
  ["currency", "cpp", "service", 2, "Converts money between currencies"],
  ["shipping", "rust", "service", 2, "Shipping quotes and tracking"],
  ["kafka", "java", "queue", 2, "Order events queue"],
  ["flagd", "go", "tool", 3, "Feature flag daemon"],
];
for (const [slug, language, kind, tier, description] of services) {
  n("Service", slug, { name: slug, slug, language, kind, tier, description, repoPath: `src/${slug}`, synthetic: false });
}
const deps: [string, string, string][] = [
  ["frontend", "checkout", "grpc"],
  ["frontend", "cart", "grpc"],
  ["frontend", "currency", "grpc"],
  ["checkout", "cart", "grpc"],
  ["checkout", "payment", "grpc"],
  ["checkout", "currency", "grpc"],
  ["checkout", "shipping", "http"],
  ["checkout", "kafka", "kafka"],
  ["cart", "valkey-cart", "redis"],
  ["payment", "currency", "grpc"],
];
for (const [a, b, protocol] of deps) e("DEPENDS_ON", `Service:${a}`, `Service:${b}`, { protocol, source: "docker-compose.yml" });

// ── Teams + people ──────────────────────────────────────────────────────────
const teams: [string, string, string[]][] = [
  ["cart-team", "Cart Team", ["cart", "valkey-cart"]],
  ["checkout-team", "Checkout Team", ["checkout", "payment", "shipping"]],
  ["web-team", "Web Team", ["frontend", "currency"]],
  ["platform-team", "Platform Team", ["kafka", "flagd"]],
];
for (const [slug, name, owns] of teams) {
  n("Team", slug, { name, slug, slack: `#${slug}`, synthetic: true });
  for (const s of owns) e("OWNS", `Team:${slug}`, `Service:${s}`);
}
const people: [string, string, boolean, string | null][] = [
  ["alice-chen", "Alice Chen", false, "cart-team"],
  ["bob-patel", "Bob Patel", false, "checkout-team"],
  ["carol-diaz", "Carol Diaz", false, "checkout-team"],
  ["dan-kim", "Dan Kim", false, "web-team"],
  ["erin-wu", "Erin Wu", false, "platform-team"],
  ["renovate-bot", "renovate[bot]", true, null],
];
for (const [slug, name, isBot, team] of people) {
  n("Person", slug, { name, slug, isBot, prCount: 0, firstSeenAt: ago(400), lastSeenAt: ago(1), synthetic: false });
  if (team) e("MEMBER_OF", `Person:${slug}`, `Team:${team}`);
}

// ── Files ───────────────────────────────────────────────────────────────────
const files: [string, string, string][] = [
  ["src/cart/CartService.cs", "cart", "csharp"],
  ["src/cart/ValkeyCartStore.cs", "cart", "csharp"],
  ["src/checkout/main.go", "checkout", "go"],
  ["src/checkout/money.go", "checkout", "go"],
  ["src/payment/charge.js", "payment", "javascript"],
  ["src/frontend/pages/cart.tsx", "frontend", "typescript"],
  ["src/currency/server.cpp", "currency", "cpp"],
  ["src/shipping/main.rs", "shipping", "rust"],
];
for (const [path, service, language] of files) {
  n("File", path, { path, service, language });
  e("PART_OF", `File:${path}`, `Service:${service}`);
}

// ── PRs ─────────────────────────────────────────────────────────────────────
const prs: [number, string, string, number, string[]][] = [
  [90, "cart: add idempotency key to AddItem", "alice-chen", 100, ["src/cart/CartService.cs"]],
  [95, "checkout: emit order events to kafka", "carol-diaz", 90, ["src/checkout/main.go"]],
  [101, "Move cart storage from Redis to Valkey", "alice-chen", 200, ["src/cart/ValkeyCartStore.cs", "src/cart/CartService.cs"]],
  [110, "Frontend cart page redesign", "dan-kim", 10, ["src/frontend/pages/cart.tsx"]],
  [120, "payment: add retry to card charge", "bob-patel", 60, ["src/payment/charge.js"]],
  [125, "currency: cache exchange rates", "erin-wu", 20, ["src/currency/server.cpp"]],
  [130, "checkout: refactor money rounding", "carol-diaz", 40, ["src/checkout/money.go"]],
  [140, "cart: reduce Valkey connection pool size", "alice-chen", 5, ["src/cart/ValkeyCartStore.cs"]],
  [141, "chore(deps): update grpc to v1.66", "renovate-bot", 0, ["src/checkout/main.go", "src/cart/CartService.cs"]],
  [142, "checkout: cache shipping quotes", "bob-patel", 3, ["src/checkout/main.go", "src/shipping/main.rs"]],
];
for (const [num, title, author, daysAgo, touched] of prs) {
  const isBot = author.endsWith("-bot");
  n("PR", String(num), {
    number: num,
    title,
    sha: `sha${num}`,
    mergedAt: ago(daysAgo),
    additions: 10 + num,
    deletions: num % 17,
    filesChanged: touched.length,
    url: `https://github.com/example/shop/pull/${num}`,
    isBot,
    authorName: people.find((p) => p[0] === author)![1],
    synthetic: false,
  });
  e("AUTHORED", `Person:${author}`, `PR:${num}`);
  for (const f of touched) e("MODIFIES", `PR:${num}`, `File:${f}`, { additions: 10 + num, deletions: num % 17 });
}

// ── On-call: one edge PER WEEK (lesson 1) ───────────────────────────────────
const oncall: [string, string, string][] = [
  ["alice-chen", "cart", "2025-09-22"],
  ["erin-wu", "cart", "2025-09-29"],
  ["carol-diaz", "checkout", "2025-09-22"],
  ["bob-patel", "checkout", "2025-09-29"],
  ["alice-chen", "valkey-cart", "2025-09-29"],
];
for (const [p, s, w] of oncall) e("ON_CALL_FOR", `Person:${p}`, `Service:${s}`, { weekStart: w, weekStartTs: Date.parse(`${w}T00:00:00Z`) });

// ── Decision → Doc, PR (decision trace chain) ───────────────────────────────
n("Decision", "ADR-003", {
  key: "ADR-003",
  title: "Move cart session storage from Redis to Valkey",
  status: "accepted",
  context: "Redis licensing changed and the cart needs a drop-in key-value store for sessions.",
  decision: "Use Valkey for cart storage, with a bounded connection pool per cart pod.",
  consequences: "Connection pool size must be tuned; too small a pool exhausts connections under load.",
  decidedAt: ago(210),
  synthetic: true,
});
n("Doc", "adr-003-valkey", {
  title: "ADR-003: Valkey for cart storage",
  kind: "adr",
  text: "We replace Redis with Valkey for cart sessions. Pool sizing guidance: at least 50 connections per pod.",
  synthetic: true,
});
n("Doc", "howto-cart-debugging", {
  title: "How to debug cart latency",
  kind: "howto",
  text: "Check Valkey connection pool saturation first, then cart pod CPU. Grafana dashboard: cart-overview.",
  synthetic: true,
});
e("DOCUMENTED_IN", "Decision:ADR-003", "Doc:adr-003-valkey");
e("DECIDED_BY", "Decision:ADR-003", "Person:alice-chen");
e("DECIDED_BY", "Decision:ADR-003", "Team:cart-team");
e("JUSTIFIES", "Decision:ADR-003", "PR:101");
e("ABOUT", "Decision:ADR-003", "Service:cart");
e("ABOUT", "Doc:adr-003-valkey", "Service:cart");
e("ABOUT", "Doc:howto-cart-debugging", "Service:cart");

// ── Incidents + runbooks (procedural memory seed) ───────────────────────────
n("Incident", "INC-2025-007", {
  key: "INC-2025-007",
  title: "Cart 5xx after Valkey connection exhaustion",
  summary: "Cart returned HTTP 503 for 40 minutes; checkout failed for users adding items.",
  rootCause: "The Valkey connection pool was too small after the Redis to Valkey migration.",
  severity: "SEV2",
  status: "resolved",
  startedAt: ago(150),
  resolvedAt: ago(150) + 40 * 60_000,
  synthetic: true,
});
n("Runbook", "valkey-connection-exhaustion", {
  title: "Valkey connection exhaustion",
  steps: ["Check cart pool metrics", "Raise ValkeyPoolSize to 50", "Restart cart pods one at a time"],
  createdAt: ago(149),
  synthetic: true,
});
n("Incident", "INC-2025-019", {
  key: "INC-2025-019",
  title: "Checkout payment timeouts during peak",
  summary: "Checkout requests timed out because payment retries piled up on the card processor.",
  rootCause: "Aggressive retry loop in the payment charge path.",
  severity: "SEV1",
  status: "resolved",
  startedAt: ago(55),
  resolvedAt: ago(55) + 90 * 60_000,
  synthetic: true,
});
n("Runbook", "payment-timeout-rollback", {
  title: "Payment timeout rollback",
  steps: ["Disable payment retries via flagd", "Roll back the payment deployment", "Drain the checkout queue"],
  createdAt: ago(54),
  synthetic: true,
});
n("Alert", "alert-0001", {
  title: "cart 5xx > 5%",
  metric: "http_5xx_rate",
  value: "12%",
  message: "cart 5xx at 12%",
  firedAt: ago(150),
  synthetic: true,
});
e("AFFECTED", "Incident:INC-2025-007", "Service:cart");
e("AFFECTED", "Incident:INC-2025-007", "Service:valkey-cart");
e("CAUSED_BY", "Incident:INC-2025-007", "PR:101");
e("RESOLVED_BY", "Incident:INC-2025-007", "Runbook:valkey-connection-exhaustion");
e("RESPONDED_BY", "Incident:INC-2025-007", "Person:alice-chen");
e("RESPONDED_BY", "Incident:INC-2025-007", "Person:erin-wu");
e("TRIGGERED_BY", "Incident:INC-2025-007", "Alert:alert-0001");
e("FIRED_ON", "Alert:alert-0001", "Service:cart");
e("MENTIONS", "Incident:INC-2025-007", "Decision:ADR-003");
e("APPLIES_TO", "Runbook:valkey-connection-exhaustion", "Service:cart");
e("AFFECTED", "Incident:INC-2025-019", "Service:checkout");
e("AFFECTED", "Incident:INC-2025-019", "Service:payment");
e("CAUSED_BY", "Incident:INC-2025-019", "PR:120");
e("RESOLVED_BY", "Incident:INC-2025-019", "Runbook:payment-timeout-rollback");
e("RESPONDED_BY", "Incident:INC-2025-019", "Person:bob-patel");
e("RESPONDED_BY", "Incident:INC-2025-019", "Person:carol-diaz");
e("APPLIES_TO", "Runbook:payment-timeout-rollback", "Service:payment");

// ── Company brain: a chat thread and a ticket ───────────────────────────────
n("Thread", "t-0001", {
  channel: "#cart-team",
  title: "Valkey pool exhaustion again?",
  text: "Alice Chen: I lowered the Valkey pool size in PR 140 to save memory.\nErin Wu: careful, that's what caused INC-2025-007.",
  createdAt: ago(4),
  synthetic: true,
});
e("ABOUT", "Thread:t-0001", "Service:cart");
e("MENTIONS", "Thread:t-0001", "PR:140");
e("MENTIONS", "Thread:t-0001", "Person:alice-chen");
e("MENTIONS", "Thread:t-0001", "Incident:INC-2025-007");
n("Issue", "ACME-142", {
  key: "ACME-142",
  title: "Checkout intermittently returns 503 when adding to cart",
  body: "Users see 503 on add-to-cart during peak hours. Suspect cart storage timeouts.",
  status: "open",
  priority: "P2",
  createdAt: ago(2),
  synthetic: true,
});
e("ABOUT", "Issue:ACME-142", "Service:cart");
e("MENTIONS", "Issue:ACME-142", "Service:checkout");

// prCount per person
for (const node of nodes) {
  if (node.label === "Person") node.props.prCount = prs.filter((p) => `Person:${p[2]}` === node.uid).length;
}

export const fixtureSnapshot: Snapshot = {
  tenant: "acme",
  generatedAt: new Date(NEWEST).toISOString(),
  seed: 1,
  sources: [{ repo: "example/shop", url: "https://github.com/example/shop", sha: "fixture", license: "Apache-2.0" }],
  nodes,
  edges,
};

/** A held-back PR for the ingestDelta test: newer than everything in the fixture. */
export const fixtureDelta: { nodes: SnapshotNode[]; edges: SnapshotEdge[] } = {
  nodes: [
    {
      label: "PR",
      uid: "PR:150",
      props: {
        number: 150,
        title: "cart: restore Valkey pool size to 50",
        sha: "sha150",
        mergedAt: NEWEST + 1 * DAY,
        additions: 3,
        deletions: 3,
        filesChanged: 1,
        url: "https://github.com/example/shop/pull/150",
        isBot: false,
        authorName: "Alice Chen",
        synthetic: false,
      },
    },
  ],
  edges: [
    { type: "AUTHORED", from: "Person:alice-chen", to: "PR:150" },
    { type: "MODIFIES", from: "PR:150", to: "File:src/cart/ValkeyCartStore.cs", props: { additions: 3, deletions: 3 } },
  ],
};
