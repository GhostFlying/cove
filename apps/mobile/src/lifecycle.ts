// Small ownership gate for this actual native host. T3 owns shared sessions and
// mirrors; this gate only invalidates async work across foreground incarnations.
export class ForegroundOwnership {
  private generation = 0;
  private active = true;

  begin(): number {
    return ++this.generation;
  }
  current(generation: number): boolean {
    return this.active && generation === this.generation;
  }
  setForeground(active: boolean): void {
    this.active = active;
    ++this.generation;
  }
}
