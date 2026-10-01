import { randomInt } from 'node:crypto';

/**
 * Display names for the filler players that complete a table when nobody else joins.
 *
 * They must read like ordinary usernames, so they come in several shapes
 * (daniel_42, MayaOkoro, chris.k, ngozi2003 ...). A generated name is thrown away
 * if it contains anything that hints at automation ("ai", "bot", "cpu" ...), which
 * also drops names that merely contain those letters (Aisha, Kai, Hailey, Rainer).
 * The internal `synthetic` / `bot:` markers stay server-side and are never shown.
 */

const FIRST_NAMES = [
  'Daniel', 'Maya', 'Chris', 'Sophia', 'Jayden', 'Amara', 'Kevin', 'Lina', 'Marcus', 'Zoe',
  'Ryan', 'Nora', 'Ethan', 'Ella', 'Noah', 'Tunde', 'Chidi', 'Ngozi', 'Emeka', 'Folake',
  'Bayo', 'Tola', 'Seun', 'Kemi', 'Femi', 'Ada', 'Obinna', 'Yemi', 'Sade', 'Ife',
  'Kunle', 'Dayo', 'Tobi', 'Efe', 'Uche', 'Bisi', 'Segun', 'Nneka', 'Wale', 'Dami',
  'Lola', 'Jide', 'Funmi', 'Ibrahim', 'Hassan', 'Zainab', 'Musa', 'Fatima', 'Grace', 'David',
  'Joshua', 'Esther', 'Samuel', 'Ruth', 'Victor', 'Linda', 'Peter', 'Janet', 'Victoria', 'Michael',
  'Leo', 'Mia', 'Omar', 'Layla', 'Tariq', 'Sara', 'Liam', 'Olivia', 'Jack', 'Emma',
];

const LAST_NAMES = [
  'Okoro', 'Adebayo', 'Johnson', 'Bello', 'Eze', 'Williams', 'Musa', 'Okafor', 'Ade', 'Brown',
  'Ibrahim', 'Nwosu', 'Smith', 'Lawal', 'Obi', 'Taylor', 'Yusuf', 'Balogun', 'James', 'Chukwu',
  'Ojo', 'Davis', 'Salami', 'Uzor', 'Martins', 'Cole', 'Idowu', 'Nnamdi', 'Peters', 'Bakare',
];

// Anything containing these (case-insensitive) is rejected, including as part of a longer word.
const FORBIDDEN = /ai|bot|cpu|robot|computer|auto|npc|synthetic/i;

const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)];
const two = () => String(randomInt(10, 100));

function candidate(): string {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  switch (randomInt(7)) {
    case 0: return `${first}_${two()}`;
    case 1: return `${first}${last}`;
    case 2: return `${first.toLowerCase()}.${last.toLowerCase()}`;
    case 3: return `${first.toLowerCase()}${randomInt(1985, 2008)}`;
    case 4: return `${first}_${last[0]}`;
    case 5: return `${first.toLowerCase()}_${last.toLowerCase()}${two()}`;
    default: return `${first.toLowerCase()}${two()}`;
  }
}

/** One random username that never contains AI/bot wording. */
export function randomPlayerName(): string {
  for (let i = 0; i < 50; i += 1) {
    const name = candidate();
    if (!FORBIDDEN.test(name)) return name;
  }
  return `player${randomInt(1000, 10000)}`; // unreachable in practice; still passes the filter
}

/** `count` different random usernames (no two alike), optionally avoiding names already at the table. */
export function randomPlayerNames(count: number, taken: Iterable<string> = []): string[] {
  const used = new Set<string>([...taken].map((n) => n.toLowerCase()));
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard < 500) {
    guard += 1;
    const name = randomPlayerName();
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    out.push(name);
  }
  while (out.length < count) out.push(`player${randomInt(1000, 10000)}${out.length}`);
  return out;
}
