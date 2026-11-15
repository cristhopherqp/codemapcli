type Listener = (items: string[]) => void;

export default class Store {
  items: string[] = [];
  private listeners: Listener[] = [];

  constructor() {
    this.items = [];
  }

  add(item: string): void {
    this.items.push(item);
    this.notify();
  }

  subscribe = (listener: Listener): void => {
    this.listeners.push(listener);
  };

  private notify(): void {
    this.listeners.forEach((listener) => listener(this.items));
  }
}

export function StoreBadge({ store }: { store: Store }) {
  return <span>{store.items.length}</span>;
}
