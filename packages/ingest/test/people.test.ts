import { describe, expect, it } from "vitest";
import { isBotName, personSlug } from "../src/people.ts";
import { languageForPath } from "../src/services.ts";
import { serviceForPath } from "../src/services.ts";
import { isoDate, mondayOf, mondaysBetween } from "../src/time.ts";

describe("people", () => {
  it("slugifies names with transliteration and aliases", () => {
    expect(personSlug("Piotr Kiełkowicz")).toBe("piotr-kielkowicz");
    expect(personSlug("Dónal O'Sullivan")).toBe("donal-o-sullivan");
    expect(personSlug("smeet07")).toBe("smeet-nagda");
  });
  it("flags bots", () => {
    for (const b of ["dependabot[bot]", "Mend Renovate", "WhiteSource Renovate", "github-actions[bot]", "OpenTelemetry Bot", "otelbot", "StepSecurity Bot"]) expect(isBotName(b)).toBe(true);
    for (const h of ["Cijo Thomas", "Juliano Costa", "Abbott"]) expect(isBotName(h)).toBe(false);
  });
});

describe("services", () => {
  it("maps paths through the alias table (incl. legacy dirs)", () => {
    expect(serviceForPath("acme", "src/cart/src/Program.cs")).toBe("cart");
    expect(serviceForPath("acme", "src/cartservice/src/Program.cs")).toBe("cart");
    expect(serviceForPath("acme", "src/postgresql/init.sql")).toBe("astronomy-db");
    expect(serviceForPath("acme", "docs/README.md")).toBeNull();
    expect(serviceForPath("globex", "src/productcatalogservice/server.go")).toBe("product-catalog");
    expect(languageForPath("src/cart/Dockerfile")).toBe("docker");
    expect(languageForPath("src/checkout/main.go")).toBe("go");
  });
});

describe("time", () => {
  it("finds Mondays in UTC", () => {
    expect(isoDate(mondayOf(Date.parse("2026-10-15T23:00:00Z")))).toBe("2026-10-12");
    expect(isoDate(mondayOf(Date.parse("2026-10-12T00:00:00Z")))).toBe("2026-10-12");
    expect(isoDate(mondayOf(Date.parse("2026-10-18T23:59:59Z")))).toBe("2026-10-12");
    const ms = mondaysBetween(Date.parse("2027-12-20T00:00:00Z"), "2027-12-31");
    expect(ms.map(isoDate)).toEqual(["2027-12-20", "2027-12-27"]);
  });
});
