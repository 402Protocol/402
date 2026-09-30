/**
 * The Count — agent blackjack game engine. Pure functions only: no I/O,
 * no randomness except through an explicit seed. All amounts are integer
 * USDC base units (bigint); blackjack pays 3:2 as bet*5/2 (floored — odd
 * base-unit bets lose at most half a unit of dust to the house).
 *
 * Provable fairness: the shoe is a Fisher-Yates shuffle driven by
 * shoeRandom(seed), a sha256(seed || counter) stream. The server publishes
 * seedHash(seed) at shoe creation and reveals the seed on reshuffle, so any
 * agent can reimplement shoeRandom and verify every card dealt. Card
 * counting is not just allowed — it's the point.
 */
import { createHash } from 'node:crypto';
import type { Hex } from 'viem';

export type Rank =
  | 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10'
  | 'J' | 'Q' | 'K';
export type Suit = 'S' | 'H' | 'D' | 'C';

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type HandStatus =
  | 'active'
  | 'player_blackjack'
  | 'bust'
  | 'dealer_blackjack'
  | 'push'
  | 'player_win'
  | 'dealer_win';

const RANKS: Rank[] = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

/** Six decks, per the house rules. */
export const SHOE_DECKS = 6;
export const SHOE_SIZE = SHOE_DECKS * 52;
/** Reshuffle when this fraction of the shoe has been dealt. */
export const RESHUFFLE_PENETRATION = 0.75;

/**
 * Deterministic PRNG: sha256(seed || counter-as-u64be) streamed as
 * big-endian uint32s, each scaled to [0, 1). Reimplementable by any agent
 * from the revealed seed.
 */
export function shoeRandom(seed: Hex): () => number {
  const seedBuf = Buffer.from(seed.slice(2), 'hex');
  let counter = 0;
  let buf = Buffer.alloc(0);
  let i = 0;
  return () => {
    if (i + 4 > buf.length) {
      const ctr = Buffer.alloc(8);
      ctr.writeBigUInt64BE(BigInt(counter));
      buf = createHash('sha256').update(seedBuf).update(ctr).digest();
      counter += 1;
      i = 0;
    }
    const v = buf.readUInt32BE(i);
    i += 4;
    return v / 0x100000000;
  };
}

/** Commitment published at shoe creation: agents verify it on reveal. */
export function seedHash(seed: Hex): Hex {
  return `0x${createHash('sha256')
    .update(Buffer.from(seed.slice(2), 'hex'))
    .digest('hex')}` as Hex;
}

/** Six-deck shoe, Fisher-Yates shuffled from the seed. */
export function newShoe(seed: Hex): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < SHOE_DECKS; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ rank, suit });
      }
    }
  }
  const rand = shoeRandom(seed);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = cards[i]!;
    cards[i] = cards[j]!;
    cards[j] = tmp;
  }
  return cards;
}

/** Blackjack hand value: aces count 11 unless that busts, then 1 each. */
export function handValue(cards: Card[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      aces += 1;
      total += 11;
    } else if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J') {
      total += 10;
    } else {
      total += parseInt(c.rank, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

/** A natural: exactly two cards totalling 21. */
export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && handValue(cards) === 21;
}

/**
 * Deal one hand: player, dealer-up, player, dealer-hole. Returns the new
 * shoe position. Throws shoe_exhausted when fewer than 4 cards remain.
 */
export function dealHand(
  cards: Card[],
  pos: number,
): { player: Card[]; dealer: Card[]; pos: number } {
  if (pos + 4 > cards.length) throw new Error('shoe_exhausted');
  return {
    player: [cards[pos]!, cards[pos + 2]!],
    dealer: [cards[pos + 1]!, cards[pos + 3]!],
    pos: pos + 4,
  };
}

/** Draw a single card. Throws shoe_exhausted at the end of the shoe. */
export function drawCard(
  cards: Card[],
  pos: number,
): { card: Card; pos: number } {
  if (pos >= cards.length) throw new Error('shoe_exhausted');
  return { card: cards[pos]!, pos: pos + 1 };
}

/**
 * Dealer plays: hits below 17, stands on ALL 17s (soft 17 stands — house
 * rule, no exceptions). Returns the final dealer hand and shoe position.
 */
export function dealerPlay(
  dealer: Card[],
  cards: Card[],
  pos: number,
): { dealer: Card[]; pos: number } {
  const d = [...dealer];
  let p = pos;
  while (handValue(d) < 17) {
    if (p >= cards.length) throw new Error('shoe_exhausted');
    d.push(cards[p]!);
    p += 1;
  }
  return { dealer: d, pos: p };
}

/**
 * Settle a finished hand. payout is the TOTAL chips returned to the player:
 * 0 on any loss, bet on a push, 2*bet on a win, bet*5/2 on a natural.
 * Naturals are detected from the cards (two cards totalling 21).
 */
export function resolve(
  player: Card[],
  dealer: Card[],
  bet: bigint,
): { status: HandStatus; payout: bigint } {
  const pv = handValue(player);
  const dv = handValue(dealer);
  const pBJ = isBlackjack(player);
  const dBJ = isBlackjack(dealer);
  if (pBJ && dBJ) return { status: 'push', payout: bet };
  if (pBJ) return { status: 'player_blackjack', payout: (bet * 5n) / 2n };
  if (dBJ) return { status: 'dealer_blackjack', payout: 0n };
  if (pv > 21) return { status: 'bust', payout: 0n };
  if (dv > 21 || pv > dv) return { status: 'player_win', payout: bet * 2n };
  if (pv < dv) return { status: 'dealer_win', payout: 0n };
  return { status: 'push', payout: bet };
}
