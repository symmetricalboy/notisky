import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import { BrowserOAuthClient, type ClientMetadata } from '@atproto/oauth-client-browser';
import BskyAgent from '@atproto/api';
import { Account } from '../../src/services/auth'; // Adjust path as needed
import { BLUESKY_SERVICE } from '../../src/services/atproto-oauth'; // Adjust path for constants

// --- OAuth Configuration (Should match background/shared config) ---

// Fallback Redirect URI
const FALLBACK_REDIRECT_URI = 'https://notisky.symm.app/redirect.html'; // Replace with your actual deployed callback page if different

// Safely get redirect URL
const getRedirectURL = (): string => {
  try {
    if (browser.identity && typeof browser.identity.getRedirectURL === 'function') {
      const url = browser.identity.getRedirectURL();
      if (url && (url.startsWith('https://') || url.startsWith('http://'))) { 
        console.log('Login UI: Using redirect URL from browser.identity:', url);
        return url;
      }
      console.warn('Login UI: browser.identity.getRedirectURL() returned invalid value:', url, 'Using fallback.');
    } else {
        console.warn('Login UI: browser.identity.getRedirectURL is not available. Using fallback.');
    }
  } catch (error) {
    console.warn('Login UI: Error getting redirect URL from browser.identity, using fallback:', error);
  }
  console.log('Login UI: Using fallback redirect URL:', FALLBACK_REDIRECT_URI);
  return FALLBACK_REDIRECT_URI;
};

// Client Metadata
const clientMetadata: ClientMetadata = {
  client_id: 'https://notisky.symm.app/public/client-metadata/client.json', // <<< UPDATED PATH
  client_name: 'Notisky', // Use name consistent with client.json (or this one, just be consistent)
  client_uri: 'https://notisky.symm.app', // Your app's homepage/info URL
  redirect_uris: [getRedirectURL()], 
  logo_uri: 'https://notisky.symm.app/icon/128.png', // URL to your app's logo
  tos_uri: 'https://notisky.symm.app/terms', // URL to Terms of Service
  policy_uri: 'https://notisky.symm.app/privacy', // URL to Privacy Policy
  contacts: ['notisky@symm.app'], // Use email consistent with client.json
  token_endpoint_auth_method: 'none', 
  grant_types: ['authorization_code', 'refresh_token'], 
  response_types: ['code'], 
  scope: 'atproto transition:generic transition:chat.bsky', 
  application_type: 'web', 
  dpop_bound_access_tokens: true 
};

