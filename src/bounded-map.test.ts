import { describe, expect, test, vi } from "vitest";
import { BoundedMap } from "./bounded-map.js";

describe("constructor", () => {
  test("throws when maxSize is zero or negative", () => {
    expect(() => new BoundedMap(0)).toThrow("maxSize must be greater than 0");
    expect(() => new BoundedMap(-5)).toThrow("maxSize must be greater than 0");
  });

  test("behaves like a regular Map under the size limit", () => {
    const map = new BoundedMap<string, number>(3);

    map.set("a", 1).set("b", 2);

    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.size).toBe(2);
  });
});

describe("set()", () => {
  test("evicts the oldest entry when the size is exceeded", () => {
    const map = new BoundedMap<string, number>(2);

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  test("eviction follows insertion order across multiple overflows", () => {
    const map = new BoundedMap<string, number>(2);

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4);

    expect([...map.keys()]).toEqual(["c", "d"]);
  });

  test("updating an existing key does not evict and moves it to the end", () => {
    const map = new BoundedMap<string, number>(2);

    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10);

    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(10);
    expect([...map.keys()]).toEqual(["b", "a"]);
    /*
     * The set moved "a" to the newest position. Thus the map removes "b" first.
     */
    map.set("c", 3);
    expect([...map.keys()]).toEqual(["a", "c"]);
  });

  test("returns the map for chaining", () => {
    const map = new BoundedMap<string, number>(1);

    expect(map.set("a", 1)).toBe(map);
  });

  test("a map of size one only ever holds the latest entry", () => {
    const map = new BoundedMap<string, number>(1);

    map.set("a", 1);
    map.set("b", 2);

    expect([...map.entries()]).toEqual([["b", 2]]);
  });
});

describe("getOrInsert()", () => {
  test("returns the existing value without inserting", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);

    expect(map.getOrInsert("a", 99)).toBe(1);
    expect(map.size).toBe(1);
  });

  test("inserts the default value for a missing key", () => {
    const map = new BoundedMap<string, number>(2);

    expect(map.getOrInsert("a", 1)).toBe(1);
    expect(map.get("a")).toBe(1);
  });

  test("evicts the oldest entry when inserting over the limit", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);

    map.getOrInsert("c", 3);

    expect([...map.keys()]).toEqual(["b", "c"]);
  });
});

describe("getOrInsertComputed()", () => {
  test("returns the existing value without calling the callback", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    const callback = vi.fn(() => 99);

    expect(map.getOrInsertComputed("a", callback)).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  test("computes and inserts the value for a missing key", () => {
    const map = new BoundedMap<string, number>(2);
    const callback = vi.fn((key: string) => key.length);

    expect(map.getOrInsertComputed("abc", callback)).toBe(3);
    expect(map.get("abc")).toBe(3);
    expect(callback).toHaveBeenCalledExactlyOnceWith("abc");
  });

  test("evicts the oldest entry when inserting over the limit", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);

    map.getOrInsertComputed("c", () => 3);

    expect([...map.keys()]).toEqual(["b", "c"]);
  });
});

describe("inherited Map behavior", () => {
  test("delete frees a slot for a new entry without evicting", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);

    map.delete("a");
    map.set("c", 3);

    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  test("clear empties the map", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);

    map.clear();

    expect(map.size).toBe(0);
  });
});
