function freshBag(length, currentIndex) {
  return Array.from({ length }, (_v, i) => i).filter((i) => i !== currentIndex);
}

export function takeShuffleIndex(bag, length, currentIndex, random = Math.random) {
  if (length <= 1) return { index: currentIndex, bag: [] };

  let pool = bag.filter((i) => i >= 0 && i < length && i !== currentIndex);
  if (pool.length === 0) pool = freshBag(length, currentIndex);

  const slot = Math.floor(random() * pool.length);
  const index = pool[slot];
  const nextBag = pool.filter((_v, i) => i !== slot);

  return { index, bag: nextBag };
}
