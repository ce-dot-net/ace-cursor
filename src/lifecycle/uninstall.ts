/**
 * ACE Extension Uninstall Cleanup
 *
 * Runs when the extension is uninstalled from VS Code/Cursor.
 * Registered via package.json "vscode:uninstall" script.
 *
 * Cleans up:
 * - .cursor/hooks.json (removes ACE hooks, preserves non-ACE hooks)
 * - .cursor/scripts/ace_*.sh and ace_*.ps1
 * - .cursor/rules/ace-* folders
 * - .cursor/commands/ace-*.md
 * - .cursor/ace/ data directory
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function cleanup() {
  // Find workspace roots from Cursor's project directories
  const cursorProjectsDir = path.join(os.homedir(), '.cursor', 'projects');

  if (!fs.existsSync(cursorProjectsDir)) {
    return;
  }

  // Also try current working directory (might be the workspace)
  const possibleRoots: string[] = [];

  if (process.cwd() && fs.existsSync(path.join(process.cwd(), '.cursor'))) {
    possibleRoots.push(process.cwd());
  }

  // Scan Cursor projects for any that have ACE hooks
  try {
    const projects = fs.readdirSync(cursorProjectsDir);
    for (const project of projects) {
      const projectDir = path.join(cursorProjectsDir, project);
      // The project name encodes the workspace path
      const wsPath = '/' + project.replace(/-/g, '/');
      if (fs.existsSync(wsPath) && fs.existsSync(path.join(wsPath, '.cursor', 'scripts'))) {
        possibleRoots.push(wsPath);
      }
    }
  } catch {
    // Ignore errors scanning projects
  }

  for (const root of possibleRoots) {
    cleanupWorkspace(root);
  }
}

function cleanupWorkspace(wsRoot: string) {
  const cursorDir = path.join(wsRoot, '.cursor');
  if (!fs.existsSync(cursorDir)) return;

  // 1. Clean hooks.json — remove ACE entries, keep others
  const hooksPath = path.join(cursorDir, 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    try {
      const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      if (hooks.hooks) {
        let modified = false;
        for (const [event, scripts] of Object.entries(hooks.hooks)) {
          if (Array.isArray(scripts)) {
            const filtered = scripts.filter((s: any) =>
              !s.command?.includes('ace_') && !s.command?.includes('/ace/')
            );
            if (filtered.length !== scripts.length) {
              hooks.hooks[event] = filtered;
              modified = true;
            }
            // Remove empty arrays
            if (filtered.length === 0) {
              delete hooks.hooks[event];
              modified = true;
            }
          }
        }
        if (modified) {
          if (Object.keys(hooks.hooks).length === 0) {
            // No hooks left — remove the file
            fs.unlinkSync(hooksPath);
          } else {
            fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
          }
        }
      }
    } catch {
      // If hooks.json is corrupt, remove it
      try { fs.unlinkSync(hooksPath); } catch {}
    }
  }

  // 2. Remove ACE scripts
  const scriptsDir = path.join(cursorDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    try {
      const files = fs.readdirSync(scriptsDir);
      for (const file of files) {
        if (file.startsWith('ace_')) {
          fs.unlinkSync(path.join(scriptsDir, file));
        }
      }
      // Remove scripts dir if empty
      if (fs.readdirSync(scriptsDir).length === 0) {
        fs.rmdirSync(scriptsDir);
      }
    } catch {}
  }

  // 3. Remove ACE rules (folder-based)
  const rulesDir = path.join(cursorDir, 'rules');
  if (fs.existsSync(rulesDir)) {
    try {
      const entries = fs.readdirSync(rulesDir);
      for (const entry of entries) {
        if (entry.startsWith('ace-')) {
          const entryPath = path.join(rulesDir, entry);
          if (fs.statSync(entryPath).isDirectory()) {
            fs.rmSync(entryPath, { recursive: true });
          } else {
            fs.unlinkSync(entryPath); // Legacy .mdc files
          }
        }
      }
      // Remove rules dir if empty
      if (fs.readdirSync(rulesDir).length === 0) {
        fs.rmdirSync(rulesDir);
      }
    } catch {}
  }

  // 4. Remove ACE commands
  const commandsDir = path.join(cursorDir, 'commands');
  if (fs.existsSync(commandsDir)) {
    try {
      const files = fs.readdirSync(commandsDir);
      for (const file of files) {
        if (file.startsWith('ace-')) {
          fs.unlinkSync(path.join(commandsDir, file));
        }
      }
      if (fs.readdirSync(commandsDir).length === 0) {
        fs.rmdirSync(commandsDir);
      }
    } catch {}
  }

  // 5. Remove ACE data directory
  const aceDir = path.join(cursorDir, 'ace');
  if (fs.existsSync(aceDir)) {
    try {
      fs.rmSync(aceDir, { recursive: true });
    } catch {}
  }
}

// Run cleanup
cleanup();
