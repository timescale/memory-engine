import { describe, expect, test } from "bun:test";
import { detectTreeFilterType, rrfFusion } from "./memory";

describe("detectTreeFilterType", () => {
  test("detects ltxtquery (contains &)", () => {
    expect(detectTreeFilterType("api & v2")).toBe("ltxtquery");
    expect(detectTreeFilterType("work & !draft")).toBe("ltxtquery");
    expect(detectTreeFilterType("a & b & c")).toBe("ltxtquery");
  });

  test("detects lquery (contains pattern chars)", () => {
    // Wildcard
    expect(detectTreeFilterType("work.*")).toBe("lquery");
    expect(detectTreeFilterType("*.api.*")).toBe("lquery");

    // Quantifier
    expect(detectTreeFilterType("work.*{2}")).toBe("lquery");
    expect(detectTreeFilterType("work.*{1,3}")).toBe("lquery");

    // Negation
    expect(detectTreeFilterType("*.!draft.*")).toBe("lquery");

    // Alternation
    expect(detectTreeFilterType("work|personal.*")).toBe("lquery");

    // Other pattern chars
    expect(detectTreeFilterType("work.@api")).toBe("lquery");
    expect(detectTreeFilterType("work.%")).toBe("lquery");
  });

  test("detects ltree (plain paths)", () => {
    expect(detectTreeFilterType("work")).toBe("ltree");
    expect(detectTreeFilterType("work.projects")).toBe("ltree");
    expect(detectTreeFilterType("work.projects.api")).toBe("ltree");
    expect(detectTreeFilterType("a.b.c.d.e")).toBe("ltree");
    expect(detectTreeFilterType("")).toBe("ltree");
  });
});

describe("rrfFusion", () => {
  test("combines results from both sources", () => {
    const bm25Results = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const semanticResults = [{ id: "b" }, { id: "d" }, { id: "a" }];

    const fused = rrfFusion(bm25Results, semanticResults);

    // All unique IDs should be present
    const ids = fused.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).toContain("d");
    expect(ids).toHaveLength(4);
  });

  test("ranks items appearing in both lists higher", () => {
    const bm25Results = [{ id: "a" }, { id: "b" }];
    const semanticResults = [{ id: "b" }, { id: "c" }];

    const fused = rrfFusion(bm25Results, semanticResults);

    // 'b' appears in both, should have highest score
    expect(fused[0]!.id).toBe("b");
  });

  test("respects rank order within each list", () => {
    const bm25Results = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const semanticResults: Array<{ id: string }> = [];

    const fused = rrfFusion(bm25Results, semanticResults);

    // Order should be preserved from BM25
    expect(fused[0]!.id).toBe("a");
    expect(fused[1]!.id).toBe("b");
    expect(fused[2]!.id).toBe("c");
  });

  test("applies weights correctly", () => {
    const bm25Results = [{ id: "a" }];
    const semanticResults = [{ id: "b" }];

    // With equal weights
    const fusedEqual = rrfFusion(bm25Results, semanticResults, 60, {
      fulltext: 1.0,
      semantic: 1.0,
    });
    expect(fusedEqual[0]!.score).toBe(fusedEqual[1]!.score);

    // With higher BM25 weight
    const fusedBM25Heavy = rrfFusion(bm25Results, semanticResults, 60, {
      fulltext: 2.0,
      semantic: 1.0,
    });
    const aScore = fusedBM25Heavy.find((r) => r.id === "a")!.score;
    const bScore = fusedBM25Heavy.find((r) => r.id === "b")!.score;
    expect(aScore).toBeGreaterThan(bScore);

    // With higher semantic weight
    const fusedSemanticHeavy = rrfFusion(bm25Results, semanticResults, 60, {
      fulltext: 1.0,
      semantic: 2.0,
    });
    const aScore2 = fusedSemanticHeavy.find((r) => r.id === "a")!.score;
    const bScore2 = fusedSemanticHeavy.find((r) => r.id === "b")!.score;
    expect(bScore2).toBeGreaterThan(aScore2);
  });

  test("handles empty inputs", () => {
    expect(rrfFusion([], [])).toEqual([]);
    expect(rrfFusion([{ id: "a" }], [])).toHaveLength(1);
    expect(rrfFusion([], [{ id: "b" }])).toHaveLength(1);
  });

  test("uses k parameter correctly", () => {
    const bm25Results = [{ id: "a" }];
    const semanticResults: Array<{ id: string }> = [];

    // RRF score = weight / (k + rank)
    // With k=60, rank=1: score = 1 / 61 ≈ 0.0164
    const fusedK60 = rrfFusion(bm25Results, semanticResults, 60);
    expect(fusedK60[0]!.score).toBeCloseTo(1 / 61, 5);

    // With k=10, rank=1: score = 1 / 11 ≈ 0.0909
    const fusedK10 = rrfFusion(bm25Results, semanticResults, 10);
    expect(fusedK10[0]!.score).toBeCloseTo(1 / 11, 5);
  });
});
