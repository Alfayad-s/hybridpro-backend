import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultSettings,
  emptyDay,
  evaluate,
  type DaySnapshot,
  type EngagementSettings,
  type MemberRoutine,
  type SentNotice,
} from '../../src/engagement/rules.js';
import { suggestTypicalMinutes, zonedDateTime } from '../../src/engagement/time.js';

const DATE = { year: 2026, month: 9, day: 28 };

function routine(overrides: Partial<MemberRoutine> = {}): MemberRoutine {
  return {
    timezone: 'Asia/Kolkata',
    wakeMinutes: 7 * 60,
    gymMinutes: 7 * 60,
    breakfastMinutes: 8 * 60 + 30,
    lunchMinutes: 13 * 60,
    dinnerMinutes: 20 * 60 + 30,
    sleepMinutes: 23 * 60,
    ...overrides,
  };
}

function at(hour: number, minute: number, timeZone = 'Asia/Kolkata') {
  return zonedDateTime(timeZone, DATE.year, DATE.month, DATE.day, hour, minute);
}

function run(
  hour: number,
  minute: number,
  options: {
    routine?: Partial<MemberRoutine>;
    day?: Partial<DaySnapshot>;
    settings?: Parameters<typeof defaultSettings>[0];
    sent?: SentNotice[];
    timeZone?: string;
  } = {},
) {
  const zone = options.timeZone ?? options.routine?.timezone ?? 'Asia/Kolkata';
  return evaluate({
    now: at(hour, minute, zone),
    routine: routine({ timezone: zone, ...options.routine }),
    day: emptyDay({
      workoutScheduled: true,
      workoutName: 'Push Day',
      ...options.day,
    }),
    settings: defaultSettings(options.settings),
    sent: options.sent ?? [],
  });
}

describe('local time', () => {
  it('reads the same instant differently in each member timezone', () => {
    const instant = new Date('2026-09-28T01:30:00.000Z');
    const zones = [
      ['Asia/Kolkata', '07:00', 'MORNING'],
      ['Asia/Dubai', '05:30', 'LATE_NIGHT'],
      ['Europe/London', '02:30', 'LATE_NIGHT'],
      ['America/New_York', '21:30', 'EVENING'],
    ] as const;

    for (const [zone, localTime, experience] of zones) {
      const decision = evaluate({
        now: instant,
        routine: routine({ timezone: zone, gymMinutes: 18 * 60 + 30 }),
        day: emptyDay({ workoutScheduled: true, workoutName: 'Upper Body' }),
        settings: defaultSettings(),
        sent: [],
      });
      assert.equal(decision.localTime, localTime, zone);
      assert.equal(decision.experience.type, experience, zone);
    }
    assert.equal(
      evaluate({
        now: instant,
        routine: routine({ timezone: 'America/New_York' }),
        day: emptyDay(),
        settings: defaultSettings(),
        sent: [],
      }).localDate,
      '2026-09-27',
    );
  });
});

