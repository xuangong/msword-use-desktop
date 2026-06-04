/**
 * Pure NDJSON line splitter — extracted from DriverClient.pump so we can
 * fuzz it without spawning a real subprocess.
 *
 * Semantics:
 *   - Stream bytes (Uint8Array chunks) in, get fully-formed UTF-8 lines out.
 *   - Boundaries are LF (0x0A); CR before LF is stripped.
 *   - UTF-8 codepoints split across chunks are buffered until the next chunk completes them.
 *   - Empty lines are dropped.
 *   - Malformed UTF-8 is replaced with U+FFFD (matches TextDecoder default).
 */

export class NdjsonSplitter {
  private buf = "";
  private decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Flush any final bytes from the decoder. Lines without trailing LF are dropped. */
  end(): string[] {
    this.buf += this.decoder.decode();
    const out = this.drain();
    this.buf = "";
    return out;
  }

  private drain(): string[] {
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
    return lines;
  }
}
