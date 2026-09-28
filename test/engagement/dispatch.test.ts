import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { claimOccurrence } from '../../src/engagement/dispatch.js';

describe('send claim', () => {
  it('uses one slot per day, and a second slot only for water', () => {
    assert.equal(claimOccurrence('LUNCH_REMINDER', 0), 1);
    assert.equal(claimOccurrence('LUNCH_REMINDER', 1), null);
    assert.equal(claimOccurrence('HYDRATION_REMINDER', 0), 1);
    assert.equal(claimOccurrence('HYDRATION_REMINDER', 1), 2);
    assert.equal(claimOccurrence('HYDRATION_REMINDER', 2), null);
  });
});