describe('experience by time of day', () => {
  const cases = [
    [5, 0, 'LATE_NIGHT', "It's getting late"],
    [7, 0, 'MORNING', 'Good morning'],
    [11, 0, 'MORNING', 'Good morning'],
    [13, 0, 'AFTERNOON', 'Good afternoon'],
    [18, 0, 'AFTERNOON', 'Good afternoon'],
    [22, 0, 'EVENING', 'Good evening'],
    [0, 30, 'LATE_NIGHT', "It's getting late"],
  ] as const;

  for (const [hour, minute, type, title] of cases) {
    it(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} is ${type}`, () => {
      const decision = run(hour, minute);
      assert.equal(decision.experience.type, type);
      assert.equal(decision.experience.title, title);
    });
  }

  it('does not warn at 1:00 when sleep is 1:30', () => {
    const decision = run(1, 0, {
      routine: { sleepMinutes: 1 * 60 + 30, wakeMinutes: 9 * 60 },
    });
    assert.equal(decision.experience.type, 'EVENING');
    assert.equal(decision.notification.result, 'SKIP');
  });

  it('warns at 3:00 when sleep was 1:30', () => {
    const decision = run(3, 0, {
      routine: { sleepMinutes: 1 * 60 + 30, wakeMinutes: 9 * 60 },
    });
    assert.equal(decision.experience.type, 'LATE_NIGHT');
    assert.equal(decision.actions[0]?.type, 'START_WIND_DOWN');
  });

  it('does not show a late-night card when sleep time is unset', () => {
    const decision = run(1, 0, { routine: { sleepMinutes: null } });
    assert.notEqual(decision.experience.type, 'LATE_NIGHT');
  });
});

describe('morning and gym time', () => {
  it('asks for a gym time and suggests the typical recent time', () => {
    const decision = run(7, 10, {
      routine: { gymMinutes: null },
      day: { recentGymMinutes: [7 * 60 + 10, 7 * 60 + 15, 7 * 60 + 8, 7 * 60 + 12, 7 * 60 + 11] },
    });
    assert.equal(decision.experience.subtitle, 'Ready to start your day?');
    assert.equal(decision.gym.scheduled, false);
    assert.deepEqual(decision.actions[0], {
      type: 'CONFIRM_GYM_TIME',
      suggestedTime: '7:10 AM',
      suggestedMinutes: 7 * 60 + 10,
    });
  });

  it('shows the scheduled workout when gym time is already set', () => {
    const decision = run(7, 5);
    assert.equal(decision.experience.subtitle, 'Your workout is scheduled for 7:00 AM.');
    assert.equal(decision.workout.name, 'Push Day');
    assert.equal(decision.actions.some((action) => action.type === 'VIEW_WORKOUT'), true);
  });

  it('uses a different gym time per member', () => {
    const early = run(7, 10, { routine: { gymMinutes: 7 * 60 + 40 } });
    const late = run(19, 40, { routine: { gymMinutes: 20 * 60 } });
    assert.equal(early.notification.result === 'SEND' && early.notification.type, 'PRE_WORKOUT');
    assert.equal(late.experience.type, 'EVENING');
    assert.equal(late.notification.result === 'SEND' && late.notification.type, 'PRE_WORKOUT');
    assert.match(late.experience.subtitle, /8:00 PM/);
  });
});

describe('meals', () => {
  it('asks about lunch only when it is not logged', () => {
    const open = run(13, 10);
    assert.equal(open.experience.subtitle, 'Have you had lunch?');
    assert.equal(open.notification.result === 'SEND' && open.notification.type, 'LUNCH_REMINDER');
    assert.equal(open.meals.lunch.completed, false);

    const done = run(13, 10, { day: { lunch: { planned: true, completed: true, skipped: false } } });
    assert.match(done.experience.subtitle, /Lunch completed/);
    assert.equal(done.notification.result, 'SKIP');
    const lunchTrace = done.trace.find((row) => row.type === 'LUNCH_REMINDER');
    assert.equal(lunchTrace?.reason, 'Lunch already completed');

    const skipped = run(13, 10, {
      day: { lunch: { planned: true, completed: false, skipped: true } },
    });
    assert.equal(skipped.trace.find((row) => row.type === 'LUNCH_REMINDER')?.reason, 'Lunch skipped');
  });

  it('sends breakfast and dinner only inside their own windows', () => {
    const breakfast = run(8, 40, { day: { workoutScheduled: false, workoutName: null } });
    assert.equal(breakfast.notification.result === 'SEND' && breakfast.notification.type, 'BREAKFAST_REMINDER');
    const dinner = run(20, 40, { day: { workoutScheduled: false, workoutName: null } });
    assert.equal(dinner.notification.result === 'SEND' && dinner.notification.type, 'DINNER_REMINDER');
    assert.equal(
      run(11, 30).trace.find((row) => row.type === 'BREAKFAST_REMINDER')?.reason,
      'Outside the scheduled window',
    );
  });
});

describe('workout states', () => {
  it('sends the pre-workout notice, then the start notice, then missed', () => {
    const gym = { gymMinutes: 8 * 60 };
    const pre = run(7, 40, { routine: gym });
    const start = run(8, 10, { routine: gym });
    const missed = run(9, 40, {
      routine: gym,
      day: { breakfast: { planned: true, completed: true, skipped: false } },
    });
    assert.equal(pre.notification.result === 'SEND' && pre.notification.type, 'PRE_WORKOUT');
    assert.equal(start.notification.result === 'SEND' && start.notification.type, 'WORKOUT_REMINDER');
    assert.equal(missed.notification.result === 'SEND' && missed.notification.type, 'MISSED_WORKOUT');
  });

  it('does not nag after completion, check-in, or a rest day', () => {
    const done = run(7, 10, {
      day: { workoutCompleted: true, workoutCompletedMinutes: 7 * 60 },
    });
    assert.equal(done.experience.type === 'EVENING' ? done.experience.subtitle : done.trace.find((row) => row.type === 'WORKOUT_REMINDER')?.reason, 'Workout already completed');
    assert.equal(run(8, 40, { day: { checkedIn: true } }).trace.find((row) => row.type === 'MISSED_WORKOUT')?.reason, 'Already checked in');
    assert.equal(
      run(7, 10, { day: { workoutScheduled: false, workoutName: null } }).trace.find(
        (row) => row.type === 'WORKOUT_REMINDER',
      )?.reason,
      'No workout scheduled today',
    );
  });

  it('shows the completed evening card and a post-workout notice', () => {
    const decision = run(18, 20, {
      routine: { gymMinutes: 18 * 60 },
      day: { workoutCompleted: true, workoutCompletedMinutes: 18 * 60 + 10 },
    });
    assert.equal(decision.experience.subtitle, 'Workout completed. Great work today.');
    assert.equal(decision.notification.result === 'SEND' && decision.notification.type, 'POST_WORKOUT');
  });
});

describe('notification guards', () => {
  it('skips a type that was already sent today', () => {
    const decision = run(13, 10, { sent: [{ type: 'LUNCH_REMINDER', sentAtMinutes: 13 * 60 }] });
    assert.equal(decision.trace.find((row) => row.type === 'LUNCH_REMINDER')?.reason, 'Already sent today');
    assert.notEqual(
      decision.notification.result === 'SEND' ? decision.notification.type : null,
      'LUNCH_REMINDER',
    );
  });

  it('holds a lower-priority notice when a meal is also due', () => {
    const decision = run(9, 0, {
      day: { workoutScheduled: false, workoutName: null, streakDays: 4 },
    });
    assert.equal(decision.notification.result === 'SEND' && decision.notification.type, 'BREAKFAST_REMINDER');
    assert.equal(decision.trace.find((row) => row.type === 'STREAK')?.reason, 'Held for BREAKFAST_REMINDER');
  });

  it('stops at the daily limit', () => {
    const sent: SentNotice[] = [
      { type: 'MORNING_GREETING', sentAtMinutes: 7 * 60 },
      { type: 'PRE_WORKOUT', sentAtMinutes: 6 * 60 + 40 },
      { type: 'WORKOUT_REMINDER', sentAtMinutes: 7 * 60 + 5 },
      { type: 'BREAKFAST_REMINDER', sentAtMinutes: 8 * 60 + 40 },
      { type: 'HYDRATION_REMINDER', sentAtMinutes: 10 * 60 + 10 },
      { type: 'STREAK', sentAtMinutes: 9 * 60 },
    ];
    const decision = run(13, 10, { sent, settings: { dailyLimit: 6 } });
    assert.equal(decision.notification.result, 'SKIP');
    assert.equal(decision.notification.reason, 'Daily limit reached (6 / 6)');
  });

  it('blocks ordinary notices during quiet hours and still allows sleep', () => {
    const quiet = run(23, 10);
    assert.equal(quiet.notification.result === 'SEND' && quiet.notification.type, 'SLEEP_REMINDER');
    assert.equal(quiet.trace.find((row) => row.type === 'DINNER_REMINDER')?.reason, 'Quiet hours');

    const blocked = run(6, 40, { settings: { quietEndMinutes: 7 * 60 } });
    assert.equal(blocked.trace.find((row) => row.type === 'PRE_WORKOUT')?.reason, 'Quiet hours');
  });

  it('respects a disabled category and a disabled template', () => {
    const mealsOff = run(13, 10, { settings: { prefs: { meals: false } } });
    assert.equal(mealsOff.trace.find((row) => row.type === 'LUNCH_REMINDER')?.reason, 'Notification disabled');

    const templateOff = run(13, 10, {
      settings: { templates: { LUNCH_REMINDER: { enabled: false } } },
    });
    assert.equal(templateOff.trace.find((row) => row.type === 'LUNCH_REMINDER')?.reason, 'Template disabled');
  });

  it('waits out the hydration cooldown and skips a second send the same hour', () => {
    const settings: Parameters<typeof defaultSettings>[0] = {};
    const cooled = run(16, 10, {
      settings,
      day: { waterMl: 200, waterGoalMl: 2300 },
      sent: [{ type: 'HYDRATION_REMINDER', sentAtMinutes: 10 * 60 + 20 }],
    });
    assert.equal(cooled.notification.result === 'SEND' && cooled.notification.type, 'HYDRATION_REMINDER');

    const recent = run(16, 10, {
      day: { waterMl: 200, waterGoalMl: 2300 },
      sent: [{ type: 'HYDRATION_REMINDER', sentAtMinutes: 15 * 60 }],
    });
    assert.equal(recent.trace.find((row) => row.type === 'HYDRATION_REMINDER')?.reason, 'Cooldown active');
  });

  it('does not send hydration when water is on pace', () => {
    const decision = run(10, 20, { day: { waterMl: 800, waterGoalMl: 2300 } });
    assert.equal(decision.trace.find((row) => row.type === 'HYDRATION_REMINDER')?.reason, 'Hydration is on pace');
  });
});

describe('typical gym time', () => {
  it('returns the median rounded to five minutes', () => {
    assert.equal(
      suggestTypicalMinutes([7 * 60 + 10, 7 * 60 + 15, 7 * 60 + 8, 7 * 60 + 12, 7 * 60 + 11]),
      7 * 60 + 10,
    );
    assert.equal(suggestTypicalMinutes([]), null);
  });
});

describe('settings shape', () => {
  it('uses a template title from the fixed catalog', () => {
    const decision = run(13, 5);
    assert.equal(decision.notification.result, 'SEND');
    if (decision.notification.result !== 'SEND') return;
    const templates: EngagementSettings = defaultSettings();
    assert.equal(decision.notification.title, templates.templates.LUNCH_REMINDER.title);
    assert.equal(decision.notification.deepLink, '/meals');
  });
});
