import { describe, it, expect } from 'vitest';
import { executionCoordinator } from '../server/execution/coordinator';
import { operatorAlertLevel } from '../server/system/systemChecks';

/**
 * Round 14 integration: TOKENS_LEFT_AFTER_EXIT (R14-2/R13-16) and BUY_OUTCOME_UNKNOWN (R14-10) report a past event and nothing clears
 * them, so without an acknowledge they stay CRITICAL until a restart. The real coordinator singleton and the real system-checks levels.
 */
describe('the round 14 past-event alerts can be acknowledged by the operator', () => {
  for (const [code, key] of [['TOKENS_LEFT_AFTER_EXIT', 'leftover-MintAck111'], ['BUY_OUTCOME_UNKNOWN', undefined]] as const) {
    it(`${code} is CRITICAL and clears on acknowledge`, () => {
      (executionCoordinator as any).raiseOperatorAlert(code, `test ${code}`, key);
      expect(operatorAlertLevel(code)).toBe('CRITICAL');
      expect(executionCoordinator.acknowledgeOperatorAlert(code, key)).toEqual({ acknowledged: true });
      expect((executionCoordinator as any).operatorAlerts.some((a: any) => a.code === code && a.positionId === key && !a.cleared)).toBe(false);
    });
  }
});
