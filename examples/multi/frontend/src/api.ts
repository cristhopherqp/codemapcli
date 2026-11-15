export interface User {
  first: string;
  last: string;
}

/** Descarga la lista de usuarios desde la API. */
export async function fetchUsers(): Promise<User[]> {
  const response = await fetch('/api/users');
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return response.json();
}
