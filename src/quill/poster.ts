/**
 * Quill X poster — POST https://api.x.com/2/tweets.
 *
 * Dry-run FIRST: postTweet defaults to dryRun=true and only logs the payload.
 * A real post requires an explicit dryRun: false, and even then the caller
 * (the HTTP route) is where human approval lives.
 *
 * The 280-char limit is enforced client-side with code-point counting, so a
 * too-long draft fails before it ever touches the network or spends credits.
 */
export const X_TWEETS_URL = 'https://api.x.com/2/tweets';

/** 280 chars unless the authoring account has X Premium (we assume not). */
export const MAX_TWEET_CHARS = 280;

export interface PostTweetArgs {
  fetchFn?: typeof fetch;
  accessToken: string;
  text: string;
  /** Default true: validate + log, never send. Pass false to really post. */
  dryRun?: boolean;
  /** Optional: post as a reply to this tweet id. */
  replyToTweetId?: string;
  /** Optional: post as a quote tweet of this tweet id. */
  quoteTweetId?: string;
}

export interface PostResult {
  ok: true;
  dryRun: boolean;
  posted: boolean;
  length: number;
  tweetId: string | null;
}

/** Code-point length of the tweet text. */
export function tweetLength(text: string): number {
  return [...text].length;
}

export class TweetTooLongError extends Error {
  readonly length: number;
  constructor(length: number) {
    super(`tweet is ${length} chars; max is ${MAX_TWEET_CHARS}`);
    this.name = 'TweetTooLongError';
    this.length = length;
  }
}

export async function postTweet({
  fetchFn = fetch,
  accessToken,
  text,
  dryRun = true,
  replyToTweetId,
  quoteTweetId,
}: PostTweetArgs): Promise<PostResult> {
  const length = tweetLength(text);
  if (length > MAX_TWEET_CHARS) throw new TweetTooLongError(length);
  if (!text.trim()) throw new Error('tweet text is empty');

  if (dryRun) {
    return { ok: true, dryRun: true, posted: false, length, tweetId: null };
  }

  const payload: Record<string, unknown> = { text };
  if (replyToTweetId) {
    payload.reply = { in_reply_to_tweet_id: replyToTweetId };
  }
  if (quoteTweetId) {
    payload.quote_tweet_id = quoteTweetId;
  }
  const res = await fetchFn(X_TWEETS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `x post tweet: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const body = (await res.json()) as { data?: { id?: string } };
  return {
    ok: true,
    dryRun: false,
    posted: true,
    length,
    tweetId: body?.data?.id ?? null,
  };
}
