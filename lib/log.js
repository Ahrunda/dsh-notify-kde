/**
 * Small append-only log at $DSH_HOME/notify-kde.log.
 *
 * The host logger's info level is often below the console threshold, so a
 * delivery that silently did nothing is indistinguishable from one that
 * worked. This file is the operator-facing answer to "did it fire?".
 *
 * @module dsh-notify-kde/log
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from './config.js';

const MAX_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

export function logPath() {
  return join(dshHome(), 'notify-kde.log');
}

/** Re-create the log from its own tail instead of truncating it to nothing. */
function rotate(file) {
  try {
    if (!existsSync(file) || statSync(file).size <= MAX_BYTES) return;
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      const newline = text.indexOf('\n');
      writeFileSync(file, newline >= 0 ? text.slice(newline + 1) : text);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Logging is best-effort.
  }
}

/**
 * Append one line; failures are swallowed so a read-only home cannot break
 * notification delivery.
 *
 * @param {string} level
 * @param {string} message
 */
export function appendLog(level, message) {
  const file = logPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotate(file);
    appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
  } catch {
    // Never let logging break delivery.
  }
}
