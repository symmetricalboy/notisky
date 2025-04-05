// This file may no longer be necessary or could be refactored further.
// It previously contained BrowserOAuthClient logic unsuitable for Service Workers.

import BskyAgent from '@atproto/api'; // Reverting to default import as linter suggests again
import { Account } from './auth';

// Constants
export const BLUESKY_SERVICE = 'https://bsky.social';

// Potential future home for functions converting raw token data to Account,
// but might fit better in auth.ts or where the callback is handled.

/*
// Example: Convert raw token data (e.g., from message) to Account
// This assumes you get the profile info elsewhere or the token endpoint returns it
export async function tokenDataToAccount(tokenData: { 
    access_token: string;
    refresh_token: string;
    did: string; // or sub 
}) {
// Removed Promise<Account | null> for simplicity in example comment
  try {
    if (!tokenData || !tokenData.did || !tokenData.access_token || !tokenData.refresh_token) {
      console.error('Invalid token data provided');
      return null;
    }

    // Need to fetch handle and email separately
    const agent = new BskyAgent({ service: BLUESKY_SERVICE });
    await agent.resumeSession({ 
        accessJwt: tokenData.access_token, 
        refreshJwt: tokenData.refresh_token,
        did: tokenData.did,
        handle: 'unknown' // Temporary handle - profile fetch will get correct one
    });

    if (!agent.session?.did) {
        console.error('Failed to resume session with provided tokens');
        return null;
    }

    const { data: profile } = await agent.getProfile({ actor: agent.session.did });

    const account: Account = {
      did: agent.session.did,
      handle: profile.handle,
      refreshJwt: agent.session.refreshJwt!,
      accessJwt: agent.session.accessJwt!,
      email: profile.email
    };
    return account;

  } catch (error) {
    console.error('Error converting token data to account:', error);
    return null;
  }
}
*/ 