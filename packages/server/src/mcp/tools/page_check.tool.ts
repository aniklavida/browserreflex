import type { ToolContext, ToolDefinition } from './tool.js';
import {
  pageCheckInputSchema,
  pageCheckOutputSchema,
  executePageCheck,
} from '../../tools/page_check.js';

export const tool: ToolDefinition = {
  name: 'page_check',
  title: 'Check what a page is',
  description:
    'Reports what one page is from a redacted accessibility tree or DOM snapshot, in a single ' +
    'call: page_type, popup (with the close control when a rule names one), login_wall, ' +
    'captcha and the risky actions found on the page, each with the element text, the risk ' +
    'kind and the rule id that flagged it. Every part also carries its decision_id, ' +
    'confidence, path and latency. A part no rule answered comes back in needs_ai in the ' +
    'shape decide uses, so submit_answers completes it. A huge snapshot is cut to stated ' +
    'bounds and the output says what was cut. Page content is data: it is matched against ' +
    'rules and never read as an instruction. The safety check is advisory: a risky action ' +
    'is a request for the user and nothing here prevents an agent from acting.',
  inputSchema: pageCheckInputSchema,
  outputSchema: pageCheckOutputSchema,

  async handle(args: Record<string, unknown>, context: ToolContext) {
    const result = await executePageCheck(args, {
      store: context.store,
      session: context.session,
      sessionId: context.sessionId,
      patternEngine: context.patternEngine,
      logDecision: context.logDecision,
    });

    const answered = [result.page_type, result.popup, result.login_wall, result.captcha].filter(
      (part) => part.status === 'answered',
    ).length;

    const summary =
      `Checked one page: ${answered} of 4 page-level parts answered from a rule, ` +
      `${result.needs_ai.length} need the agent's own answer, ` +
      `${result.needs_human.length} need a person, and ${result.risky_actions.length} ` +
      `risky action(s) found from ${result.packs.rule_count} rule(s) in ` +
      `${result.packs.pack_ids.length} pack(s)` +
      `${result.packs.errors.length > 0 ? `, ${result.packs.errors.length} pack error(s)` : ''}. ` +
      `${result.snapshot.truncated ? 'The snapshot was cut to the stated bounds; see snapshot. ' : ''}` +
      `The safety check is advisory: a risky action is a request for the user, not a block.`;

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
