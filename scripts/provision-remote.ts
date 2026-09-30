import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTaapServer } from '../src/taap/server.js';
import { TaapDb } from '../src/taap/db.js';

const db = new TaapDb(':memory:');
const server = createTaapServer({
  db,
  config: { mode: 'paper', dbPath: ':memory:', claimServerUrl: 'https://shaggy-rings-hear.loca.lt' },
});
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'smoke', version: '0.0.0' });
await Promise.all([client.connect(ct), server.connect(st)]);

const call = async (name: string, args: any) =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);

const p = await call('provision_wallet', {});
console.log('provisioned:', p.ok, '| url:', p.claim_url, '| mode:', p.claim_mode);

const s1 = await call('claim_status', { trader_id: p.trader_id });
console.log('before ceremony:', s1.ceremony_status, '| backed_up:', s1.backed_up, '| address:', s1.deposit_address);

const page = await fetch(p.claim_url);
console.log('claim page HTTP:', page.status);

db.close();
process.exit(0);
