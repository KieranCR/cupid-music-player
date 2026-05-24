import { describe, expect, it } from 'vitest';
import { takeShuffleIndex } from './shuffleBag.js';

describe('takeShuffleIndex', () => {
  it('draws from the remaining bag', () => {
    const first = takeShuffleIndex([1, 2], 3, 0, () => 0);
    const second = takeShuffleIndex(first.bag, 3, 1, () => 0);

    expect(first).toEqual({ index: 1, bag: [2] });
    expect(second).toEqual({ index: 2, bag: [] });
  });

  it('refills without the current track', () => {
    const next = takeShuffleIndex([], 4, 2, () => 0);

    expect(next.index).toBe(0);
    expect(next.bag).toEqual([1, 3]);
  });
});
