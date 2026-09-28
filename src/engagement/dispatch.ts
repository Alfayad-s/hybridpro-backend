import { HYDRATION_DAILY_CAP } from './rules.js';
import type { NotificationType } from './templates.js';

/** Slot used by the unique send claim. Null means this type is already used up today. */
export function claimOccurrence(type: NotificationType, alreadySent: number): number | null {
  if (type === 'HYDRATION_REMINDER') {
    if (alreadySent >= HYDRATION_DAILY_CAP) return null;
    return alreadySent + 1;
  }
  if (alreadySent > 0) return null;
  return 1;
}
