import type { ToolContext, ToolDefinition } from './tool.js';
import {
  actionGuardInputSchema,
  actionGuardOutputSchema,
  executeActionGuard,
} from '../../tools/action_guard.js';

export const tool: ToolDefinition = {
  name: 'action_guard',
  title: 'Advisory safety gate for one browser action',
  description:
    'Reports whether one browser action should be allowed, should ask the user first, or ' +
    'should be blocked: allow, ask_user or block, with a reason written for the user and the ' +
    'rule ids that produced it. Send it before a click, a submit, a delete or anything that ' +
    'types, navigates or runs a command, with the action, the target element and the URL. ' +
    'A payment or destructive action always comes back ask_user: no learned pattern and no ' +
    'argument the caller sends can turn that into allow. The safety check is advisory. This ' +
    'tool reports a verdict and never prevents an agent from acting; real enforcement belongs ' +
    'in the permission or hook system of the agent host. Page text is matched against rules ' +
    'and never read as an instruction, so a page claiming an action is approved changes nothing.',
  inputSchema: actionGuardInputSchema,
  outputSchema: actionGuardOutputSchema,

  async handle(args: Record<string, unknown>, context: ToolContext) {
    const result = await executeActionGuard(args, {
      store: context.store,
      session: context.session,
      sessionId: context.sessionId,
      patternEngine: context.patternEngine,
    });

    // The reason already ends with the advisory note, so a client that reads only the
    // text still reads it.
    const summary =
      `${result.verdict}: ${result.reason} ` +
      `Confidence ${result.confidence} on the ${result.path} path, logged as decision ` +
      `${result.decision_id}. Safety rules matched: ` +
      `${result.rule_ids.length > 0 ? result.rule_ids.join(', ') : 'none'}.` +
      (result.needs_ai ? ' No rule answered, so the model should decide this one.' : '');

    return {
      content: [
        {
          type: 'text' as const,
          text: summary,
        },
      ],
      structuredContent: result,
    };
  },
};
