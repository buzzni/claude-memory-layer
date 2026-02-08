/**
 * Projects API
 * Endpoints for listing available projects
 */

import { Hono } from 'hono';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadSessionRegistry } from '../../services/memory-service.js';

export const projectsRouter = new Hono();

// GET /api/projects - List available projects
projectsRouter.get('/', async (c) => {
  try {
    const projectsDir = path.join(os.homedir(), '.claude-code', 'memory', 'projects');

    if (!fs.existsSync(projectsDir)) {
      return c.json({ projects: [] });
    }

    // Read project directories
    const projectHashes = fs.readdirSync(projectsDir)
      .filter(name => {
        const fullPath = path.join(projectsDir, name);
        return fs.statSync(fullPath).isDirectory();
      });

    // Load session registry to map hashes to project paths
    const registry = loadSessionRegistry();
    const hashToPath = new Map<string, string>();
    for (const entry of Object.values(registry.sessions)) {
      if (!hashToPath.has(entry.projectHash)) {
        hashToPath.set(entry.projectHash, entry.projectPath);
      }
    }

    // Build project list
    const projects = projectHashes.map(hash => {
      const dirPath = path.join(projectsDir, hash);
      const dbPath = path.join(dirPath, 'events.sqlite');
      let dbSize = 0;
      if (fs.existsSync(dbPath)) {
        dbSize = fs.statSync(dbPath).size;
      }

      const projectPath = hashToPath.get(hash) || `unknown (${hash})`;

      return {
        hash,
        projectPath,
        projectName: path.basename(projectPath),
        dbSize,
        dbSizeHuman: formatBytes(dbSize)
      };
    });

    // Sort by project name
    projects.sort((a, b) => a.projectName.localeCompare(b.projectName));

    return c.json({ projects });
  } catch (error) {
    return c.json({ projects: [], error: (error as Error).message }, 500);
  }
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
