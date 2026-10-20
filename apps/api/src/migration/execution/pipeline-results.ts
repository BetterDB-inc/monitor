import type { ChainableCommander } from 'iovalkey';

/**
 * Run a pipeline and return its replies, throwing the first per-command error.
 *
 * `pipeline.exec()` resolves even when individual commands fail (OOM on the
 * target, a wrong type, an ACL denial); each result is an `[error, reply]`
 * pair. Callers that ignore those pairs report partially written keys as
 * transferred.
 */
export async function execPipeline(pipeline: ChainableCommander): Promise<unknown[]> {
  const results = await pipeline.exec();
  if (!results) throw new Error('pipeline returned no results');
  return results.map(([err, reply]) => {
    if (err) throw err;
    return reply;
  });
}
