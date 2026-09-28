import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDaySnapshot } from '../../src/engagement/snapshot.js';

const today = '2026-09-28';

function snapshot(payload: unknown, extras: Partial<Parameters<typeof buildDaySnapshot>[0]> = {}) {
  return buildDaySnapshot({
    payload,
    localDate: today,
    weekday: 1,
    checkedIn: false,
    recentGymMinutes: [],
    streakDays: 0,
    skippedMeals: [],
    isLocalDate: (iso) => iso.startsWith(today),
    minutesOf: () => 7 * 60 + 12,
    ...extras,
  });
}

describe('day snapshot', () => {
  it('uses the coach plan for Monday and ignores a rest day', () => {
    const training = snapshot({
      stores: {
        plans: {
          data: [
            {
              id: 'plan',
              isActive: true,
              assignedByCoach: true,
              updatedAt: '2026-09-01T00:00:00.000Z',
              days: [
                { dayOfWeek: 1, name: 'Push Day', isRestDay: false, exercises: [{ name: 'Bench' }] },
                { dayOfWeek: 2, name: 'Rest', isRestDay: true, exercises: [] },
              ],
            },
          ],
        },
      },
    });
    assert.equal(training.workoutScheduled, true);
    assert.equal(training.workoutName, 'Push Day');

    const rest = snapshot(
      {
        stores: {
          plans: {
            data: [
              {
                id: 'plan',
                isActive: true,
                assignedByCoach: true,
                days: [{ dayOfWeek: 1, name: 'Rest', isRestDay: true, exercises: [] }],
              },
            ],
          },
        },
      },
    );
    assert.equal(rest.workoutScheduled, false);
  });

  it('marks lunch complete from the meal log and skips an unplanned slot', () => {
    const day = snapshot({
      stores: {
        mealPlans: {
          data: [
            {
              id: 'meals',
              isActive: true,
              assignedByCoach: true,
              updatedAt: '2026-09-01T00:00:00.000Z',
              days: [
                {
                  dayOfWeek: 1,
                  meals: [
                    { type: 'breakfast', name: 'Oats' },
                    { type: 'lunch', name: 'Rice' },
                  ],
                },
              ],
            },
          ],
        },
        meals: {
          data: {
            entries: [{ date: today, type: 'lunch', name: 'Rice' }],
            waterLogs: [{ date: today, amountMl: 400 }],
          },
        },
        waterChallenges: {
          data: [
            {
              id: 'water',
              isActive: true,
              assignedByCoach: true,
              targetMlPerDay: 3000,
              startDate: '2026-09-01',
              endDate: '2026-09-30',
            },
          ],
        },
      },
    });
    assert.equal(day.lunch.completed, true);
    assert.equal(day.breakfast.planned, true);
    assert.equal(day.breakfast.completed, false);
    assert.equal(day.dinner.planned, false);
    assert.equal(day.waterMl, 400);
    assert.equal(day.waterGoalMl, 3000);
  });

  it('reads a completed workout on the member local date', () => {
    const day = snapshot({
      stores: {
        history: {
          data: [{ completedAt: '2026-09-28T01:42:00.000Z', dayName: 'Push Day' }],
        },
      },
    });
    assert.equal(day.workoutCompleted, true);
    assert.equal(day.workoutCompletedMinutes, 7 * 60 + 12);
  });
});
