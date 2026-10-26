// A synthetic upstream's tool list for the "many tools" tests (ADR 012): 120 plausible
// verb × noun tools plus a few distinctive ones a search must find among them.
import type { FakeTool } from './fake-upstream.js';

const VERBS = [
  'list',
  'get',
  'create',
  'update',
  'delete',
  'archive',
  'export',
  'import',
  'count',
  'search',
];
const NOUNS = [
  'order',
  'product',
  'customer',
  'invoice',
  'coupon',
  'shipment',
  'review',
  'category',
  'supplier',
  'warehouse',
  'report',
  'webhook',
];

export const DISTINCTIVE: FakeTool[] = [
  { name: 'refund_payment', description: "Refund a captured payment back to the customer's card" },
  { name: 'issue_gift_card', description: 'Issue a gift card with a balance to an email address' },
  { name: 'translate_text', description: 'Translate a text between two languages' },
];

export function syntheticTools(): FakeTool[] {
  const tools: FakeTool[] = [];
  for (const verb of VERBS) {
    for (const noun of NOUNS) {
      tools.push({
        name: `${verb}_${noun}s`,
        description: `${verb} ${noun} records in the back office`,
      });
    }
  }
  return [...tools, ...DISTINCTIVE];
}
