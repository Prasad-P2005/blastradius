/**
 * Placeholders for SYNTHETIC prose that point at REAL entities.
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
 *   {{author:3869}}     → Adii                       MENTIONS Person:adii
 *   {{person:cijo-thomas}} → Cijo Thomas             MENTIONS Person:cijo-thomas
 *   {{expert:cart}} / {{expert2:cart}} → top / second human author on cart
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

  constructor(private readonly ix: RealIndex) {}

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
        case "author": {
          const pr = this.ix.pr(Number(arg));
          const p = this.ix.person(pr.author);
          add(p.uid);
          return p.name;
        }
        case "person": {
          const p = this.ix.person(arg);
          add(p.uid);
          return p.name;
        }
        case "expert":
        case "expert2": {
          const ranked = this.ix.expertsOn(arg);
          const e = ranked[kind === "expert" ? 0 : 1] ?? ranked[0];
          if (!e) throw new Error(`${this.ix.tenant}: no human expert on ${arg}`);
          const p = this.ix.person(e.slug);
          add(p.uid);
          return p.name;
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
