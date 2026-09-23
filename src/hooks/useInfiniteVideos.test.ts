// =============================================================================
// GENHUB - Tests for the shared infinite-scroll feed hook (pure logic)
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import {
  videoQueryKey,
  mergeVideos,
  fetchVideoPage,
} from "./useInfiniteVideos";

describe("videoQueryKey", () => {
  it("is stable for equivalent queries with missing optional fields", () => {
    expect(videoQueryKey({})).toBe(videoQueryKey({ q: "", category: "", sort: "" }));
  });

  it("differs when any filter field changes", () => {
    const base = videoQueryKey({ q: "a", category: "music", sort: "newest" });
    expect(videoQueryKey({ q: "b", category: "music", sort: "newest" })).not.toBe(base);
    expect(videoQueryKey({ q: "a", category: "comedy", sort: "newest" })).not.toBe(base);
    expect(videoQueryKey({ q: "a", category: "music", sort: "popular" })).not.toBe(base);
    expect(videoQueryKey({ q: "a", category: "music", sort: "newest", duration: "short" })).not.toBe(base);
    expect(videoQueryKey({ q: "a", category: "music", sort: "newest", date: "week" })).not.toBe(base);
    expect(videoQueryKey({ q: "a", category: "music", sort: "newest", pageSize: 12 })).not.toBe(base);
  });

  it("defaults sort to 'newest' so undefined and explicit newest match", () => {
    expect(videoQueryKey({ sort: undefined })).toBe(videoQueryKey({ sort: "newest" }));
  });
});

describe("mergeVideos", () => {
  const v = (id: string) => ({ id, title: id });

  it("replace discards the previous list", () => {
    const merged = mergeVideos([v("a"), v("b")], [v("c")], true);
    expect(merged.map((x) => x.id)).toEqual(["c"]);
  });

  it("append keeps the existing list and adds new items in order", () => {
    const merged = mergeVideos([v("a"), v("b")], [v("c"), v("d")], false);
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("deduplicates overlapping pages by id", () => {
    const merged = mergeVideos([v("a"), v("b")], [v("b"), v("c")], false);
    expect(merged.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const prev = [v("a")];
    mergeVideos(prev, [v("b")], false);
    expect(prev.map((x) => x.id)).toEqual(["a"]);
  });

  it("replace with duplicates inside the incoming batch still dedupes", () => {
    const merged = mergeVideos([], [v("a"), v("a"), v("b")], true);
    expect(merged.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("fetchVideoPage", () => {
  it("builds the request with all query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        success: true,
        data: { videos: [{ id: "v1" }], pagination: { totalPages: 3 } },
      }),
    }) as unknown as typeof fetch;

    const result = await fetchVideoPage(
      { q: "afro", category: "music", sort: "popular", duration: "short", date: "week", pageSize: 12 },
      2,
      fetchMock
    );

    const calledUrl = (fetchMock as any).mock.calls[0][0] as string;
    const params = new URLSearchParams(calledUrl.split("?")[1]);
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("12");
    expect(params.get("sort")).toBe("popular");
    expect(params.get("q")).toBe("afro");
    expect(params.get("category")).toBe("music");
    expect(params.get("duration")).toBe("short");
    expect(params.get("date")).toBe("week");

    expect(result.totalPages).toBe(3);
    expect(result.videos).toHaveLength(1);
  });

  it("omits empty optional params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { videos: [], pagination: { totalPages: 0 } } }),
    }) as unknown as typeof fetch;

    await fetchVideoPage({ pageSize: 20 }, 1, fetchMock);
    const calledUrl = (fetchMock as any).mock.calls[0][0] as string;
    const params = new URLSearchParams(calledUrl.split("?")[1]);
    expect(params.get("q")).toBeNull();
    expect(params.get("category")).toBeNull();
    expect(params.get("duration")).toBeNull();
    expect(params.get("date")).toBeNull();
    expect(params.get("sort")).toBe("newest");
  });

  it("throws when the API reports failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, error: "boom" }),
    }) as unknown as typeof fetch;

    await expect(fetchVideoPage({}, 1, fetchMock)).rejects.toThrow("boom");
  });

  it("throws on a malformed payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: {} }),
    }) as unknown as typeof fetch;

    await expect(fetchVideoPage({}, 1, fetchMock)).rejects.toThrow();
  });
});
