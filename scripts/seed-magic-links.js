#!/usr/bin/env node
/**
 * Generate magic-link tokens for existing bookings.
 *
 * Usage:
 *   node scripts/seed-magic-links.js [--dry-run]
 *
 * This script reads all bookings from D1 that have a buyer_email but no token yet,
 * generates token INSERT statements, and outputs the magic link URLs.
 *
 * To use:
 *   1. Run with --dry-run to preview
 *   2. Run without --dry-run to generate SQL
 *   3. Pipe SQL to wrangler:
 *      node scripts/seed-magic-links.js > magic-links.sql
 *      npx wrangler d1 execute swa-portal --remote --file=magic-links.sql
 *   4. Copy the printed URLs and send them via the admin UI "Copy Link" button
 *      or share manually
 *
 * Note: This script does NOT send emails. Use the admin UI "Send Magic Link" button
 * to trigger email sending through Resend, or share the URLs manually.
 *
 * Prerequisite: The formCutoffTime in KV config (swa:reg_tables_config) determines
 * when tokens expire. Make sure it's set before running this.
 */

const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// Read booking data from seed-data file or provide manually
// For real use, you would query D1 directly:
//   npx wrangler d1 execute swa-portal --remote --command="SELECT id, booking_ref, buyer_email, buyer_name FROM reg_bookings WHERE buyer_email IS NOT NULL" --json
// Then paste the results into a JSON file referenced here.

const FORM_CUTOFF_TIME = '2026-06-20T18:00:00+08:00';

console.log('-- Magic link token generator');
console.log('-- Generated at: ' + new Date().toISOString());
console.log('-- Token expiry: ' + FORM_CUTOFF_TIME);
console.log('');

if (dryRun) {
  console.log('-- DRY RUN MODE');
  console.log('-- In production, you would:');
  console.log('--   1. Query D1 for bookings with buyer_email that have no token yet');
  console.log('--   2. Generate token INSERT statements');
  console.log('--   3. Apply via: npx wrangler d1 execute swa-portal --remote --file=magic-links.sql');
  console.log('');

  // Example output
  const exampleToken = crypto.randomBytes(16).toString('hex');
  const exampleUrl = `https://admin.singaporewomenassociation.org/reg/buyer/?token=${exampleToken}`;
  console.log('-- Example token: ' + exampleToken);
  console.log('-- Example URL: ' + exampleUrl);
  console.log('');
  console.log('To query bookings needing tokens:');
  console.log('  npx wrangler d1 execute swa-portal --remote --command="SELECT id, booking_ref, buyer_email, buyer_name FROM reg_bookings WHERE buyer_email IS NOT NULL AND buyer_email != \\"\\"," --json');
  console.log('');
  console.log('To generate tokens for specific bookings, create a JSON file with:');
  console.log('  [');
  console.log('    { "id": "booking-uuid", "booking_ref": "REG-ABC12", "buyer_email": "buyer@example.com", "buyer_name": "Buyer Name" }');
  console.log('  ]');
  console.log('');
  console.log('Then run: node scripts/seed-magic-links.js bookings.json');
} else {
  console.log('-- No booking data file provided.');
  console.log('-- Usage: node scripts/seed-magic-links.js <bookings.json>');
  console.log('');
  console.log('-- To get booking data from D1, run:');
  console.log('--   npx wrangler d1 execute swa-portal --remote --json --command="SELECT id, booking_ref, buyer_email, buyer_name FROM reg_bookings WHERE buyer_email IS NOT NULL"');
  console.log('--');
  console.log('-- Save the "results" array as a JSON file, then run:');
  console.log('--   node scripts/seed-magic-links.js bookings.json');

  if (args.length > 0 && !args[0].startsWith('--')) {
    const dataFile = args[0];
    try {
      const bookings = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      const baseUrl = 'https://admin.singaporewomenassociation.org';

      console.log('');
      console.log('-- Generating tokens for ' + bookings.length + ' booking(s)');
      console.log('');

      const urls = [];

      for (const b of bookings) {
        const token = crypto.randomBytes(16).toString('hex');
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

        console.log(`-- Token for ${b.buyer_name} (${b.buyer_email})`);
        console.log(
          `INSERT INTO reg_tokens (token, booking_id, created_at, expires_at) ` +
          `VALUES ('${token}', '${b.id}', '${now}', '${FORM_CUTOFF_TIME}');`
        );
        console.log('');

        urls.push({
          booking_ref: b.booking_ref,
          buyer_name: b.buyer_name,
          buyer_email: b.buyer_email,
          url: `${baseUrl}/reg/buyer/?token=${token}`,
        });
      }

      console.log('-- Magic link URLs:');
      console.log('-- (Copy these and share via WhatsApp, or use the admin UI to send emails)');
      console.log('');
      for (const u of urls) {
        console.log(`-- ${u.buyer_name} (${u.booking_ref}): ${u.url}`);
      }
    } catch (err) {
      console.error('Error reading file: ' + err.message);
    }
  }
}