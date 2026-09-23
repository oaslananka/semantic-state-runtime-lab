import { describe, expect, it } from "vitest";
import {
  ContextIndex,
  lexicalBaseline,
  type ContextCorpus,
} from "../src/index.js";

const corpus: ContextCorpus = {
  entities: [
    { id: "project:atlas", aliases: ["Project Atlas", "Atlas"] },
    { id: "project:other", aliases: ["Project Other"] },
  ],
  records: [
    {
      id: "atlas-current",
      entityId: "project:atlas",
      kind: "decision",
      text: "ADR-42: keep server-side sessions; do not migrate sessions to JWT yet.",
      current: true,
      importance: 1,
    },
    {
      id: "atlas-old",
      entityId: "project:atlas",
      kind: "decision",
      text: "Old proposal: migrate authentication sessions to JWT.",
      current: false,
      importance: 0.2,
    },
    {
      id: "other-jwt",
      entityId: "project:other",
      kind: "decision",
      text: "Authentication decision uses JWT for every session.",
      current: true,
      importance: 1,
    },
  ],
};

describe("ContextIndex", () => {
  it("resolves named entities before ranking records", () => {
    const index = new ContextIndex(corpus);
    expect(index.resolveEntities("What is the current JWT decision for Project Atlas?"))
      .toEqual(["project:atlas"]);
  });

  it("keeps compiled context within the requested budget", () => {
    const index = new ContextIndex(corpus);
    const result = index.compile({
      query: "What is the current JWT decision for Project Atlas?",
      budgetTokens: 80,
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(80);
    expect(result.records[0]?.id).toBe("atlas-current");
    expect(result.records.some((record) => record.id === "other-jwt")).toBe(false);
  });

  it("narrows candidates before ranking while lexical baseline scans the corpus", () => {
    const index = new ContextIndex(corpus);
    const request = {
      query: "What is the current JWT decision for Project Atlas?",
      budgetTokens: 80,
    };

    const compiled = index.compile(request);
    const baseline = lexicalBaseline(corpus, request);

    expect(compiled.consideredRecords).toBe(2);
    expect(baseline.consideredRecords).toBe(3);
  });
});
