#!/usr/bin/env node
// Dependency-free sanity checks:
//   * every JS file parses
//   * every JSON file parses
//   * manifest.json references only files that exist and stays MV3-shaped
//   * HTML pages only reference local assets that exist

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const errors = [];
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function rel(file) {
  return path.relative(root, file);
}

const files = walk(root);

/* --- JS syntax ---------------------------------------------------- */
for (const file of files.filter((f) => f.endsWith('.js'))) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(source, { filename: file });
  } catch (err) {
    errors.push(`${rel(file)}: syntax error - ${err.message}`);
  }
}

/* --- JSON syntax -------------------------------------------------- */
for (const file of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    errors.push(`${rel(file)}: invalid JSON - ${err.message}`);
  }
}

/* --- Manifest ----------------------------------------------------- */
const manifestPath = path.join(root, 'manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (_err) {
  errors.push('manifest.json could not be parsed');
}

function requireFile(relativePath, context) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) {
    errors.push(`${context}: missing file "${relativePath}"`);
  }
}

if (manifest) {
  if (manifest.manifest_version !== 3) {
    errors.push('manifest.json: manifest_version must be 3');
  }
  if (manifest.background && manifest.background.page) {
    errors.push('manifest.json: MV3 forbids background.page; use background.service_worker');
  }
  if (manifest.background && manifest.background.service_worker) {
    requireFile(manifest.background.service_worker, 'manifest.background');
  }
  if (manifest.browser_action) {
    errors.push('manifest.json: MV3 uses "action", not "browser_action"');
  }
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) requireFile(file, 'manifest.content_scripts.js');
    for (const file of script.css || []) requireFile(file, 'manifest.content_scripts.css');
    if (!Array.isArray(script.matches) || script.matches.length === 0) {
      errors.push('manifest.json: every content script needs a non-empty "matches"');
    }
  }
  if (manifest.action && manifest.action.default_popup) {
    requireFile(manifest.action.default_popup, 'manifest.action');
  }
  for (const key of Object.keys(manifest.icons || {})) {
    requireFile(manifest.icons[key], 'manifest.icons');
  }
  for (const entry of manifest.web_accessible_resources || []) {
    for (const resource of entry.resources || []) {
      if (!resource.includes('*')) requireFile(resource, 'manifest.web_accessible_resources');
    }
    if ((entry.matches || []).includes('<all_urls>')) {
      errors.push(
        'manifest.web_accessible_resources: "<all_urls>" exposes extension files to every site'
      );
    }
  }
}

/* --- HTML asset references ---------------------------------------- */
for (const file of files.filter((f) => f.endsWith('.html'))) {
  const source = fs.readFileSync(file, 'utf8');
  const refs = [...source.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
    const target = path.resolve(path.dirname(file), ref);
    if (!fs.existsSync(target)) {
      errors.push(`${rel(file)}: references missing asset "${ref}"`);
    }
  }
}

if (errors.length) {
  console.error('Lint failed:\n');
  for (const error of errors) console.error(`  ✗ ${error}`);
  console.error('');
  process.exit(1);
}

console.log(`Lint passed (${files.length} files checked).`);
