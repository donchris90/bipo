import express, { NextFunction, Request, Response } from 'express';
import { allNumbers, computeMultipliers, scaleStakes, suggestStakes, sumStakes } from './game';
import { PROBABILITIES } from './probability';
import { placeBet, ValidationError } from './settlement';
import { BetStore, Wallet } from './store';
import { DEFAULT_CONFIG, GameConfig, PlaceBetRequest, SuggestStakesRequest, SuggestStakesResponse } from './types';

const config: GameConfig = { ...DEFAULT_CONFIG };
const store = new BetStore();
const wallet = new Wallet(10_000);

const app = express();
app.use(express.json());

// Minimal CORS so the static game screen (opened as a local file or served
// from a different port) can call this API directly. Tighten this to a
// specific origin before deploying for real.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- GET /api/config ----------------------------------------------------
// Odds and the RTP, published so players can find them (and so the
// frontend never has to hard-code the math).
app.get('/api/config', (_req: Request, res: Response) => {
  const multipliers = computeMultipliers(config);
  res.json({
    rtp: config.rtp,
    basePrize: config.basePrize,
    minTotalStake: config.minTotalStake,
    maxTotalStake: config.maxTotalStake,
    numbers: allNumbers().map((n) => ({
      n,
      probability: PROBABILITIES[n],
      multiplier: multipliers[n],
    })),
  });
});

app.get('/api/wallet', (_req: Request, res: Response) => {
  res.json({ balance: wallet.getBalance() });
});

// ---- POST /api/stakes/suggest -------------------------------------------
app.post('/api/stakes/suggest', (req: Request, res: Response) => {
  const body = req.body as SuggestStakesRequest;
  if (!Array.isArray(body.picks) || body.picks.length === 0) {
    return res.status(400).json({ error: 'picks must be a non-empty array' });
  }
  for (const n of body.picks) {
    if (!Number.isInteger(n) || n < 0 || n > 27) {
      return res.status(400).json({ error: `pick ${n} is out of range 0-27` });
    }
  }

  const multipliers = computeMultipliers(config);
  const { stakes: baseStakes, suggestedTotal } = suggestStakes(body.picks, config);

  const finalStakes =
    body.desiredTotal !== undefined ? scaleStakes(baseStakes, body.desiredTotal) : baseStakes;
  const total = sumStakes(finalStakes);

  const prizeIfHit: Record<number, number> = {};
  for (const n of body.picks) {
    prizeIfHit[n] = finalStakes[n] * multipliers[n];
  }

  const response: SuggestStakesResponse = {
    picks: body.picks,
    stakes: finalStakes,
    multipliers: Object.fromEntries(body.picks.map((n) => [n, multipliers[n]])),
    suggestedTotal,
    total,
    prizeIfHit,
  };
  res.json(response);
});

// ---- POST /api/bets --------------------------------------------------
app.post('/api/bets', (req: Request, res: Response) => {
  const body = req.body as PlaceBetRequest;
  try {
    const result = placeBet(body, config, store, wallet);
    res.json({ ...result, balance: wallet.getBalance() });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof Error && err.message === 'insufficient balance') {
      return res.status(402).json({ error: err.message });
    }
    throw err;
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Lucky Number backend listening on :${PORT}`);
  });
}

export { app, config, store, wallet };
