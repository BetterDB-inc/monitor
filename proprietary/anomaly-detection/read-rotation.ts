export interface RotationPick<T> {
  due: T[];
  sweepPolls: number;
}

const PRIORITY_SHARE = 4;

export class ReadRotation {
  private readonly lastRead = new Map<string, string>();

  pick<T>(
    scope: string,
    items: readonly T[],
    idOf: (item: T) => string,
    budget: number,
    isPriority: (item: T) => boolean = () => false,
  ): RotationPick<T> {
    if (items.length <= budget) {
      this.lastRead.delete(scope);
      return { due: [...items], sweepPolls: 1 };
    }
    const sorted = [...items].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
    const priority = sorted.filter(isPriority).slice(0, Math.floor(budget / PRIORITY_SHARE));
    const rotating = sorted.filter((item) => !priority.includes(item));
    const slots = budget - priority.length;
    const last = this.lastRead.get(scope);
    const next = last === undefined ? 0 : rotating.findIndex((item) => idOf(item) > last);
    const start = next < 0 ? 0 : next;
    const turn = Array.from({ length: slots }, (_, i) => rotating[(start + i) % rotating.length]);
    this.lastRead.set(scope, idOf(turn[turn.length - 1]));
    return { due: [...priority, ...turn], sweepPolls: Math.ceil(rotating.length / slots) };
  }

  forget(scope: string): void {
    this.lastRead.delete(scope);
  }
}
