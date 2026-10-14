/**
 * Where each tenant's REAL data comes from, pinned for reproducibility.
 *
 * Real:  both repos are public Apache-2.0 projects on GitHub. We read their
 *        git history (merged PRs, authors, files) at a pinned commit.
 * Pinned: `snapshotSha` is the commit we snapshot FROM. `data:build` checks it
 *        out, so the same SHA + seed always produces byte-identical JSON.
 *        `deltaSha` is a later commit: the PRs between the two are held back
 *        into data/deltas/<tenant>.json for the "keeping knowledge current"
 *        demo (`add-prs`).
 *
 * Why these particular cuts?
 *   acme   — opentelemetry-demo is busy, so we cut just before the newest
 *            5 human PRs (2026-10-08). The 30-day "recent" window then holds
 *            plenty of human PRs on checkout / payment / product-catalog.
 *   globex — microservices-demo's last two years are almost all Renovate bot
 *            PRs and direct pushes without PR numbers. Its latest 30 days have
 *            NO human PR on any service, so incident scenarios could not have
 *            a human suspect. We therefore snapshot the repo as it was on
 *            2024-05-10, when humans were actively changing services
 *            (ShoppingAssistant launch, scratch base images, adservice
 *            profiler). This is still 100% real history, just an older cut.
 */
import type { Tenant } from "@blastradius/shared";

export interface SourceConfig {
  tenant: Tenant;
  /** GitHub `owner/repo` */
  repo: string;
  url: string;
  license: string;
  /** Directory name under .cache/repos/ */
  cloneDir: string;
  /** Commit the snapshot is built from (inclusive). */
  snapshotSha: string;
  /** Later commit; PRs in (snapshotSha, deltaSha] become the delta file. */
  deltaSha: string;
  /** How many of the newest merged PRs (≤ snapshotSha) to keep. */
  prLimit: number;
  /**
   * Older "landmark" PRs kept in addition to the newest `prLimit`, because a
   * real architectural decision (ADR) is grounded in them. E.g. acme #1619
   * "[Valkey] Replace Redis with Valkey" is from 2024 but justifies ADR-001.
   */
  landmarkPrs: number[];
  /** Seed for the synthetic org data (teams, on-call, incidents, tickets…). */
  seed: number;
}

export const SOURCES: Record<Tenant, SourceConfig> = {
  acme: {
    tenant: "acme",
    repo: "open-telemetry/opentelemetry-demo",
    url: "https://github.com/open-telemetry/opentelemetry-demo",
    license: "Apache-2.0",
    cloneDir: "open-telemetry__opentelemetry-demo",
    // #4064 "feat: add PostgreSQL query telemetry dashboard" (2026-10-08)
    snapshotSha: "1fbf2a8d67a00269bf720d318633c4b98fc8d54c",
    // #4108 "chore(deps): bump library/golang" (2026-10-14), HEAD when cloned
    deltaSha: "6dc0b6067090ec12d4649694c0bca8d172dc4a46",
    prLimit: 600,
    landmarkPrs: [
      1619, // [Valkey] Replace Redis with Valkey (2024-06)
      2859, // [product-catalog] use database for products (2026-01)
      3153, // More realistic PostgreSQL setup with dedicated users… (2026-04)
      3219, // fix/add KAFKA_ADDR env var (2026-04)
      2830, // Grpc readiness probe for cart, failure behind a flag (2026-01)
    ],
    seed: 1337,
  },
  globex: {
    tenant: "globex",
    repo: "GoogleCloudPlatform/microservices-demo",
    url: "https://github.com/GoogleCloudPlatform/microservices-demo",
    license: "Apache-2.0",
    cloneDir: "GoogleCloudPlatform__microservices-demo",
    // #2537 "chore(deps): bump Npgsql…" (2024-05-10), just before #2538
    snapshotSha: "912468a8aeb5ec095f36ff177f7b4876f192f84a",
    // #2598 "adservice - ca-certificates is already in the final base image" (2024-06-19)
    deltaSha: "8846a45814c5bfbe82dab9ec5c6e5724a597ed2f",
    // Wider than acme: ~85% of PRs here are Renovate/dependabot, so we keep
    // more (back to Oct 2022) to get ~170 human PRs from ~28 people.
    prLimit: 1100,
    landmarkPrs: [
      1109, // `cartservice` - Spanner as database option (2022-10)
      1167, // feat!: Add OpenTelemetry Collector (2022-11)
      1180, // feat!: Add distributed tracing to Online Boutique (2022-11)
    ],
    seed: 4242,
  },
};

/** Repo-relative clone directory (gitignored). */
export const REPOS_DIR = ".cache/repos";
/** Intermediate output of `snapshot` (real data only), consumed by `synth`. */
export const REAL_DIR = ".cache/snapshots";

export function prUrl(src: SourceConfig, n: number): string {
  return `https://github.com/${src.repo}/pull/${n}`;
}
