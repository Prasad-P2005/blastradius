import { describe, expect, it } from "vitest";
import { splitUrlUser } from "./connection.ts";

describe("splitUrlUser", () => {
  it("moves a password-less user (FalkorDB Cloud's URL form) into the username option", () => {
    expect(splitUrlUser("redis://falkordb@db.example.cloud:59535")).toEqual({ url: "redis://db.example.cloud:59535", username: "falkordb" });
  });
  it("keeps URLs with no user or with a password unchanged", () => {
    expect(splitUrlUser("redis://localhost:6380")).toEqual({ url: "redis://localhost:6380" });
    expect(splitUrlUser("redis://u:p%40ss@h:1")).toEqual({ url: "redis://u:p%40ss@h:1" });
  });
});
