// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cancelOpenAt, requestOpenAt, takeOpenAt } from './store';

afterEach(() => { takeOpenAt(7); takeOpenAt(9); });
it('P-3 open request is consumed once and only by its clip', () => {
  const request = requestOpenAt(7, 7.4);
  expect(takeOpenAt(9)).toBeNull();
  expect(takeOpenAt(7)).toEqual({ clipId: 7, seconds: 7.4, resume: false });
  expect(takeOpenAt(7)).toBeNull();
  cancelOpenAt(request);
});
it('P-3 cancelling an obsolete request cannot clear its replacement', () => {
  const first = requestOpenAt(7, 3);
  const second = requestOpenAt(9, 8);
  cancelOpenAt(first);
  expect(takeOpenAt(9)).toBe(second);
  const cancelled = requestOpenAt(7, 6);
  cancelOpenAt(cancelled);
  expect(takeOpenAt(7)).toBeNull();
});
it.each([NaN, Infinity, -1])('P-3 invalid start %s is not queued', seconds => {
  expect(requestOpenAt(7, seconds)).toBeNull();
  expect(takeOpenAt(7)).toBeNull();
});
