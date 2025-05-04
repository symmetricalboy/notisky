import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import BskyAgent from '@atproto/api'; // Linter ignored
// Removed unused Account import and BLUESKY_SERVICE import

// --- PKCE Helper Functions ---
// (Keep generateCodeVerifier and generateCodeChallenge as they were)
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

// --- Constants for Auth Server Flow ---
// const AUTH_SERVER_BASE_URL = 'https://notisky.symm.app'; 
// const AUTH_INITIATE_ENDPOINT = `${AUTH_SERVER_BASE_URL}/api/auth/ext-auth`;
const CLIENT_ID = 'https://notisky.symm.app/client-metadata/client.json'; // Use the actual Client ID URL

// Bluesky OAuth Constants for Direct Flow
const BLUESKY_OAUTH_URL = 'https://bsky.social/oauth/authorize';
// const BLUESKY_REDIRECT_URI = 'https://notisky.symm.app/api/auth/extension-callback';

// Function to get the extension's redirect URI for launchWebAuthFlow
function getExtensionRedirectUri(): string {
    // IMPORTANT: Make sure this exact URI is registered with Bluesky!
    return browser.identity.getRedirectURL(); // Gets https://<extension-id>.chromiumapp.org/
}

// --- Login Component ---
function Login() {
  const [handle, setHandle] = useState(''); // Keep for consistency?
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // Listener for completion message from background script
  useEffect(() => {
    const handleMessage = (message: any, sender: browser.runtime.MessageSender) => {
       if (sender.id !== browser.runtime.id) return; // Only listen to self

       if (message.type === 'OAUTH_COMPLETE') { // Listen for the final outcome
          console.log('[Login] Received OAUTH_COMPLETE from background:', message);
          setLoading(false);
          if (message.success) {
            setInfo('Login successful! You can close this window.');
            setError(null);
            setTimeout(() => window.close(), 1500); 
          } else {
            setError(`Login failed: ${message.error || 'Unknown error from background.'}`);
            setInfo(null);
          }
       }
    };
    browser.runtime.onMessage.addListener(handleMessage);
    return () => browser.runtime.onMessage.removeListener(handleMessage);
  }, []);
  
  // Refactored direct Bluesky OAuth flow using launchWebAuthFlow
  const handleLoginDirectOAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[Login Page - launchWebAuthFlow] Started');
    setError(null);
    setInfo('Preparing secure login with Bluesky...');
    setLoading(true);
    let generatedState: string | null = null;
    let verifierStorageKey: string | null = null;

    try {
      // 1. Generate PKCE values and state
      const state = crypto.randomUUID();
      generatedState = state;
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const redirectUri = getExtensionRedirectUri();
      console.log(`[Login Page - launchWebAuthFlow] State: ${state.substring(0, 5)}...`);
      console.log(`[Login Page - launchWebAuthFlow] Challenge: ${codeChallenge}`);
      console.log(`[Login Page - launchWebAuthFlow] Redirect URI: ${redirectUri}`);

      if (!CLIENT_ID) {
           throw new Error("Client ID is not set."); // Keep a basic check
      }
      if (!redirectUri) {
        throw new Error("Could not determine extension redirect URI.");
      }

      // 2. Store verifier temporarily (background script will retrieve and remove it)
      verifierStorageKey = `pkce_${state}`;
      await browser.storage.session.set({ [verifierStorageKey]: codeVerifier });
      console.log('[Login Page - launchWebAuthFlow] Stored PKCE verifier in session storage.');

      // 3. Construct URL for Bluesky's OAuth endpoint
      const blueskyOAuthParams = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: redirectUri, // Use the extension's specific redirect URI
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // Optional: Add scope if needed, e.g., 'read write'
        // scope: 'read write',
      });
      const blueskyOAuthUrl = `${BLUESKY_OAUTH_URL}?${blueskyOAuthParams.toString()}`;
      console.log('[Login Page - launchWebAuthFlow] Constructed Bluesky OAuth URL:', blueskyOAuthUrl);

      // 4. Use launchWebAuthFlow to initiate the flow
      setInfo('Redirecting to Bluesky for authorization...');
      console.log('[Login Page - launchWebAuthFlow] Calling browser.identity.launchWebAuthFlow...');

      const finalRedirectUrl = await browser.identity.launchWebAuthFlow({
        url: blueskyOAuthUrl,
        interactive: true // Allows user interaction (login, consent)
      });

      console.log('[Login Page - launchWebAuthFlow] Received final redirect URL:', finalRedirectUrl);

      if (!finalRedirectUrl) {
          throw new Error('Authentication flow was cancelled or failed before redirect.');
      }

      // 5. Parse code and state from the final redirect URL
      const url = new URL(finalRedirectUrl);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code) {
        throw new Error('Authorization code not found in redirect URL.');
      }
      if (returnedState !== generatedState) {
        // Attempt to clean up stored verifier if state mismatch
        if (verifierStorageKey) {
             try { await browser.storage.session.remove(verifierStorageKey); } catch (e) { console.warn('Error during cleanup on state mismatch:', e)}
        }
        throw new Error('State mismatch error. Potential CSRF attack.');
      }

      // 6. Send code and state (for verifier lookup) to background script for token exchange
      setInfo('Authorization received. Completing sign in...');
      console.log('[Login Page - launchWebAuthFlow] Sending code and state to background script...');
      await browser.runtime.sendMessage({
          type: 'EXCHANGE_CODE',
          data: {
              code: code,
              state: returnedState, // Background uses this to find the verifier
              clientId: CLIENT_ID, // Send client ID used
              redirectUri: redirectUri // Send redirect URI used
          }
      });

      console.log('[Login Page - launchWebAuthFlow] Message sent to background. Waiting for OAUTH_COMPLETE...');
      // Login page now waits for the OAUTH_COMPLETE message from the background via the useEffect listener

    } catch (err: any) {
      console.error('[Login Page - launchWebAuthFlow] Error during login flow:', err);
      // Attempt to clean up stored verifier on error
      if (verifierStorageKey) {
           try { await browser.storage.session.remove(verifierStorageKey); } catch (e) { console.warn('Error during cleanup on error:', e)}
      }
      // Check if the error is from launchWebAuthFlow being cancelled
      if (err.message?.includes('cancelled') || err.message?.includes('closed by the user')) {
           setError('Authentication cancelled.');
      } else {
           setError(`Login failed: ${err.message || 'Unknown error'}`);
      }
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
      
      {/* Ensure the form uses the correct handler */}
      <form onSubmit={handleLoginDirectOAuth} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {info && !error && <div className="info-message">{info}</div>}
                        
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