import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import BskyAgent from '@atproto/api'; // Linter ignored
import { Account } from '../../src/services/auth'; 
import { BLUESKY_SERVICE } from '../../src/services/atproto-oauth';

// --- OAuth Configuration ---
// Corrected to match background.ts values
const WEB_CALLBACK_URL = 'https://notisky.symm.app/api/auth/extension-callback';
const CLIENT_METADATA_URL = 'https://notisky.symm.app/client-metadata/client.json';
const AUTHORIZATION_ENDPOINT = `${BLUESKY_SERVICE}/oauth/authorize`; // Use standard authorize endpoint

// PKCE Helper functions
async function generateCodeVerifier(): Promise<string> {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...randomBytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

// --- Login Component ---
function Login() {
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // Handle initiating the OAuth sign-in flow using launchWebAuthFlow
  const handleOAuthLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[launchWebAuthFlow] Started');
    // Note: Handle input is not directly used in this flow, but kept for consistency
    setError(null);
    setInfo('Preparing secure login...');
    setLoading(true);
    let generatedState = null; // Keep state for potential cleanup
    let verifierStorageKey = null; // Keep key for potential cleanup

    try {
        const state = crypto.randomUUID();
        generatedState = state;
        const codeVerifier = await generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const codeChallengeMethod = 'S256';

        // Store verifier in browser.storage.session instead of localStorage
        verifierStorageKey = `pkce_${state}`;
        await browser.storage.session.set({ [verifierStorageKey]: codeVerifier });
        console.log('[launchWebAuthFlow] Stored PKCE verifier in session storage for state:', state);

        // Define scopes needed
        const scope = 'atproto transition:generic transition:chat.bsky'; // Match client.json

        const authParams = new URLSearchParams({
            response_type: 'code',
            client_id: CLIENT_METADATA_URL, // Use hosted metadata URL as client_id
            redirect_uri: WEB_CALLBACK_URL, // Use hosted callback URL
            scope: scope,
            state: state,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
        });
        const authorizationUrl = `${AUTHORIZATION_ENDPOINT}?${authParams.toString()}`;
        console.log('[launchWebAuthFlow] Constructed Auth URL:', authorizationUrl);

        setInfo('Waiting for Bluesky authorization...');
        console.log('[launchWebAuthFlow] Calling browser.identity.launchWebAuthFlow...');
        
        const resultUrl = await browser.identity.launchWebAuthFlow({
            url: authorizationUrl,
            interactive: true
        });

        console.log('[launchWebAuthFlow] Call finished. Result URL:', resultUrl);

        // --- Process Result URL --- 
        if (!resultUrl) {
            console.log('[launchWebAuthFlow] Flow cancelled by user (no result URL).');
            throw new Error('Authentication flow was cancelled.');
        }

        const url = new URL(resultUrl);
        // Check query parameters, not hash fragment
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const errorCode = url.searchParams.get('error');
        const errorDesc = url.searchParams.get('error_description');

        if (errorCode) {
             console.error('[launchWebAuthFlow] OAuth Error in callback URL:', errorCode, errorDesc);
             throw new Error(`OAuth Error: ${errorDesc || errorCode}`);
        }
        if (!code) {
            console.error('[launchWebAuthFlow] Code not found in callback URL parameters:', url.search);
            throw new Error('Authorization code not found in callback URL.');
        }
        if (returnedState !== state) {
             if (verifierStorageKey) await browser.storage.session.remove(verifierStorageKey); 
             console.error('[launchWebAuthFlow] State mismatch! Expected:', state, 'Received:', returnedState);
             throw new Error('OAuth state mismatch. Security check failed.');
        }

        // --- Send to Background --- 
        setInfo('Authentication approved! Finalizing login...');
        console.log('[launchWebAuthFlow] Sending code and verifier key to background...');
        const exchangeResponse = await browser.runtime.sendMessage({
            type: 'EXCHANGE_OAUTH_CODE',
            data: { code, state: returnedState, verifierStorageKey: verifierStorageKey }
        });

        // --- Handle Background Response --- 
        console.log('[launchWebAuthFlow] Received response from background:', exchangeResponse);
        if (exchangeResponse && exchangeResponse.success) {
            console.log('Background reported successful exchange.');
            setInfo('Login successful!');
            // Verifier is cleaned up by background script
            verifierStorageKey = null; // Prevent cleanup here
            setTimeout(() => window.close(), 1500);
        } else {
             console.error('[launchWebAuthFlow] Background reported error:', exchangeResponse?.error);
             throw new Error(exchangeResponse?.error || 'Token exchange failed in background.');
        }

    } catch (err: any) {
      console.error('[launchWebAuthFlow] Overall flow error:', err);
      if (err.message?.includes('cancelled') || err.message?.includes('closed by the user')) {
           setError('Login cancelled.');
      } else {
           setError(`Login failed: ${err.message || 'Unknown error'}`);
      }
      // Clean up verifier if state was generated and error occurred
      if (verifierStorageKey) await browser.storage.session.remove(verifierStorageKey);
      setLoading(false);
      setInfo(null);
    }
  };

  return (
    <div className="login-container">
      <div className="login-header">
        <img src="../icon/128.png" alt="Notisky Logo" style={{width: 48, height: 48, marginBottom: 10}}/>
        <h1>Sign in via Bluesky</h1>
        <p>Connect your Bluesky account securely using OAuth</p>
      </div>
      
      <form onSubmit={handleOAuthLogin} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {info && !error && <div className="info-message">{info}</div>}
        
        {/* Optional: Keep handle input disabled or remove it */}
        {/* <div className="form-group">
          <label htmlFor="handle">Bluesky Handle</label>
          <input
            type="text"
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="yourname.bsky.social"
            disabled={true} // Disable if kept
            autoCapitalize="none"
            autoCorrect="false"
          />
        </div> */}
                
        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : 'Sign in with Bluesky'}
        </button>
      </form>
      
      <div className="login-footer">
        <p>
           A new window will open to authorize Notisky with Bluesky.
        </p>
      </div>
    </div>
  );
}

export default Login; 