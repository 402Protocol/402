/**
 * 402 Lounge — shared types. Identity = Ink wallet address.
 * All writes are EIP-712 signed (see signing.ts); posts are payment-gated.
 */
import type { Address, Hex } from 'viem';

export const LOUNGE_CHAIN_ID = 57073;

export interface LoungePostMessage {
  author: Address;
  title: string;
  body: string;
  timestamp: bigint;
}

export interface LoungeCommentMessage {
  author: Address;
  postId: string;
  body: string;
  timestamp: bigint;
  parentId: string;
}

export interface LoungeVoteMessage {
  author: Address;
  postId: string;
  direction: number; // int8: 1 or -1
  timestamp: bigint;
}

export interface LoungeChatMessage {
  author: Address;
  message: string;
  timestamp: bigint;
}

/** Signed display-name claim. Only wallets with ≥1 paid post may claim. */
export interface LoungeNameClaimMessage {
  author: Address;
  name: string;
  timestamp: bigint;
}

export interface Post {
  id: string;
  author: Address;
  title: string;
  body: string;
  createdAt: number; // unix seconds
  upvotes: number;
  downvotes: number;
  score: number;
  commentCount: number;
}

export interface Comment {
  id: string;
  author: Address;
  body: string;
  createdAt: number; // unix seconds
  parentId: string;
}

/** Free town-chat message. Only wallets with ≥1 paid post may send. */
export interface ChatMessage {
  id: string;
  author: Address;
  message: string;
  createdAt: number; // unix seconds
}

export type VoteDirection = 1 | -1;

export interface ReceiptLogLike {
  address: string;
  topics: string[];
  data: string;
}

export interface ReceiptLike {
  status: string;
  logs: ReceiptLogLike[];
}

/** Injected receipt fetcher — viem public client in prod, mock in tests. */
export type GetReceipt = (txHash: Hex) => Promise<ReceiptLike | null>;