// --- Helper Function (Moved/Adapted from atproto-oauth.ts example) ---
async function oauthSessionToAccount(session: any): Promise<Account | null> {
  try {
    if (!session || typeof session.sub !== 'string' || 
        typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') { 
      console.error('oauthSessionToAccount: Invalid session structure:', session);
      return null;
    }
    console.log(`oauthSessionToAccount: Converting session for DID: ${session.sub}`);
    const agent = new BskyAgent({ 
      service: BLUESKY_SERVICE,
      session: session 
    });
    if (!agent.session?.did || agent.session.did !== session.sub) {
        console.error('oauthSessionToAccount: BskyAgent did not initialize correctly.');
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
    console.log(`oauthSessionToAccount: Account created for handle: ${account.handle}`);
    return account;
  } catch (error) {
    console.error('oauthSessionToAccount: Error converting session:', error);
    return null;
  }
}

// --- Login Component --- 

function Login() {
  const [handle, setHandle] = useState(''); // Use 'handle' instead of 'username'
  // const [password, setPassword] = useState(''); // Password not needed for OAuth
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null); // For status updates

  // Effect to handle OAuth callback when the component loads
  useEffect(() => {
    const processOAuthCallback = async () => {
      // Check if the URL contains OAuth response parameters (fragment)
      if (window.location.hash.includes('#code=') || window.location.hash.includes('#error=')) {
        setLoading(true); // Show loading indicator during callback processing
        setInfo('Processing login callback...');
        setError(null);
        console.log('OAuth callback detected in URL fragment.');
        
        const oauthClient = new BrowserOAuthClient({ 
            clientMetadata, 
            handleResolver: BLUESKY_SERVICE, 
            responseMode: 'fragment' 
        });

        try {
          const result = await oauthClient.init();
          if (result && result.session) {
            console.log('OAuth client initialized successfully with session:', result.session.sub);
            const account = await oauthSessionToAccount(result.session);
            if (account) {
              console.log('Account retrieved from session:', account.handle);
              setInfo(`Welcome ${account.handle}! Finalizing login...`);
              await browser.runtime.sendMessage({
                  type: 'ACCOUNT_ADDED',
                  data: { account }
              });
              console.log('ACCOUNT_ADDED message sent to background.');
              // Close the popup/login window after successful login and message sent
              setTimeout(() => window.close(), 1500); // Small delay for user feedback
            } else {
              setError('Failed to process session data after login.');
              setInfo(null);
            }
          } else {
             // Handle cases where init() doesn't return a session (e.g., error in fragment)
             const hashParams = new URLSearchParams(window.location.hash.substring(1));
             if (hashParams.has('error')) {
                 const errorCode = hashParams.get('error');
                 const errorDesc = hashParams.get('error_description');
                 console.error(`OAuth Error in callback: ${errorCode} - ${errorDesc}`);
                 setError(`Login failed: ${errorDesc || errorCode}`);
                 setInfo(null);
             } else {
                 console.warn('oauthClient.init() did not return a session after callback.', result);
                 setError('Failed to initialize session from callback.');
                 setInfo(null);
             }
          }
        } catch (err: any) {
          console.error('Error during OAuth init/callback processing:', err);
          setError(`An error occurred during login processing: ${err.message || err}`);
          setInfo(null);
        } finally {
          setLoading(false);
          // Clean the URL hash? 
          // window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
        }
      } else {
          console.log('No OAuth callback detected in URL fragment.');
      }
    };

    processOAuthCallback();
  }, []); // Empty dependency array means this runs once on mount

  // Handle initiating the OAuth sign-in flow
  const handleOAuthLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('handleOAuthLogin started');
    if (!handle) {
      setError('Please enter your Bluesky handle (e.g., yourname.bsky.social).');
      return;
    }
    setError(null);
    setInfo('Redirecting to Bluesky for login...');
    setLoading(true);
    
    try {
      console.log('Creating BrowserOAuthClient...');
      const oauthClient = new BrowserOAuthClient({ 
          clientMetadata, 
          handleResolver: BLUESKY_SERVICE, 
          responseMode: 'fragment' 
      });
      
      console.log('Calling oauthClient.signIn()...');
      // Start the sign-in process - this will redirect the user
      await oauthClient.signIn(handle.trim());
      
      // This part might not be reached due to redirect
      console.log('Redirecting to Bluesky login... (Should not see this log often)'); 
      
    } catch (err: any) {
      console.error('OAuth signIn initiation error:', err);
      setError(`Failed to start login: ${err.message || err}`);
      setLoading(false);
      setInfo(null);
    }
  };
  
  // Use handleOAuthLogin for the form submission
  const handleSubmit = handleOAuthLogin; 

  return (
    <div className="login-container">
      <div className="login-header">
        {/* App Logo can go here */} 
        <img src="../icon/128.png" alt="Notisky Logo" style={{width: 48, height: 48, marginBottom: 10}}/>
        <h1>Sign in via Bluesky</h1>
        <p>Connect your Bluesky account securely using OAuth</p>
      </div>
      
      <form onSubmit={handleSubmit} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {info && !error && <div className="info-message">{info}</div>} {/* Added info message */} 
        
        <div className="form-group">
          <label htmlFor="handle">Bluesky Handle</label>
          <input
            type="text"
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="yourname.bsky.social"
            required
            disabled={loading}
            autoCapitalize="none"
            autoCorrect="false"
          />
        </div>
        
        {/* Password field removed */}
        
        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : 'Sign in with Bluesky'}
        </button>
      </form>
      
      <div className="login-footer">
        <p>
          You will be redirected to Bluesky to authorize Notisky.
          Your password is never shared with this extension.
        </p>
      </div>
    </div>
  );
}

export default Login; 