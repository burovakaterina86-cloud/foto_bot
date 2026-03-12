export type RoleKey =
  | 'manager'
  | 'waiter'
  | 'cleaner'
  | 'cook'
  | 'sous_chef'
  | 'barista';

export type RoleConfig = {
  key: RoleKey;
  label: string;
};

export const roles: RoleConfig[] = [
  { key: 'manager', label: 'Менеджер' },
  { key: 'waiter', label: 'Официант' },
  { key: 'cleaner', label: 'Клинер' },
  { key: 'cook', label: 'Повар' },
  { key: 'sous_chef', label: 'Су-шеф' },
  { key: 'barista', label: 'Бариста' },
];

export function findRoleByLabel(label: string): RoleConfig | undefined {
  const normalized = label.trim().toLowerCase();
  return roles.find((role) => role.label.toLowerCase() === normalized);
}

