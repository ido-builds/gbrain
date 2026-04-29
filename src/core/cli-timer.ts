/**
 * Top-level command timer for the gbrain CLI.
 *
 * Renders a small ticking line on stderr ("⠋ 3.2s  gbrain query …") while a
 * command runs, then prints a final "✓ done in 3.2s" / "✗ failed in 3.2s"
 * when the command stops. The live ticker yields the line whenever the
 * shared bulk-progress reporter has an active phase so the two don't fight
 * over `\r` — when the bulk reporter is rendering a `[doctor.db_checks] 4/9`
 * line, the timer holds its ground until that phase finishes.
 *
 * Visibility rules:
 *   - stderr.isTTY === true → live ticker + final summary
 *   - non-TTY                → silent (script/pipeline output stays unchanged)
 *   - --quiet (CliOptions)   → silent
 *   - NO_COLOR env set       → no ANSI color, but ticker still renders
 *
 * Stdout is never touched. Tests that capture stdout see no change.
 */

import { hasLiveProgressPhase } from './progress.ts';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface CliTimerOptions {
  label: string;
  stream?: NodeJS.WritableStream;
  quiet?: boolean;
  intervalMs?: number;
  /** Force on/off regardless of TTY detection (tests). */
  forceTty?: boolean;
}

export interface CliTimer {
  stop(status: 'ok' | 'fail'): void;
}

function isTty(stream: NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

function colorEnabled(stream: NodeJS.WritableStream): boolean {
  if (process.env.NO_COLOR) return false;
  return isTty(stream);
}

function color(stream: NodeJS.WritableStream, code: string, text: string): string {
  if (!colorEnabled(stream)) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/**
 * Start a timer. The returned handle's `stop()` MUST be called exactly once
 * so the interval is cleared and the cursor moves to a fresh line.
 */
export function startCliTimer(opts: CliTimerOptions): CliTimer {
  const stream = opts.stream ?? process.stderr;
  const quiet = !!opts.quiet;
  const tty = opts.forceTty ?? isTty(stream);
  const intervalMs = opts.intervalMs ?? 1000;
  const startedAt = Date.now();

  // Silent path: still return a handle so callers don't branch.
  if (quiet || !tty) {
    return { stop: () => { /* no-op */ } };
  }

  let frame = 0;
  let rendered = false;
  let stopped = false;

  const clearLine = () => {
    if (rendered) {
      stream.write('\r\x1b[2K');
      rendered = false;
    }
  };

  const draw = () => {
    if (stopped) return;
    if (hasLiveProgressPhase()) {
      // Bulk reporter owns the line; back off until it finishes.
      clearLine();
      return;
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    frame++;
    const line = `${color(stream, '36', spin)} ${color(stream, '36', formatElapsed(elapsed))}  ${opts.label}`;
    stream.write(`\r\x1b[2K${line}`);
    rendered = true;
  };

  // First paint, then schedule.
  draw();
  const handle = setInterval(draw, intervalMs);
  // Don't keep the event loop alive solely for the timer — once the command's
  // own work resolves the process can exit.
  if (typeof (handle as unknown as { unref?: () => void }).unref === 'function') {
    (handle as unknown as { unref: () => void }).unref();
  }

  return {
    stop(status: 'ok' | 'fail') {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      clearLine();
      const elapsed = (Date.now() - startedAt) / 1000;
      const icon = status === 'ok'
        ? color(stream, '32', '✓')
        : color(stream, '31', '✗');
      const verb = status === 'ok' ? 'done' : 'failed';
      stream.write(`${icon} ${verb} in ${formatElapsed(elapsed)}\n`);
    },
  };
}
