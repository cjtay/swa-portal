#!/usr/bin/env node

/**
 * Interactive script to update swa:reg_tables_config in Cloudflare KV.
 *
 * Usage:
 *   node scripts/update-tables.js            # Live update
 *   node scripts/update-tables.js --dry-run  # Preview JSON without pushing
 *
 * The script fetches the current config from production KV,
 * lets you add/edit/remove tables or change the cutoff time,
 * validates the result, and pushes it via wrangler.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const KV_NAMESPACE_ID = 'ddb93996417c4476ac0f90ddf1eb332d';
const KV_KEY = 'swa:reg_tables_config';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

function questionYN(prompt, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  return new Promise((resolve) => {
    rl.question(prompt + suffix, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function questionChoice(prompt, choices) {
  return new Promise((resolve) => {
    const lines = choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    rl.question(prompt + '\n' + lines + '\n> ', (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) resolve(idx);
      else resolve(-1);
    });
  });
}

function derivePrefix(id, isVIP) {
  if (isVIP) {
    const match = id.match(/VIP-(\d+)/i);
    if (match) return 'V' + match[1];
    return 'V' + id.replace(/[^0-9]/g, '');
  }
  return id;
}

async function fetchCurrentConfig() {
  try {
    const cmd = `npx wrangler kv:key get --namespace-id=${KV_NAMESPACE_ID} --remote "${KV_KEY}"`;
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function validateConfig(config) {
  if (!config.formCutoffTime || typeof config.formCutoffTime !== 'string') {
    return 'formCutoffTime is missing or not a string.';
  }
  if (!Array.isArray(config.tables) || config.tables.length === 0) {
    return 'tables must be a non-empty array.';
  }
  const ids = new Set();
  const prefixes = new Set();
  for (const t of config.tables) {
    if (!t.id || typeof t.id !== 'string') return `Table has missing or invalid id: ${JSON.stringify(t)}`;
    if (ids.has(t.id)) return `Duplicate table id: ${t.id}`;
    ids.add(t.id);
    if (!t.label || typeof t.label !== 'string') return `Table ${t.id} has missing label.`;
    if (!t.ticketPrefix || typeof t.ticketPrefix !== 'string') return `Table ${t.id} has missing ticketPrefix.`;
    if (prefixes.has(t.ticketPrefix)) return `Duplicate ticketPrefix: ${t.ticketPrefix}`;
    prefixes.add(t.ticketPrefix);
    if (typeof t.capacity !== 'number' || t.capacity < 1) return `Table ${t.id} has invalid capacity: ${t.capacity}`;
    if (typeof t.isVIP !== 'boolean') return `Table ${t.id} has missing isVIP.`;
  }
  return null;
}

function printConfig(config) {
  console.log('\n  Cutoff: ' + config.formCutoffTime);
  console.log('  Tables:');
  for (const t of config.tables) {
    const vip = t.isVIP ? ' (VIP)' : '';
    console.log(`    ${t.id}: ${t.label}${vip} — prefix "${t.ticketPrefix}", ${t.capacity} seats`);
  }
  console.log();
}

async function pushConfig(config) {
  const tmpFile = path.join(__dirname, '_table-config-tmp.json');
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));

  try {
    const cmd = `npx wrangler kv:key put --namespace-id=${KV_NAMESPACE_ID} --remote "${KV_KEY}" --file="${tmpFile}" --path`;
    console.log('\n  Pushing to KV...');
    if (dryRun) {
      console.log('  [DRY RUN] Would run:');
      console.log('  ' + cmd);
    } else {
      execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
      console.log('  Done! Changes take effect immediately.');
    }
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

async function main() {
  console.log('========================================');
  console.log('  SWA Registration Table Config Update');
  console.log('========================================\n');

  if (dryRun) {
    console.log('  [DRY RUN MODE] No changes will be pushed.\n');
  }

  // 1. Fetch current config
  console.log('  Fetching current config from production KV...');
  let config = await fetchCurrentConfig();

  if (config) {
    console.log('  Current config found:\n');
    printConfig(config);
  } else {
    console.log('  No config found. Starting fresh.\n');
    config = {
      formCutoffTime: '2026-06-20T18:00:00+08:00',
      tables: [],
    };
  }

  // 2. Interactive loop
  let running = true;
  while (running) {
    console.log('---');
    const action = await questionChoice('What do you want to do?', [
      'Add a table',
      'Edit a table',
      'Remove a table',
      'Change cutoff time',
      'Preview and push',
      'Exit without saving',
    ]);

    switch (action) {
      case 0: {
        // Add table
        const id = await question('  Table ID (e.g. "03" or "VIP-3"): ');
        if (config.tables.find((t) => t.id === id)) {
          console.log(`  Table "${id}" already exists. Use Edit instead.`);
          break;
        }
        const isVIP = await questionYN(`  Is "${id}" a VIP table?`);
        const suggestedPrefix = derivePrefix(id, isVIP);
        const prefix = await question(`  Ticket prefix [${suggestedPrefix}]: `) || suggestedPrefix;
        const defaultLabel = isVIP
          ? id.replace(/-/g, '-').toUpperCase()
          : `Table ${parseInt(id, 10) || id}`;
        const label = await question(`  Display label [${defaultLabel}]: `) || defaultLabel;
        const capacity = parseInt(await question(`  Number of seats [10]: `) || '10', 10);

        config.tables.push({ id, label, ticketPrefix: prefix, capacity, isVIP });
        console.log(`  Added ${label} (${id}).`);
        break;
      }
      case 1: {
        // Edit table
        if (config.tables.length === 0) {
          console.log('  No tables to edit.');
          break;
        }
        const editIdx = await questionChoice(
          '  Which table?',
          config.tables.map((t) => `${t.id}: ${t.label} (${t.capacity} seats${t.isVIP ? ', VIP' : ''})`),
        );
        if (editIdx < 0) break;
        const t = config.tables[editIdx];

        const newLabel = await question(`  Label [${t.label}]: `) || t.label;
        const newCapacity = parseInt(await question(`  Seats [${t.capacity}]: `) || String(t.capacity), 10);
        const newVIP = await questionYN(`  VIP?`, t.isVIP);
        const newPrefix = newVIP !== t.isVIP ? derivePrefix(t.id, newVIP) : t.ticketPrefix;
        const finalPrefix = await question(`  Ticket prefix [${newPrefix}]: `) || newPrefix;

        t.label = newLabel;
        t.capacity = newCapacity;
        t.isVIP = newVIP;
        t.ticketPrefix = finalPrefix;
        console.log(`  Updated ${t.id}.`);
        break;
      }
      case 2: {
        // Remove table
        if (config.tables.length === 0) {
          console.log('  No tables to remove.');
          break;
        }
        const rmIdx = await questionChoice(
          '  Which table to remove?',
          config.tables.map((t) => `${t.id}: ${t.label}`),
        );
        if (rmIdx < 0) break;
        const removed = config.tables.splice(rmIdx, 1)[0];
        console.log(`  Removed ${removed.id}: ${removed.label}`);
        console.log('  WARNING: Make sure no bookings or guests reference this table ID.');
        break;
      }
      case 3: {
        // Change cutoff
        const current = config.formCutoffTime;
        const newCutoff = await question(`  New cutoff time [${current}]: `) || current;
        config.formCutoffTime = newCutoff;
        console.log(`  Cutoff set to ${newCutoff}`);
        break;
      }
      case 4: {
        // Preview and push
        const error = validateConfig(config);
        if (error) {
          console.log(`  Validation error: ${error}`);
          console.log('  Fix the issue and try again.\n');
          break;
        }

        console.log('\n  Final config:\n');
        printConfig(config);
        console.log(JSON.stringify(config, null, 2));
        console.log();

        const confirmed = await questionYN('  Push this config to production?');
        if (confirmed) {
          await pushConfig(config);
          running = false;
        } else {
          console.log('  Not pushed. You can continue editing.\n');
        }
        break;
      }
      case 5: {
        // Exit
        console.log('  Exiting without changes.');
        running = false;
        break;
      }
      default:
        console.log('  Invalid choice.');
        break;
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  rl.close();
  process.exit(1);
});