export type RoleKey =
  | 'admin'
  | 'senior_waiter'
  | 'waiter'
  | 'bartender'
  | 'hostess'
  | 'cashier'
  | 'cleaner';

export type RoleConfig = {
  key: RoleKey;
  label: string;
};

export const roles: RoleConfig[] = [
  { key: 'admin', label: 'Администратор' },
  { key: 'senior_waiter', label: 'Старший официант' },
  { key: 'waiter', label: 'Официант' },
  { key: 'bartender', label: 'Бармен' },
  { key: 'hostess', label: 'Хостес' },
  { key: 'cashier', label: 'Кассир' },
  { key: 'cleaner', label: 'Уборщик' },
];

export function findRoleByLabel(label: string): RoleConfig | undefined {
  const normalized = label.trim().toLowerCase();
  return roles.find((role) => role.label.toLowerCase() === normalized);
}

