/** Nombre completo con mayúscula inicial. */
export const formatName = (user) => capitalize(user.first) + ' ' + capitalize(user.last);

export function formatList(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
