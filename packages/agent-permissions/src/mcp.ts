import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Address, type Hex, type PublicClient, createPublicClient, http } from 'viem';
import { z } from 'zod';
import { createPermissionsClient, ink, address, bytes32 } from './index.js';

export interface PermissionsMcpConfig { manager?: Address; rpcUrl?: string; publicClient?: PublicClient }
const addressSchema = z.string().refine((s) => { try { address(s); return true; } catch { return false; } }, 'Nonzero EVM address required');
const idSchema = z.string().refine((s) => { try { bytes32(s); return true; } catch { return false; } }, 'Nonzero bytes32 reference required');
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v) }] });

export function registerPermissionsTools(server: Pick<McpServer, 'registerTool'>, config: PermissionsMcpConfig) {
  const client = config.manager ? createPermissionsClient(config.publicClient ?? createPublicClient({ chain: ink, transport: http(config.rpcUrl) }), config.manager) : undefined;
  async function run(action: (sdk: NonNullable<typeof client>) => Promise<unknown>) {
    try {
      if (!client) throw new Error('Configure FOUR02_SPENDING_MANAGER_ADDRESS with a verified Ink deployment. No manager is enabled by default.');
      return result({ ok: true, ...await action(client) as object });
    } catch (error) {
      return { ...result({ ok: false, error: (error as Error).message }), isError: true };
    }
  }
  server.registerTool('permissions_grant', {
    description: 'Prepare an UNSIGNED owner approval/grant plan for USDC spending on Ink. Funds stay in the owner wallet. Daily limits are per permission and reset at UTC midnight. Only the human owner may approve this plan. Token approval is finite and shared across the owner’s grants. Never signs or broadcasts.',
    inputSchema: { owner: addressSchema, agent: addressSchema, dailyLimitUsdc: z.string(),
      validAfter: z.number().int().nonnegative(), validUntil: z.number().int().positive(),
      recipients: z.array(addressSchema).min(1).max(32), salt: idSchema },
  }, async (args) => run(async (sdk) => ({ status: 'unsigned', plan: await sdk.prepareGrant({ ...args, owner: args.owner as Address,
    agent: args.agent as Address, recipients: args.recipients as Address[], salt: args.salt as Hex }) })));
  server.registerTool('permissions_pay', {
    description: 'Simulate and prepare an UNSIGNED agent USDC payment using an existing owner grant. Requires an approved recipient, remaining budget, unexpired permission, and a stable invoice/order paymentId. A plan or used paymentId is NOT proof of payment. Never signs or broadcasts.',
    inputSchema: { permissionId: idSchema, recipient: addressSchema, amountUsdc: z.string(), paymentId: idSchema },
  }, async (args) => run(async (sdk) => sdk.preparePayment({ ...args, permissionId: args.permissionId as Hex,
    recipient: args.recipient as Address, paymentId: args.paymentId as Hex })));
  server.registerTool('permissions_revoke', {
    description: 'Prepare an UNSIGNED revocation for the human owner to approve. Revocation is effective only after the transaction confirms. Never signs or broadcasts.',
    inputSchema: { permissionId: idSchema, owner: addressSchema },
  }, async (args) => run(async (sdk) => ({ status: 'unsigned', plan: await sdk.prepareRevoke(args.permissionId as Hex, args.owner as Address) })));
  server.registerTool('permissions_status', {
    description: 'Read an onchain permission, remaining UTC-day budget, token allowance and owner balance from the same Ink block. Available amount does not prove an invoice has been paid.',
    inputSchema: { permissionId: idSchema },
  }, async (args) => run((sdk) => sdk.status(args.permissionId as Hex)));
}
