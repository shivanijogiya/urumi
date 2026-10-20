import { describe, expect, it } from 'vitest';
import { dayWindow, isCalendarDate, storeDate, toWooGmt } from '../../src/store-time.js';

describe('dayWindow today (Asia/Kolkata)', () => {
  it.each([
    // [now (UTC), store date, start UTC, end UTC]
    ['2026-10-20T06:00:00Z', '2026-10-20', '2026-10-19T18:30:00.000Z', '2026-10-20T18:30:00.000Z'],
    ['2026-10-20T18:29:59Z', '2026-10-20', '2026-10-19T18:30:00.000Z', '2026-10-20T18:30:00.000Z'],
    ['2026-10-20T18:30:00Z', '2026-10-21', '2026-10-20T18:30:00.000Z', '2026-10-21T18:30:00.000Z'],
    ['2026-10-20T18:45:00Z', '2026-10-21', '2026-10-20T18:30:00.000Z', '2026-10-21T18:30:00.000Z'],
    ['2026-10-19T18:30:00Z', '2026-10-20', '2026-10-19T18:30:00.000Z', '2026-10-20T18:30:00.000Z'],
    ['2026-12-31T19:00:00Z', '2027-01-01', '2026-12-31T18:30:00.000Z', '2027-01-01T18:30:00.000Z'],
    ['2028-02-28T20:00:00Z', '2028-02-29', '2028-02-28T18:30:00.000Z', '2028-02-29T18:30:00.000Z'],
  ])('at %s the store day is %s', (now, date, after, before) => {
    expect(dayWindow('today', new Date(now))).toEqual({
      date,
      timezone: 'Asia/Kolkata',
      after,
      before,
    });
    expect(storeDate(new Date(now))).toBe(date);
  });
});

describe('dayWindow explicit date', () => {
  it('ignores now and spans that day in the store time zone', () => {
    expect(dayWindow('2026-03-01', new Date('2026-10-20T00:00:00Z'))).toEqual({
      date: '2026-03-01',
      timezone: 'Asia/Kolkata',
      after: '2026-02-28T18:30:00.000Z',
      before: '2026-03-01T18:30:00.000Z',
    });
  });

  it('computes the offset rather than assuming +05:30 (DST zone, 23-hour day)', () => {
    const w = dayWindow('2026-03-08', new Date(0), 'America/New_York');
    expect(w).toMatchObject({
      after: '2026-03-08T05:00:00.000Z',
      before: '2026-03-09T04:00:00.000Z',
    });
  });

  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2025-02-29',
    '26-10-20',
    '2026-1-5',
    'yesterday',
    '',
  ])('rejects %j', (date) => {
    expect(isCalendarDate(date)).toBe(false);
    expect(() => dayWindow(date, new Date())).toThrow(RangeError);
  });

  it.each(['2026-10-20', '2028-02-29', '2026-12-31'])('accepts %s', (date) => {
    expect(isCalendarDate(date)).toBe(true);
  });
});

describe('toWooGmt', () => {
  it('formats a UTC wall time without zone or milliseconds', () => {
    expect(toWooGmt('2026-10-20T18:30:00.000Z')).toBe('2026-10-20T18:30:00');
    expect(toWooGmt('2026-10-21T00:00:00.999+05:30')).toBe('2026-10-20T18:30:00');
  });
});
