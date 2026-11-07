/**
 * Machine identity for Mongo sync: tells a store that was copied or restored onto another machine apart from the
 * machine that created it, so the copy stops pushing under the original's origin id.
 *
 * Uses the OS machine id (Linux /etc/machine-id, macOS IOPlatformUUID, Windows MachineGuid), which survives
 * renames and network changes; os.hostname() is only the fallback, since a macOS hostname can follow the network.
 * A spurious change is safe (the store mints a new origin and re-reads its own old documents once); a missed one is
 * not, so the id must not be shared between machines. VMs or images cloned with their machine id are not told apart.
 * The raw id is hashed, never stored.
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as os from 'os';

const COMMAND_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf8',
  timeout: 2000,
  stdio: ['ignore', 'pipe', 'ignore']
};

function platformMachineId(): string | null {
  try {
    if (process.platform === 'linux') {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = readFileSync(file, 'utf8').trim();
          if (id) return id;
        } catch {
          // Try the next location.
        }
      }
      return null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], COMMAND_OPTIONS);
      return /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? null;
    }
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], COMMAND_OPTIONS);
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
    }
  } catch {
    // Fall back to the hostname.
  }
  return null;
}

let cached: string | null = null;

/** A hash of this machine's id, stable across restarts. */
export function machineFingerprint(): string {
  if (cached) return cached;
  const raw = platformMachineId() ?? `hostname:${os.hostname()}`;
  cached = createHash('sha256').update(`claude-memory-layer:mongo-sync:${raw}`).digest('hex').slice(0, 32);
  return cached;
}
