import { ReadRotation } from '../read-rotation';

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `n${String(i).padStart(3, '0')}`);
const self = (id: string): string => id;

describe('ReadRotation', () => {
  it('reads everything on every poll while it fits the budget', () => {
    const rotation = new ReadRotation();
    const items = ids(4);

    expect(rotation.pick('c', items, self, 4)).toEqual({ due: items, everyPoll: items, sweepPolls: 1 });
    expect(rotation.pick('c', items, self, 4)).toEqual({ due: items, everyPoll: items, sweepPolls: 1 });
  });

  it('reads a budget of items per poll and each item once per sweep', () => {
    const rotation = new ReadRotation();
    const items = ids(10);

    const polls = [1, 2, 3].map(() => rotation.pick('c', items, self, 4));

    expect(polls.map((poll) => poll.due)).toEqual([
      ['n000', 'n001', 'n002', 'n003'],
      ['n004', 'n005', 'n006', 'n007'],
      ['n008', 'n009', 'n000', 'n001'],
    ]);
    expect(polls.map((poll) => poll.sweepPolls)).toEqual([3, 3, 3]);
  });

  it('starts from the lowest id whatever order the items come in', () => {
    const rotation = new ReadRotation();

    expect(rotation.pick('c', ids(10).reverse(), self, 4).due).toEqual(['n000', 'n001', 'n002', 'n003']);
  });

  it('goes on after the last item it read when the items change', () => {
    const rotation = new ReadRotation();
    rotation.pick('c', ids(10), self, 4);
    const changed = [...ids(10).filter((id) => id !== 'n003'), 'n0025'];

    expect(rotation.pick('c', changed, self, 4).due).toEqual(['n004', 'n005', 'n006', 'n007']);
  });

  it('reads priority items on every poll and rotates the rest', () => {
    const rotation = new ReadRotation();
    const items = ids(10);
    const urgent = (id: string) => id === 'n007';

    const polls = [1, 2, 3].map(() => rotation.pick('c', items, self, 4, urgent));

    expect(polls.map((poll) => poll.due)).toEqual([
      ['n007', 'n000', 'n001', 'n002'],
      ['n007', 'n003', 'n004', 'n005'],
      ['n007', 'n006', 'n008', 'n009'],
    ]);
    expect(polls[0].sweepPolls).toBe(3);
  });

  it('names the priority items as read on every poll', () => {
    const rotation = new ReadRotation();

    const pick = rotation.pick('c', ids(10), self, 4, (id) => id === 'n007');

    expect(pick.everyPoll).toEqual(['n007']);
  });

  it('gives priority at most a quarter of the budget and rotates the others', () => {
    const rotation = new ReadRotation();
    const items = ids(20);
    const urgent = (id: string) => ['n010', 'n011', 'n012'].includes(id);

    const first = rotation.pick('c', items, self, 8, urgent);
    const read = new Set(first.due);
    for (let poll = 1; poll < first.sweepPolls; poll++) {
      rotation.pick('c', items, self, 8, urgent).due.forEach((id) => read.add(id));
    }

    expect(first.due.slice(0, 2)).toEqual(['n010', 'n011']);
    expect(first.due).toHaveLength(8);
    expect(first.sweepPolls).toBe(3);
    expect([...read].sort()).toEqual(items);
  });

  it('takes the priority cap from the caller', () => {
    const rotation = new ReadRotation();
    const urgent = (id: string) => ['n010', 'n011', 'n012', 'n013', 'n014'].includes(id);

    const pick = rotation.pick('c', ids(20), self, 8, urgent, 6);

    expect(pick.everyPoll).toEqual(['n010', 'n011', 'n012', 'n013', 'n014']);
    expect(pick.due).toHaveLength(8);
    expect(pick.sweepPolls).toBe(5);
  });

  it('leaves one read to the rotation whatever cap the caller asks for', () => {
    const rotation = new ReadRotation();

    const pick = rotation.pick('c', ids(20), self, 4, () => true, 4);

    expect(pick.everyPoll).toEqual(['n000', 'n001', 'n002']);
    expect(pick.due).toEqual(['n000', 'n001', 'n002', 'n003']);
  });

  it('keeps a place per scope and starts over once the scope is forgotten', () => {
    const rotation = new ReadRotation();
    const items = ids(10);
    rotation.pick('a', items, self, 4);

    expect(rotation.pick('b', items, self, 4).due[0]).toBe('n000');
    expect(rotation.pick('a', items, self, 4).due[0]).toBe('n004');
    rotation.forget('a');
    expect(rotation.pick('a', items, self, 4).due[0]).toBe('n000');
  });
});
