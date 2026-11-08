import { AppError } from './broker.js';

const holidays2026 = new Set([
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31',
  '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26',
  '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25'
]);
export const calendarSource = 'https://www.nseindia.com/resources/exchange-communication-holidays/';
export const muhuratSession = {
  date: '2026-11-08', open: '14:20', nonCasClose: '15:30', conservativeClose: '15:15',
  source: 'https://nsearchives.nseindia.com/content/circulars/CMTR76941.pdf'
};

export function executionWindow(now, symbol) {
  const clock = new Date(now + 19800000);
  const day = clock.toISOString().slice(0, 10);
  const minute = clock.getUTCHours() * 60 + clock.getUTCMinutes();
  if (day === muhuratSession.date) {
    // NIFTYBEES is a non-CAS ETF. Other instruments retain the conservative
    // CAS cutoff until their continuous-session eligibility is verified.
    const close = symbol === 'NIFTYBEES' ? muhuratSession.nonCasClose : muhuratSession.conservativeClose;
    return {
      symbol, open: minute >= 860 && minute < (symbol === 'NIFTYBEES' ? 930 : 915),
      specialSession: true, date: day, closeIst: close, source: muhuratSession.source,
      description: `Muhurat 8 Nov 2026: 14:20-${close} IST${symbol === 'NIFTYBEES' ? ' (non-CAS ETF)' : ' (conservative CAS cutoff)'}. No auction/post-close fills.`
    };
  }
  return {
    symbol, open: clock.getUTCDay() >= 1 && clock.getUTCDay() <= 5 && minute >= 555 && minute < 920,
    specialSession: false, date: day, closeIst: '15:20', source: null,
    description: 'Weekdays 09:15-15:20 IST; not a complete exchange holiday/special-session gate'
  };
}

export function tradingSession(day) {
  return day === muhuratSession.date || regularSession(day);
}

export function regularSession(day) {
  if (!day.startsWith('2026-')) throw new AppError('NSE session calendar is verified for 2026 only. Update it before using timed exits in another year.', 409, 'EXIT_CALENDAR');
  if (['2026-02-01', '2026-11-08'].includes(day)) throw new AppError('This holding period reaches an unsupported special NSE session. Timed exits require a calendar update; stops and targets remain active.', 409, 'EXIT_CALENDAR');
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5 && !holidays2026.has(day);
}

export function holdingSession(openingDay, currentDay) {
  let count = 0;
  for (let cursor = Date.parse(`${openingDay}T00:00:00Z`), end = Date.parse(`${currentDay}T00:00:00Z`); cursor <= end; cursor += 86400000) {
    if (tradingSession(new Date(cursor).toISOString().slice(0, 10))) count++;
  }
  return count;
}
