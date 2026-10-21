import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Resolve relative to this installation, so a host can launch MCP from any cwd.
export const projectRoot = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? '../' : '../../', import.meta.url),
);
export const dbPath = resolve(
  process.env.REHEARSAL_DB || resolve(projectRoot, 'data/rehearsal.sqlite'),
);
