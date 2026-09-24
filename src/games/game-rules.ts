import { BadRequestException } from '@nestjs/common';

// What an admin may set in a game's rulesJson, validated. The backend reads
// these keys directly (settlement, the round scheduler, entry placement), so a
// typo or an out-of-range number here would silently change real money
// outcomes — hence a strict allow-list with bounds instead of "any JSON".

export type GameRules = Record<string, number | null>;

const SHARED = ['openSeconds', 'minStake', 'maxStake'] as const;
const SHAPES = {
  dice: ['payoutMultiplier', 'diceCount', 'diceSides', 'numberPayouts', ...SHARED],
  crash: ['houseEdge', 'growthRate', ...SHARED],
  lucky: ['payoutMultiplier', ...SHARED],
  ludo: ['minEntry', 'maxEntry', 'turnSeconds', 'reconnectSeconds', 'prizeFirstPercent', 'prizeSecondPercent'],
} as const;

type Shape = keyof typeof SHAPES;

export function shapeOf(rules: any): Shape | null {
  if (!rules || typeof rules !== 'object') return null;
  if (typeof rules.houseEdge === 'number' && typeof rules.growthRate === 'number') return 'crash';
  if (rules.diceCount && rules.diceSides) return 'dice';
  if (typeof rules.payoutMultiplier === 'number') return 'lucky';
  if (typeof rules.turnSeconds === 'number' && typeof rules.prizeFirstPercent === 'number') return 'ludo';
  return null;
}

