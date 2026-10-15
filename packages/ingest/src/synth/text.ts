/**
 * Placeholders for SYNTHETIC prose that point at REAL entities (services,
 * PRs) and at fictional personas.
 *
 * Content files write `{{pr:3869}}` instead of hard-coding "#3869 feat: add PII…".
 * Resolving a placeholder (a) renders the real title / name / slug into the
 * text and (b) records a MENTIONS target, so every reference in a ticket,
 * thread, ADR or incident is also a graph edge. A placeholder that names a
 * PR or person that is not in the snapshot throws: the build fails loudly
 * instead of shipping a dangling reference.
 *
 *   {{svc:cart}}        → cart                       MENTIONS Service:cart
 *   {{pr:3869}}         → #3869 "feat: add PII…"     MENTIONS PR:3869
 *   {{prn:3869}}        → #3869                      MENTIONS PR:3869
 *   {{persona:maya-okafor}} → Maya Okafor            MENTIONS Person:persona-maya-okafor
 *
 * There is deliberately NO placeholder for a real person: synthetic prose
 * never names, quotes or blames a real contributor. It may reference their
 * PRs by number and title, which are public facts.
 *   {{inc:INC-2026-041}} → INC-2026-041              MENTIONS Incident:INC-2026-041
 *   {{adr:ADR-001}}     → ADR-001                    MENTIONS Decision:ADR-001
 *   {{issue:ACME-104}}  → ACME-104                   MENTIONS Issue:ACME-104
 */
import { uid } from "@blastradius/shared";
import type { RealIndex } from "./context.ts";

export interface Resolved {
  text: string;
  mentions: string[];
}

export class TextResolver {
  /** Keys of synthetic nodes that exist (or will exist) — checked at the end by the validator too. */
  readonly incidents = new Set<string>();
  readonly decisions = new Set<string>();
  readonly issues = new Set<string>();

  /** persona uid → display name */
  constructor(private readonly ix: RealIndex, private readonly personas: Map<string, string>) {}

  resolve(src: string): Resolved {
    const mentions: string[] = [];
    const add = (u: string) => {
      if (!mentions.includes(u)) mentions.push(u);
    };
    const text = src.replace(/\{\{(\w+):([^}]+)\}\}/g, (_m, kind: string, arg: string) => {
      switch (kind) {
        case "svc":
          add(this.ix.serviceUid(arg));
          return arg;
        case "pr":
        case "prn": {
          const pr = this.ix.pr(Number(arg));
          add(pr.uid);
          return kind === "pr" ? `#${pr.number} "${pr.title}"` : `#${pr.number}`;
        }
        case "persona": {
          const u = uid("Person", `persona-${arg}`);
          const name = this.personas.get(u);
          if (!name) throw new Error(`${this.ix.tenant}: unknown persona ${arg}`);
          add(u);
          return name;
        }
        case "inc":
          add(uid("Incident", arg));
          return arg;
        case "adr":
          add(uid("Decision", arg));
          return arg;
        case "issue":
          add(uid("Issue", arg));
          return arg;
        default:
          throw new Error(`unknown placeholder {{${kind}:${arg}}}`);
      }
    });
    return { text, mentions };
  }
}
