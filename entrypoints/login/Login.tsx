import { useState } from 'react';
import { BskyAgent } from '@atproto/api';

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    
    try {
      // Send message to background script to handle login
      const agent = new BskyAgent({ service: "https://bsky.social" });
      
      // Login directly
      const response = await agent.login({ 
        identifier: username, 
        password 
      });
      
      if (response.success) {
        const account = {
          did: response.data.did,
          handle: response.data.handle,
          refreshJwt: response.data.refreshJwt,
          accessJwt: response.data.accessJwt,
        };
        
        // Save account to storage
        const { accounts = {} } = await browser.storage.local.get('accounts');
        accounts[account.did] = account;
        await browser.storage.local.set({ accounts });
        
        // Notify background script
        await browser.runtime.sendMessage({ 
          type: 'DIRECT_LOGIN',
          data: { account }
        });
        
        // Login successful, close popup
        window.close();
      } else {
        setError('Login failed. Please check your credentials and try again.');
      }
    } catch (err) {
      console.error('Login error:', err);
      setError('An error occurred. Please check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="login-container">
      <div className="login-header">
        <h1>Sign in to Notisky</h1>
        <p>Connect your Bluesky account to receive notifications</p>
      </div>
      
      <form onSubmit={handleSubmit} className="login-form">
        {error && <div className="error-message">{error}</div>}
        
        <div className="form-group">
          <label htmlFor="username">Username or Email</label>
          <input
            type="text"
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        
        <div className="form-group">
          <label htmlFor="password">Password</label>
          <input
            type="password"
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        
        <button type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      
      <div className="login-footer">
        <p>
          Note: Your credentials are securely processed and are not stored in plaintext.
          This login method is temporary until Bluesky's OAuth support is fully implemented.
        </p>
      </div>
    </div>
  );
}

export default Login; 