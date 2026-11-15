import { fetchUsers } from './api';
import * as fmt from './format.js';
import Store from './store';

/** Arranca la app: descarga usuarios y los guarda en el store. */
export async function bootstrap(): Promise<void> {
  const store = new Store();
  const users = await fetchUsers();
  for (const user of users) {
    store.add(fmt.formatName(user));
  }
  render(store);
}

const render = (store: Store): void => {
  console.log(fmt.formatList(store.items));
};
