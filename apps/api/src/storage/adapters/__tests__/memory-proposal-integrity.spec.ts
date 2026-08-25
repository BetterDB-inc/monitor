import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { memoryForgetTargetDiscriminator } from '@betterdb/shared';
import type { MemoryForgetPayload, StoredMemoryProposal } from '@betterdb/shared';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

const CONNECTION = 'conn-1';
const STORE = 'store-1';

const BY_ID: MemoryForgetPayload = { target_kind: 'id', memory_id: 'mem-1' };
const BY_OTHER_ID: MemoryForgetPayload = { target_kind: 'id', memory_id: 'mem-2' };

const dbPaths: string[] = [];
let counter = 0;
function proposalInput(payload: MemoryForgetPayload = BY_ID) {
  counter++;
  return {
    id: `p-${counter}`,
    connection_id: CONNECTION,
    store_name: STORE,
    proposal_type: 'forget' as const,
    proposal_payload: payload,
    target_discriminator: memoryForgetTargetDiscriminator(payload),
  };
}

// Both adapters that implement StoragePort are exercised against the same
// expectations — the whole point of #276 is that the memory adapter enforced
// uniqueness in code while the SQL ones enforced nothing.
describe.each<[string, () => Promise<StoragePort>]>([
  ['memory', async () => new MemoryAdapter() as unknown as StoragePort],
  [
    'sqlite',
    async () => {
      const dbPath = path.join(os.tmpdir(), `memory-proposal-integrity-${randomUUID()}.db`);
      dbPaths.push(dbPath);
      const adapter = new SqliteAdapter({ filepath: dbPath });
      await adapter.initialize();
      return adapter as unknown as StoragePort;
    },
  ],
])('%s adapter memory-proposal integrity', (_name, make) => {
  let storage: StoragePort;

  beforeEach(async () => {
    storage = await make();
  });

  afterEach(async () => {
    const closable = storage as unknown as { close?: () => Promise<void> };
    if (typeof closable.close === 'function') {
      await closable.close();
    }
    for (const dbPath of dbPaths.splice(0)) {
      try {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
      } catch {
        // Teardown only: a lingering handle must not fail an otherwise green
        // assertion. The file lands in the OS temp dir either way.
      }
    }
  });

  describe('duplicate-pending guard', () => {
    it('counts an existing pending proposal for the same target', async () => {
      await storage.createMemoryProposal(proposalInput());

      const count = await storage.countPendingMemoryProposalsByTarget({
        connection_id: CONNECTION,
        store_name: STORE,
        target_discriminator: memoryForgetTargetDiscriminator(BY_ID),
      });

      expect(count).toBe(1);
    });

    it('does not count a different target', async () => {
      await storage.createMemoryProposal(proposalInput(BY_OTHER_ID));

      const count = await storage.countPendingMemoryProposalsByTarget({
        connection_id: CONNECTION,
        store_name: STORE,
        target_discriminator: memoryForgetTargetDiscriminator(BY_ID),
      });

      expect(count).toBe(0);
    });

    it('stops counting once the proposal leaves pending', async () => {
      const created = await storage.createMemoryProposal(proposalInput());
      await storage.updateMemoryProposalStatus({ id: created.id, status: 'rejected' });

      const count = await storage.countPendingMemoryProposalsByTarget({
        connection_id: CONNECTION,
        store_name: STORE,
        target_discriminator: memoryForgetTargetDiscriminator(BY_ID),
      });

      // The unique index is partial on status='pending' precisely so the same
      // target can be proposed again after the first is resolved.
      expect(count).toBe(0);
    });

    it('rejects a second pending proposal for the same target at the storage layer', async () => {
      await storage.createMemoryProposal(proposalInput());

      await expect(storage.createMemoryProposal(proposalInput())).rejects.toThrow(/unique/i);
    });
  });

  describe('stale-apply sweep', () => {
    async function claimed(at: number): Promise<StoredMemoryProposal> {
      const created = await storage.createMemoryProposal(proposalInput());
      await storage.updateMemoryProposalStatus({ id: created.id, status: 'approved' });
      const result = await storage.updateMemoryProposalStatus({
        id: created.id,
        expected_status: ['approved'],
        status: 'applying',
        applying_at: at,
      });
      if (result === null) {
        throw new Error('claim failed');
      }
      return result;
    }

    it('fails an applying row claimed before the cutoff', async () => {
      const row = await claimed(1_000);

      const swept = await storage.failStaleApplyingMemoryProposalsBefore(2_000);

      expect(swept.map((p) => p.id)).toEqual([row.id]);
      expect(swept[0].status).toBe('failed');
    });

    it('records that partial deletion is unknown rather than claiming a rollback', async () => {
      await claimed(1_000);

      const [swept] = await storage.failStaleApplyingMemoryProposalsBefore(2_000);

      // A crash inside dispatch may already have removed memories, so the row
      // must not imply nothing was deleted.
      expect(swept.applied_result).toMatchObject({
        success: false,
        details: { reason: 'stale_apply', partial: 'unknown' },
      });
    });

    it('leaves an applying row claimed after the cutoff alone', async () => {
      await claimed(5_000);

      expect(await storage.failStaleApplyingMemoryProposalsBefore(2_000)).toEqual([]);
    });

    it('never touches a pending row, however old', async () => {
      await storage.createMemoryProposal(proposalInput());

      expect(await storage.failStaleApplyingMemoryProposalsBefore(Date.now() + 1_000)).toEqual([]);
    });

    it('leaves expiry working', async () => {
      const created = await storage.createMemoryProposal({
        ...proposalInput(BY_OTHER_ID),
        expires_at: 500,
      });

      const expired = await storage.expireMemoryProposalsBefore(1_000);

      expect(expired.map((p) => p.id)).toEqual([created.id]);
    });
  });
});