// Probability of the single most likely sum when rolling `dice` dice with faces
// 0..sides-1 — the best single number a player can back.
export function maxSumProbability(dice: number, sides: number): number {
  let dist = new Map<number, number>([[0, 1]]);
  for (let i = 0; i < dice; i++) {
    const next = new Map<number, number>();
    for (const [sum, ways] of dist) for (let face = 0; face < sides; face++) next.set(sum + face, (next.get(sum + face) ?? 0) + ways);
    dist = next;
  }
  const total = sides ** dice;
  return Math.max(...dist.values()) / total;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isInt = (v: unknown, min: number, max: number): v is number => isNum(v) && Number.isInteger(v) && v >= min && v <= max;

export function validateGameRules(existing: any, incoming: any): GameRules {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new BadRequestException('rulesJson must be an object');

  const shape = shapeOf(existing) ?? shapeOf(incoming);
  if (!shape) throw new BadRequestException('rulesJson must define a supported game: dice (diceCount, diceSides, payoutMultiplier), crash (houseEdge, growthRate) or lucky (payoutMultiplier)');
  const allowed: readonly string[] = SHAPES[shape];

  const unknown = Object.keys(incoming).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new BadRequestException(`Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  if (shapeOf(incoming) !== shape) throw new BadRequestException('The core settings of this game cannot be removed');

  const errors: string[] = [];
  const out: GameRules = {};

  if (shape === 'dice') {
    if (!isInt(incoming.diceCount, 1, 6)) errors.push('diceCount must be a whole number from 1 to 6');
    if (!isInt(incoming.diceSides, 2, 10)) errors.push('diceSides must be a whole number from 2 to 10');
    // The client's number grid (0-27) is built for the existing dice, so the
    // dice themselves can't be changed from here — only how the game pays.
    if (existing?.diceCount && incoming.diceCount !== existing.diceCount) errors.push('diceCount cannot be changed');
    if (existing?.diceSides && incoming.diceSides !== existing.diceSides) errors.push('diceSides cannot be changed');
    if (!isNum(incoming.payoutMultiplier) || incoming.payoutMultiplier < 1.01 || incoming.payoutMultiplier > 1000) {
      errors.push('payoutMultiplier must be a number from 1.01 to 1000');
    } else if (!errors.length) {
      // Guard rail: backing the single likeliest number must not have a
      // positive expected return, or players beat the house on average.
      const best = maxSumProbability(incoming.diceCount, incoming.diceSides);
      if (incoming.payoutMultiplier * best >= 1) {
        const limit = Math.floor((1 / best) * 100) / 100;
        errors.push(`payoutMultiplier is too high: at ${incoming.payoutMultiplier}x players would win money on average. It must be below ${limit}x`);
      }
    }
    out.payoutMultiplier = incoming.payoutMultiplier;
    out.diceCount = incoming.diceCount;
    out.diceSides = incoming.diceSides;
    if (incoming.numberPayouts !== undefined) {
      if (!incoming.numberPayouts || typeof incoming.numberPayouts !== 'object' || Array.isArray(incoming.numberPayouts)) {
        errors.push('numberPayouts must be an object mapping each winning number to its payout value');
      } else if (!errors.length) {
        const max = incoming.diceCount * (incoming.diceSides - 1);
        const clean: Record<string, number> = {};
        // Per-number payout values are operator-defined and independent of
        // the mathematical probability of the number. Partial overrides are
        // valid; an unset number keeps the shared payoutMultiplier.
        for (const [key, raw] of Object.entries(incoming.numberPayouts)) {
          const n = Number(key);
          if (!/^\d+$/.test(key) || !Number.isInteger(n) || n < 0 || n > max) {
            errors.push(`numberPayouts may only contain numbers 0-${max}`);
            continue;
          }
          if (!isNum(raw) || raw < 0 || raw > 1000) {
            errors.push(`numberPayouts[${n}] must be a number from 0 to 1000`);
            continue;
          }
          clean[key] = raw;
        }
        if (!errors.length && Object.keys(clean).length) out.numberPayouts = clean as any;
      }
    }
  } else if (shape === 'crash') {
    if (!isNum(incoming.houseEdge) || incoming.houseEdge < 0.005 || incoming.houseEdge > 0.2) errors.push('houseEdge must be a number from 0.005 (0.5%) to 0.2 (20%)');
    if (!isNum(incoming.growthRate) || incoming.growthRate < 0.01 || incoming.growthRate > 1) errors.push('growthRate must be a number from 0.01 to 1');
    out.houseEdge = incoming.houseEdge;
    out.growthRate = incoming.growthRate;
  } else if (shape === 'ludo') {
    const ints: Array<[string, number, number]> = [['minEntry', 1, 1_000_000_000], ['maxEntry', 1, 1_000_000_000], ['turnSeconds', 5, 120], ['reconnectSeconds', 10, 900]];
    for (const [key, min, max] of ints) if (!isInt(incoming[key], min, max)) errors.push(`${key} must be a whole number from ${min} to ${max}`);
    if (isInt(incoming.minEntry, 1, 1_000_000_000) && isInt(incoming.maxEntry, 1, 1_000_000_000) && incoming.maxEntry < incoming.minEntry) errors.push('maxEntry cannot be below minEntry');
    if (!isNum(incoming.prizeFirstPercent) || incoming.prizeFirstPercent < 0 || incoming.prizeFirstPercent > 100) errors.push('prizeFirstPercent must be from 0 to 100');
    if (!isNum(incoming.prizeSecondPercent) || incoming.prizeSecondPercent < 0 || incoming.prizeSecondPercent > 100) errors.push('prizeSecondPercent must be from 0 to 100');
    if (isNum(incoming.prizeFirstPercent) && isNum(incoming.prizeSecondPercent) && Math.abs((incoming.prizeFirstPercent + incoming.prizeSecondPercent) - 100) > 0.001) errors.push('Ludo prize percentages must add up to 100');
    if (!errors.length) { out.minEntry = incoming.minEntry; out.maxEntry = incoming.maxEntry; out.turnSeconds = incoming.turnSeconds; out.reconnectSeconds = incoming.reconnectSeconds; out.prizeFirstPercent = incoming.prizeFirstPercent; out.prizeSecondPercent = incoming.prizeSecondPercent; }
  } else {
    if (!isNum(incoming.payoutMultiplier) || incoming.payoutMultiplier < 1.01 || incoming.payoutMultiplier > 1000) errors.push('payoutMultiplier must be a number from 1.01 to 1000');
    out.payoutMultiplier = incoming.payoutMultiplier;
  }

  // shared limits
  if (incoming.openSeconds !== undefined) {
    if (!isInt(incoming.openSeconds, 5, 300)) errors.push('openSeconds must be a whole number from 5 to 300');
    else out.openSeconds = incoming.openSeconds;
  }
  if (incoming.minStake !== undefined) {
    if (!isInt(incoming.minStake, 1, 1_000_000_000)) errors.push('minStake must be a whole number of coins, at least 1');
    else out.minStake = incoming.minStake;
  }
  if (incoming.maxStake !== undefined && incoming.maxStake !== null) {
    if (!isInt(incoming.maxStake, 1, 1_000_000_000)) errors.push('maxStake must be a whole number of coins');
    else if (isInt(incoming.minStake, 1, 1_000_000_000) && incoming.maxStake < incoming.minStake) errors.push('maxStake cannot be below minStake');
    else out.maxStake = incoming.maxStake;
  }

  if (errors.length) throw new BadRequestException(errors.join('; '));
  return out;
}

// Order-independent equality for plain settings objects.
export function sameRules(a: any, b: any): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}
