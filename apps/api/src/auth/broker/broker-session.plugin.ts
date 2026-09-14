import { z } from 'zod';
import type { BetterAuthModules } from '../better-auth-esm';

export const BROKER_SESSION_PATH = '/broker/session';

const brokerSessionBody = z.object({ userId: z.string().min(1) });

export function brokerSessionPlugin(modules: BetterAuthModules) {
  return {
    id: 'betterdb-broker-session',
    endpoints: {
      brokerSession: modules.createAuthEndpoint(
        BROKER_SESSION_PATH,
        { method: 'POST', body: brokerSessionBody, metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (user === null) {
            throw new modules.APIError('NOT_FOUND', { message: 'User not found' });
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await modules.setSessionCookie(ctx, { session, user });
          return ctx.json({ user: { id: user.id, email: user.email } });
        },
      ),
    },
  };
}
