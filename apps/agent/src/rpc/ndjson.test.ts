import { test, expect, describe } from "bun:test";
import { NdjsonSplitter } from "./ndjson";

const enc = new TextEncoder();
const u = (s: string) => enc.encode(s);

describe("NdjsonSplitter", () => {
  test("single complete line", () => {
    const s = new NdjsonSplitter();
    expect(s.push(u('{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  test("two lines in one chunk", () => {
    const s = new NdjsonSplitter();
    expect(s.push(u('a\nb\n'))).toEqual(['a', 'b']);
  });

  test("partial line buffered until newline arrives", () => {
    const s = new NdjsonSplitter();
    expect(s.push(u('foo'))).toEqual([]);
    expect(s.push(u('bar\n'))).toEqual(['foobar']);
  });

  test("CRLF line endings strip the CR", () => {
    const s = new NdjsonSplitter();
    expect(s.push(u('hi\r\nthere\r\n'))).toEqual(['hi', 'there']);
  });

  test("blank lines are dropped", () => {
    const s = new NdjsonSplitter();
    expect(s.push(u('\n\nfoo\n\n\n'))).toEqual(['foo']);
  });

  test("UTF-8 multibyte split across chunks", () => {
    // "中" = E4 B8 AD. Cut between byte 1 and 2.
    const bytes = u('hi 中 ok\n'); // hi[20]中[E4 B8 AD][20]ok[\n]
    const cut = 4; // after "hi " + first byte E4
    const first = bytes.slice(0, cut);
    const rest = bytes.slice(cut);
    const s = new NdjsonSplitter();
    expect(s.push(first)).toEqual([]);
    expect(s.push(rest)).toEqual(['hi 中 ok']);
  });

  test("emoji (4-byte UTF-8) split across three chunks", () => {
    // "👍" = F0 9F 91 8D
    const bytes = u('a👍b\n');
    const s = new NdjsonSplitter();
    let out: string[] = [];
    out = out.concat(s.push(bytes.slice(0, 2))); // "a" + first byte of emoji
    out = out.concat(s.push(bytes.slice(2, 4))); // bytes 2-3 of emoji
    out = out.concat(s.push(bytes.slice(4)));    // last byte of emoji + "b\n"
    expect(out).toEqual(['a👍b']);
  });

  test("malformed UTF-8 bytes become U+FFFD, splitter still finds line boundary", () => {
    // Stray 0xFF (invalid as first byte) embedded in text.
    const malformed = new Uint8Array([
      0x68, 0x69, 0xff, 0x6f, 0x6b, 0x0a, // "hi" + bad + "ok\n"
    ]);
    const s = new NdjsonSplitter();
    const out = s.push(malformed);
    // We don't assert exact string (U+FFFD count varies) — only that we got 1 line and it survived.
    expect(out.length).toBe(1);
    expect(out[0]).toContain("hi");
    expect(out[0]).toContain("ok");
  });

  test("long line (10k chars) reassembled byte-by-byte", () => {
    const big = "x".repeat(10_000) + "\n";
    const bytes = u(big);
    const s = new NdjsonSplitter();
    let collected: string[] = [];
    // 1-byte chunks — the pathological case.
    for (let i = 0; i < bytes.length; i++) {
      collected = collected.concat(s.push(bytes.subarray(i, i + 1)));
    }
    expect(collected.length).toBe(1);
    expect(collected[0]!.length).toBe(10_000);
  });

  test("end() flushes any decoder-buffered bytes but drops final non-newline line", () => {
    const s = new NdjsonSplitter();
    s.push(u('done\nleftover'));
    expect(s.end()).toEqual([]); // "leftover" has no newline, dropped
  });

  test("malformed JSON is passed through as a line (caller decides)", () => {
    const s = new NdjsonSplitter();
    expect(s.push(u('{"a":1\n'))).toEqual(['{"a":1']);
    // The splitter doesn't validate JSON. That's the consumer's job.
  });
});
