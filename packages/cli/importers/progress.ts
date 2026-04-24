/**
 * Single-line progress reporter for long-running imports.
 *
 * Writes a spinner + counters + current-item label to stderr on a line
 * that gets rewritten in place. Verbose log lines routed through
 * `log()` are printed above the live line so the progress doesn't
 * scroll past them.
 *
 * The spinner is driven by a timer (not by event calls) so the
 * animation stays smooth even during long awaits. `scan()` and
 * `process()` only update state (counters / label); the next timer
 * tick picks up the change on the next frame (worst-case ~80ms lag,
 * which is imperceptible). Previously the frame advanced once per
 * event call, which caused visible stutter both when events were rare
 * (spinner froze) and when events burst (spinner sped up).
 *
 * Only activates on a TTY — when stderr is piped or redirected, all
 * methods degrade to plain `console.log` (for `log()`) or noops.
 */
import { basename } from "node:path";

const SPINNER_FRAMES = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
];
const CLEAR_LINE = "\x1b[2K\r";
/** Spinner animation interval — 80ms ≈ 12.5fps, smooth and cheap. */
const SPINNER_TICK_MS = 80;
/** Fallback terminal width when `stream.columns` is unavailable. */
const FALLBACK_COLUMNS = 80;
/** Minimum width we'll bother rendering into. */
const MIN_COLUMNS = 20;
/** Leave one column unused to avoid terminal auto-wrap. */
const RIGHT_MARGIN = 1;

export interface ProgressReporter {
  /** Begin showing the live progress line. No-op if not TTY-capable. */
  start(): void;
  /** Stop and clear the live line. Safe to call multiple times. */
  stop(): void;
  /**
   * Record that a new source file is being scanned. Updates the
   * scanned counter and the current label (basename of the file).
   */
  scan(file: string): void;
  /**
   * Record that a session is being processed (post-filter, pre-write).
   * Updates the processed counter and the current label.
   */
  process(label: string): void;
  /**
   * Log a line above the progress line. Falls through to console.log
   * when the reporter is inactive.
   */
  log(line: string): void;
}

/**
 * Create a progress reporter appropriate for the given stream. Returns
 * a no-op reporter when the stream isn't a TTY.
 */
export function createProgressReporter(
  stream: NodeJS.WriteStream,
): ProgressReporter {
  if (!stream.isTTY) {
    return {
      start() {},
      stop() {},
      scan() {},
      process() {},
      log(line: string) {
        console.log(line);
      },
    };
  }

  let scanned = 0;
  let processed = 0;
  let label = "";
  let spinnerIdx = 0;
  let active = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function maxRenderWidth(): number {
    const columns = Math.max(stream.columns ?? FALLBACK_COLUMNS, MIN_COLUMNS);
    return Math.max(columns - RIGHT_MARGIN, MIN_COLUMNS - RIGHT_MARGIN);
  }

  function truncateToWidth(s: string, width: number): string {
    if (width <= 0) return "";
    if (s.length <= width) return s;
    if (width === 1) return "\u2026";
    return `${s.slice(0, width - 1)}\u2026`;
  }

  function render(): string {
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length] ?? "";
    const counters = `[${scanned} scanned, ${processed} processed]`;
    const prefix = `  ${frame} ${counters}`;
    const width = maxRenderWidth();
    const availableForLabel = width - prefix.length;
    if (!label || availableForLabel <= 0) {
      return truncateToWidth(prefix, width);
    }

    const labelPrefix = " \u00b7 ";
    const labelWidth = availableForLabel - labelPrefix.length;
    if (labelWidth <= 0) {
      return truncateToWidth(prefix, width);
    }

    return `${prefix}${labelPrefix}${truncateToWidth(label, labelWidth)}`;
  }

  function draw(): void {
    if (!active) return;
    stream.write(`${CLEAR_LINE}${render()}`);
  }

  function tick(): void {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
    draw();
  }

  function clear(): void {
    if (!active) return;
    stream.write(CLEAR_LINE);
  }

  return {
    start() {
      if (active) return;
      active = true;
      draw();
      timer = setInterval(tick, SPINNER_TICK_MS);
      // Don't keep the process alive just for the spinner.
      timer.unref?.();
    },
    stop() {
      if (!active) return;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clear();
      active = false;
    },
    scan(file: string) {
      scanned++;
      label = basename(file);
      // State-only update — the timer draws the next frame.
    },
    process(newLabel: string) {
      processed++;
      label = newLabel;
      // State-only update — the timer draws the next frame.
    },
    log(line: string) {
      if (!active) {
        console.log(line);
        return;
      }
      clear();
      stream.write(`${line}\n`);
      draw();
    },
  };
}
