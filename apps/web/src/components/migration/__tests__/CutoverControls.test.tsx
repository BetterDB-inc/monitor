import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MigrationExecutionResult } from '@betterdb/shared';
import { CutoverControls } from '../CutoverControls';

const CONFIRM_TEXT =
  "Before you continue: pause writes on the source. The migration finishes once every shard's lag stays at 0. After it completes, point your application at the target.";

function execution(partial: Partial<MigrationExecutionResult>): MigrationExecutionResult {
  return {
    id: 'exec-1',
    status: 'running',
    mode: 'redis_shake_sync',
    startedAt: Date.now(),
    logs: [],
    progress: null,
    syncStage: 'aof_replicating',
    replicationLag: [{ shard: 'src-0', diff: 0, updatedAt: Date.now() }],
    expectedShards: 1,
    fullySynced: false,
    cutover: null,
    ...partial,
  };
}

const timedOut = { requestedAt: 1, deadlineAt: 2, outcome: 'timed_out' as const };

describe('CutoverControls', () => {
  it('disables Complete cutover until the initial sync finishes', () => {
    render(<CutoverControls execution={execution({ syncStage: 'rdb_syncing' })} onComplete={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Complete cutover' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Available once the initial sync finishes');
  });

  it('asks for confirmation before completing', () => {
    const onComplete = vi.fn();
    render(<CutoverControls execution={execution({})} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    expect(screen.getByText(CONFIRM_TEXT)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('completes without force after confirmation', () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<CutoverControls execution={execution({})} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    expect(onComplete).toHaveBeenCalledWith(false);
  });

  it('cancels the confirmation', () => {
    render(<CutoverControls execution={execution({})} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(CONFIRM_TEXT)).toBeNull();
  });

  it('hides force until an attempt has timed out', () => {
    const { rerender } = render(<CutoverControls execution={execution({})} onComplete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Force cutover' })).toBeNull();
    rerender(
      <CutoverControls
        execution={execution({ cutover: { requestedAt: 1, deadlineAt: 2, outcome: 'waiting' } })}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Force cutover' })).toBeNull();
  });

  it('offers retry and force after a timeout', () => {
    render(<CutoverControls execution={execution({ cutover: timedOut })} onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry cutover' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Force cutover' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete cutover' })).toBeNull();
  });

  it('retries without force after confirmation', () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<CutoverControls execution={execution({ cutover: timedOut })} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry cutover' }));
    expect(screen.getByText(CONFIRM_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    expect(onComplete).toHaveBeenCalledWith(false);
  });

  it('lists the current lag in the force confirmation', () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(
      <CutoverControls
        execution={execution({
          cutover: timedOut,
          expectedShards: 2,
          replicationLag: [
            { shard: 'src-1', diff: 4096, updatedAt: Date.now() },
            { shard: 'src-2', diff: null, updatedAt: Date.now() },
          ],
        })}
        onComplete={onComplete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Force cutover' }));
    expect(screen.getByText(/Force the cutover now\? Writes not yet on the target will be missing:/)).toBeTruthy();
    expect(screen.getByText('src-1: 4.00 KB behind')).toBeTruthy();
    expect(screen.getByText('src-2: initial sync')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Force cutover' }).at(-1)!);
    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it('counts shards with no report in the force confirmation', () => {
    render(
      <CutoverControls
        execution={execution({
          cutover: timedOut,
          expectedShards: 3,
          replicationLag: [{ shard: 'src-0', diff: 4096, updatedAt: Date.now() }],
        })}
        onComplete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Force cutover' }));
    expect(screen.getByText('src-0: 4.00 KB behind')).toBeTruthy();
    expect(screen.getByText('2 shard(s) with no report')).toBeTruthy();
  });

  it('says so when no shard has reported lag', () => {
    render(
      <CutoverControls
        execution={execution({ cutover: timedOut, expectedShards: null, replicationLag: [] })}
        onComplete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Force cutover' }));
    expect(screen.getByText('No shard has reported lag yet.')).toBeTruthy();
  });

  it('shows the API error inline', async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error('Cutover is available only while a sync migration is replicating'));
    render(<CutoverControls execution={execution({})} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete cutover' }));
    expect(await screen.findByText('Cutover is available only while a sync migration is replicating')).toBeTruthy();
  });

  it('renders nothing outside sync mode', () => {
    const { container } = render(
      <CutoverControls execution={execution({ mode: 'redis_shake', syncStage: null })} onComplete={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
