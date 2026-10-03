/** A tool file whose definition has no handler, which the registry must refuse. */
import { z } from 'zod';

export const tool = {
  name: 'no_handler',
  title: 'Tool with no handler',
  description: 'Fixture tool used by the registry tests. Not served by the server.',
  inputSchema: {},
  outputSchema: { ok: z.boolean() },
};
